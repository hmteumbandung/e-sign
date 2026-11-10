import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, FileSpreadsheet, FileText, FileUp, Pencil, Power, Search, Trash2, Upload } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ConfirmDialog from '../../components/ConfirmDialog';
import EditSignerDialog from './EditSignerDialog';
import ImportSignersDialog from './ImportSignersDialog';
import { downloadCsv, downloadXlsx, stamp } from '../../lib/exporter';
import type { Doc, Profile, Signer } from '../../types';

type Props = {
  signers: Signer[];
  docs?: Doc[];
  reload: () => void | Promise<void>;
  user: any;
  isAdmin?: boolean;
  /** true = halaman "Database Tanda Tangan" (fokus pada file tanda tangan); false = "Database Pengurus" */
  signaturesOnly?: boolean;
};

const MAX_PNG = 2 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

type Pending = { kind: 'owners' | 'signatures'; items: Signer[] } | null;
type StatusF = 'active' | 'inactive' | 'archived' | 'all';
const STATUS_LABEL: Record<string, string> = { active: 'Aktif', inactive: 'Nonaktif', archived: 'Diarsipkan' };

export default function SignersPage({ signers, docs = [], reload, user, isAdmin = false, signaturesOnly = false }: Props) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  useEffect(() => {
    if (!supabase || !isAdmin) return;
    supabase.from('profiles').select('id,full_name,email,role,status,created_at').order('full_name').then(({ data }) => setProfiles((data || []) as Profile[]));
  }, [isAdmin]);

  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState<StatusF>('active');
  const [periodF, setPeriodF] = useState('');
  const [editing, setEditing] = useState<Signer | null>(null);
  const [importing, setImporting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archPeriod, setArchPeriod] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [nim, setNim] = useState('');
  const [position, setPosition] = useState('');
  const [department, setDepartment] = useState('');
  const [period, setPeriod] = useState('Kabinet Resonansi');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending>(null);
  const [rowMsg, setRowMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<Signer | null>(null);

  const periods = useMemo(() => [...new Set(signers.map((s) => s.period || '').filter(Boolean))].sort(), [signers]);
  const statusCount = useMemo(() => {
    const c = { active: 0, inactive: 0, archived: 0, all: signers.length } as Record<string, number>;
    signers.forEach((s) => { c[s.status || 'active'] = (c[s.status || 'active'] || 0) + 1; });
    return c;
  }, [signers]);
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return signers.filter((s) => {
      if (statusF !== 'all' && (s.status || 'active') !== statusF) return false;
      if (periodF && (s.period || '') !== periodF) return false;
      return [s.full_name, s.position, s.student_id || '', s.department || '', s.period || ''].join(' ').toLowerCase().includes(needle);
    });
  }, [signers, q, statusF, periodF]);

  // buang pilihan yang barisnya sudah tidak ada
  useEffect(() => { setSelected((cur) => { const ids = new Set(signers.map((s) => s.id)); const n = new Set([...cur].filter((i) => ids.has(i))); return n.size === cur.size ? cur : n; }); }, [signers]);

  const chosen = filtered.filter((s) => selected.has(s.id));
  const allOn = filtered.length > 0 && filtered.every((s) => selected.has(s.id));
  const toggle = (id: string) => setSelected((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = (on: boolean) => setSelected((c) => { const n = new Set(c); filtered.forEach((s) => (on ? n.add(s.id) : n.delete(s.id))); return n; });

  // ---- tambah ----
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !user) { alert('Login admin diperlukan.'); return; }
    setBusy(true);
    try {
      let path: string | null = null;
      if (file) {
        const safe = `${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const up = await supabase.storage.from('signature-files').upload(safe, file, { upsert: false });
        if (up.error) throw up.error;
        path = safe;
      }
      const r = await supabase.from('signature_owners').insert({ full_name: name, student_id: nim || null, position, department: department || null, period, status: 'active', signature_path: path, phone: phone.trim() || null });
      if (r.error) { if (path) await supabase.storage.from('signature-files').remove([path]); throw r.error; }
      setName(''); setNim(''); setPosition(''); setDepartment(''); setPhone(''); setFile(null);
      await reload();
      alert('Data berhasil disimpan.');
    } catch (e: any) { alert(e.message || 'Gagal menyimpan data'); } finally { setBusy(false); }
  }

  // ---- hapus ----
  async function confirmDelete() {
    if (!supabase || !pending) return;
    const ids = pending.items.map((s) => s.id);
    if (pending.kind === 'owners') {
      const r = await supabase.from('signature_owners').delete().in('id', ids).select('id,signature_path');
      if (r.error) throw r.error;
      const gone = r.data || [];
      const paths = gone.map((x: any) => x.signature_path).filter(Boolean) as string[];
      if (paths.length) await supabase.storage.from('signature-files').remove(paths); // baris sudah terhapus; gagal hapus file tidak fatal
      if (gone.length < ids.length) throw new Error(`Hanya ${gone.length} dari ${ids.length} data yang terhapus. Anda mungkin tidak berwenang untuk sisanya.`);
    } else {
      const withFile = pending.items.filter((s) => s.signature_path);
      const r = await supabase.from('signature_owners').update({ signature_path: null }).in('id', withFile.map((s) => s.id)).select('id');
      if (r.error) throw r.error;
      const okIds = new Set((r.data || []).map((x: any) => x.id));
      const paths = withFile.filter((s) => okIds.has(s.id)).map((s) => s.signature_path!) ;
      if (paths.length) await supabase.storage.from('signature-files').remove(paths);
      if (okIds.size < withFile.length) throw new Error(`Hanya ${okIds.size} dari ${withFile.length} tanda tangan yang terhapus.`);
    }
    setSelected(new Set());
    setPending(null);
    setRowMsg({ kind: 'ok', text: pending.kind === 'owners' ? `${ids.length} data pengurus dihapus.` : 'Tanda tangan dihapus.' });
    await reload();
  }

  // ---- status: nonaktifkan / arsipkan / aktifkan ----
  async function setStatus(list: Signer[], status: 'active' | 'inactive' | 'archived') {
    if (!supabase || !list.length) return;
    setRowMsg(null);
    const r = await supabase.from('signature_owners').update({ status }).in('id', list.map((x) => x.id)).select('id');
    if (r.error) { setRowMsg({ kind: 'error', text: r.error.message }); return; }
    setRowMsg({ kind: 'ok', text: `${r.data?.length || 0} pengurus ${status === 'active' ? 'diaktifkan' : status === 'inactive' ? 'dinonaktifkan' : 'diarsipkan'}.` });
    setSelected(new Set());
    await reload();
  }
  async function archivePeriod() {
    const list = signers.filter((x) => (x.period || '') === archPeriod && (x.status || 'active') === 'active');
    if (!list.length) throw new Error('Tidak ada pengurus aktif pada periode itu.');
    await setStatus(list, 'archived');
    setArchiving(false);
  }
  const exportRows = (list: Signer[]) => [['Nama', 'NIM', 'Jabatan', 'Departemen', 'Periode', 'Status', 'Telepon', 'File tanda tangan', 'Akun login'],
    ...list.map((x) => [x.full_name, x.student_id || '', x.position, x.department || '', x.period || '', STATUS_LABEL[x.status || 'active'] || x.status || '', x.phone || '', x.signature_path ? 'Ada' : 'Belum ada', x.user_id ? 'Terhubung' : ''])];

  // ---- unggah / ganti file tanda tangan ----
  async function onPickSignature(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const owner = uploadFor.current;
    e.target.value = '';
    if (!f || !owner || !supabase) return;
    setRowMsg(null);
    try {
      if (f.size > MAX_PNG) throw new Error('Ukuran PNG maksimal 2 MB.');
      const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
      if (!PNG_MAGIC.every((b, i) => head[i] === b)) throw new Error('File harus berformat PNG yang valid.');
      const path = `${crypto.randomUUID()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const up = await supabase.storage.from('signature-files').upload(path, f, { contentType: 'image/png', upsert: false });
      if (up.error) throw up.error;
      const r = await supabase.from('signature_owners').update({ signature_path: path }).eq('id', owner.id).select('id');
      if (r.error || !r.data?.length) { await supabase.storage.from('signature-files').remove([path]); throw r.error || new Error('Tidak berwenang mengubah data ini.'); }
      if (owner.signature_path) await supabase.storage.from('signature-files').remove([owner.signature_path]);
      setRowMsg({ kind: 'ok', text: `Tanda tangan ${owner.full_name} diperbarui.` });
      await reload();
    } catch (err: any) { setRowMsg({ kind: 'error', text: err?.message || 'Gagal mengunggah tanda tangan.' }); }
  }

  const pendingDocsFor = (s: Signer) => (s.user_id ? docs.filter((d) => d.status === 'pending' && d.signer_user_id === s.user_id).length : 0);
  const items = pending?.items || [];
  const bulk = items.length > 1;
  const title = signaturesOnly ? 'Database Tanda Tangan' : 'Database Pengurus';

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div><h3>{title}</h3><p>Kelola identitas pengurus dan aset tanda tangan organisasi.</p></div>
          <div className="head-actions">
            <span className="badge">{filtered.length} data</span>
            <button type="button" className="button ghost sm" onClick={() => downloadXlsx(`pengurus-${stamp()}.xlsx`, [{ name: 'Pengurus', rows: exportRows(chosen.length ? chosen : filtered) }])}><FileSpreadsheet size={14} />Excel</button>
            <button type="button" className="button ghost sm" onClick={() => downloadCsv(`pengurus-${stamp()}.csv`, exportRows(chosen.length ? chosen : filtered))}><FileText size={14} />CSV</button>
            {user && !signaturesOnly && <button type="button" className="button ghost sm" onClick={() => setImporting(true)}><FileUp size={14} />Impor Excel</button>}
            {isAdmin && !signaturesOnly && <button type="button" className="button ghost sm" onClick={() => { setArchPeriod(periods[0] || ''); setArchiving(true); }}><Archive size={14} />Arsipkan periode</button>}
          </div>
        </div>
        <div className="gbar" role="tablist" aria-label="Status pengurus">
          {(['active', 'inactive', 'archived', 'all'] as StatusF[]).map((k) => (
            <button type="button" role="tab" aria-selected={statusF === k} key={k} className={`gtab ${statusF === k ? 'on' : ''}`} onClick={() => setStatusF(k)}>{k === 'all' ? 'Semua' : STATUS_LABEL[k]} <b>{statusCount[k] || 0}</b></button>
          ))}
        </div>
        <div className="filter-row">
          <label>Periode kabinet
            <select value={periodF} onChange={(e) => setPeriodF(e.target.value)}>
              <option value="">Semua periode</option>
              {periods.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        </div>
        <div className="searchbox"><Search size={17} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama, NIM, jabatan, atau departemen..." /></div>

        {isAdmin && chosen.length > 0 && (
          <div className="bulkbar" role="region" aria-label="Aksi massal">
            <b>{chosen.length} data dipilih</b>
            {signaturesOnly
              ? <button type="button" className="button danger sm" disabled={!chosen.some((s) => s.signature_path)} onClick={() => setPending({ kind: 'signatures', items: chosen.filter((s) => s.signature_path) })}><Trash2 size={14} />Hapus tanda tangan terpilih</button>
              : (
                <>
                  <button type="button" className="button ghost sm" onClick={() => setStatus(chosen, 'active')}><Power size={14} />Aktifkan</button>
                  <button type="button" className="button ghost sm" onClick={() => setStatus(chosen, 'inactive')}><Power size={14} />Nonaktifkan</button>
                  <button type="button" className="button ghost sm" onClick={() => setStatus(chosen, 'archived')}><Archive size={14} />Arsipkan</button>
                  <button type="button" className="button danger sm" onClick={() => setPending({ kind: 'owners', items: chosen })}><Trash2 size={14} />Hapus data terpilih</button>
                </>
              )}
            <button type="button" className="button ghost sm" onClick={() => setSelected(new Set())}>Batal pilih</button>
          </div>
        )}
        {rowMsg && <p className={rowMsg.kind === 'ok' ? 'ok' : 'error'} role="status">{rowMsg.text}</p>}

        <input ref={uploadRef} type="file" accept="image/png" hidden onChange={onPickSignature} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {isAdmin && <th className="cell-check"><input type="checkbox" aria-label="Pilih semua" checked={allOn} onChange={(e) => toggleAll(e.target.checked)} /></th>}
                <th>Nama</th><th>NIM</th><th>Jabatan</th><th>Departemen</th><th>Periode</th><th>Status</th><th>TTE</th>
                {isAdmin && <th>Akun login</th>}
                {isAdmin && <th></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  {isAdmin && <td className="cell-check"><input type="checkbox" aria-label={`Pilih ${s.full_name}`} checked={selected.has(s.id)} onChange={() => toggle(s.id)} /></td>}
                  <td><b>{s.full_name}</b></td>
                  <td>{s.student_id || '—'}</td>
                  <td>{s.position}</td>
                  <td>{s.department || '—'}</td>
                  <td>{s.period || '—'}</td>
                  <td><span className={`status ${(s.status || 'active') === 'active' ? 'good' : 'pending'}`}>{STATUS_LABEL[s.status || 'active'] || s.status}</span></td>
                  <td><span className={`status ${s.signature_path ? 'good' : 'pending'}`}>{s.signature_path ? 'Terdaftar' : 'Belum ada file'}</span></td>
                  {isAdmin && <td><AccountLink signer={s} profiles={profiles} reload={reload} /></td>}
                  {isAdmin && (
                    <td>
                      <div className="row-actions">
                        {signaturesOnly ? (
                          <>
                            <button type="button" className="button ghost sm" onClick={() => { uploadFor.current = s; uploadRef.current?.click(); }}><Upload size={13} />{s.signature_path ? 'Ganti' : 'Unggah'}</button>
                            {s.signature_path && <button type="button" className="button danger sm" onClick={() => setPending({ kind: 'signatures', items: [s] })}><Trash2 size={13} />Hapus TTE</button>}
                          </>
                        ) : (
                          <>
                            <button type="button" className="button ghost sm" onClick={() => setEditing(s)}><Pencil size={13} />Edit</button>
                            <button type="button" className="button danger sm" onClick={() => setPending({ kind: 'owners', items: [s] })}><Trash2 size={13} />Hapus</button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={isAdmin ? 10 : 7} className="empty">{signers.length ? 'Tidak ada data yang cocok.' : 'Belum ada data pengurus.'}</td></tr>}
            </tbody>
          </table>
        </div>
        {!isAdmin && <p className="muted small">Penghapusan dan penggantian file tanda tangan hanya dapat dilakukan oleh Admin.</p>}
      </section>

      {!signaturesOnly && (
        <section className="panel">
          <div className="panel-head"><div><h3>Tambah pengurus</h3><p>Form ini memerlukan akun yang telah login dan memiliki izin.</p></div></div>
          {!user ? <p className="notice">Login sebagai admin untuk menambah data.</p> : (
            <form className="form-grid" onSubmit={add}>
              <label>Nama lengkap<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama pengurus" /></label>
              <label>NIM<input value={nim} onChange={(e) => setNim(e.target.value)} placeholder="Nomor induk mahasiswa" /></label>
              <label>Jabatan<input required value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Ketua Umum" /></label>
              <label>Departemen / Bidang<input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Sekretariat / Medkominfo" /></label>
              <label>Periode kabinet<input value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
              <label>Nomor HP / WhatsApp<input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08xxxxxxxxxx" /></label>
              <label>File tanda tangan PNG<input type="file" accept="image/png" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
              <div className="form-actions"><button disabled={busy} className="button primary">{busy ? 'Menyimpan...' : 'Simpan data pengurus'}</button></div>
            </form>
          )}
        </section>
      )}

      {editing && <EditSignerDialog signer={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
      {importing && <ImportSignersDialog existing={signers} defaultPeriod={period} onClose={() => setImporting(false)} onDone={async (n) => { setImporting(false); setRowMsg({ kind: 'ok', text: `${n} pengurus diimpor.` }); await reload(); }} />}
      {archiving && (
        <ConfirmDialog title="Arsipkan satu periode kabinet?" confirmLabel="Arsipkan" danger={false} onConfirm={archivePeriod} onClose={() => setArchiving(false)}>
          <p>Semua pengurus <b>aktif</b> pada periode yang dipilih diubah menjadi <b>Diarsipkan</b>. Data tetap tersimpan, tetapi tanda tangannya tidak dapat dipakai lagi. Dokumen yang sudah ditandatangani tidak terpengaruh.</p>
          <label className="dlg-field">Periode
            <select value={archPeriod} onChange={(e) => setArchPeriod(e.target.value)}>
              {periods.map((x) => <option key={x} value={x}>{x} ({signers.filter((y) => (y.period || '') === x && (y.status || 'active') === 'active').length} aktif)</option>)}
            </select>
          </label>
        </ConfirmDialog>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'owners' ? (bulk ? `Hapus ${items.length} data pengurus?` : 'Hapus data pengurus?') : (bulk ? `Hapus ${items.length} file tanda tangan?` : 'Hapus file tanda tangan?')}
          confirmLabel={pending.kind === 'owners' ? 'Hapus data' : 'Hapus tanda tangan'}
          requireText={bulk ? 'HAPUS' : undefined}
          onConfirm={confirmDelete}
          onClose={() => setPending(null)}
        >
          {pending.kind === 'owners' ? (
            <>
              <p>{bulk ? 'Data berikut' : <b>{items[0].full_name}</b>} akan dihapus permanen beserta file tanda tangannya.</p>
              {bulk && <ul className="acc-list">{items.slice(0, 6).map((s) => <li key={s.id}>{s.full_name} — {s.position}</li>)}{items.length > 6 && <li>…dan {items.length - 6} lainnya</li>}</ul>}
              <ul className="acc-list">
                <li>Dokumen yang sudah ditandatangani <b>tidak terpengaruh</b> dan tetap dapat diverifikasi.</li>
                <li>Akun login pengurus tidak ikut terhapus; hanya keterhubungannya yang dilepas.</li>
                {items.some((s) => pendingDocsFor(s) > 0) && <li>Ada dokumen <b>menunggu tanda tangan</b> yang ditugaskan ke akun terkait; periksa penugasannya di Manajemen Dokumen.</li>}
              </ul>
            </>
          ) : (
            <p>{bulk ? `${items.length} file tanda tangan` : <>File tanda tangan <b>{items[0].full_name}</b></>} akan dihapus permanen. Data pengurusnya tetap ada dan file dapat diunggah ulang.</p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

function AccountLink({ signer, profiles, reload }: { signer: Signer; profiles: Profile[]; reload: () => void | Promise<void> }) {
  async function change(v: string) {
    if (!supabase) return;
    const r = await supabase.from('signature_owners').update({ user_id: v || null }).eq('id', signer.id);
    if (r.error) { alert(r.error.message.includes('duplicate') ? 'Akun tersebut sudah terhubung ke pengurus lain.' : r.error.message); return; }
    await reload();
  }
  return (
    <select value={signer.user_id || ''} onChange={(e) => change(e.target.value)} aria-label={`Akun login untuk ${signer.full_name}`}>
      <option value="">Tidak terhubung</option>
      {profiles.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email} ({p.role})</option>)}
    </select>
  );
}
