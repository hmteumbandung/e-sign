import { useEffect, useState } from 'react';
import { Copy, Download, Eye, Mail, MessageCircle, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import PdfViewer from '../esign/PdfViewer';
import { statusLabel } from './DocTable';
import { mailLink, signLink, signRequestText, verifyLink, waLink } from '../../lib/appUrl';
import type { Doc, DocSigner, Signer } from '../../types';

type Props = {
  doc: Doc;
  steps: DocSigner[];
  owners: Signer[];
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
};

const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB' : '—');
const stepLabel: Record<string, string> = { signed: 'Sudah tanda tangan', pending: 'Menunggu', waiting: 'Belum giliran', rejected: 'Menolak' };

/** Rincian dokumen: pratinjau PDF, alur penandatangan, tautan permintaan TTD (WhatsApp/email), dan riwayat verifikasi. */
export default function DocumentDetail({ doc, steps, owners, canManage, onClose, onChanged }: Props) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [page, setPage] = useState(1);
  const [fileErr, setFileErr] = useState('');
  const [logs, setLogs] = useState<{ id: string; method: string; created_at: string }[]>([]);
  const [logCount, setLogCount] = useState<number | null>(null);
  const [pub, setPub] = useState(doc.public_access !== false);
  const [copied, setCopied] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let off = false;
    setBytes(null); setFileErr('');
    if (!supabase || !doc.file_path) return;
    supabase.storage.from('documents').download(doc.file_path).then(async ({ data, error }) => {
      if (off) return;
      if (error) setFileErr(error.message); else setBytes(new Uint8Array(await data.arrayBuffer()));
    });
    return () => { off = true; };
  }, [doc.id, doc.file_path]);

  useEffect(() => {
    if (!supabase || !canManage) return;
    supabase.from('verification_logs').select('id,method,created_at', { count: 'exact' }).eq('document_id', doc.id).order('created_at', { ascending: false }).limit(8)
      .then(({ data, count, error }) => { if (!error) { setLogs((data || []) as any); setLogCount(count ?? (data || []).length); } });
  }, [doc.id, canManage]);

  async function download() {
    if (!supabase || !doc.file_path) return;
    const r = await supabase.storage.from('documents').createSignedUrl(doc.file_path, 120, { download: `${doc.document_number.replace(/[^\w.-]+/g, '_')}.pdf` });
    if (r.error) { setMsg(r.error.message); return; }
    window.open(r.data.signedUrl, '_blank', 'noopener');
  }

  async function togglePublic(v: boolean) {
    if (!supabase) return;
    const r = await supabase.from('documents').update({ public_access: v }).eq('id', doc.id).select('id');
    if (r.error || !r.data?.length) { setMsg(r.error?.message || 'Tidak dapat mengubah pengaturan.'); return; }
    setPub(v); setMsg('');
    await onChanged();
  }

  async function copy(label: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(label); window.setTimeout(() => setCopied(''), 1500); } catch { /* clipboard tidak tersedia */ }
  }

  const pendingSteps = steps.filter((s) => s.status === 'pending');
  const url = signLink(doc.id);

  return (
    <div className="dlg-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg wide" role="dialog" aria-modal="true" aria-labelledby="dd-title">
        <div className="dlg-head">
          <span className="dlg-icon"><Eye size={20} /></span>
          <h3 id="dd-title">{doc.document_number}</h3>
          <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="detail-grid">
          <div className="detail-info">
            <p className="detail-title">{doc.title}</p>
            <dl className="kv">
              <dt>Status</dt><dd><span className={`status ${doc.status === 'verified' ? 'good' : doc.status === 'revoked' || doc.status === 'rejected' ? 'bad' : 'pending'}`}>{statusLabel[doc.status] || doc.status}</span>{(doc.revision || 1) > 1 ? ` · revisi ${doc.revision}` : ''}</dd>
              <dt>Tanggal surat</dt><dd>{doc.issued_at || '—'}</dd>
              <dt>Ditandatangani</dt><dd>{fmtDT(doc.signed_at)}</dd>
              <dt>Kode singkat</dt><dd className="mono">{doc.short_code || '—'}</dd>
              <dt>Verification ID</dt><dd className="mono break small">{doc.verification_id}</dd>
              {doc.sha256 && <><dt>SHA-256</dt><dd className="mono break small">{doc.sha256}</dd></>}
            </dl>

            {doc.status === 'rejected' && <div className="notice reject-note"><b>Ditolak:</b> {doc.reject_reason || '—'}<br /><small>{fmtDT(doc.rejected_at)}</small></div>}

            <h4>Alur penandatangan {steps.length > 1 ? `(${doc.sign_mode === 'parallel' ? 'bebas urutan' : 'berurutan'})` : ''}</h4>
            <ol className="step-list">
              {steps.map((s) => (
                <li key={s.id} className={s.status}>
                  <span>{s.step}. {s.signer_name}{s.signer_position ? ` — ${s.signer_position}` : ''}{s.note ? <small className="muted"> · “{s.note}”</small> : null}</span>
                  <em>{stepLabel[s.status]}{s.status === 'signed' ? ` · ${fmtDT(s.signed_at)}` : ''}</em>
                </li>
              ))}
              {!steps.length && <li className="muted">Belum ada penandatangan.</li>}
            </ol>

            {doc.status === 'pending' && canManage && pendingSteps.length > 0 && (
              <div className="share-box">
                <h4>Kirim permintaan tanda tangan</h4>
                {pendingSteps.map((s) => {
                  const owner = owners.find((o) => o.id === s.owner_id);
                  const text = signRequestText({ name: s.signer_name, number: doc.document_number, title: doc.title, url });
                  return (
                    <div key={s.id} className="share-row">
                      <span>{s.signer_name}{owner?.phone ? '' : <small className="muted"> · nomor HP belum diisi</small>}</span>
                      <span className="row-actions">
                        <a className="button ghost sm" href={waLink(owner?.phone, text)} target="_blank" rel="noopener noreferrer"><MessageCircle size={13} />WhatsApp</a>
                        <a className="button ghost sm" href={mailLink('', `Permintaan tanda tangan: ${doc.document_number}`, text)}><Mail size={13} />Email</a>
                      </span>
                    </div>
                  );
                })}
                <button type="button" className="button ghost sm" onClick={() => copy('link', url)}><Copy size={13} />{copied === 'link' ? 'Tersalin' : 'Salin tautan dokumen'}</button>
                <p className="muted small">Penerima harus login, lalu tautan membuka dokumennya langsung di menu Penandatanganan.</p>
              </div>
            )}

            {canManage && doc.status === 'verified' && (
              <label className="check"><input type="checkbox" checked={pub} onChange={(e) => togglePublic(e.target.checked)} />Izinkan pratinjau & unduh publik lewat QR (halaman Verifikasi)</label>
            )}
            {canManage && (
              <div className="detail-log">
                <h4>Riwayat verifikasi{logCount !== null ? ` · ${logCount} kali` : ''}</h4>
                {logs.length ? <ul>{logs.map((l) => <li key={l.id}>{fmtDT(l.created_at)} <small className="muted">· {l.method}</small></li>)}</ul> : <p className="muted small">Belum pernah diverifikasi.</p>}
                {doc.status === 'verified' && <button type="button" className="button ghost sm" onClick={() => copy('ver', verifyLink(doc.verification_id))}><Copy size={13} />{copied === 'ver' ? 'Tersalin' : 'Salin tautan verifikasi'}</button>}
              </div>
            )}
            {msg && <p className="error">{msg}</p>}
          </div>

          <div className="detail-preview">
            {doc.file_path ? (
              <>
                <PdfViewer data={bytes} page={page} onPageChange={setPage} />
                {!bytes && !fileErr && <p className="muted">Memuat pratinjau…</p>}
                {fileErr && <p className="error">{fileErr}</p>}
                <button type="button" className="button primary" onClick={download}><Download size={15} />Unduh PDF</button>
              </>
            ) : <p className="muted">Dokumen belum memiliki file.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
