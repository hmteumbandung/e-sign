import { useEffect, useMemo, useState } from 'react';
import { Eye, FileSpreadsheet, FileText, Inbox, Plus, Search, Trash2, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ConfirmDialog from '../../components/ConfirmDialog';
import { downloadCsv, downloadXlsx, stamp, type Cell } from '../../lib/exporter';
import type { Signer } from '../../types';

type Letter = {
  id: string; agenda_no: string | null; letter_number: string | null; sender: string; subject: string; letter_date: string | null;
  received_date: string; priority: 'biasa' | 'segera' | 'rahasia'; status: 'baru' | 'diproses' | 'selesai'; notes: string | null; file_path: string | null; created_at: string;
};
type Disp = {
  id: string; letter_id: string; to_owner_id: string | null; to_user_id: string | null; to_name: string; instruction: string;
  due_date: string | null; status: 'belum' | 'dikerjakan' | 'selesai'; response: string | null; created_at: string;
};

type Props = { user: any; role: string | null; signers: Signer[] };

const PRIORITY: Record<string, string> = { biasa: 'Biasa', segera: 'Segera', rahasia: 'Rahasia' };
const LSTATUS: Record<string, string> = { baru: 'Baru', diproses: 'Diproses', selesai: 'Selesai' };
const DSTATUS: Record<string, string> = { belum: 'Belum', dikerjakan: 'Dikerjakan', selesai: 'Selesai' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

/** Pencatatan surat masuk dan disposisi. */
export default function IncomingPage({ user, role, signers }: Props) {
  const staff = role === 'super_admin' || role === 'admin' || role === 'secretary';
  const canSee = staff || role === 'signer';
  const [letters, setLetters] = useState<Letter[]>([]);
  const [disps, setDisps] = useState<Disp[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');
  const [priorityF, setPriorityF] = useState('');
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Letter | null>(null);

  async function load() {
    if (!supabase || !user || !canSee) return;
    setLoading(true);
    const [l, d] = await Promise.all([
      supabase.from('incoming_letters').select('*').order('received_date', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('dispositions').select('*').order('created_at'),
    ]);
    setLoading(false);
    const err = l.error || d.error;
    if (err) { setError(/relation|schema cache/i.test(err.message) ? 'Fitur surat masuk belum aktif. Jalankan supabase/workflow-setup.sql di Supabase SQL Editor.' : err.message); return; }
    setError('');
    setLetters((l.data || []) as Letter[]);
    setDisps((d.data || []) as Disp[]);
  }
  useEffect(() => { load(); }, [user?.id, role]); // eslint-disable-line react-hooks/exhaustive-deps

  const dispsOf = useMemo(() => {
    const m = new Map<string, Disp[]>();
    disps.forEach((x) => { const a = m.get(x.letter_id) || []; a.push(x); m.set(x.letter_id, a); });
    return m;
  }, [disps]);

  const visible = useMemo(() => {
    const n = q.trim().toLowerCase();
    return letters.filter((l) => (!statusF || l.status === statusF) && (!priorityF || l.priority === priorityF)
      && (!n || [l.agenda_no, l.letter_number, l.sender, l.subject].join(' ').toLowerCase().includes(n)));
  }, [letters, q, statusF, priorityF]);

  const rows = (list: Letter[]): Cell[][] => [
    ['No. agenda', 'Nomor surat', 'Pengirim', 'Perihal', 'Tanggal surat', 'Tanggal diterima', 'Sifat', 'Status', 'Disposisi (selesai/total)', 'Catatan'],
    ...list.map((l) => { const d = dispsOf.get(l.id) || []; return [l.agenda_no || '', l.letter_number || '', l.sender, l.subject, l.letter_date || '', l.received_date, PRIORITY[l.priority], LSTATUS[l.status], `${d.filter((x) => x.status === 'selesai').length}/${d.length}`, l.notes || '']; }),
  ];

  async function remove() {
    if (!supabase || !toDelete) return;
    const r = await supabase.from('incoming_letters').delete().eq('id', toDelete.id).select('id');
    if (r.error) throw r.error;
    if (!r.data?.length) throw new Error('Tidak dapat menghapus. Anda mungkin tidak berwenang.');
    if (toDelete.file_path) await supabase.storage.from('documents').remove([toDelete.file_path]);
    setToDelete(null);
    setDetailId(null);
    await load();
  }

  if (!user) return <section className="panel"><h3>Surat masuk</h3><p className="muted">Login terlebih dahulu.</p></section>;
  if (!canSee) return <section className="panel"><h3>Surat masuk</h3><p className="muted">Menu ini hanya untuk admin, sekretaris, dan penandatangan.</p></section>;

  const detail = letters.find((l) => l.id === detailId) || null;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div><h3><Inbox size={17} className="ico" />Surat masuk & disposisi</h3><p>Catat surat yang diterima, arsipkan filenya, dan teruskan sebagai disposisi.</p></div>
          <div className="head-actions">
            <span className="badge">{visible.length} surat</span>
            <button type="button" className="button ghost sm" disabled={!visible.length} onClick={() => downloadXlsx(`surat-masuk-${stamp()}.xlsx`, [{ name: 'Surat masuk', rows: rows(visible) }])}><FileSpreadsheet size={14} />Excel</button>
            <button type="button" className="button ghost sm" disabled={!visible.length} onClick={() => downloadCsv(`surat-masuk-${stamp()}.csv`, rows(visible))}><FileText size={14} />CSV</button>
            {staff && <button type="button" className="button primary sm" onClick={() => setAdding(true)}><Plus size={14} />Catat surat masuk</button>}
          </div>
        </div>
        {error && <p className="notice">{error}</p>}
        <div className="searchbox"><Search size={17} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari no. agenda, nomor surat, pengirim, atau perihal…" /></div>
        <div className="filter-row">
          <label>Status<select value={statusF} onChange={(e) => setStatusF(e.target.value)}><option value="">Semua</option>{Object.entries(LSTATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Sifat<select value={priorityF} onChange={(e) => setPriorityF(e.target.value)}><option value="">Semua</option>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>No. agenda</th><th>Pengirim</th><th>Perihal</th><th>Diterima</th><th>Sifat</th><th>Status</th><th>Disposisi</th><th></th></tr></thead>
            <tbody>
              {visible.map((l) => {
                const d = dispsOf.get(l.id) || [];
                return (
                  <tr key={l.id}>
                    <td><b>{l.agenda_no || '—'}</b>{l.letter_number && <small className="code-sm">{l.letter_number}</small>}</td>
                    <td>{l.sender}</td>
                    <td>{l.subject}</td>
                    <td>{l.received_date}</td>
                    <td><span className={`status ${l.priority === 'biasa' ? 'pending' : 'bad'}`}>{PRIORITY[l.priority]}</span></td>
                    <td><span className={`status ${l.status === 'selesai' ? 'good' : 'pending'}`}>{LSTATUS[l.status]}</span></td>
                    <td>{d.length ? `${d.filter((x) => x.status === 'selesai').length}/${d.length} selesai` : '—'}</td>
                    <td><div className="row-actions">
                      <button className="button ghost sm" onClick={() => setDetailId(l.id)}><Eye size={13} />Detail</button>
                      {staff && <button className="button danger sm" onClick={() => setToDelete(l)}><Trash2 size={13} />Hapus</button>}
                    </div></td>
                  </tr>
                );
              })}
              {!visible.length && <tr><td colSpan={8} className="empty">{loading ? 'Memuat…' : letters.length ? 'Tidak ada surat yang cocok.' : 'Belum ada surat masuk.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {adding && <AddLetter userId={user.id} nextAgenda={`${new Date().getFullYear()}/${String(letters.filter((l) => l.received_date.startsWith(String(new Date().getFullYear()))).length + 1).padStart(3, '0')}`} onClose={() => setAdding(false)} onSaved={async () => { setAdding(false); await load(); }} />}
      {detail && <LetterDetail letter={detail} disps={dispsOf.get(detail.id) || []} signers={signers} staff={staff} userId={user.id} onClose={() => setDetailId(null)} onChanged={load} />}
      {toDelete && (
        <ConfirmDialog title="Hapus surat masuk?" confirmLabel="Hapus" onConfirm={remove} onClose={() => setToDelete(null)}>
          <p><b>{toDelete.agenda_no || toDelete.letter_number || toDelete.subject}</b> beserta {(dispsOf.get(toDelete.id) || []).length} disposisi dan file lampirannya akan dihapus permanen.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function AddLetter({ userId, nextAgenda, onClose, onSaved }: { userId: string; nextAgenda: string; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [v, setV] = useState({ agenda_no: nextAgenda, letter_number: '', sender: '', subject: '', letter_date: '', received_date: today(), priority: 'biasa', notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true); setError('');
    let path: string | null = null;
    try {
      if (file) {
        if (file.size > 10 * 1024 * 1024) throw new Error('Ukuran file maksimal 10 MB.');
        const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
        if (String.fromCharCode(...head) !== '%PDF-') throw new Error('Lampiran harus berformat PDF.');
        path = `incoming/${crypto.randomUUID()}.pdf`;
        const up = await supabase.storage.from('documents').upload(path, file, { contentType: 'application/pdf', upsert: false });
        if (up.error) throw up.error;
      }
      const r = await supabase.from('incoming_letters').insert({
        agenda_no: v.agenda_no.trim() || null, letter_number: v.letter_number.trim() || null, sender: v.sender.trim(), subject: v.subject.trim(),
        letter_date: v.letter_date || null, received_date: v.received_date, priority: v.priority, notes: v.notes.trim() || null, file_path: path, created_by: userId,
      });
      if (r.error) { if (path) await supabase.storage.from('documents').remove([path]); throw r.error; }
      await onSaved();
    } catch (err: any) { setError(err?.message || 'Gagal menyimpan.'); } finally { setBusy(false); }
  }

  return (
    <div className="dlg-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="dlg wide" role="dialog" aria-modal="true" aria-labelledby="al-title" onSubmit={save}>
        <div className="dlg-head"><h3 id="al-title">Catat surat masuk</h3><button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose} disabled={busy}><X size={17} /></button></div>
        <div className="dlg-fields two">
          <label className="dlg-field">No. agenda<input value={v.agenda_no} onChange={set('agenda_no')} /></label>
          <label className="dlg-field">Nomor surat (dari pengirim)<input value={v.letter_number} onChange={set('letter_number')} /></label>
          <label className="dlg-field">Pengirim<input required value={v.sender} onChange={set('sender')} /></label>
          <label className="dlg-field">Perihal<input required value={v.subject} onChange={set('subject')} /></label>
          <label className="dlg-field">Tanggal surat<input type="date" value={v.letter_date} onChange={set('letter_date')} /></label>
          <label className="dlg-field">Tanggal diterima<input required type="date" value={v.received_date} onChange={set('received_date')} /></label>
          <label className="dlg-field">Sifat<select value={v.priority} onChange={set('priority')}>{Object.entries(PRIORITY).map(([k, x]) => <option key={k} value={k}>{x}</option>)}</select></label>
          <label className="dlg-field">Lampiran PDF (opsional)<input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
          <label className="dlg-field full">Catatan<textarea rows={2} value={v.notes} onChange={set('notes')} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="dlg-actions"><button type="button" className="button ghost" onClick={onClose} disabled={busy}>Batal</button><button className="button primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan'}</button></div>
      </form>
    </div>
  );
}

function LetterDetail({ letter, disps, signers, staff, userId, onClose, onChanged }: { letter: Letter; disps: Disp[]; signers: Signer[]; staff: boolean; userId: string; onClose: () => void; onChanged: () => void | Promise<void> }) {
  const [toId, setToId] = useState('');
  const [toName, setToName] = useState('');
  const [instr, setInstr] = useState('');
  const [due, setDue] = useState('');
  const [msg, setMsg] = useState('');
  const activeOwners = signers.filter((s) => (s.status ?? 'active') === 'active');

  async function openFile() {
    if (!supabase || !letter.file_path) return;
    const r = await supabase.storage.from('documents').createSignedUrl(letter.file_path, 120);
    if (r.error) { setMsg(r.error.message); return; }
    window.open(r.data.signedUrl, '_blank', 'noopener');
  }
  async function setLetterStatus(status: string) {
    if (!supabase) return;
    const r = await supabase.from('incoming_letters').update({ status }).eq('id', letter.id);
    if (r.error) setMsg(r.error.message); else await onChanged();
  }
  async function addDisp(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    const owner = activeOwners.find((o) => o.id === toId);
    const name = owner?.full_name || toName.trim();
    if (!name || !instr.trim()) { setMsg('Isi penerima dan instruksi disposisi.'); return; }
    const r = await supabase.from('dispositions').insert({ letter_id: letter.id, to_owner_id: owner?.id ?? null, to_user_id: owner?.user_id ?? null, to_name: name, instruction: instr.trim(), due_date: due || null, created_by: userId });
    if (r.error) { setMsg(r.error.message); return; }
    if (letter.status === 'baru') await supabase.from('incoming_letters').update({ status: 'diproses' }).eq('id', letter.id);
    setToId(''); setToName(''); setInstr(''); setDue(''); setMsg('');
    await onChanged();
  }
  async function updDisp(d: Disp, patch: Partial<Disp>) {
    if (!supabase) return;
    const r = await supabase.from('dispositions').update(patch).eq('id', d.id).select('id');
    if (r.error || !r.data?.length) { setMsg(r.error?.message || 'Tidak dapat mengubah disposisi.'); return; }
    setMsg('');
    await onChanged();
  }
  async function delDisp(d: Disp) {
    if (!supabase || !window.confirm('Hapus disposisi ini?')) return;
    const r = await supabase.from('dispositions').delete().eq('id', d.id);
    if (r.error) setMsg(r.error.message); else await onChanged();
  }

  return (
    <div className="dlg-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg wide" role="dialog" aria-modal="true" aria-labelledby="ld-title">
        <div className="dlg-head"><h3 id="ld-title">{letter.subject}</h3><button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={17} /></button></div>
        <dl className="kv">
          <dt>No. agenda</dt><dd>{letter.agenda_no || '—'}</dd>
          <dt>Nomor surat</dt><dd>{letter.letter_number || '—'}</dd>
          <dt>Pengirim</dt><dd>{letter.sender}</dd>
          <dt>Tanggal surat / diterima</dt><dd>{letter.letter_date || '—'} / {letter.received_date}</dd>
          <dt>Sifat</dt><dd>{PRIORITY[letter.priority]}</dd>
          <dt>Status</dt><dd>{staff ? <select value={letter.status} onChange={(e) => setLetterStatus(e.target.value)}>{Object.entries(LSTATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : LSTATUS[letter.status]}</dd>
          {letter.notes && <><dt>Catatan</dt><dd>{letter.notes}</dd></>}
        </dl>
        {letter.file_path && <button type="button" className="button primary" onClick={openFile}>Buka lampiran PDF</button>}

        <h4>Disposisi</h4>
        <ul className="disp-list">
          {disps.map((d) => {
            const mine = d.to_user_id === userId;
            return (
              <li key={d.id}>
                <div><b>{d.to_name}</b>{d.due_date ? <small className="muted"> · batas {d.due_date}</small> : null}<p>{d.instruction}</p></div>
                <div className="disp-ctl">
                  {(staff || mine) ? (
                    <>
                      <select value={d.status} aria-label="Status disposisi" onChange={(e) => updDisp(d, { status: e.target.value as Disp['status'] })}>{Object.entries(DSTATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                      <input defaultValue={d.response || ''} placeholder="Tanggapan…" aria-label="Tanggapan" onBlur={(e) => { if (e.target.value !== (d.response || '')) updDisp(d, { response: e.target.value || null }); }} />
                    </>
                  ) : <span className={`status ${d.status === 'selesai' ? 'good' : 'pending'}`}>{DSTATUS[d.status]}{d.response ? ` · ${d.response}` : ''}</span>}
                  {staff && <button type="button" className="icon-btn" aria-label="Hapus disposisi" onClick={() => delDisp(d)}><Trash2 size={14} /></button>}
                </div>
              </li>
            );
          })}
          {!disps.length && <li className="muted">Belum ada disposisi.</li>}
        </ul>
        {staff && (
          <form className="disp-add" onSubmit={addDisp}>
            <select value={toId} onChange={(e) => setToId(e.target.value)} aria-label="Penerima disposisi"><option value="">Penerima: pilih pengurus…</option>{activeOwners.map((o) => <option key={o.id} value={o.id}>{o.full_name} — {o.position}</option>)}</select>
            {!toId && <input value={toName} onChange={(e) => setToName(e.target.value)} placeholder="atau ketik nama/bidang penerima" />}
            <input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Instruksi disposisi" />
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Batas waktu" />
            <button className="button primary sm"><Plus size={13} />Tambah disposisi</button>
          </form>
        )}
        {msg && <p className="error">{msg}</p>}
      </div>
    </div>
  );
}
