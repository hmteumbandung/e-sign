import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { KeyRound, LogOut, Mail, ShieldAlert, Trash2, UserRound } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ConfirmDialog from '../../components/ConfirmDialog';
import { ROLE_LABEL, type Profile } from '../../types';

type Props = {
  user: any;
  profile: Profile | null;
  onProfileChanged: () => void;
  onSignedOut: () => void;
};

const statusLabel: Record<string, string> = { active: 'Aktif', pending: 'Menunggu aktivasi', suspended: 'Dinonaktifkan' };
const fmt = (s?: string) => (s ? new Date(s).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long' }) : '—');

type Msg = { kind: 'ok' | 'error'; text: string } | null;
function Note({ m }: { m: Msg }) { return m ? <p className={m.kind === 'ok' ? 'ok' : 'error'} role="status">{m.text}</p> : null; }

/** Halaman "Akun Saya": ubah profil, email, password, keluar dari semua perangkat, dan hapus akun. */
export default function AccountPage({ user, profile, onProfileChanged, onSignedOut }: Props) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const recovery = params.get('pemulihan') === '1';

  const [name, setName] = useState('');
  const [nim, setNim] = useState('');
  const [profMsg, setProfMsg] = useState<Msg>(null);
  const [profBusy, setProfBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [emailMsg, setEmailMsg] = useState<Msg>(null);
  const [emailBusy, setEmailBusy] = useState(false);

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwMsg, setPwMsg] = useState<Msg>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const [sessMsg, setSessMsg] = useState<Msg>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { setName(profile?.full_name || ''); setNim(profile?.nim || ''); }, [profile?.full_name, profile?.nim]);

  if (!user || !supabase) {
    return <section className="panel"><h3>Akun saya</h3><p className="muted">Login terlebih dahulu untuk mengelola akun.</p></section>;
  }
  const sb = supabase;

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfMsg(null);
    if (name.trim().length < 2) { setProfMsg({ kind: 'error', text: 'Nama minimal 2 karakter.' }); return; }
    setProfBusy(true);
    try {
      const r = await sb.rpc('update_my_profile', { p_full_name: name.trim(), p_nim: nim.trim() || null });
      if (r.error) throw r.error;
      await sb.auth.updateUser({ data: { full_name: name.trim(), nim: nim.trim() } }); // sinkron metadata; kegagalan tidak kritis
      onProfileChanged();
      setProfMsg({ kind: 'ok', text: 'Profil diperbarui.' });
    } catch (err: any) {
      const m = String(err?.message || '');
      setProfMsg({ kind: 'error', text: /function|schema cache/i.test(m) ? 'Fitur belum aktif di database. Jalankan supabase/features-setup.sql.' : m || 'Gagal menyimpan profil.' });
    } finally { setProfBusy(false); }
  }

  async function changeEmail(e: React.FormEvent) {
    e.preventDefault();
    setEmailMsg(null);
    const v = email.trim().toLowerCase();
    if (!v || v === (user.email || '').toLowerCase()) { setEmailMsg({ kind: 'error', text: 'Masukkan alamat email baru yang berbeda.' }); return; }
    setEmailBusy(true);
    try {
      const { error } = await sb.auth.updateUser({ email: v }, { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL });
      if (error) throw error;
      setEmail('');
      setEmailMsg({ kind: 'ok', text: 'Tautan konfirmasi dikirim. Email baru berlaku setelah Anda membuka tautan tersebut (periksa juga email lama bila diminta).' });
    } catch (err: any) {
      setEmailMsg({ kind: 'error', text: err?.message || 'Gagal mengubah email.' });
    } finally { setEmailBusy(false); }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (newPw.length < 8) { setPwMsg({ kind: 'error', text: 'Password baru minimal 8 karakter.' }); return; }
    if (newPw !== newPw2) { setPwMsg({ kind: 'error', text: 'Konfirmasi password baru tidak sama.' }); return; }
    if (!recovery && !curPw) { setPwMsg({ kind: 'error', text: 'Masukkan password saat ini.' }); return; }
    if (!recovery && newPw === curPw) { setPwMsg({ kind: 'error', text: 'Password baru harus berbeda dari password saat ini.' }); return; }
    setPwBusy(true);
    try {
      if (!recovery) { // verifikasi password lama dengan masuk ulang
        const chk = await sb.auth.signInWithPassword({ email: user.email, password: curPw });
        if (chk.error) throw new Error('Password saat ini salah.');
      }
      const { error } = await sb.auth.updateUser({ password: newPw });
      if (error) throw error;
      setCurPw(''); setNewPw(''); setNewPw2('');
      setPwMsg({ kind: 'ok', text: 'Password berhasil diganti.' });
      if (recovery) navigate('/profil', { replace: true });
    } catch (err: any) {
      setPwMsg({ kind: 'error', text: err?.message || 'Gagal mengganti password.' });
    } finally { setPwBusy(false); }
  }

  async function signOutEverywhere() {
    setSessMsg(null);
    const { error } = await sb.auth.signOut({ scope: 'global' });
    if (error) { setSessMsg({ kind: 'error', text: error.message }); return; }
    onSignedOut();
  }

  async function deleteAccount({ password }: { password: string }) {
    const chk = await sb.auth.signInWithPassword({ email: user.email, password });
    if (chk.error) throw new Error('Password salah.');
    const r = await sb.rpc('delete_my_account');
    if (r.error) throw r.error;
    await sb.auth.signOut({ scope: 'local' });
    setDeleting(false);
    onSignedOut();
  }

  return (
    <div className="account-grid">
      {recovery && <div className="notice" style={{ gridColumn: '1 / -1' }}><b>Pemulihan password:</b> Anda masuk melalui tautan email. Atur password baru pada kartu “Ganti password”.</div>}

      <section className="panel">
        <div className="panel-head"><div><h3><UserRound size={17} className="ico" />Profil</h3><p>Nama dan NIM yang tampil di sistem.</p></div></div>
        <dl className="kv acc-kv">
          <dt>Role</dt><dd>{profile ? ROLE_LABEL[profile.role] : '—'}</dd>
          <dt>Status</dt><dd>{profile ? statusLabel[profile.status] : '—'}</dd>
          <dt>Terdaftar</dt><dd>{fmt(profile?.created_at)}</dd>
        </dl>
        <form className="acc-form" onSubmit={saveProfile}>
          <label>Nama lengkap<input required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
          <label>NIM<input value={nim} onChange={(e) => setNim(e.target.value)} maxLength={30} placeholder="Opsional" /></label>
          <button className="button primary" disabled={profBusy}>{profBusy ? 'Menyimpan…' : 'Simpan profil'}</button>
          <Note m={profMsg} />
        </form>
        <p className="muted small">Role dan status hanya dapat diubah oleh Super Admin.</p>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h3><Mail size={17} className="ico" />Email</h3><p>Email login saat ini: <b>{user.email}</b></p></div></div>
        <form className="acc-form" onSubmit={changeEmail}>
          <label>Email baru<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <button className="button primary" disabled={emailBusy}>{emailBusy ? 'Mengirim…' : 'Ubah email'}</button>
          <Note m={emailMsg} />
        </form>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h3><KeyRound size={17} className="ico" />Ganti password</h3><p>Gunakan minimal 8 karakter.</p></div></div>
        <form className="acc-form" onSubmit={changePassword}>
          {!recovery && <label>Password saat ini<input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" /></label>}
          <label>Password baru<input type="password" minLength={8} required value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" /></label>
          <label>Konfirmasi password baru<input type="password" required value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" /></label>
          <button className="button primary" disabled={pwBusy}>{pwBusy ? 'Menyimpan…' : 'Ganti password'}</button>
          <Note m={pwMsg} />
        </form>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h3><LogOut size={17} className="ico" />Sesi login</h3><p>Keluar dari semua perangkat bila Anda curiga akun dipakai orang lain.</p></div></div>
        <button className="button ghost" onClick={signOutEverywhere}><LogOut size={15} />Keluar dari semua perangkat</button>
        <Note m={sessMsg} />
      </section>

      <section className="panel danger-zone">
        <div className="panel-head"><div><h3><ShieldAlert size={17} className="ico" />Hapus akun</h3><p>Akun dihapus permanen dan tidak dapat dipulihkan.</p></div></div>
        <ul className="muted small acc-list">
          <li>Dokumen yang pernah Anda tandatangani tetap ada dan tetap dapat diverifikasi; nama Anda tetap tercatat pada dokumen dan riwayat aktivitas.</li>
          <li>Keterhubungan ke data pengurus dilepas (data pengurus tidak ikut terhapus).</li>
          <li>Super Admin terakhir tidak dapat menghapus akunnya; alihkan peran ke orang lain terlebih dahulu.</li>
        </ul>
        <button className="button danger" onClick={() => setDeleting(true)}><Trash2 size={15} />Hapus akun saya</button>
      </section>

      {deleting && (
        <ConfirmDialog title="Hapus akun secara permanen?" confirmLabel="Hapus akun" requireText="HAPUS" askPassword onConfirm={deleteAccount} onClose={() => setDeleting(false)}>
          <p>Akun <b>{user.email}</b> akan dihapus dan Anda langsung keluar. Tindakan ini tidak dapat dibatalkan.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
