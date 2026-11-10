import { useMemo, useState } from 'react';
import { Download, FileUp, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { downloadXlsx, readTable } from '../../lib/exporter';
import type { Signer } from '../../types';

type Props = { existing: Signer[]; defaultPeriod?: string; onClose: () => void; onDone: (n: number) => void | Promise<void> };
type Row = { full_name: string; student_id: string; position: string; department: string; period: string; phone: string; status: string; error?: string; skip?: string };

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELD: Record<string, keyof Omit<Row, 'error' | 'skip'>> = {
  nama: 'full_name', namalengkap: 'full_name', fullname: 'full_name', name: 'full_name',
  nim: 'student_id', npm: 'student_id', nomorindukmahasiswa: 'student_id',
  jabatan: 'position', posisi: 'position', position: 'position',
  departemen: 'department', bidang: 'department', divisi: 'department', department: 'department',
  periode: 'period', kabinet: 'period', periodekabinet: 'period', period: 'period',
  telepon: 'phone', hp: 'phone', nohp: 'phone', nomorhp: 'phone', whatsapp: 'phone', wa: 'phone', phone: 'phone',
  status: 'status',
};
const STATUS: Record<string, string> = { aktif: 'active', active: 'active', nonaktif: 'inactive', inactive: 'inactive', arsip: 'archived', diarsipkan: 'archived', archived: 'archived' };

/** Impor pengurus dari Excel (.xlsx) atau CSV: pratinjau + validasi dulu, baru disimpan. */
export default function ImportSignersDialog({ existing, defaultPeriod = '', onClose, onDone }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const have = useMemo(() => new Set(existing.map((s) => (s.student_id || '').trim().toLowerCase()).filter(Boolean)), [existing]);
  const valid = rows.filter((r) => !r.error && !r.skip);

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(''); setRows([]); setFileName(f.name);
    try {
      const table = await readTable(f);
      if (table.length < 2) throw new Error('Berkas kosong atau hanya berisi judul kolom.');
      const cols = table[0].map((h) => FIELD[norm(String(h))]);
      if (!cols.includes('full_name') || !cols.includes('position')) throw new Error('Kolom "Nama" dan "Jabatan" wajib ada pada baris pertama. Unduh templat untuk contoh.');
      const seen = new Set<string>();
      const out: Row[] = table.slice(1).map((cells) => {
        const r: Row = { full_name: '', student_id: '', position: '', department: '', period: defaultPeriod, phone: '', status: 'active' };
        cols.forEach((c, i) => { if (c && cells[i] != null) (r as any)[c] = String(cells[i]).trim(); });
        r.status = STATUS[norm(r.status)] || 'active';
        if (!r.full_name || !r.position) r.error = 'Nama/jabatan kosong';
        else {
          const k = r.student_id.toLowerCase();
          if (k && (have.has(k) || seen.has(k))) r.skip = have.has(k) ? 'NIM sudah terdaftar' : 'NIM ganda di berkas';
          if (k) seen.add(k);
        }
        return r;
      });
      if (out.length > 500) throw new Error('Maksimal 500 baris per impor.');
      setRows(out);
    } catch (e: any) { setError(e?.message || 'Berkas tidak dapat dibaca.'); }
  }

  async function run() {
    if (!supabase || !valid.length) return;
    setBusy(true); setError('');
    try {
      for (let i = 0; i < valid.length; i += 100) {
        const chunk = valid.slice(i, i + 100).map((r) => ({
          full_name: r.full_name, student_id: r.student_id || null, position: r.position, department: r.department || null,
          period: r.period || null, phone: r.phone || null, status: r.status,
        }));
        const res = await supabase.from('signature_owners').insert(chunk);
        if (res.error) throw new Error(`${res.error.message}${i ? ` (${i} data pertama sudah tersimpan)` : ''}`);
      }
      await onDone(valid.length);
    } catch (e: any) { setError(e?.message || 'Impor gagal.'); } finally { setBusy(false); }
  }

  return (
    <div className="dlg-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dlg wide" role="dialog" aria-modal="true" aria-labelledby="imp-title">
        <div className="dlg-head">
          <h3 id="imp-title">Impor pengurus dari Excel / CSV</h3>
          <button type="button" className="icon-btn" aria-label="Tutup" onClick={onClose} disabled={busy}><X size={17} /></button>
        </div>
        <p className="muted small">Kolom: Nama*, Jabatan*, NIM, Departemen, Periode, Telepon, Status (aktif/nonaktif/arsip). Baris dengan NIM yang sudah terdaftar dilewati. File tanda tangan diunggah terpisah di Database Tanda Tangan.</p>
        <div className="btn-row">
          <label className="button primary"><FileUp size={15} />Pilih berkas<input type="file" hidden accept=".xlsx,.csv,.txt,.tsv" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} /></label>
          <button type="button" className="button ghost" onClick={() => downloadXlsx('templat-pengurus.xlsx', [{ name: 'Pengurus', rows: [['Nama', 'NIM', 'Jabatan', 'Departemen', 'Periode', 'Telepon', 'Status'], ['Contoh Nama', '2101234', 'Sekretaris Umum', 'Sekretariat', defaultPeriod || 'Kabinet Resonansi', '081234567890', 'aktif']] }])}><Download size={15} />Unduh templat</button>
          {fileName && <span className="muted small">{fileName}</span>}
        </div>
        {error && <p className="error">{error}</p>}
        {rows.length > 0 && (
          <>
            <p><b>{valid.length}</b> siap diimpor · {rows.filter((r) => r.skip).length} dilewati · {rows.filter((r) => r.error).length} bermasalah</p>
            <div className="table-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
              <table>
                <thead><tr><th>#</th><th>Nama</th><th>NIM</th><th>Jabatan</th><th>Departemen</th><th>Periode</th><th>Keterangan</th></tr></thead>
                <tbody>
                  {rows.slice(0, 200).map((r, i) => (
                    <tr key={i} className={r.error ? 'row-bad' : r.skip ? 'row-skip' : ''}>
                      <td>{i + 2}</td><td>{r.full_name}</td><td>{r.student_id}</td><td>{r.position}</td><td>{r.department}</td><td>{r.period}</td>
                      <td>{r.error || r.skip || 'OK'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="dlg-actions">
          <button type="button" className="button ghost" onClick={onClose} disabled={busy}>Tutup</button>
          <button type="button" className="button primary" onClick={run} disabled={busy || !valid.length}>{busy ? 'Mengimpor…' : `Impor ${valid.length} data`}</button>
        </div>
      </div>
    </div>
  );
}
