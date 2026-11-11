import { useState } from 'react';
import { Check, FolderPlus, Pencil, Trash2, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ConfirmDialog from '../../components/ConfirmDialog';
import { isInstansi } from '../../lib/instansi';
import type { Doc, DocGroup } from '../../types';

export const GROUP_COLORS = ['#2563EB', '#16A34A', '#DC2626', '#F59E0B', '#7C3AED', '#0891B2', '#DB2777', '#64748B'];

type NumFields = { code: string; fmt: string; reset: string };
function NumberingFields({ v, onChange }: { v: NumFields; onChange: (n: NumFields) => void }) {
  return (
    <details className="num-fields">
      <summary>Penomoran otomatis untuk kelompok ini (opsional)</summary>
      <div className="num-grid">
        <label>Kode kelompok<input maxLength={12} value={v.code} onChange={(e) => onChange({ ...v, code: e.target.value.toUpperCase() })} placeholder="UND" /></label>
        <label>Format nomor<input maxLength={80} value={v.fmt} onChange={(e) => onChange({ ...v, fmt: e.target.value })} placeholder="Kosong = format bawaan" /></label>
        <label>Urutan kembali ke 001
          <select value={v.reset} onChange={(e) => onChange({ ...v, reset: e.target.value })}>
            <option value="">Ikuti pengaturan umum</option>
            <option value="month">Setiap bulan</option>
            <option value="year">Setiap tahun</option>
            <option value="never">Tidak pernah</option>
          </select>
        </label>
      </div>
      <p className="muted small">Token: <span className="mono">{'{no} {bulan} {bulan_romawi} {tahun} {kode}'}</span>. Contoh: <span className="mono">{'{no}/{kode}/HMTE/{bulan_romawi}/{tahun}'}</span>. Urutan dihitung terpisah untuk tiap kelompok.</p>
    </details>
  );
}

type Props = { groups: DocGroup[]; docs: Doc[]; userId: string; onChanged: () => void; onClose: () => void };

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <span className="gcolors" role="radiogroup" aria-label="Warna kelompok">
      {GROUP_COLORS.map((c) => (
        <button type="button" key={c} role="radio" aria-checked={value === c} aria-label={c} className={`swatch ${value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </span>
  );
}

/** Panel kelola kelompok surat: tambah, ubah nama/warna, hapus. Menghapus kelompok tidak menghapus surat. */
export default function GroupManager({ groups, docs, userId, onChanged, onClose }: Props) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(GROUP_COLORS[0]);
  const [desc, setDesc] = useState('');
  const [num, setNum] = useState<NumFields>({ code: '', fmt: '', reset: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState('');
  const [eColor, setEColor] = useState(GROUP_COLORS[0]);
  const [eDesc, setEDesc] = useState('');
  const [eNum, setENum] = useState<NumFields>({ code: '', fmt: '', reset: '' });
  const [toDelete, setToDelete] = useState<DocGroup | null>(null);

  const editBuiltin = Boolean(editId && groups.find((g) => g.id === editId && isInstansi(g)));
  const count = (id: string) => docs.filter((d) => d.group_id === id).length;
  const friendly = (m: string) => (/duplicate|unique/i.test(m) ? 'Nama kelompok sudah dipakai.' : /relation|schema cache/i.test(m) ? 'Fitur belum aktif di database. Jalankan supabase/features-setup.sql.' : m);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !name.trim()) return;
    setBusy(true); setError('');
    const r = await supabase.from('document_groups').insert({ name: name.trim(), color, description: desc.trim() || null, created_by: userId, code: num.code.trim() || null, number_format: num.fmt.trim() || null, reset_period: num.reset || null });
    setBusy(false);
    if (r.error) { setError(friendly(r.error.message)); return; }
    setName(''); setDesc(''); setNum({ code: '', fmt: '', reset: '' });
    onChanged();
  }

  function startEdit(g: DocGroup) { setEditId(g.id); setEName(g.name); setEColor(g.color); setEDesc(g.description || ''); setENum({ code: g.code || '', fmt: g.number_format || '', reset: g.reset_period || '' }); setError(''); }

  async function saveEdit() {
    if (!supabase || !editId || !eName.trim()) return;
    setBusy(true); setError('');
    const r = await supabase.from('document_groups').update({ name: eName.trim(), color: eColor, description: eDesc.trim() || null, code: eNum.code.trim() || null, number_format: eNum.fmt.trim() || null, reset_period: eNum.reset || null }).eq('id', editId);
    setBusy(false);
    if (r.error) { setError(friendly(r.error.message)); return; }
    setEditId(null);
    onChanged();
  }

  async function remove() {
    if (!supabase || !toDelete) return;
    const r = await supabase.from('document_groups').delete().eq('id', toDelete.id).select('id');
    if (r.error) throw new Error(friendly(r.error.message));
    if (!r.data?.length) throw new Error('Kelompok tidak dapat dihapus. Anda mungkin tidak berwenang.');
    setToDelete(null);
    onChanged();
  }

  return (
    <section className="panel group-panel" aria-label="Kelola kelompok surat">
      <div className="panel-head">
        <div><h3>Instansi &amp; kelompok surat</h3><p>Enam instansi/lembaga bersifat bawaan (warna dan kode dapat diubah). Anda juga dapat menambah kelompok lain. Menghapus kelompok tidak menghapus surat di dalamnya.</p></div>
        <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={18} /></button>
      </div>

      <form className="group-add" onSubmit={add}>
        <label>Nama kelompok<input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Surat Keluar" /></label>
        <label>Keterangan (opsional)<input maxLength={160} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <div className="group-add-row" style={{ gridColumn: '1 / -1' }}><NumberingFields v={num} onChange={setNum} /></div>
        <div className="group-add-row"><ColorPicker value={color} onChange={setColor} /><button className="button primary sm" disabled={busy || !name.trim()}><FolderPlus size={14} />Tambah kelompok</button></div>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="group-list">
        {groups.map((g) => (
          <li key={g.id}>
            {editId === g.id ? (
              <div className="group-edit">
                <input value={eName} maxLength={60} disabled={editBuiltin} title={editBuiltin ? 'Nama instansi bawaan tidak dapat diubah' : undefined} onChange={(e) => setEName(e.target.value)} aria-label="Nama kelompok" />
                <input value={eDesc} maxLength={160} onChange={(e) => setEDesc(e.target.value)} placeholder="Keterangan" aria-label="Keterangan" />
                <ColorPicker value={eColor} onChange={setEColor} />
                <div style={{ gridColumn: '1 / -1' }}><NumberingFields v={eNum} onChange={setENum} /></div>
                <span className="row-actions">
                  <button type="button" className="button primary sm" disabled={busy || !eName.trim()} onClick={saveEdit}><Check size={14} />Simpan</button>
                  <button type="button" className="button ghost sm" onClick={() => setEditId(null)}>Batal</button>
                </span>
              </div>
            ) : (
              <>
                <span className="gchip" style={{ ['--gc' as any]: g.color }}><i />{g.name}</span>
                <small className="muted">{count(g.id)} surat{g.code ? ` · kode ${g.code}` : ''}{g.description ? ` · ${g.description}` : ''}</small>
                <span className="row-actions">
                  <button type="button" className="button ghost sm" onClick={() => startEdit(g)}><Pencil size={13} />Ubah</button>
                  {isInstansi(g) ? <span className="muted small" title="Instansi bawaan tidak dapat dihapus">Instansi bawaan</span> : <button type="button" className="button danger sm" onClick={() => setToDelete(g)}><Trash2 size={13} />Hapus</button>}
                </span>
              </>
            )}
          </li>
        ))}
        {!groups.length && <li className="muted">Belum ada kelompok.</li>}
      </ul>

      {toDelete && (
        <ConfirmDialog title="Hapus kelompok?" confirmLabel="Hapus kelompok" onConfirm={remove} onClose={() => setToDelete(null)}>
          <p>Kelompok <b>{toDelete.name}</b> akan dihapus. {count(toDelete.id)} surat di dalamnya <b>tidak ikut dihapus</b>, hanya menjadi “tanpa kelompok”.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
