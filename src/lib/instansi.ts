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
