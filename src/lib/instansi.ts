import type { DocGroup } from '../types';

/** 6 instansi/lembaga bawaan. Urutan di sini = urutan tampil di Manajemen Dokumen. */
export const INSTANSI = [
  { name: 'Himpunan Mahasiswa Teknik Elektro', code: 'HMTE', color: '#2563EB' },
  { name: 'Badan Pengurus Harian', code: 'BPH', color: '#14213D' },
  { name: 'Departemen Riset dan Teknologi', code: 'RISTEK', color: '#0891B2' },
  { name: 'Departemen Pengembangan Sumber Daya Manusia', code: 'PSDM', color: '#16A34A' },
  { name: 'Departemen Komunikasi dan Informasi', code: 'KOMINFO', color: '#7C3AED' },
  { name: 'Departemen Ekonomi dan Bisnis', code: 'EKBIS', color: '#F59E0B' },
] as const;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const order = new Map<string, number>(INSTANSI.map((i, n) => [norm(i.name), n]));

/** true bila kelompok ini salah satu dari 6 instansi bawaan */
export const isInstansi = (g: Pick<DocGroup, 'name'>) => order.has(norm(g.name));

/** Urutkan: 6 instansi dulu (sesuai urutan resmi), kelompok lain sesudahnya menurut abjad. */
export function sortGroups(list: DocGroup[]): DocGroup[] {
  return [...list].sort((a, b) => {
    const ia = order.get(norm(a.name)), ib = order.get(norm(b.name));
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.name.localeCompare(b.name, 'id');
  });
}

/** Instansi bawaan yang belum ada di database. */
export const missingInstansi = (groups: DocGroup[]) => INSTANSI.filter((i) => !groups.some((g) => norm(g.name) === norm(i.name)));

/** 10 jenis surat; berlaku untuk setiap instansi. Kode (01-10) dipakai token {jenis} pada nomor surat. */
export const JENIS_SURAT = [
  { code: '01', abbr: 'SK', name: 'Surat Ketetapan' },
  { code: '02', abbr: 'Skep', name: 'Surat Keputusan' },
  { code: '03', abbr: 'SR', name: 'Surat Rekomendasi' },
  { code: '04', abbr: 'SU', name: 'Surat Undangan' },
  { code: '05', abbr: 'ST', name: 'Surat Tugas' },
  { code: '06', abbr: 'SM', name: 'Surat Mandat' },
  { code: '07', abbr: 'SI', name: 'Surat Izin' },
  { code: '08', abbr: 'Spm', name: 'Surat Permohonan' },
  { code: '09', abbr: 'SP', name: 'Surat Peringatan' },
  { code: '10', abbr: 'SPem', name: 'Surat Pemberitahuan' },
] as const;

export const jenisOf = (code?: string | null) => JENIS_SURAT.find((j) => j.code === code);
export const jenisLabel = (code?: string | null) => { const j = jenisOf(code); return j ? `${j.code} · ${j.name} (${j.abbr})` : ''; };
