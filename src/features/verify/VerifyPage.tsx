import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Camera, Download, Eye, ShieldCheck, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { sha256Hex } from '../esign/pdfStamp';
import PdfViewer from '../esign/PdfViewer';

type VSigner = { step: number; name: string; position: string | null; status: string; signed_at: string | null };
type VDoc = {
  found: boolean; ambiguous?: boolean; document_number: string; title: string; status: string; issued_at: string | null; signed_at: string | null;
  revoked_reason: string | null; revoked_at: string | null; sha256: string | null; original_sha256: string | null; verification_id: string; short_code: string | null;
  signers: VSigner[]; downloadable: boolean; file_path: string | null;
};
type Outcome = { doc?: VDoc; message?: string; match?: boolean | null; isOriginal?: boolean };

const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'short' }) + ' WIB' : '—');
const STATUS: Record<string, string> = { verified: 'Terverifikasi', revoked: 'DICABUT', pending: 'Menunggu tanda tangan', rejected: 'Ditolak / dikembalikan', draft: 'Draf', archived: 'Diarsipkan' };

/** Mengambil Verification ID / kode dari isi QR (tautan atau kode polos). */
export function extractKey(text: string) {
  const m = text.match(/[?&]id=([^&#\s]+)/i);
  return decodeURIComponent((m ? m[1] : text).trim());
}

export default function VerifyPage() {
  const [params] = useSearchParams();
  const [id, setId] = useState(params.get('id') || '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome | null>(null);
  const [preview, setPreview] = useState<Uint8Array | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const [page, setPage] = useState(1);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);

  async function run(raw: string, pdf: File | null, method: 'qr' | 'manual' | 'kamera' | 'unggah') {
    if (!supabase) { alert('Supabase belum dikonfigurasi.'); return; }
    setBusy(true); setOut(null); setPreview(null); setPreviewErr(''); setPage(1);
    try {
      const r = await supabase.rpc('verify_document', { p_key: raw.trim(), p_method: pdf ? 'unggah' : method });
      if (r.error) throw new Error(/function|schema cache/i.test(r.error.message) ? 'Fungsi verifikasi belum terpasang di database. Admin perlu menjalankan supabase/workflow-setup.sql.' : r.error.message);
      const d = r.data as VDoc;
      if (!d?.found) { setOut({ message: d?.ambiguous ? 'Kode singkat ini cocok dengan lebih dari satu dokumen. Gunakan Verification ID lengkap.' : 'Dokumen tidak ditemukan. Periksa kembali kode atau QR.' }); return; }
      let match: boolean | null = null, isOriginal = false;
      if (pdf && d.sha256) {
        const h = await sha256Hex(new Uint8Array(await pdf.arrayBuffer()));
        match = h === d.sha256;
        isOriginal = !match && Boolean(d.original_sha256) && h === d.original_sha256;
      }
      setOut({ doc: d, match, isOriginal });
    } catch (e: any) { setOut({ message: e.message || 'Verifikasi gagal.' }); } finally { setBusy(false); }
  }

  useEffect(() => { const q = params.get('id'); if (q) { setId(q); run(q, null, 'qr'); } }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  async function signedUrl(doc: VDoc, download?: string) {
    if (!supabase || !doc.file_path) throw new Error('File tidak tersedia.');
    const r = await supabase.storage.from('documents').createSignedUrl(doc.file_path, 300, download ? { download } : undefined);
    if (r.error) throw new Error('Pratinjau/unduhan publik untuk dokumen ini tidak diizinkan.');
    return r.data.signedUrl;
  }
  async function showPreview(doc: VDoc) {
    setPreviewBusy(true); setPreviewErr('');
    try {
      const res = await fetch(await signedUrl(doc));
      if (!res.ok) throw new Error('Gagal memuat PDF.');
      setPreview(new Uint8Array(await res.arrayBuffer()));
    } catch (e: any) { setPreviewErr(e.message); } finally { setPreviewBusy(false); }
  }
  async function download(doc: VDoc) {
    try { window.open(await signedUrl(doc, `${doc.document_number.replace(/[^\w.-]+/g, '_')}.pdf`), '_blank', 'noopener'); } catch (e: any) { setPreviewErr(e.message); }
  }

  // ---- pindai QR dengan kamera (BarcodeDetector: Chrome/Edge/Android; lainnya gunakan kamera bawaan ponsel) ----
  const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null, stop = false, timer = 0;
    (async () => {
      try {
        const Detector = (window as any).BarcodeDetector;
        const detector = new Detector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (stop) return;
          try {
            const codes = await detector.detect(v);
            if (codes.length) {
              const key = extractKey(codes[0].rawValue || '');
              if (key) { stop = true; setScanning(false); setId(key); run(key, null, 'kamera'); return; }
            }
          } catch { /* frame belum siap */ }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      } catch (e: any) {
        setScanErr(e?.name === 'NotAllowedError' ? 'Izin kamera ditolak. Aktifkan izin kamera pada browser.' : 'Kamera tidak dapat dibuka.');
        setScanning(false);
      }
    })();
    return () => { stop = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = out?.doc;
  const ok = d && d.status === 'verified' && out?.match !== false;

  return (
    <section className="panel verify-panel">
      <div className="verify-icon"><ShieldCheck size={34} /></div>
      <h2>Verifikasi Dokumen HMTE</h2>
      <p>Pindai QR Code pada dokumen atau masukkan kode di bawah QR. Unggah PDF untuk memeriksa integritas file.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(id, file, 'manual'); }} className="verify-form">
        <label>Verification ID atau kode di bawah QR
          <input required value={id} onChange={(e) => setId(e.target.value)} placeholder="Contoh: 8F573B89BC atau ID lengkap" />
        </label>
        <label>File PDF untuk pemeriksaan hash (opsional)<input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        <div className="btn-row">
          <button className="button primary" disabled={busy}>{busy ? 'Memeriksa...' : 'Verifikasi dokumen'}</button>
          {canScan
            ? <button type="button" className="button ghost" onClick={() => { setScanErr(''); setScanning(true); }}><Camera size={15} />Pindai QR dengan kamera</button>
            : <small className="muted">Pindai QR: gunakan aplikasi kamera ponsel, atau buka halaman ini di Chrome/Edge untuk pemindai bawaan.</small>}
        </div>
        {scanErr && <p className="error">{scanErr}</p>}
      </form>

      {scanning && (
        <div className="dlg-backdrop" role="presentation">
          <div className="dlg scan-dlg" role="dialog" aria-modal="true" aria-label="Pindai QR">
            <div className="dlg-head"><h3>Arahkan kamera ke QR Code</h3><button type="button" className="icon-btn" aria-label="Tutup" onClick={() => setScanning(false)}><X size={17} /></button></div>
            <video ref={videoRef} playsInline muted className="scan-video" />
          </div>
        </div>
      )}

      {out && (
        <div className={`result ${ok ? 'valid' : 'invalid'}`}>
          {out.message ? (
            <><h3>Verifikasi gagal</h3><p>{out.message}</p></>
          ) : d && (
            <>
              <h3>{d.status === 'revoked' ? 'Dokumen telah DICABUT' : d.status === 'verified' ? (out.match === false ? 'File TIDAK COCOK dengan dokumen terdaftar' : 'Dokumen terdaftar dan terverifikasi') : `Dokumen belum final: ${STATUS[d.status] || d.status}`}</h3>
              <p><b>Nomor:</b> {d.document_number}</p>
              <p><b>Perihal:</b> {d.title}</p>
              <p><b>Tanggal surat:</b> {d.issued_at || '—'}</p>
              {d.signed_at && <p><b>Selesai ditandatangani:</b> {fmtDT(d.signed_at)}</p>}
              <p><b>Status sistem:</b> {STATUS[d.status] || d.status}</p>
              {d.status === 'revoked' && <p><b>Alasan pencabutan:</b> {d.revoked_reason || '—'}{d.revoked_at ? ` (${fmtDT(d.revoked_at)})` : ''}</p>}

              <h4>Penandatangan</h4>
              <ol className="step-list">
                {d.signers.map((s) => (
                  <li key={s.step} className={s.status}>
                    <span>{d.signers.length > 1 ? `${s.step}. ` : ''}{s.name}{s.position ? ` — ${s.position}` : ''}</span>
                    <em>{s.status === 'signed' ? `Menandatangani ${fmtDT(s.signed_at)}` : s.status === 'rejected' ? 'Menolak' : 'Belum menandatangani'}</em>
                  </li>
                ))}
                {!d.signers.length && <li className="muted">Data penandatangan tidak tersedia.</li>}
              </ol>

              <p><b>SHA-256 terdaftar:</b> <code style={{ wordBreak: 'break-all' }}>{d.sha256 || '—'}</code></p>
              <p><b>Hash file:</b> {out.match == null ? 'Belum dibandingkan (PDF tidak diunggah)' : out.match ? 'Cocok' : out.isOriginal ? 'TIDAK COCOK: file ini adalah dokumen asli sebelum ditandatangani, bukan versi bertanda tangan' : 'TIDAK COCOK'}</p>

              {d.downloadable && (
                <div className="btn-row">
                  <button type="button" className="button ghost" onClick={() => showPreview(d)} disabled={previewBusy || Boolean(preview)}><Eye size={15} />{previewBusy ? 'Memuat…' : 'Pratinjau dokumen'}</button>
                  <button type="button" className="button primary" onClick={() => download(d)}><Download size={15} />Unduh dokumen asli</button>
                </div>
              )}
              {d.status === 'verified' && !d.downloadable && <small className="muted">Pratinjau dan unduhan publik dinonaktifkan untuk dokumen ini.</small>}
              {previewErr && <p className="error">{previewErr}</p>}
              {preview && <div className="verify-preview"><PdfViewer data={preview} page={page} onPageChange={setPage} /></div>}
              <small>Catatan: ID yang ditemukan membuktikan dokumen tercatat di sistem HMTE, bukan sertifikat elektronik tersertifikasi. Status final mengikuti status dokumen dan kecocokan hash file.</small>
            </>
          )}
        </div>
      )}
    </section>
  );
}
