-- SIGNATURE HUB HMTE UMBandung
-- Pengelompokan surat berdasarkan 6 instansi/lembaga.
-- Jalankan SETELAH features-setup.sql dan workflow-setup.sql. Aman dijalankan berulang kali:
-- instansi yang sudah ada tidak diduplikasi dan data lain tidak diubah.

insert into public.document_groups (name, color, description, code)
select v.name, v.color, v.description, v.code
from (values
  ('Himpunan Mahasiswa Teknik Elektro',               '#2563EB', 'Surat atas nama Himpunan Mahasiswa Teknik Elektro', 'HMTE'),
  ('Badan Pengurus Harian',                           '#14213D', 'Surat Badan Pengurus Harian',                        'BPH'),
  ('Departemen Riset dan Teknologi',                  '#0891B2', 'Surat Departemen Riset dan Teknologi',               'RISTEK'),
  ('Departemen Pengembangan Sumber Daya Manusia',     '#16A34A', 'Surat Departemen Pengembangan Sumber Daya Manusia',  'PSDM'),
  ('Departemen Komunikasi dan Informasi',             '#7C3AED', 'Surat Departemen Komunikasi dan Informasi',          'KOMINFO'),
  ('Departemen Ekonomi dan Bisnis',                   '#F59E0B', 'Surat Departemen Ekonomi dan Bisnis',                'EKBIS')
) as v(name, color, description, code)
where not exists (
  select 1 from public.document_groups g where lower(btrim(g.name)) = lower(btrim(v.name))
);

-- Catatan:
-- * Kolom "code" dipakai token {kode} pada format nomor surat, mis. {no}/{kode}/HMTE/{bulan_romawi}/{tahun}
--   (atur di Manajemen Dokumen > Kelola kelompok, atau Pengaturan).
-- * Surat lama tidak dipindahkan otomatis; pindahkan lewat dropdown "Kelompok" atau centang beberapa surat.
