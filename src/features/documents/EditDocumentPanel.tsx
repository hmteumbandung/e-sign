import { useMemo, useState } from 'react';
import { RefreshCcw, Save, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { sha256Hex } from '../esign/pdfStamp';
import SignerListEditor, { type SignMode } from './SignerListEditor';
import type { DocGroup, DocSigner, Signer } from '../../types';

export type EditableDoc = {
  id: string; document_number: string; title: string; signer_name: string | null; signer_user_id?: string | null;
  verification_id: string; file_path: string | null; original_file_path?: string | null; status: string; group_id?: string | null;
  sign_mode?: SignMode; reject_reason?: string | null; revision?: number;
};

export const EDITABLE_STATUSES = ['draft', 'pending', 'rejected', 'archived'];
const MAX_BYTES = 10 * 1024 * 1024;

type Props = {
  doc: EditableDoc;
  steps: DocSigner[];
  signers: Signer[];
  groups?: DocGroup[];
  onClose: () => void;
  onSaved: () => void;
};

/** Panel edit dokumen yang belum selesai ditandatangani: metadata, kelompok, penandatangan (banyak), file revisi, dan ajukan ulang. */
export default function EditDocumentPanel({ doc, steps, signers, groups = [], onClose, onSaved }: Props) {
  const activeOwners = useMemo(() => signers.filter((s) => (s.status ?? 'active') === 'active'), [signers]);
  const initialIds = useMemo(() => (steps.length ? [...steps].sort((a, b) => a.step - b.step).map((s) => s.owner_id || '') : ['']), [steps]);
  const [number, setNumber] = useState(doc.document_number);
  const [title, setTitle] = useState(doc.title);
  const [ownerIds, setOwnerIds] = useState<string[]>(initialIds);
  const [mode, setMode] = useState<SignMode>(doc.sign_mode || 'sequential');
  const [groupId, setGroupId] = useState(doc.group_id || '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const anySigned = steps.some((s) => s.status === 'signed');
  const lockSigners = doc.status === 'pending' && anySigned; // tolak dulu bila ingin mengubah
  const lockFile = doc.status === 'pending' && anySigned;
  const rejected = doc.status === 'rejected';
  const signersChanged = ownerIds.join('|') !== initialIds.join('|') || mode !== (doc.sign_mode || 'sequential');

  async function save(resubmit: boolean) {
    if (!supabase) return;
    setError('');
    setBusy(true);
    let newPath: string | null = null;
    try {
      const chosen = ownerIds.filter(Boolean);
      if (!lockSigners && signersChanged && chosen.length !== ownerIds.length) throw new Error('Lengkapi semua baris penandatangan atau hapus baris yang kosong.');
      if (resubmit && !chosen.length && !steps.length) throw new Error('Tentukan penandatangan terlebih dahulu.');

      const patch: Record<string, unknown> = { document_number: number.trim(), title: title.trim(), ...(groups.length ? { group_id: groupId || null } : {}) };
      if (file) {
        if (file.size > MAX_BYTES) throw new Error('Ukuran PDF maksimal 10 MB.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('Isi file bukan PDF yang valid.');
        patch.sha256 = await sha256Hex(bytes);
        patch.original_file_path = null; // revisi baru: buang jejak versi lama yang sudah dibubuhi tanda tangan
        patch.original_sha256 = null;
        newPath = `${doc.verification_id}-${Date.now()}.pdf`;
        const up = await supabase.storage.from('documents').upload(newPath, file, { contentType: 'application/pdf', upsert: false });
        if (up.error) throw up.error;
        patch.file_path = newPath;
      }
      const r = await supabase.from('documents').update(patch).eq('id', doc.id).in('status', EDITABLE_STATUSES).select('id');
      if (r.error) throw r.error;
      if (!r.data?.length) throw new Error('Dokumen tidak dapat diubah. Mungkin sudah ditandatangani atau Anda tidak berwenang.');
      if (newPath && doc.file_path && !doc.original_file_path) await supabase.storage.from('documents').remove([doc.file_path]); // file lama; gagal pun tidak masalah

      if (!lockSigners && signersChanged) {
        const s = await supabase.rpc('set_document_signers', { p_doc: doc.id, p_signers: chosen.map((id) => ({ owner_id: id })), p_mode: mode });
        if (s.error) throw s.error;
      }
      if (resubmit) {
        const s = await supabase.rpc('resubmit_document', { p_doc: doc.id });
        if (s.error) throw s.error;
      }
      onSaved();
    } catch (err: any) {
      if (newPath && supabase) await supabase.storage.from('documents').remove([newPath]);
      const m = String(err?.message || 'Gagal menyimpan perubahan.');
      setError(/function|schema cache|relation/i.test(m) ? 'Fitur belum aktif di database. Jalankan supabase/workflow-setup.sql.' : m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel edit-panel" aria-label="Edit dokumen">
      <div className="panel-head">
        <div><h3>{rejected ? 'Revisi dokumen yang ditolak' : 'Edit dokumen'}</h3><p>Hanya dokumen yang belum selesai ditandatangani yang dapat diubah. Verification ID tetap.</p></div>
        <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={18} /></button>
      </div>
      {rejected && (
        <div className="notice reject-note">
          <b>Catatan penolakan{(doc.revision || 1) > 1 ? ` (revisi ${doc.revision})` : ''}:</b> {doc.reject_reason || '—'}
          <br /><small>Perbaiki dokumen lalu unggah file revisi (opsional), kemudian klik “Simpan & ajukan ulang”. Tanpa file baru, dokumen diajukan ulang dengan PDF aslinya.</small>
        </div>
      )}
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save(false); }}>
        <label>Nomor surat<input required value={number} onChange={(e) => setNumber(e.target.value)} /></label>
        <label>Perihal / nama dokumen<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {groups.length > 0 && (
          <label>Kelompok surat
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Tanpa kelompok</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
        <label>Ganti / revisi file PDF (opsional)<input type="file" disabled={lockFile} accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        <div className="full">
          <span className="lbl">Penandatangan</span>
          <SignerListEditor owners={activeOwners} value={ownerIds} mode={mode} disabled={lockSigners} onChange={(v, m) => { setOwnerIds(v); setMode(m); }} />
          {lockSigners && <p className="muted small">Sudah ada penandatangan yang menandatangani, sehingga daftar penandatangan dan file dikunci. Tolak dokumen terlebih dahulu bila perlu mengubahnya.</p>}
        </div>
        {error && <p className="error" style={{ gridColumn: '1 / -1' }}>{error}</p>}
        <div className="form-actions">
          <button className="button primary" disabled={busy}><Save size={16} />{busy ? 'Menyimpan…' : 'Simpan perubahan'}</button>
          {(rejected || doc.status === 'draft' || doc.status === 'archived') && (
            <button type="button" className="button dark" disabled={busy} onClick={() => save(true)}><RefreshCcw size={16} />Simpan & ajukan ulang</button>
          )}
          <button type="button" className="button ghost" onClick={onClose} disabled={busy}>Batal</button>
        </div>
      </form>
    </section>
  );
}
