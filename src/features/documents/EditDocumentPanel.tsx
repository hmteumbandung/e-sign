import { useState } from 'react';
import { Save, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { sha256Hex } from '../esign/pdfStamp';
import type { DocGroup } from '../../types';

type Owner = { id: string; full_name: string; position: string; user_id?: string | null };
export type EditableDoc = { id: string; document_number: string; title: string; signer_name: string | null; signer_user_id?: string | null; verification_id: string; file_path: string | null; status: string; group_id?: string | null };

export const EDITABLE_STATUSES = ['draft', 'pending', 'rejected', 'archived'];
const MAX_BYTES = 10 * 1024 * 1024;

/** Panel edit metadata dokumen yang belum ditandatangani, dengan opsi mengganti file PDF. */
export default function EditDocumentPanel({ doc, signers, groups = [], onClose, onSaved }: { doc: EditableDoc; signers: Owner[]; groups?: DocGroup[]; onClose: () => void; onSaved: () => void }) {
  const initialOwner = signers.find((s) => (doc.signer_user_id && s.user_id === doc.signer_user_id) || s.full_name === doc.signer_name);
  const [number, setNumber] = useState(doc.document_number);
  const [title, setTitle] = useState(doc.title);
  const [ownerId, setOwnerId] = useState(initialOwner?.id || '');
  const [groupId, setGroupId] = useState(doc.group_id || '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setError('');
    setBusy(true);
    let newPath: string | null = null;
    try {
      const owner = signers.find((s) => s.id === ownerId);
      const patch: Record<string, unknown> = {
        document_number: number.trim(),
        title: title.trim(),
        signer_name: owner?.full_name ?? (ownerId === '' && doc.signer_name && !initialOwner ? doc.signer_name : null),
        signer_user_id: owner?.user_id ?? null,
        ...(groups.length ? { group_id: groupId || null } : {}),
      };
      if (file) {
        if (file.size > MAX_BYTES) throw new Error('Ukuran PDF maksimal 10 MB.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('Isi file bukan PDF yang valid.');
        patch.sha256 = await sha256Hex(bytes);
        newPath = `${doc.verification_id}-${Date.now()}.pdf`;
        const up = await supabase.storage.from('documents').upload(newPath, file, { contentType: 'application/pdf', upsert: false });
        if (up.error) throw up.error;
        patch.file_path = newPath;
      }
      const r = await supabase.from('documents').update(patch).eq('id', doc.id).in('status', EDITABLE_STATUSES).select('id');
      if (r.error) throw r.error;
      if (!r.data?.length) throw new Error('Dokumen tidak dapat diubah. Mungkin sudah ditandatangani atau Anda tidak berwenang.');
      if (newPath && doc.file_path) await supabase.storage.from('documents').remove([doc.file_path]); // file lama; gagal pun tidak masalah
      onSaved();
    } catch (err: any) {
      if (newPath && supabase) await supabase.storage.from('documents').remove([newPath]);
      setError(err?.message || 'Gagal menyimpan perubahan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel edit-panel" aria-label="Edit dokumen">
      <div className="panel-head">
        <div><h3>Edit dokumen</h3><p>Hanya dokumen yang belum ditandatangani yang dapat diubah. Verification ID tetap.</p></div>
        <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={18} /></button>
      </div>
      <form className="form-grid" onSubmit={save}>
        <label>Nomor surat<input required value={number} onChange={(e) => setNumber(e.target.value)} /></label>
        <label>Perihal / nama dokumen<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Penandatangan
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">{doc.signer_name && !initialOwner ? `${doc.signer_name} (tidak ada di database)` : 'Belum ditentukan'}</option>
            {signers.map((s) => <option key={s.id} value={s.id}>{s.full_name} — {s.position}{s.user_id ? '' : ' (belum terhubung akun)'}</option>)}
          </select>
        </label>
        {groups.length > 0 && (
          <label>Kelompok surat
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">Tanpa kelompok</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
        )}
        <label>Ganti file PDF (opsional)<input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        {error && <p className="error" style={{ gridColumn: '1 / -1' }}>{error}</p>}
        <div className="form-actions">
          <button className="button primary" disabled={busy}><Save size={16} />{busy ? 'Menyimpan…' : 'Simpan perubahan'}</button>
          <button type="button" className="button ghost" onClick={onClose} disabled={busy}>Batal</button>
        </div>
      </form>
    </section>
  );
}
