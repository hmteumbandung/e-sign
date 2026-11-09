import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

type Props = {
  title: string;
  /** Isi peringatan; boleh berupa JSX. */
  children: React.ReactNode;
  confirmLabel?: string;
  /** Bila diisi, pengguna harus mengetik kata ini persis sebelum tombol aktif. */
  requireText?: string;
  /** Bila true, tampil kolom alasan yang wajib diisi. */
  askReason?: boolean;
  reasonLabel?: string;
  /** Bila true, tampil kolom password untuk konfirmasi ulang. */
  askPassword?: boolean;
  danger?: boolean;
  onConfirm: (input: { reason: string; password: string }) => Promise<void> | void;
  onClose: () => void;
};

/** Dialog konfirmasi untuk tindakan yang tidak dapat dibatalkan. */
export default function ConfirmDialog({ title, children, confirmLabel = 'Hapus', requireText, askReason, reasonLabel = 'Alasan', askPassword, danger = true, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const ok = (!requireText || typed.trim() === requireText) && (!askReason || reason.trim().length >= 3) && (!askPassword || password.length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm({ reason: reason.trim(), password });
    } catch (err: any) {
      setError(err?.message || 'Tindakan gagal.');
      setBusy(false);
    }
  }

  return (
    <div className="dlg-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" onSubmit={submit}>
        <div className="dlg-head">
          <span className={`dlg-icon ${danger ? 'bad' : ''}`}><AlertTriangle size={20} /></span>
          <h3 id="dlg-title">{title}</h3>
          <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose} disabled={busy}><X size={17} /></button>
        </div>
        <div className="dlg-body">{children}</div>
        {askReason && (
          <label className="dlg-field">{reasonLabel}
            <textarea ref={first as any} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Minimal 3 karakter" />
          </label>
        )}
        {askPassword && (
          <label className="dlg-field">Password Anda
            <input ref={first} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {requireText && (
          <label className="dlg-field">Ketik <b className="mono">{requireText}</b> untuk melanjutkan
            <input ref={!askReason && !askPassword ? first : undefined} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="dlg-actions">
          <button type="button" className="button ghost" onClick={onClose} disabled={busy}>Batal</button>
          <button className={`button ${danger ? 'danger-solid' : 'primary'}`} disabled={!ok || busy}>{busy ? 'Memproses…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
