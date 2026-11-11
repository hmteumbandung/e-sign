import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Building2, Eye, FileSpreadsheet, FileText, FolderCog, FolderInput, List, Search, Trash2, UploadCloud } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ConfirmDialog from '../../components/ConfirmDialog';
import DocTable, { GroupChip, hashFile, statusLabel } from './DocTable';
import EditDocumentPanel, { EDITABLE_STATUSES } from './EditDocumentPanel';
import DocumentDetail from './DocumentDetail';
import GroupManager from './GroupManager';
import SignerListEditor, { type SignMode } from './SignerListEditor';
import { INSTANSI, JENIS_SURAT, jenisLabel, jenisOf, missingInstansi } from '../../lib/instansi';
import { downloadCsv, downloadXlsx, downloadZip, stamp, type Cell } from '../../lib/exporter';
import type { AppSettings, Doc, DocGroup, DocSigner, Signer } from '../../types';

type Props = {
  docs: Doc[];
  steps: DocSigner[];
  signers: Signer[];
  groups: DocGroup[];
  /** false bila tabel document_groups belum ada di database */
  groupsReady: boolean;
  settings: AppSettings;
  reload: () => void | Promise<void>;
  /** akun yang boleh mengelola dokumen (admin / sekretaris aktif); null bila tidak */
  user: any;
  isAdmin?: boolean;
};

type Filter = 'all' | 'none' | string;
const dayMs = 86400000;
const docDate = (d: Doc) => d.issued_at || (d.created_at || '').slice(0, 10);
const fmtDT = (s?: string | null) => (s ? new Date(s).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) : '');

