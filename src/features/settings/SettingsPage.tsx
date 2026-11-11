import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { DEFAULT_FOOTER_TEXT } from '../esign/pdfStamp';
import type { AppSettings } from '../../types';

type Props = { settings: AppSettings; user: any; isAdmin: boolean; onSaved: () => void };

const preview = (fmt: string, pad: string) => {
  const d = new Date();
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  return fmt.replace('{no}', '1'.padStart(Number(pad) || 3, '0')).replace('{bulan_romawi}', roman[d.getMonth()]).replace('{bulan}', String(d.getMonth() + 1).padStart(2, '0')).replace('{tahun}', String(d.getFullYear())).replace('{kode}', 'UMUM').replace('{jenis}', '04').replace('{singkatan}', 'SU');
};

/** Pengaturan bersama: format nomor surat, teks footer QR, dan batas pengingat dokumen tertunda. */
export default function SettingsPage({ settings, user, isAdmin, onSaved }: Props) {
  const [fmt, setFmt] = useState(settings.number_format);
  const [reset, setReset] = useState(settings.number_reset);
  const [pad, setPad] = useState(settings.number_pad);
  const [days, setDays] = useState(String(settings.reminder_days));
  const [footer, setFooter] = useState(settings.footer_text || DEFAULT_FOOTER_TEXT);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setFmt(settings.number_format); setReset(settings.number_reset); setPad(settings.number_pad); setDays(String(settings.reminder_days)); setFooter(settings.footer_text || DEFAULT_FOOTER_TEXT); }, [settings]);

  if (!user || !supabase) return <section className="panel"><h3>Pengaturan</h3><p className="muted">Login terlebih dahulu.</p></section>;
  if (!isAdmin) return <section className="panel"><h3>Pengaturan</h3><p className="muted">Hanya admin yang dapat mengubah pengaturan. Sekretaris dapat menyimpan teks footer dari menu Penandatanganan.</p></section>;
  const sb = supabase;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!fmt.includes('{no}')) { setMsg({ kind: 'error', text: 'Format nomor harus memuat {no}.' }); return; }
    const d = Math.round(Number(days));
    if (!Number.isFinite(d) || d < 1 || d > 60) { setMsg({ kind: 'error', text: 'Batas pengingat 1-60 hari.' }); return; }
    setBusy(true);
    const rows = [
      { key: 'number_format', value: fmt.trim() },
      { key: 'number_reset', value: reset },
      { key: 'number_pad', value: String(Math.min(8, Math.max(1, Number(pad) || 3))) },
      { key: 'reminder_days', value: String(d) },
      { key: 'footer_text', value: footer.trim() === DEFAULT_FOOTER_TEXT ? '' : footer.trim() },
    ].map((r) => ({ ...r, updated_by: user.id, updated_at: new Date().toISOString() }));
    const r = await sb.from('app_settings').upsert(rows);
    setBusy(false);
    if (r.error) { setMsg({ kind: 'error', text: /relation|schema cache/i.test(r.error.message) ? 'Jalankan supabase/workflow-setup.sql terlebih dahulu.' : r.error.message }); return; }
    setMsg({ kind: 'ok', text: 'Pengaturan disimpan.' });
    onSaved();
  }

  return (
    <section className="panel">
      <div className="panel-head"><div><h3>Pengaturan</h3><p>Berlaku untuk seluruh tim.</p></div></div>
      <form className="acc-form wide-form" onSubmit={save}>
        <h4>Penomoran surat otomatis</h4>
        <label>Format nomor<input value={fmt} maxLength={80} onChange={(e) => setFmt(e.target.value)} /></label>
        <p className="muted small">Token: <span className="mono">{'{no} {bulan} {bulan_romawi} {tahun} {kode} {jenis} {singkatan}'}</span>. Contoh hasil: <b className="mono">{preview(fmt, pad)}</b>. Kelompok surat dapat memakai format dan kode sendiri.</p>
        <div className="num-grid">
          <label>Urutan kembali ke 001
            <select value={reset} onChange={(e) => setReset(e.target.value as AppSettings['number_reset'])}>
              <option value="month">Setiap bulan</option>
              <option value="year">Setiap tahun</option>
              <option value="never">Tidak pernah</option>
            </select>
          </label>
          <label>Jumlah digit nomor<input type="number" min={1} max={8} value={pad} onChange={(e) => setPad(e.target.value)} /></label>
        </div>
        <h4>Pengingat</h4>
        <label>Tandai dokumen tertunda setelah (hari)<input type="number" min={1} max={60} value={days} onChange={(e) => setDays(e.target.value)} /></label>
        <h4>Teks footer QR (bersama)</h4>
        <label>Teks bawaan footer<textarea className="footer-text" rows={5} maxLength={600} value={footer} onChange={(e) => setFooter(e.target.value)} /></label>
        <p className="muted small">Placeholder: <span className="mono">{'{penandatangan} {jabatan} {waktu} {kode} {nomor}'}</span>. Dipakai semua pengguna saat menandatangani; tetap dapat disesuaikan per dokumen.</p>
        <button className="button primary" disabled={busy}><Save size={15} />{busy ? 'Menyimpan…' : 'Simpan pengaturan'}</button>
        {msg && <p className={msg.kind === 'ok' ? 'ok' : 'error'} role="status">{msg.text}</p>}
      </form>
    </section>
  );
}
