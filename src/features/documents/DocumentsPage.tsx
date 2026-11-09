import { useMemo, useState } from 'react';
import { FolderCog, FolderInput, Search, Trash2, UploadCloud } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import ConfirmDialog from '../../components/ConfirmDialog';
import DocTable, { GroupChip, hashFile, statusLabel } from './DocTable';
import EditDocumentPanel, { EDITABLE_STATUSES } from './EditDocumentPanel';
import GroupManager from './GroupManager';
import type { Doc, DocGroup, Signer } from '../../types';

type Props = {
  docs: Doc[];
  signers: Signer[];
  groups: DocGroup[];
  /** false bila tabel document_groups belum ada di database */
  groupsReady: boolean;
  reload: () => void | Promise<void>;
  /** akun yang boleh mengelola dokumen (admin / sekretaris aktif); null bila tidak */
  user: any;
  isAdmin?: boolean;
};

type Filter = 'all' | 'none' | string;

export default function DocumentsPage({ docs, signers, groups, groupsReady, reload, user, isAdmin = false }: Props) {
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [signer, setSigner] = useState('');
  const [upGroup, setUpGroup] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [manageGroups, setManageGroups] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkGroup, setBulkGroup] = useState('');
  const [bulkMsg, setBulkMsg] = useState('');
  const [purging, setPurging] = useState<Doc | null>(null);

  const canManage = Boolean(user);
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
      if (!needle) return true;
      return [d.document_number, d.title, d.signer_name || '', d.short_code || '', statusLabel[d.status] || d.status].join(' ').toLowerCase().includes(needle);
    });
  }, [docs, groups, filter, q]);

  const selectedVisible = visible.filter((d) => selected.has(d.id));

  // ---- aksi ----
  async function removeUnsigned(d: Doc) {
    if (!supabase) return;
    if (!window.confirm(`Hapus dokumen "${d.title}" (${d.document_number})?\nFile PDF-nya juga akan dihapus. Tindakan ini tidak dapat dibatalkan.`)) return;
    const r = await supabase.from('documents').delete().eq('id', d.id).in('status', EDITABLE_STATUSES).select('id');
    if (r.error) { alert(r.error.message); return; }
    if (!r.data?.length) { alert('Dokumen tidak dapat dihapus. Dokumen yang sudah ditandatangani dihapus oleh admin lewat "Hapus permanen".'); return; }
    if (d.file_path) await supabase.storage.from('documents').remove([d.file_path]);
    if (editing?.id === d.id) setEditing(null);
    await reload();
  }

  /** Hapus permanen dokumen terverifikasi/dicabut (khusus admin). Alasan tercatat di Riwayat Aktivitas. */
  async function purge({ reason }: { reason: string }) {
    if (!supabase || !purging) return;
    const r = await supabase.rpc('delete_document', { p_id: purging.id, p_reason: reason });
    if (r.error) {
      const m = r.error.message || '';
      throw new Error(/function|schema cache/i.test(m) ? 'Fitur belum aktif di database. Jalankan supabase/esign-setup.sql lalu supabase/features-setup.sql.' : m);
    }
    const paths = [r.data?.file_path, r.data?.original_file_path].filter(Boolean) as string[];
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
    if (!supabase || !ids.length) return;
    const r = await supabase.from('documents').update({ group_id: groupId }).in('id', ids).select('id');
    if (r.error) { alert(/group_id|schema cache/i.test(r.error.message) ? 'Fitur kelompok belum aktif di database. Jalankan supabase/features-setup.sql.' : r.error.message); return false; }
    if ((r.data?.length || 0) < ids.length) setBulkMsg(`${r.data?.length || 0} dari ${ids.length} surat diperbarui; sisanya tidak dapat diubah oleh akun Anda.`); else setBulkMsg('');
    await reload();
    return true;
  }

  async function applyBulk() {
    if (!bulkGroup) return;
    const ok = await setGroup(selectedVisible.map((d) => d.id), bulkGroup === '__none' ? null : bulkGroup);
    if (ok) setSelected(new Set());
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !user || !file) return;
    setBusy(true);
    try {
      const hash = await hashFile(file);
      const id = crypto.randomUUID();
      const path = `${id}.pdf`;
      const up = await supabase.storage.from('documents').upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (up.error) throw up.error;
      const owner = signers.find((s) => s.id === signer);
      const ins = await supabase.from('documents').insert({
        document_number: number, title, signer_name: owner?.full_name || null,
        issued_at: new Date().toISOString().slice(0, 10), status: 'pending', verification_id: id, sha256: hash, file_path: path,
        ...(owner?.user_id ? { signer_user_id: owner.user_id } : {}),
        ...(groupsReady && upGroup ? { group_id: upGroup } : {}),
      }).select().single();
      if (ins.error) { await supabase.storage.from('documents').remove([path]); throw ins.error; }
      setNumber(''); setTitle(''); setFile(null);
      await reload();
      alert('Dokumen berhasil diarsipkan. Status awal: menunggu proses persetujuan/penandatanganan.');
    } catch (e: any) { alert(e.message || 'Upload gagal'); } finally { setBusy(false); }
  }

  const selection = canManage ? {
    ids: selected,
    toggle: (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }),
    toggleAll: (ids: string[], on: boolean) => setSelected((s) => { const n = new Set(s); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; }),
  } : undefined;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div><h3>Manajemen dokumen</h3><p>Unggah arsip PDF, kelompokkan surat, dan catat metadata dokumen resmi.</p></div>
          <div className="head-actions">
            <span className="badge">{docs.length} dokumen</span>
            {canManage && groupsReady && <button type="button" className="button ghost sm" onClick={() => setManageGroups((v) => !v)}><FolderCog size={14} />Kelola kelompok</button>}
          </div>
        </div>

        {!groupsReady && <p className="notice">Pengelompokan surat belum aktif. Jalankan <code>supabase/features-setup.sql</code> di Supabase SQL Editor.</p>}

        {groupsReady && (
          <div className="gbar" role="tablist" aria-label="Kelompok surat">
            <button type="button" role="tab" aria-selected={filter === 'all'} className={`gtab ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>Semua <b>{docs.length}</b></button>
            {groups.map((g) => (
              <button type="button" role="tab" aria-selected={filter === g.id} key={g.id} className={`gtab ${filter === g.id ? 'on' : ''}`} style={{ ['--gc' as any]: g.color }} onClick={() => setFilter(g.id)}><i />{g.name} <b>{counts.m.get(g.id) || 0}</b></button>
            ))}
            <button type="button" role="tab" aria-selected={filter === 'none'} className={`gtab ${filter === 'none' ? 'on' : ''}`} onClick={() => setFilter('none')}>Tanpa kelompok <b>{counts.none}</b></button>
          </div>
        )}

        <div className="searchbox"><Search size={17} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nomor surat, perihal, penandatangan, atau kode…" /></div>

        {canManage && groupsReady && selectedVisible.length > 0 && (
          <div className="bulkbar" role="region" aria-label="Aksi massal">
            <b>{selectedVisible.length} surat dipilih</b>
            <select value={bulkGroup} onChange={(e) => setBulkGroup(e.target.value)} aria-label="Pindahkan ke kelompok">
              <option value="">Pindahkan ke kelompok…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              <option value="__none">Tanpa kelompok</option>
            </select>
            <button type="button" className="button primary sm" disabled={!bulkGroup} onClick={applyBulk}><FolderInput size={14} />Terapkan</button>
            <button type="button" className="button ghost sm" onClick={() => setSelected(new Set())}>Batal pilih</button>
          </div>
        )}
        {bulkMsg && <p className="error">{bulkMsg}</p>}

        <DocTable
          docs={visible}
          meId={user?.id}
          groups={groupsReady ? groups : undefined}
          selection={groupsReady ? selection : undefined}
          renderGroup={canManage ? (d) => (
            <select className="group-select" aria-label={`Kelompok untuk ${d.document_number}`} value={d.group_id && groups.some((g) => g.id === d.group_id) ? d.group_id : ''} onChange={(e) => setGroup([d.id], e.target.value || null)}>
              <option value="">—</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          ) : (d) => <GroupChip group={groups.find((g) => g.id === d.group_id)} />}
          actions={user ? (d) => (
            <div className="row-actions">
              {d.file_path && <button className="button ghost sm" onClick={() => openFile(d)}>Unduh</button>}
              {EDITABLE_STATUSES.includes(d.status) && <button className="button ghost sm" onClick={() => setEditing(d)}>Edit</button>}
              {EDITABLE_STATUSES.includes(d.status) && <button className="button danger sm" onClick={() => removeUnsigned(d)}>Hapus</button>}
              {isAdmin && d.status === 'verified' && <button className="button danger sm" onClick={() => revoke(d)}>Cabut</button>}
              {isAdmin && (d.status === 'verified' || d.status === 'revoked') && <button className="button danger sm" title="Hapus permanen dokumen bertanda tangan" onClick={() => setPurging(d)}><Trash2 size={13} />Hapus permanen</button>}
            </div>
          ) : undefined}
        />
        {q.trim() && !visible.length && docs.length > 0 && <p className="muted">Tidak ada surat yang cocok dengan pencarian.</p>}
      </section>

      {manageGroups && canManage && groupsReady && (
        <GroupManager groups={groups} docs={docs} userId={user.id} onChanged={() => reload()} onClose={() => setManageGroups(false)} />
      )}

      {editing && user && (
        <EditDocumentPanel key={editing.id} doc={editing as any} signers={signers} groups={groupsReady ? groups : []} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />
      )}

      <section className="panel">
        <h3>Unggah dokumen PDF</h3>
        {!user ? <p className="notice">Login admin diperlukan untuk mengunggah dokumen.</p> : (
          <form className="form-grid" onSubmit={upload}>
            <label>Nomor surat<input required value={number} onChange={(e) => setNumber(e.target.value)} placeholder="001/ HMTE / XI / 2026" /></label>
            <label>Perihal / nama dokumen<input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Surat Undangan Rapat" /></label>
            <label>Penandatangan
              <select value={signer} onChange={(e) => setSigner(e.target.value)}>
                <option value="">Pilih penandatangan</option>
                {signers.map((s) => <option value={s.id} key={s.id}>{s.full_name} — {s.position}</option>)}
              </select>
            </label>
            {groupsReady && (
              <label>Kelompok surat
                <select value={upGroup} onChange={(e) => setUpGroup(e.target.value)}>
                  <option value="">Tanpa kelompok</option>
                  {groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
            <label>File PDF<input required type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
            <div className="form-actions"><button className="button primary" disabled={busy || !file}><UploadCloud size={17} />{busy ? 'Mengunggah...' : 'Upload dan hitung SHA-256'}</button></div>
          </form>
        )}
      </section>

      {purging && (
        <ConfirmDialog title="Hapus permanen dokumen bertanda tangan?" confirmLabel="Hapus permanen" requireText="HAPUS" askReason reasonLabel="Alasan penghapusan (tercatat di Riwayat Aktivitas)" onConfirm={purge} onClose={() => setPurging(null)}>
          <p><b>{purging.document_number}</b> — {purging.title} <span className={`status ${purging.status === 'verified' ? 'good' : 'bad'}`}>{statusLabel[purging.status]}</span></p>
          <ul className="acc-list">
            <li>Data dokumen dan file PDF-nya di arsip dihapus selamanya.</li>
            <li>QR / kode pada salinan yang sudah dicetak atau dikirim akan menampilkan <b>“Dokumen tidak ditemukan”</b> saat diverifikasi.</li>
            <li>Bila tujuannya hanya membatalkan keabsahan, gunakan <b>Cabut</b>: dokumen tetap ada dan verifikasi menampilkan status DICABUT.</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}