export default function DocumentsPage({ docs, steps, signers, groups, groupsReady, settings, reload, user, isAdmin = false }: Props) {
  const [number, setNumber] = useState('');
  const [numTouched, setNumTouched] = useState(false);
  const autoNum = useRef('');
  const [title, setTitle] = useState('');
  const [ownerIds, setOwnerIds] = useState<string[]>(['']);
  const [mode, setMode] = useState<SignMode>('sequential');
  const [upGroup, setUpGroup] = useState('');
  const [upType, setUpType] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [upMsg, setUpMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [detail, setDetail] = useState<Doc | null>(null);

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');
  const [signerF, setSignerF] = useState('');
  const [typeF, setTypeF] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [manageGroups, setManageGroups] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkGroup, setBulkGroup] = useState('');
  const [bulkMsg, setBulkMsg] = useState('');
  const [zipBusy, setZipBusy] = useState('');
  const [purging, setPurging] = useState<Doc | null>(null);
  const [view, setView] = useState<'grouped' | 'list'>('grouped');
  const [bulkType, setBulkType] = useState('');
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedMsg, setSeedMsg] = useState('');

  const canManage = Boolean(user);
  const owners = signers;
  const activeOwners = useMemo(() => signers.filter((s) => (s.status ?? 'active') === 'active'), [signers]);

  const stepsOf = useMemo(() => {
    const m = new Map<string, DocSigner[]>();
    for (const s of steps) { const l = m.get(s.document_id) || []; l.push(s); m.set(s.document_id, l); }
    m.forEach((l) => l.sort((a, b) => a.step - b.step));
    return m;
  }, [steps]);
  const signerNames = useMemo(() => [...new Set(steps.map((s) => s.signer_name))].sort(), [steps]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    let none = 0;
    for (const d of docs) { if (d.group_id && groups.some((g) => g.id === d.group_id)) m.set(d.group_id, (m.get(d.group_id) || 0) + 1); else none++; }
    return { m, none };
  }, [docs, groups]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs.filter((d) => {
      if (filter === 'none' && d.group_id && groups.some((g) => g.id === d.group_id)) return false;
      if (filter !== 'all' && filter !== 'none' && d.group_id !== filter) return false;
      if (statusF && d.status !== statusF) return false;
      if (typeF && d.letter_type !== typeF) return false;
      if (signerF && !(stepsOf.get(d.id) || []).some((s) => s.signer_name === signerF) && d.signer_name !== signerF) return false;
      const dd = docDate(d);
      if (from && dd < from) return false;
      if (to && dd > to) return false;
      if (!needle) return true;
      const sg = (stepsOf.get(d.id) || []).map((s) => s.signer_name).join(' ');
      return [d.document_number, d.title, d.signer_name || '', sg, d.short_code || '', statusLabel[d.status] || d.status, jenisLabel(d.letter_type)].join(' ').toLowerCase().includes(needle);
    });
  }, [docs, groups, filter, q, statusF, typeF, signerF, from, to, stepsOf]);

  const selectedVisible = visible.filter((d) => selected.has(d.id));
  const filtersOn = Boolean(q || statusF || typeF || signerF || from || to || filter !== 'all');

  // Nomor surat otomatis (dapat diubah manual); mengikuti kelompok yang dipilih
  useEffect(() => {
    if (!supabase || !canManage || numTouched) return;
    let off = false;
    supabase.rpc('preview_document_number', { p_group: upGroup || null, p_type: upType || null }).then(({ data, error }) => {
      if (off || error || !data) return;
      autoNum.current = data as string;
      setNumber(data as string);
    });
    return () => { off = true; };
  }, [upGroup, upType, canManage, numTouched, docs.length]);

  const missing = useMemo(() => missingInstansi(groups), [groups]);

  /** Buat instansi bawaan yang belum ada (tanpa perlu membuka SQL Editor). */
  async function seedInstansi() {
    if (!supabase || !user || !missing.length) return;
    setSeedBusy(true); setSeedMsg('');
    const r = await supabase.from('document_groups').insert(missing.map((i) => ({ name: i.name, color: i.color, code: i.code, description: `Surat ${i.name}`, created_by: user.id }))).select('id');
    setSeedBusy(false);
    if (r.error) { setSeedMsg(/duplicate|unique/i.test(r.error.message) ? 'Sebagian instansi sudah ada. Muat ulang halaman.' : r.error.message); return; }
    await reload();
  }

  // ---- aksi ----
  async function removeUnsigned(d: Doc) {
    if (!supabase) return;
    if (!window.confirm(`Hapus dokumen "${d.title}" (${d.document_number})?\nFile PDF-nya juga akan dihapus. Tindakan ini tidak dapat dibatalkan.`)) return;
    const r = await supabase.from('documents').delete().eq('id', d.id).in('status', EDITABLE_STATUSES).select('id');
    if (r.error) { alert(r.error.message); return; }
    if (!r.data?.length) { alert('Dokumen tidak dapat dihapus. Dokumen yang sudah ditandatangani dihapus oleh admin lewat "Hapus permanen".'); return; }
    const paths = [d.file_path, d.original_file_path, ...(stepsOf.get(d.id) || []).map((s) => (s as any).file_path)].filter(Boolean) as string[];
    if (paths.length) await supabase.storage.from('documents').remove([...new Set(paths)]);
    if (editing?.id === d.id) setEditing(null);
    await reload();
  }

  /** Hapus permanen dokumen terverifikasi/dicabut (khusus admin). Alasan tercatat di Riwayat Aktivitas. */
  async function purge({ reason }: { reason: string }) {
    if (!supabase || !purging) return;
    const r = await supabase.rpc('delete_document', { p_id: purging.id, p_reason: reason });
    if (r.error) {
      const m = r.error.message || '';
      throw new Error(/function|schema cache/i.test(m) ? 'Fitur belum aktif di database. Jalankan supabase/esign-setup.sql, features-setup.sql, lalu workflow-setup.sql.' : m);
    }
    const d: any = r.data || {};
    const paths = [d.file_path, d.original_file_path, ...(d.extra_paths || [])].filter(Boolean) as string[];
    if (paths.length) await supabase.storage.from('documents').remove([...new Set(paths)]); // gagal pun tidak masalah: barisnya sudah terhapus
    setSelected((s) => { const n = new Set(s); n.delete(purging.id); return n; });
    setPurging(null);
    await reload();
  }

  async function openFile(d: Doc) {
    if (!supabase || !d.file_path) return;
    const r = await supabase.storage.from('documents').createSignedUrl(d.file_path, 120);
    if (r.error) { alert(r.error.message); return; }
    window.open(r.data.signedUrl, '_blank', 'noopener');
  }

  async function revoke(d: Doc) {
    if (!supabase) return;
    const reason = window.prompt(`Cabut dokumen ${d.document_number}? Tindakan ini permanen.\nTulis alasan pencabutan:`);
    if (!reason || !reason.trim()) return;
    const r = await supabase.from('documents').update({ status: 'revoked', revoked_reason: reason.trim() }).eq('id', d.id).select('id');
    if (r.error) { alert(r.error.message); return; }
    if (!r.data?.length) { alert('Dokumen tidak dapat dicabut.'); return; }
    await reload();
  }

  async function setGroup(ids: string[], groupId: string | null) {
    if (!supabase || !ids.length) return false;
    const r = await supabase.from('documents').update({ group_id: groupId }).in('id', ids).select('id');
    if (r.error) { alert(/group_id|schema cache/i.test(r.error.message) ? 'Fitur kelompok belum aktif di database. Jalankan supabase/features-setup.sql.' : r.error.message); return false; }
    if ((r.data?.length || 0) < ids.length) setBulkMsg(`${r.data?.length || 0} dari ${ids.length} surat diperbarui; sisanya tidak dapat diubah oleh akun Anda.`); else setBulkMsg('');
    await reload();
    return true;
  }

  /** Ubah jenis surat (hanya admin/super admin; dijaga juga di database). */
  async function setLetterType(ids: string[], code: string | null) {
    if (!supabase || !isAdmin || !ids.length) return false;
    const r = await supabase.from('documents').update({ letter_type: code }).in('id', ids).select('id');
    if (r.error) { alert(/letter_type|schema cache/i.test(r.error.message) ? 'Fitur jenis surat belum aktif di database. Jalankan supabase/instansi-setup.sql.' : r.error.message); return false; }
    setBulkMsg((r.data?.length || 0) < ids.length ? `${r.data?.length || 0} dari ${ids.length} surat diperbarui.` : '');
    await reload();
    return true;
  }

  async function applyBulkType() {
    if (!bulkType) return;
    const ok = await setLetterType(selectedVisible.map((d) => d.id), bulkType === '__none' ? null : bulkType);
    if (ok) { setSelected(new Set()); setBulkType(''); }
  }

  async function applyBulk() {
    if (!bulkGroup) return;
    const ok = await setGroup(selectedVisible.map((d) => d.id), bulkGroup === '__none' ? null : bulkGroup);
    if (ok) setSelected(new Set());
  }

  // ---- ekspor & unduh massal ----
  const groupName = (d: Doc) => groups.find((g) => g.id === d.group_id)?.name || '';
  function exportRows(list: Doc[]): Cell[][] {
    const head = ['Nomor surat', 'Perihal', 'Instansi', 'Jenis surat', 'Penandatangan', 'Status', 'Tanggal surat', 'Waktu tanda tangan', 'Kode singkat', 'Verification ID', 'SHA-256', 'Revisi', 'Catatan penolakan'];
    return [head, ...list.map((d) => {
      const sg = (stepsOf.get(d.id) || []).map((s) => `${s.step}. ${s.signer_name}${s.status === 'signed' ? ' ✓' : ''}`).join('; ') || d.signer_name || '';
      return [d.document_number, d.title, groupName(d), jenisLabel(d.letter_type), sg, statusLabel[d.status] || d.status, docDate(d), fmtDT(d.signed_at), d.short_code || '', d.verification_id, d.sha256 || '', d.revision || 1, d.reject_reason || ''];
    })];
  }
  const exportList = selectedVisible.length ? selectedVisible : visible;
  const exportXlsx = () => downloadXlsx(`dokumen-${stamp()}.xlsx`, [{ name: 'Dokumen', rows: exportRows(exportList) }]);
  const exportCsv = () => downloadCsv(`dokumen-${stamp()}.csv`, exportRows(exportList));

  async function downloadZipSelected() {
    if (!supabase) return;
    const list = selectedVisible.filter((d) => d.file_path);
    if (!list.length) { setBulkMsg('Surat terpilih tidak memiliki file PDF.'); return; }
    if (list.length > 60) { setBulkMsg('Maksimal 60 PDF sekali unduh. Kurangi pilihan.'); return; }
    setBulkMsg('');
    const entries: { name: string; data: Uint8Array }[] = [];
    const used = new Set<string>();
    try {
      for (let i = 0; i < list.length; i++) {
        setZipBusy(`Mengunduh ${i + 1}/${list.length}…`);
        const d = list[i];
        const r = await supabase.storage.from('documents').download(d.file_path!);
        if (r.error) throw new Error(`${d.document_number}: ${r.error.message}`);
        let name = d.document_number.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || d.id;
        while (used.has(name.toLowerCase())) name += '-2';
        used.add(name.toLowerCase());
        entries.push({ name: `${name}.pdf`, data: new Uint8Array(await r.data.arrayBuffer()) });
      }
      downloadZip(`dokumen-${stamp()}.zip`, entries);
    } catch (e: any) { setBulkMsg(e?.message || 'Gagal mengunduh.'); } finally { setZipBusy(''); }
  }

  // ---- unggah ----
  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !user || !file) return;
    const chosen = ownerIds.filter(Boolean);
    if (!chosen.length || chosen.length !== ownerIds.length) { setUpMsg({ kind: 'error', text: 'Pilih penandatangan pada semua baris, atau hapus baris yang kosong.' }); return; }
    setBusy(true);
    setUpMsg(null);
    let path: string | null = null;
    let docId: string | null = null;
    try {
      const hash = await hashFile(file);
      const id = crypto.randomUUID();
      path = `${id}.pdf`;
      const up = await supabase.storage.from('documents').upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (up.error) throw up.error;

      let num = number.trim();
      if (!num || num === autoNum.current) { // ambil nomor resmi secara atomik (menghindari nomor ganda)
        const rr = await supabase.rpc('next_document_number', { p_group: upGroup || null, p_type: upType || null });
        if (rr.error) { if (!num) throw rr.error; } else num = rr.data as string;
      }
      const first = owners.find((o) => o.id === chosen[0]);
      const ins = await supabase.from('documents').insert({
        document_number: num, title, signer_name: first?.full_name || null, signer_user_id: first?.user_id ?? null,
        issued_at: new Date().toISOString().slice(0, 10), status: 'pending', verification_id: id, sha256: hash, file_path: path, sign_mode: mode,
        ...(groupsReady && upGroup ? { group_id: upGroup } : {}), ...(upType ? { letter_type: upType } : {}),
      }).select('id').single();
      if (ins.error) throw ins.error;
      docId = ins.data.id;
      const sg = await supabase.rpc('set_document_signers', { p_doc: docId, p_signers: chosen.map((o) => ({ owner_id: o })), p_mode: mode });
      if (sg.error) throw sg.error;

      setNumTouched(false); setTitle(''); setFile(null); setUpType(''); setOwnerIds(['']); setMode('sequential');
      setUpMsg({ kind: 'ok', text: `Dokumen ${num} diarsipkan dan menunggu tanda tangan. Buka Detail untuk mengirim tautan permintaan tanda tangan.` });
      await reload();
    } catch (e: any) {
      if (docId) await supabase.from('documents').delete().eq('id', docId);
      if (path) await supabase.storage.from('documents').remove([path]);
      const m = String(e?.message || 'Upload gagal');
      setUpMsg({ kind: 'error', text: /function|schema cache|relation/i.test(m) ? 'Skema database belum diperbarui. Jalankan supabase/workflow-setup.sql.' : m });
    } finally { setBusy(false); }
  }

  const renderTable = (list: Doc[]) => (
  <DocTable
    docs={list}
    mineIds={new Set(steps.filter((x) => x.status === 'pending' && user && x.user_id === user.id).map((x) => x.document_id))}
    groups={groupsReady ? groups : undefined}
    selection={selection}
    renderSigner={(d) => {
      const st = stepsOf.get(d.id);
      if (!st?.length) return d.signer_name || '—';
      return <div className="schips">{st.map((s) => <span key={s.id} className={`schip ${s.status}`} title={s.signer_position || ''}>{s.step}. {s.signer_name}</span>)}</div>;
    }}
    statusExtra={(d) => {
      if (d.status !== 'pending' || !d.created_at) return null;
      const age = Math.floor((Date.now() - new Date(d.created_at).getTime()) / dayMs);
      return age >= settings.reminder_days ? <span className="status attn" title="Menunggu tanda tangan cukup lama">Tertunda {age} hari</span> : null;
    }}
    renderJenis={isAdmin ? (d) => (
      <select className="group-select" aria-label={`Jenis surat untuk ${d.document_number}`} value={jenisOf(d.letter_type)?.code || ''} onChange={(e) => setLetterType([d.id], e.target.value || null)}>
        <option value="">—</option>
        {JENIS_SURAT.map((j) => <option key={j.code} value={j.code}>{j.code} · {j.abbr}</option>)}
      </select>
    ) : undefined}
    renderGroup={canManage ? (d) => (
      <select className="group-select" aria-label={`Kelompok untuk ${d.document_number}`} value={d.group_id && groups.some((g) => g.id === d.group_id) ? d.group_id : ''} onChange={(e) => setGroup([d.id], e.target.value || null)}>
        <option value="">—</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
    ) : (d) => <GroupChip group={groups.find((g) => g.id === d.group_id)} />}
    actions={user ? (d) => (
      <div className="row-actions">
        <button className="button ghost sm" onClick={() => setDetail(d)}><Eye size={13} />Detail</button>
        {d.file_path && <button className="button ghost sm" onClick={() => openFile(d)}>Unduh</button>}
        {EDITABLE_STATUSES.includes(d.status) && <button className="button ghost sm" onClick={() => setEditing(d)}>{d.status === 'rejected' ? 'Revisi' : 'Edit'}</button>}
        {EDITABLE_STATUSES.includes(d.status) && <button className="button danger sm" onClick={() => removeUnsigned(d)}>Hapus</button>}
        {isAdmin && d.status === 'verified' && <button className="button danger sm" onClick={() => revoke(d)}>Cabut</button>}
        {isAdmin && (d.status === 'verified' || d.status === 'revoked') && <button className="button danger sm" title="Hapus permanen dokumen bertanda tangan" onClick={() => setPurging(d)}><Trash2 size={13} />Hapus permanen</button>}
      </div>
    ) : undefined}
  />
  );

  const showGrouped = view === 'grouped' && groupsReady && groups.length > 0;
  const sections = useMemo(() => {
    const filtered = filtersOn || filter !== 'all';
    const secs = groups.map((g) => ({ id: g.id, group: g as DocGroup | null, list: visible.filter((d) => d.group_id === g.id) }));
    const none = visible.filter((d) => !d.group_id || !groups.some((g) => g.id === d.group_id));
    if (none.length) secs.push({ id: '__none', group: null, list: none });
    return filtered ? secs.filter((x) => x.list.length > 0) : secs;
  }, [groups, visible, filtersOn, filter]);
  /** Daftar surat tersembunyi secara default; terbuka otomatis saat memilih tab instansi atau memakai pencarian/filter. */
  const narrowed = filtersOn || filter !== 'all';

  const selection = canManage ? {
    ids: selected,
    toggle: (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }),
    toggleAll: (ids: string[], on: boolean) => setSelected((s) => { const n = new Set(s); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; }),
  } : undefined;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div><h3>Manajemen dokumen</h3><p>Unggah arsip PDF, atur penandatangan, kelompokkan surat, dan pantau statusnya.</p></div>
          <div className="head-actions">
            <span className="badge">{filtersOn ? `${visible.length} dari ${docs.length}` : `${docs.length}`} dokumen</span>
            <button type="button" className="button ghost sm" onClick={exportXlsx} disabled={!exportList.length}><FileSpreadsheet size={14} />Excel</button>
            <button type="button" className="button ghost sm" onClick={exportCsv} disabled={!exportList.length}><FileText size={14} />CSV</button>
            {canManage && groupsReady && <button type="button" className="button ghost sm" onClick={() => setManageGroups((v) => !v)}><FolderCog size={14} />Kelola kelompok</button>}
          </div>
        </div>

        {!groupsReady && <p className="notice">Pengelompokan surat belum aktif. Jalankan <code>supabase/features-setup.sql</code> di Supabase SQL Editor.</p>}
        {groupsReady && canManage && missing.length > 0 && (
          <div className="notice seed-notice">
            <span>{missing.length === INSTANSI.length ? 'Instansi/lembaga belum dibuat.' : `${missing.length} instansi belum ada: ${missing.map((m) => m.name).join(', ')}.`}</span>
            <button type="button" className="button primary sm" disabled={seedBusy} onClick={seedInstansi}><Building2 size={14} />{seedBusy ? 'Membuat…' : missing.length === INSTANSI.length ? 'Buat 6 instansi' : 'Lengkapi instansi'}</button>
            {seedMsg && <span className="error">{seedMsg}</span>}
          </div>
        )}

        {groupsReady && (
          <div className="gbar" role="tablist" aria-label="Kelompok surat">
            <button type="button" role="tab" aria-selected={filter === 'all'} className={`gtab ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>Semua <b>{docs.length}</b></button>
            {groups.map((g) => (
              <button type="button" role="tab" aria-selected={filter === g.id} key={g.id} className={`gtab ${filter === g.id ? 'on' : ''}`} style={{ ['--gc' as any]: g.color }} onClick={() => setFilter(g.id)}><i />{g.name} <b>{counts.m.get(g.id) || 0}</b></button>
            ))}
            <button type="button" role="tab" aria-selected={filter === 'none'} className={`gtab ${filter === 'none' ? 'on' : ''}`} onClick={() => setFilter('none')}>Tanpa kelompok <b>{counts.none}</b></button>
          </div>
        )}

        {groupsReady && groups.length > 0 && (
          <div className="view-toggle" role="group" aria-label="Tampilan daftar surat">
            <button type="button" className={`button ghost sm ${view === 'grouped' ? 'on' : ''}`} aria-pressed={view === 'grouped'} onClick={() => setView('grouped')}><Building2 size={14} />Per instansi</button>
            <button type="button" className={`button ghost sm ${view === 'list' ? 'on' : ''}`} aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={14} />Daftar biasa</button>
          </div>
        )}
        <div className="searchbox"><Search size={17} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nomor surat, perihal, penandatangan, atau kode…" /></div>
        <div className="filter-row">
          <label>Status
            <select value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="">Semua status</option>
              {Object.entries(statusLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Jenis surat
            <select value={typeF} onChange={(e) => setTypeF(e.target.value)}>
              <option value="">Semua jenis</option>
              {JENIS_SURAT.map((j) => <option key={j.code} value={j.code}>{j.code} · {j.name} ({j.abbr})</option>)}
            </select>
          </label>
          <label>Penandatangan
            <select value={signerF} onChange={(e) => setSignerF(e.target.value)}>
              <option value="">Semua</option>
              {signerNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>Dari tanggal<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Sampai tanggal<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          {filtersOn && <button type="button" className="button ghost sm" onClick={() => { setQ(''); setStatusF(''); setTypeF(''); setSignerF(''); setFrom(''); setTo(''); setFilter('all'); }}>Reset filter</button>}
        </div>

        {canManage && selectedVisible.length > 0 && (
          <div className="bulkbar" role="region" aria-label="Aksi massal">
            <b>{selectedVisible.length} surat dipilih</b>
            {groupsReady && (
              <>
                <select value={bulkGroup} onChange={(e) => setBulkGroup(e.target.value)} aria-label="Pindahkan ke kelompok">
                  <option value="">Pindahkan ke kelompok…</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  <option value="__none">Tanpa kelompok</option>
                </select>
                <button type="button" className="button primary sm" disabled={!bulkGroup} onClick={applyBulk}><FolderInput size={14} />Terapkan</button>
              </>
            )}
            {isAdmin && (
              <>
                <select value={bulkType} onChange={(e) => setBulkType(e.target.value)} aria-label="Ubah jenis surat">
                  <option value="">Ubah jenis surat…</option>
                  {JENIS_SURAT.map((j) => <option key={j.code} value={j.code}>{j.code} · {j.name} ({j.abbr})</option>)}
                  <option value="__none">Tanpa jenis</option>
                </select>
                <button type="button" className="button primary sm" disabled={!bulkType} onClick={applyBulkType}>Terapkan jenis</button>
              </>
            )}
            <button type="button" className="button ghost sm" disabled={Boolean(zipBusy)} onClick={downloadZipSelected}><Archive size={14} />{zipBusy || 'Unduh PDF (ZIP)'}</button>
            <button type="button" className="button ghost sm" onClick={() => setSelected(new Set())}>Batal pilih</button>
          </div>
        )}
        {bulkMsg && <p className="error">{bulkMsg}</p>}

        {showGrouped ? (
          <div className="inst-sections">
            {sections.map((sec) => (
              <details className="inst-section" key={`${sec.id}-${narrowed}`} open={narrowed || undefined} style={{ ['--gc' as any]: sec.group?.color || '#64748B' }}>
                <summary>
                  {sec.group ? <span className="gchip" style={{ ['--gc' as any]: sec.group.color }}><i />{sec.group.name}</span> : <span className="gchip" style={{ ['--gc' as any]: '#64748B' }}><i />Tanpa instansi</span>}
                  {sec.group?.code && <small className="mono code-sm">{sec.group.code}</small>}
                  <b className="inst-count">{sec.list.length} surat</b>
                </summary>
                {sec.list.length ? (
                  <div className="jenis-sections">
                    {[...JENIS_SURAT.map((j) => ({ code: j.code as string, label: `${j.code} · ${j.name} (${j.abbr})` })), { code: '', label: 'Tanpa jenis surat' }]
                      .map((j) => ({ ...j, list: sec.list.filter((d) => (jenisOf(d.letter_type)?.code || '') === j.code) }))
                      .filter((j) => j.list.length > 0)
                      .map((j) => (
                        <details className="jenis-section" key={`${j.code || 'none'}-${filtersOn}`} open={filtersOn || undefined}>
                          <summary><span className="jenis-tag">{j.label}</span><b className="inst-count">{j.list.length} surat</b></summary>
                          {renderTable(j.list)}
                        </details>
                      ))}
                  </div>
                ) : <p className="muted small inst-empty">Belum ada surat untuk instansi ini.</p>}
              </details>
            ))}
          </div>
        ) : renderTable(visible)}
        {visible.length === 0 && docs.length > 0 && <p className="muted">Tidak ada surat yang cocok dengan filter.</p>}
      </section>

      {manageGroups && canManage && groupsReady && (
        <GroupManager groups={groups} docs={docs} userId={user.id} onChanged={() => reload()} onClose={() => setManageGroups(false)} />
      )}

      {editing && user && (
        <EditDocumentPanel key={editing.id} doc={editing as any} steps={stepsOf.get(editing.id) || []} signers={signers} groups={groupsReady ? groups : []} isAdmin={isAdmin} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
      )}

      <section className="panel">
        <h3>Unggah dokumen PDF</h3>
        {!user ? <p className="notice">Login admin diperlukan untuk mengunggah dokumen.</p> : (
          <form className="form-grid" onSubmit={upload}>
            <label>Nomor surat <small className="muted">(otomatis, dapat diubah)</small>
              <input required value={number} onChange={(e) => { setNumTouched(true); setNumber(e.target.value); }} placeholder="001/HMTE/XI/2026" />
            </label>
            <label>Perihal / nama dokumen<input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Surat Undangan Rapat" /></label>
            <label>Jenis surat
              <select required value={upType} onChange={(e) => setUpType(e.target.value)}>
                <option value="">Pilih jenis surat…</option>
                {JENIS_SURAT.map((j) => <option key={j.code} value={j.code}>{j.code} · {j.name} ({j.abbr})</option>)}
              </select>
            </label>
            {groupsReady && (
              <label>Instansi / lembaga
                <select required value={upGroup} onChange={(e) => setUpGroup(e.target.value)}>
                  <option value="">Pilih instansi / lembaga…</option>
                  {groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
            <label>File PDF<input required type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
            <div className="full">
              <span className="lbl">Penandatangan</span>
              <SignerListEditor owners={activeOwners} value={ownerIds} mode={mode} onChange={(v, m) => { setOwnerIds(v); setMode(m); }} />
            </div>
            {numTouched && <div className="full"><button type="button" className="button ghost sm" onClick={() => setNumTouched(false)}>Kembali ke nomor otomatis</button></div>}
            {upMsg && <p className={upMsg.kind === 'ok' ? 'ok' : 'error'} style={{ gridColumn: '1 / -1' }}>{upMsg.text}</p>}
            <div className="form-actions"><button className="button primary" disabled={busy || !file}><UploadCloud size={17} />{busy ? 'Mengunggah...' : 'Upload dan hitung SHA-256'}</button></div>
          </form>
        )}
      </section>

      {detail && (
        <DocumentDetail
          doc={docs.find((d) => d.id === detail.id) || detail}
          steps={stepsOf.get(detail.id) || []}
          owners={owners}
          canManage={canManage}
          onClose={() => setDetail(null)}
          onChanged={() => reload()}
        />
      )}

      {purging && (
        <ConfirmDialog title="Hapus permanen dokumen bertanda tangan?" confirmLabel="Hapus permanen" requireText="HAPUS" askReason reasonLabel="Alasan penghapusan (tercatat di Riwayat Aktivitas)" onConfirm={purge} onClose={() => setPurging(null)}>
          <p><b>{purging.document_number}</b> — {purging.title} <span className={`status ${purging.status === 'verified' ? 'good' : 'bad'}`}>{statusLabel[purging.status]}</span></p>
          <ul className="acc-list">
            <li>Data dokumen dan semua file PDF-nya di arsip dihapus selamanya.</li>
            <li>QR / kode pada salinan yang sudah dicetak atau dikirim akan menampilkan <b>“Dokumen tidak ditemukan”</b> saat diverifikasi.</li>
            <li>Bila tujuannya hanya membatalkan keabsahan, gunakan <b>Cabut</b>: dokumen tetap ada dan verifikasi menampilkan status DICABUT.</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}
