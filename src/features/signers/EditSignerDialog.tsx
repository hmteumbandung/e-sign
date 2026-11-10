import { useState } from 'react';
import { Save, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { Signer } from '../../types';

type Props = { signer: Signer; onClose: () => void; onSaved: () => void | Promise<void> };

/** Edit data pengurus (nama, NIM, jabatan, departemen, periode, telepon, status). */
export default function EditSignerDialog({ signer, onClose, onSaved }: Props) {
  const [v, setV] = useState({
    full_name: signer.full_name,
    student_id: signer.student_id || '',
    position: signer.position,
    department: signer.department || '',
    period: signer.period || '',
    phone: signer.phone || '',
    status: signer.status || 'active',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((x) => ({ ...x, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError('');
    const r = await supabase.from('signature_owners').update({
      full_name: v.full_name.trim(), student_id: v.student_id.trim() || null, position: v.position.trim(),
      department: v.department.trim() || null, period: v.period.trim() || null, phone: v.phone.trim() || null, status: v.status,
    }).eq('id', signer.id).select('id');
    setBusy(false);
    if (r.error) { setError(/phone|schema cache/i.test(r.error.message) ? 'Kolom nomor HP belum ada. Jalankan supabase/workflow-setup.sql.' : r.error.message); return; }
    if (!r.data?.length) { setError('Data tidak dapat diubah. Anda mungkin tidak berwenang.'); return; }
    await onSaved();
  }

  return (
    <div className="dlg-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="dlg" role="dialog" aria-modal="true" aria-labelledby="es-title" onSubmit={save}>
        <div className="dlg-head">
          <h3 id="es-title">Edit pengurus</h3>
          <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose} disabled={busy}><X size={17} /></button>
        </div>
        <div className="dlg-fields">
          <label className="dlg-field">Nama lengkap<input required value={v.full_name} onChange={set('full_name')} maxLength={80} /></label>
          <label className="dlg-field">NIM<input value={v.student_id} onChange={set('student_id')} maxLength={30} /></label>
          <label className="dlg-field">Jabatan<input required value={v.position} onChange={set('position')} maxLength={80} /></label>
          <label className="dlg-field">Departemen / Bidang<input value={v.department} onChange={set('department')} maxLength={80} /></label>
          <label className="dlg-field">Periode kabinet<input value={v.period} onChange={set('period')} maxLength={80} /></label>
          <label className="dlg-field">Nomor HP / WhatsApp<input inputMode="tel" value={v.phone} onChange={set('phone')} placeholder="08xxxxxxxxxx" maxLength={20} /></label>
          <label className="dlg-field">Status
            <select value={v.status} onChange={set('status')}>
              <option value="active">Aktif</option>
              <option value="inactive">Nonaktif (tanda tangan tidak dapat dipakai)</option>
              <option value="archived">Diarsipkan (periode lama)</option>
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="dlg-actions">
          <button type="button" className="button ghost" onClick={onClose} disabled={busy}>Batal</button>
          <button className="button primary" disabled={busy}><Save size={15} />{busy ? 'Menyimpan…' : 'Simpan'}</button>
        </div>
      </form>
    </div>
  );
}
