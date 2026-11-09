import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlignVerticalJustifyEnd, CheckCircle2, Copy, Download, FileUp, Hash, Image as ImageIcon, PenLine, QrCode, RotateCcw, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { isConfigured, supabase } from '../../lib/supabase';
import PdfViewer, { type OverlayItem } from './PdfViewer';
import SignaturePad from './SignaturePad';
import { processPngBytes, processUploadedPng, type SignatureAsset } from './signatureImage';
import { DEFAULT_FOOTER_TEXT, QR_BLOCK_ASPECT, buildVerifyUrl, formatSignedAt, renderQrBlock, sha256Hex, shortCode, stampPdf } from './pdfStamp';
import type { DocGroup } from '../../types';

type Signer = { id: string; full_name: string; position: string; signature_path: string | null; user_id?: string | null };
type Props = { signers: Signer[]; groups?: DocGroup[]; user: any; role: string | null; reload: () => void };
type PendingDoc = { id: string; document_number: string; title: string; signer_name: string | null; signer_user_id?: string | null; verification_id: string; sha256: string | null; file_path: string | null; group_id?: string | null };
type Extra = { id: string; page: number; x: number; y: number; w: number };
type Pos = { x: number; y: number; w: number };
type Tab = 'draw' | 'upload' | 'db';
type Result = {
  bytes: Uint8Array;
  sha256: string;
  verificationId: string;
  verifyUrl: string;
  signedAt: Date;
  originalSha256: string;
  qrDataUrl: string;
  placement: { page: number; sig: Pos; qr: Pos; qrAllPages: boolean; extras: { page: number; x: number; y: number; w: number }[] };
};

const SIG_MIN = 0.08, SIG_MAX = 0.6, QR_MIN = 0.3, QR_MAX = 1;
const FOOTER_KEY = 'sh-footer-text';
const loadFooterText = () => { try { return localStorage.getItem(FOOTER_KEY) || DEFAULT_FOOTER_TEXT; } catch { return DEFAULT_FOOTER_TEXT; } };
const short = (h: string) => `${h.slice(0, 12)}…${h.slice(-8)}`;
const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const wibDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);

