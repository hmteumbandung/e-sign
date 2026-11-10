import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type { Signer } from '../../types';

export type SignMode = 'sequential' | 'parallel';
type Props = {
  /** pengurus yang boleh dipilih (hanya yang aktif) */
  owners: Signer[];
  value: string[];
  mode: SignMode;
  onChange: (value: string[], mode: SignMode) => void;
  disabled?: boolean;
};

/** Daftar penandatangan 1-8 orang, berurutan atau bebas urutan. */
export default function SignerListEditor({ owners, value, mode, onChange, disabled }: Props) {
  const set = (v: string[]) => onChange(v, mode);
  const move = (i: number, d: -1 | 1) => { const v = [...value]; [v[i], v[i + d]] = [v[i + d], v[i]]; set(v); };
  const byId = new Map(owners.map((o) => [o.id, o]));

  return (
    <div className="signer-editor">
      <ol>
        {value.map((id, i) => {
          const o = byId.get(id);
          return (
            <li key={i}>
              <span className="stepno">{i + 1}</span>
              <select value={id} disabled={disabled} aria-label={`Penandatangan ${i + 1}`} onChange={(e) => { const v = [...value]; v[i] = e.target.value; set(v); }}>
                <option value="">Pilih pengurus…</option>
                {owners.filter((x) => x.id === id || !value.includes(x.id)).map((x) => <option key={x.id} value={x.id}>{x.full_name} — {x.position}</option>)}
              </select>
              <span className="row-actions">
                <button type="button" className="icon-btn" aria-label="Naikkan" disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                <button type="button" className="icon-btn" aria-label="Turunkan" disabled={disabled || i === value.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                <button type="button" className="icon-btn" aria-label="Hapus penandatangan" disabled={disabled || value.length === 1} onClick={() => set(value.filter((_, k) => k !== i))}><X size={14} /></button>
              </span>
              {o && !o.user_id && <small className="muted">Belum terhubung akun login: hanya admin yang dapat menandatangani untuknya.</small>}
            </li>
          );
        })}
      </ol>
      <div className="btn-row">
        <button type="button" className="button ghost sm" disabled={disabled || value.length >= 8} onClick={() => set([...value, ''])}><Plus size={13} />Tambah penandatangan</button>
        {value.length > 1 && (
          <span className="seg" role="group" aria-label="Urutan penandatanganan">
            <button type="button" className={mode === 'sequential' ? 'on' : ''} disabled={disabled} onClick={() => onChange(value, 'sequential')}>Berurutan</button>
            <button type="button" className={mode === 'parallel' ? 'on' : ''} disabled={disabled} onClick={() => onChange(value, 'parallel')}>Bebas urutan</button>
          </span>
        )}
      </div>
      {value.length > 1 && <p className="muted small">{mode === 'sequential' ? 'Penandatangan berikutnya baru dapat menandatangani setelah yang sebelumnya selesai.' : 'Semua penandatangan dapat menandatangani kapan saja.'} Footer QR memuat semua nama dan dipasang oleh penandatangan terakhir.</p>}
    </div>
  );
}