export default function ESignPage({ signers, groups = [], user, role, reload }: Props) {
  const isAdmin = role === 'super_admin' || role === 'admin';
  const isSigner = role === 'signer';
  const [params, setParams] = useSearchParams();
  const docParam = params.get('doc');
  const [pdf, setPdf] = useState<{ name: string; size: number; bytes: Uint8Array; sha256: string } | null>(null);
  const [pdfError, setPdfError] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [stampPage, setStampPage] = useState(1);
  const [verificationId, setVerificationId] = useState<string>(() => crypto.randomUUID());

  const [tab, setTab] = useState<Tab>('draw');
  const [signature, setSignature] = useState<SignatureAsset | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [removeWhite, setRemoveWhite] = useState(false);
  const [uploadNote, setUploadNote] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [dbSignerId, setDbSignerId] = useState('');
  const [dbBusy, setDbBusy] = useState(false);

  const [sigPos, setSigPos] = useState<Pos>({ x: 0.56, y: 0.66, w: 0.28 });
  const [qrPos, setQrPos] = useState<Pos>({ x: 0.04, y: 0.87, w: 0.92 });
  const [footerText, setFooterText] = useState<string>(loadFooterText);
  const [footerSaved, setFooterSaved] = useState(false);
  const [qrAllPages, setQrAllPages] = useState(false);
  const [groupId, setGroupId] = useState('');
  const pageRatio = useRef(0.707);
  const needSnap = useRef(false);
  const [qrPreview, setQrPreview] = useState('');
  const [extras, setExtras] = useState<Extra[]>([]);

  const [source, setSource] = useState<'upload' | 'archive'>('upload');
  const [pending, setPending] = useState<PendingDoc[]>([]);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingErr, setPendingErr] = useState('');
  const [sourceDoc, setSourceDoc] = useState<PendingDoc | null>(null);

  const [signerId, setSignerId] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signerPosition, setSignerPosition] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const [docTitle, setDocTitle] = useState('');

  const [result, setResult] = useState<Result | null>(null);
  const [viewResult, setViewResult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveMsg, setSaveMsg] = useState('');
  const [copied, setCopied] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const withSig = useMemo(() => signers.filter((s) => s.signature_path), [signers]);

  // ---------- 1. Dokumen ----------
  async function loadPdf(file: File | undefined | null) {
    if (!file) return;
    setPdfError('');
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setPdfError('File harus berformat PDF.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') { setPdfError('Isi file bukan PDF yang valid.'); return; }
    const sha256 = await sha256Hex(bytes);
    freshLoad.current = true;
    needSnap.current = true;
    setGroupId('');
    setSourceDoc(null);
    setExtras([]);
    setPdf({ name: file.name, size: file.size, bytes, sha256 });
    setResult(null);
    setViewResult(false);
    setSaveState('idle');
    setSaveMsg('');
    setError('');
    setVerificationId(crypto.randomUUID());
    setPage(1);
    if (!docTitle) setDocTitle(file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' '));
  }

  // ---------- 1b. Dokumen dari arsip (menunggu tanda tangan) ----------
  async function refreshPending() {
    if (!supabase || !user) return;
    setPendingBusy(true);
    setPendingErr('');
    let q = supabase.from('documents').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    if (isSigner) q = q.eq('signer_user_id', user.id);
    let r: any = await q;
    if (r.error && /signer_user_id/.test(r.error.message)) {
      r = await supabase.from('documents').select('id,document_number,title,signer_name,verification_id,sha256,file_path').eq('status', 'pending').order('created_at', { ascending: false });
    }
    if (r.error) setPendingErr(r.error.message); else setPending(r.data || []);
    setPendingBusy(false);
  }
  useEffect(() => { if (source === 'archive') refreshPending(); }, [source, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Penandatangan langsung diarahkan ke daftar arsip; tautan notifikasi (?doc=ID) langsung membuka dokumennya.
  useEffect(() => { if ((isSigner || docParam) && user) setSource('archive'); }, [isSigner, docParam, user]);
  const openedParam = useRef<string | null>(null);
  useEffect(() => {
    if (!docParam || openedParam.current === docParam || !pending.length) return;
    const d = pending.find((x) => x.id === docParam);
    openedParam.current = docParam;
    if (d) openPending(d.id);
    else setPendingErr('Dokumen dari notifikasi tidak ditemukan. Mungkin sudah ditandatangani atau bukan ditugaskan kepada Anda.');
  }, [docParam, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openPending(id: string) {
    const d = pending.find((x) => x.id === id);
    if (!d || !supabase || !d.file_path) return;
    setPendingBusy(true);
    setPendingErr('');
    try {
      const { data, error } = await supabase.storage.from('documents').download(d.file_path);
      if (error) throw error;
      const bytes = new Uint8Array(await data.arrayBuffer());
      const sha256 = await sha256Hex(bytes);
      if (d.sha256 && d.sha256 !== sha256) throw new Error('Isi file di arsip tidak cocok dengan SHA-256 yang tercatat. Dokumen mungkin berubah; hubungi admin.');
      freshLoad.current = true;
      needSnap.current = true;
      setGroupId(d.group_id || '');
      setExtras([]);
      setResult(null);
      setViewResult(false);
      setSaveState('idle');
      setSaveMsg('');
      setError('');
      setPdf({ name: `${d.title}.pdf`, size: bytes.length, bytes, sha256 });
      setSourceDoc(d);
      setVerificationId(d.verification_id); // QR memakai ID yang sudah tercatat
      setDocNumber(d.document_number);
      setDocTitle(d.title);
      const owner = signers.find((s) => (d.signer_user_id && s.user_id === d.signer_user_id) || s.full_name === d.signer_name);
      setSignerId(owner?.id || '');
      setSignerName(owner?.full_name || d.signer_name || '');
      setSignerPosition(owner?.position || '');
      setPage(1);
    } catch (e: any) {
      setPendingErr(e.message || 'Gagal mengambil dokumen dari arsip.');
    } finally {
      setPendingBusy(false);
    }
  }

  const freshLoad = useRef(false);
  function onPdfLoaded(n: number) {
    setNumPages(n);
    if (freshLoad.current) { // hanya saat berkas baru dibuka; bukan saat berpindah ke tampilan hasil
      freshLoad.current = false;
      setStampPage(n);
      setPage(n);
    }
  }

  function snapFooter(ratio = pageRatio.current) {
    setQrPos((p) => ({ ...p, x: (1 - p.w) / 2, y: Math.max(0, 1 - p.w * QR_BLOCK_ASPECT * ratio - 0.02) }));
  }
  function onAspect(r: number) {
    pageRatio.current = r;
    if (needSnap.current) { needSnap.current = false; snapFooter(r); }
  }
  function saveFooterDefault() {
    try { localStorage.setItem(FOOTER_KEY, footerText); setFooterSaved(true); window.setTimeout(() => setFooterSaved(false), 1800); } catch { /* penyimpanan tidak tersedia */ }
  }
  function resetFooter() {
    setFooterText(DEFAULT_FOOTER_TEXT);
    try { localStorage.removeItem(FOOTER_KEY); } catch { /* abaikan */ }
  }

  // ---------- 2. Tanda tangan ----------
  useEffect(() => {
    if (!uploadFile) return;
    let off = false;
    processUploadedPng(uploadFile, removeWhite).then(
      (r) => {
        if (off) return;
        setSignature(r.asset);
        setUploadError('');
        setUploadNote(r.hadTransparency || removeWhite ? '' : 'PNG ini tidak memiliki latar transparan, sehingga akan menutupi teks di bawahnya. Aktifkan "Hapus latar putih" bila latarnya putih.');
      },
      (e) => { if (!off) { setUploadError(e.message); setSignature(null); } },
    );
    return () => { off = true; };
  }, [uploadFile, removeWhite]);

  async function useDbSignature() {
    const s = signers.find((x) => x.id === dbSignerId);
    if (!s?.signature_path || !supabase) return;
    setDbBusy(true);
    setUploadError('');
    try {
      const { data, error } = await supabase.storage.from('signature-files').download(s.signature_path);
      if (error) throw error;
      const { asset } = await processPngBytes(new Uint8Array(await data.arrayBuffer()), false);
      setUploadFile(null);
      setSignature(asset);
      if (!signerName) { setSignerName(s.full_name); setSignerPosition(s.position); setSignerId(s.id); }
    } catch (e: any) {
      setUploadError(e.message || 'Gagal mengambil tanda tangan dari database. Pastikan akun Anda memiliki izin.');
    } finally {
      setDbBusy(false);
    }
  }

  // ---------- 3. Blok verifikasi (pratinjau) ----------
  useEffect(() => {
    if (!pdf) { setQrPreview(''); return; }
    let off = false;
    const t = window.setTimeout(() => {
      renderQrBlock({
        verificationId,
        verifyUrl: buildVerifyUrl(verificationId),
        signerName: signerName || 'Nama penandatangan',
        signerPosition,
        originalSha256: pdf.sha256,
        signedAt: new Date(),
        documentNumber: docNumber,
        footerText,
      }).then((r) => { if (!off) setQrPreview(r.dataUrl); });
    }, 150);
    return () => { off = true; window.clearTimeout(t); };
  }, [pdf, verificationId, signerName, signerPosition, docNumber, footerText]);

  const items: OverlayItem[] = [];
  if (pdf && signature) {
    const aspect = signature.height / signature.width;
    items.push({ id: 'sig', page: stampPage, label: 'Tanda tangan', src: signature.dataUrl, aspect, ...sigPos, minW: SIG_MIN, maxW: SIG_MAX });
    extras.forEach((ex, i) => items.push({ id: ex.id, page: ex.page, label: `Paraf ${i + 1}`, src: signature.dataUrl, aspect, x: ex.x, y: ex.y, w: ex.w, minW: SIG_MIN, maxW: SIG_MAX }));
  }
  if (pdf && qrPreview) {
    items.push({ id: 'qr', page: stampPage, label: 'Footer QR verifikasi', src: qrPreview, aspect: QR_BLOCK_ASPECT, ...qrPos, minW: QR_MIN, maxW: QR_MAX });
  }

  function onItemChange(id: string, patch: Partial<Pos>) {
    if (id === 'sig') setSigPos((p) => ({ ...p, ...patch }));
    else if (id === 'qr') setQrPos((p) => ({ ...p, ...patch }));
    else setExtras((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function addExtra() {
    setExtras((list) => [...list, { id: `ex-${crypto.randomUUID()}`, page, x: 0.6, y: 0.8, w: Math.min(sigPos.w, 0.2) }]);
  }

  function changeStampPage(n: number) {
    setStampPage(n);
    setPage(n);
    setViewResult(false);
  }

  // ---------- 4. Bubuhkan ----------
  const canStamp = Boolean(pdf && signature && signerName.trim());

  async function stamp() {
    if (!pdf || !signature) return;
    setBusy(true);
    setError('');
    setSaveState('idle');
    setSaveMsg('');
    try {
      const id = result && !sourceDoc ? crypto.randomUUID() : verificationId; // ID lama mungkin sudah diunduh; ID dokumen arsip tetap
      if (id !== verificationId) setVerificationId(id);
      const signedAt = new Date();
      const info = {
        verificationId: id,
        verifyUrl: buildVerifyUrl(id),
        signerName: signerName.trim(),
        signerPosition: signerPosition.trim(),
        originalSha256: pdf.sha256,
        signedAt,
        documentNumber: docNumber.trim(),
        footerText,
      };
      const qr = await renderQrBlock(info);
      const placement = { page: stampPage, sig: sigPos, qr: qrPos, qrAllPages, extras: extras.map(({ page: pg, x, y, w }) => ({ page: pg, x, y, w })) };
      const out = await stampPdf(pdf.bytes, signature, qr, placement, info);
      setResult({ bytes: out.bytes, sha256: out.sha256, verificationId: id, verifyUrl: info.verifyUrl, signedAt, originalSha256: pdf.sha256, qrDataUrl: qr.dataUrl, placement });
      setViewResult(true);
      setPage(stampPage);
    } catch (e: any) {
      setError(e.message || 'Gagal membubuhkan tanda tangan.');
    } finally {
      setBusy(false);
    }
  }

  // ---------- 5. Simpan ----------
  function download() {
    if (!result || !pdf) return;
    const url = URL.createObjectURL(new Blob([result.bytes as BlobPart], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pdf.name.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_')}_signed.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Admin: boleh mengarsipkan dokumen baru maupun menandatangani dokumen pending.
  // Penandatangan (role signer): hanya dokumen pending yang ditugaskan kepadanya.
  const canArchive = Boolean(user) && isConfigured && (isAdmin || (isSigner && sourceDoc !== null));
  const archiveBlockReason = !isConfigured ? 'Hubungkan Supabase untuk mengaktifkan arsip.'
    : !user ? 'Login untuk menyimpan ke arsip.'
    : isSigner && !sourceDoc ? 'Penandatangan hanya dapat menandatangani dokumen yang ditugaskan: pilih sumber “Dari arsip”.'
    : !isAdmin && !isSigner ? 'Hanya admin atau penandatangan yang ditugaskan yang dapat mengarsipkan dokumen bertanda tangan. Sekretaris dapat mengunggah dokumen dan menugaskan penandatangan di Manajemen Dokumen.'
    : '';

  async function archive() {
    if (!result || !supabase || !user || !canArchive) return;
    if (!docNumber.trim() || !docTitle.trim()) { setSaveMsg('Isi nomor surat dan perihal terlebih dahulu.'); return; }
    if (result.bytes.length > 10 * 1024 * 1024) { setSaveMsg('Ukuran PDF melebihi batas arsip 10 MB. Unduh file secara lokal.'); return; }
    setSaveState('saving');
    setSaveMsg('');
    const path = `${result.verificationId}-signed.pdf`;
    try {
      const up = await supabase.storage.from('documents').upload(path, new Blob([result.bytes as BlobPart], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false });
      if (up.error) throw up.error;
      const signedFields = {
        status: 'verified',
        sha256: result.sha256,
        original_sha256: result.originalSha256,
        file_path: path,
        issued_at: wibDate(result.signedAt),
        signed_at: result.signedAt.toISOString(),
        signature_position: result.placement,
      };
      let failure: { message: string } | null = null;
      if (sourceDoc) {
        const patch: Record<string, unknown> = { ...signedFields, original_file_path: sourceDoc.file_path };
        if (isAdmin) { patch.document_number = docNumber.trim(); patch.title = docTitle.trim(); patch.signer_name = signerName.trim(); if (groups.length) patch.group_id = groupId || null; }
        const r = await supabase.from('documents').update(patch).eq('id', sourceDoc.id).eq('status', 'pending').select('id');
        failure = r.error ?? (r.data?.length ? null : { message: 'Dokumen tidak dapat diperbarui. Status sudah berubah atau Anda tidak berwenang menandatanganinya.' });
      } else {
        const r = await supabase.from('documents').insert({ ...signedFields, document_number: docNumber.trim(), title: docTitle.trim(), signer_name: signerName.trim(), verification_id: result.verificationId, signer_user_id: signers.find((x) => x.id === signerId)?.user_id ?? null, ...(groups.length && groupId ? { group_id: groupId } : {}) });
        failure = r.error;
      }
      if (failure) {
        await supabase.storage.from('documents').remove([path]); // dapat gagal bila tanpa izin hapus; tidak masalah
        throw failure;
      }
      setSaveState('saved');
      setSaveMsg('Dokumen diarsipkan. QR pada dokumen sekarang dapat diverifikasi.');
      reload();
      if (source === 'archive') refreshPending();
      if (docParam) setParams({}, { replace: true });
    } catch (e: any) {
      setSaveState('idle');
      const m = String(e?.message || 'Gagal menyimpan dokumen.');
      setSaveMsg(/column|schema cache/i.test(m) ? 'Skema database belum diperbarui. Jalankan supabase/esign-setup.sql di Supabase SQL Editor.' : m);
    }
  }

  async function copy(label: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(label); window.setTimeout(() => setCopied(''), 1500); } catch { /* clipboard tidak tersedia */ }
  }

  const lockMeta = Boolean(sourceDoc) && !isAdmin; // penandatangan tidak boleh mengubah data surat
  const viewData = viewResult && result ? result.bytes : pdf?.bytes ?? null;
  const dirty = Boolean(result) && !viewResult;

  return (
    <div className="esign">
      <section
        className="panel esign-stage"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); loadPdf(e.dataTransfer.files?.[0]); }}
      >
        <div className="panel-head">
          <div>
            <h3>{viewResult ? 'Hasil dokumen bertanda tangan' : 'Pratinjau & posisi'}</h3>
            <p>{viewResult ? 'Periksa hasil akhir sebelum diunduh atau diarsipkan.' : pdf ? 'Seret tanda tangan dan blok QR ke posisi yang diinginkan. Tarik sudut kanan-bawah untuk mengubah ukuran.' : 'Seret berkas PDF ke area ini atau pilih dari panel di samping.'}</p>
          </div>
          {result && (
            <div className="seg" role="group" aria-label="Mode tampilan">
              <button type="button" className={!viewResult ? 'on' : ''} onClick={() => { setViewResult(false); setPage(stampPage); }}>Atur posisi</button>
              <button type="button" className={viewResult ? 'on' : ''} onClick={() => setViewResult(true)}>Lihat hasil</button>
            </div>
          )}
        </div>
        <PdfViewer
          data={viewData}
          page={page}
          onPageChange={setPage}
          onLoaded={onPdfLoaded}
          onAspect={onAspect}
          items={viewResult ? [] : items}
                    onItemChange={onItemChange}
        />
        {dirty && <p className="muted">Posisi diubah? Klik “Bubuhkan ulang” untuk memperbarui dokumen hasil.</p>}
      </section>

      <div className="esign-side">
        <Step n={1} title="Dokumen PDF" done={Boolean(pdf)}>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { loadPdf(e.target.files?.[0]); e.target.value = ''; }} />
          {isConfigured && user && (
            <div className="seg wide" role="tablist" aria-label="Sumber dokumen">
              <button type="button" role="tab" aria-selected={source === 'upload'} className={source === 'upload' ? 'on' : ''} onClick={() => setSource('upload')}>Unggah baru</button>
              <button type="button" role="tab" aria-selected={source === 'archive'} className={source === 'archive' ? 'on' : ''} onClick={() => setSource('archive')}>Dari arsip</button>
            </div>
          )}
          {source === 'upload' || !user ? (
            <button type="button" className="button primary" onClick={() => fileInput.current?.click()}><FileUp size={16} />{pdf ? 'Ganti PDF' : 'Pilih PDF'}</button>
          ) : (
            <div className="stack">
              <select aria-label="Dokumen menunggu tanda tangan" value={sourceDoc?.id || ''} disabled={pendingBusy} onChange={(e) => e.target.value && openPending(e.target.value)}>
                <option value="">{pendingBusy ? 'Memuat…' : pending.length ? 'Pilih dokumen menunggu tanda tangan…' : 'Tidak ada dokumen menunggu'}</option>
                {pending.map((d) => <option key={d.id} value={d.id}>{d.document_number} — {d.title}</option>)}
              </select>
              <button type="button" className="button ghost" onClick={refreshPending} disabled={pendingBusy}>Muat ulang daftar</button>
              {pendingErr && <p className="error">{pendingErr}</p>}
            </div>
          )}
          {pdfError && <p className="error">{pdfError}</p>}
          {pdf && (
            <dl className="kv">
              <dt>Berkas</dt><dd>{pdf.name}</dd>
              <dt>Ukuran</dt><dd>{fmtSize(pdf.size)}{numPages ? ` · ${numPages} halaman` : ''}</dd>
              <dt>SHA-256 asli</dt><dd className="mono" title={pdf.sha256}>{short(pdf.sha256)}</dd>
            </dl>
          )}
        </Step>

        <Step n={2} title="Tanda tangan" done={Boolean(signature)}>
          <div className="seg wide" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'draw'} className={tab === 'draw' ? 'on' : ''} onClick={() => setTab('draw')}><PenLine size={14} />Gambar</button>
            <button type="button" role="tab" aria-selected={tab === 'upload'} className={tab === 'upload' ? 'on' : ''} onClick={() => setTab('upload')}><Upload size={14} />Unggah PNG</button>
            {isConfigured && <button type="button" role="tab" aria-selected={tab === 'db'} className={tab === 'db' ? 'on' : ''} onClick={() => setTab('db')}><ImageIcon size={14} />Database</button>}
          </div>
          {tab === 'draw' && <SignaturePad onUse={(a) => { setSignature(a); setUploadFile(null); }} />}
          {tab === 'upload' && (
            <div className="stack">
              <label className="filebox">PNG tanda tangan (maks. 2 MB)
                <input type="file" accept="image/png" onChange={(e) => { setUploadFile(e.target.files?.[0] || null); }} />
              </label>
              <label className="check"><input type="checkbox" checked={removeWhite} onChange={(e) => setRemoveWhite(e.target.checked)} />Hapus latar putih otomatis</label>
              {uploadNote && <p className="notice">{uploadNote}</p>}
            </div>
          )}
          {tab === 'db' && (
            <div className="stack">
              {!user ? <p className="notice">Login terlebih dahulu untuk memakai tanda tangan dari database.</p> : !withSig.length ? <p className="muted">Belum ada pengurus dengan file tanda tangan.</p> : (
                <>
                  <select value={dbSignerId} onChange={(e) => setDbSignerId(e.target.value)} aria-label="Pilih pengurus">
                    <option value="">Pilih pengurus…</option>
                    {withSig.map((s) => <option key={s.id} value={s.id}>{s.full_name} — {s.position}</option>)}
                  </select>
                  <button type="button" className="button primary" disabled={!dbSignerId || dbBusy} onClick={useDbSignature}>{dbBusy ? 'Mengambil…' : 'Gunakan tanda tangan'}</button>
                </>
              )}
            </div>
          )}
          {uploadError && <p className="error">{uploadError}</p>}
          {signature && (
            <div className="sigpreview">
              <img src={signature.dataUrl} alt="Tanda tangan yang dipakai" />
              <button type="button" className="icon-btn" title="Hapus tanda tangan" aria-label="Hapus tanda tangan" onClick={() => { setSignature(null); setUploadFile(null); }}><Trash2 size={16} /></button>
            </div>
          )}
        </Step>

        <Step n={3} title="Posisi & footer QR" done={Boolean(pdf && signature)}>
          <div className="stack">
            <label className="field">Halaman tanda tangan
              <select value={stampPage} disabled={!numPages} onChange={(e) => changeStampPage(Number(e.target.value))}>
                {Array.from({ length: numPages || 1 }, (_, i) => <option key={i + 1} value={i + 1}>Halaman {i + 1}</option>)}
              </select>
            </label>
            <label className="field">Ukuran tanda tangan
              <input type="range" min={SIG_MIN} max={SIG_MAX} step={0.01} value={sigPos.w} disabled={!signature} onChange={(e) => setSigPos((p) => ({ ...p, w: Number(e.target.value) }))} />
            </label>
            <label className="field">Lebar footer QR
              <input type="range" min={QR_MIN} max={QR_MAX} step={0.01} value={qrPos.w} disabled={!pdf} onChange={(e) => setQrPos((p) => ({ ...p, w: Number(e.target.value), x: Math.min(p.x, 1 - Number(e.target.value)) }))} />
            </label>
            <button type="button" className="button ghost" disabled={!pdf} onClick={() => snapFooter()}><AlignVerticalJustifyEnd size={14} />Rapatkan footer ke bawah halaman</button>
            <label className="check"><input type="checkbox" checked={qrAllPages} onChange={(e) => setQrAllPages(e.target.checked)} />Pasang footer QR di semua halaman</label>
            <label className="field">Teks footer (dapat diubah)
              <textarea className="footer-text" rows={5} value={footerText} maxLength={600} onChange={(e) => setFooterText(e.target.value)} />
            </label>
            <p className="muted small">Placeholder otomatis: <span className="mono">{'{penandatangan} {jabatan} {waktu} {kode} {nomor}'}</span>. Kode di bawah QR: <span className="mono">{shortCode(verificationId)}</span>. Ukuran huruf menyesuaikan agar teks muat.</p>
            <div className="btn-row">
              <button type="button" className="button ghost sm" onClick={saveFooterDefault}><Save size={13} />{footerSaved ? 'Tersimpan' : 'Simpan sebagai default'}</button>
              <button type="button" className="button ghost sm" onClick={resetFooter}><RotateCcw size={13} />Teks bawaan</button>
            </div>
            <button type="button" className="button ghost" disabled={!signature || !numPages} onClick={addExtra}><PenLine size={14} />Tambah paraf di halaman {page}</button>
            {extras.map((ex, i) => (
              <div className="extra-row" key={ex.id}>
                <span>Paraf {i + 1} · halaman {ex.page}</span>
                <button type="button" className="icon-btn" aria-label={`Hapus paraf ${i + 1}`} onClick={() => setExtras((l) => l.filter((e) => e.id !== ex.id))}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </Step>

        <Step n={4} title="Penandatangan & bubuhkan" done={Boolean(result)}>
          <div className="stack">
            <label className="field">Penandatangan
              <select value={signerId} disabled={lockMeta} onChange={(e) => { const s = signers.find((x) => x.id === e.target.value); setSignerId(e.target.value); if (s) { setSignerName(s.full_name); setSignerPosition(s.position); } }}>
                <option value="">Isi manual</option>
                {signers.map((s) => <option key={s.id} value={s.id}>{s.full_name} — {s.position}</option>)}
              </select>
            </label>
            <label className="field">Nama<input value={signerName} readOnly={lockMeta} onChange={(e) => setSignerName(e.target.value)} placeholder="Nama lengkap penandatangan" maxLength={80} /></label>
            <label className="field">Jabatan<input value={signerPosition} onChange={(e) => setSignerPosition(e.target.value)} placeholder="Contoh: Ketua Umum HMTE" maxLength={80} /></label>
            <label className="field">Nomor surat<input value={docNumber} readOnly={lockMeta} onChange={(e) => setDocNumber(e.target.value)} placeholder="001/HMTE/XI/2026" /></label>
            <label className="field">Perihal<input value={docTitle} readOnly={lockMeta} onChange={(e) => setDocTitle(e.target.value)} placeholder="Surat Undangan Rapat" /></label>
            {groups.length > 0 && isAdmin && (
              <label className="field">Kelompok surat
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">Tanpa kelompok</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
            <p className="muted small">Verification ID: <span className="mono">{verificationId}</span></p>
            <button type="button" className="button primary" disabled={!canStamp || busy} onClick={stamp}>
              <PenLine size={16} />{busy ? 'Memproses…' : result ? 'Bubuhkan ulang' : 'Bubuhkan tanda tangan'}
            </button>
            {!canStamp && <p className="muted small">Lengkapi: {[!pdf && 'PDF', !signature && 'tanda tangan', !signerName.trim() && 'nama penandatangan'].filter(Boolean).join(', ')}.</p>}
            {error && <p className="error">{error}</p>}
          </div>
        </Step>

        {result && (
          <section className="esign-card result-card">
            <h4><ShieldCheck size={17} />Dokumen siap disimpan</h4>
            <div className="result-qr">
              <img src={result.qrDataUrl} alt="Footer QR verifikasi" />
            </div>
            <dl className="kv">
              <dt><Hash size={12} />Verification ID</dt>
              <dd className="mono copyable">{result.verificationId}<button type="button" className="icon-btn" aria-label="Salin Verification ID" onClick={() => copy('id', result.verificationId)}><Copy size={13} /></button>{copied === 'id' && <small>Tersalin</small>}</dd>
              <dt>SHA-256 dokumen akhir</dt>
              <dd className="mono copyable break">{result.sha256}<button type="button" className="icon-btn" aria-label="Salin SHA-256" onClick={() => copy('hash', result.sha256)}><Copy size={13} /></button>{copied === 'hash' && <small>Tersalin</small>}</dd>
              <dt>Waktu</dt><dd>{formatSignedAt(result.signedAt)}</dd>
              <dt><QrCode size={12} />Kode singkat</dt><dd className="mono">{shortCode(result.verificationId)}</dd>
              <dt><QrCode size={12} />Tautan QR</dt><dd className="break small">{result.verifyUrl}</dd>
            </dl>
            <div className="btn-row">
              <button type="button" className="button primary" onClick={download}><Download size={16} />Unduh PDF</button>
              <button type="button" className="button dark" onClick={archive} disabled={!canArchive || saveState !== 'idle'}>
                {saveState === 'saved' ? <CheckCircle2 size={16} /> : <Save size={16} />}{saveState === 'saving' ? 'Menyimpan…' : saveState === 'saved' ? 'Tersimpan' : 'Simpan ke arsip'}
              </button>
            </div>
            {saveState !== 'saved' && !canArchive && <p className="notice">QR baru dapat diverifikasi setelah dokumen diarsipkan. {archiveBlockReason}</p>}
            {saveMsg && <p className={saveState === 'saved' ? 'ok' : 'error'}>{saveMsg}</p>}
          </section>
        )}
      </div>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section className="esign-card">
      <h4><span className={`stepno ${done ? 'done' : ''}`}>{done ? <CheckCircle2 size={15} /> : n}</span>{title}</h4>
      {children}
    </section>
  );
}
