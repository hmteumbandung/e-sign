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

------------------------------------------------------------------
-- Jenis surat (10 jenis, berlaku untuk tiap instansi)
--   01 Surat Ketetapan (SK)      06 Surat Mandat (SM)
--   02 Surat Keputusan (Skep)    07 Surat Izin (SI)
--   03 Surat Rekomendasi (SR)    08 Surat Permohonan (Spm)
--   04 Surat Undangan (SU)       09 Surat Peringatan (SP)
--   05 Surat Tugas (ST)          10 Surat Pemberitahuan (SPem)
-- Penomoran: urutan dihitung terpisah untuk tiap kombinasi instansi + jenis surat.
-- Token format nomor baru: {jenis} = kode 01-10, {singkatan} = SK/Skep/SR/SU/ST/SM/SI/Spm/SP/SPem.
-- JALANKAN FILE INI SETELAH workflow-setup.sql (bila workflow-setup.sql dijalankan ulang, jalankan file ini lagi).
------------------------------------------------------------------
alter table public.documents add column if not exists letter_type text;
alter table public.documents drop constraint if exists documents_letter_type_check;
alter table public.documents add constraint documents_letter_type_check
  check (letter_type is null or letter_type in ('01','02','03','04','05','06','07','08','09','10'));
create index if not exists documents_letter_type_idx on public.documents(letter_type);

-- Ganti fungsi penomoran lama (tanpa jenis) dengan versi yang mengenal jenis surat
drop function if exists public.preview_document_number(uuid, date);
drop function if exists public.next_document_number(uuid, date);
drop function if exists public._format_number(uuid, date, int);
drop function if exists public._number_scope(uuid, date);

create or replace function public._number_scope(p_group uuid, p_type text, p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare g public.document_groups%rowtype; rs text; per text;
begin
  if p_group is not null then select * into g from public.document_groups where id = p_group; end if;
  rs := coalesce(g.reset_period, public._setting('number_reset', 'month'));
  per := case rs when 'month' then to_char(p_date, 'YYYY-MM') when 'year' then to_char(p_date, 'YYYY') else 'all' end;
  -- tanpa jenis: format lama dipertahankan agar penghitung yang sudah berjalan tetap berlanjut
  return coalesce(p_group::text, 'none') || case when p_type is null then '' else ':t' || p_type end || ':' || per;
end $$;

create or replace function public._format_number(p_group uuid, p_type text, p_date date, p_no int) returns text
language plpgsql stable security definer set search_path = public as $$
declare g public.document_groups%rowtype; f text; pad int; abbr text;
  roman text[] := array['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
begin
  if p_group is not null then select * into g from public.document_groups where id = p_group; end if;
  f := coalesce(nullif(g.number_format, ''), public._setting('number_format', '{no}/HMTE/{bulan_romawi}/{tahun}'));
  pad := coalesce(nullif(public._setting('number_pad', '3'), '')::int, 3);
  abbr := case p_type when '01' then 'SK' when '02' then 'Skep' when '03' then 'SR' when '04' then 'SU' when '05' then 'ST'
                      when '06' then 'SM' when '07' then 'SI' when '08' then 'Spm' when '09' then 'SP' when '10' then 'SPem' else '' end;
  f := replace(f, '{no}', lpad(p_no::text, pad, '0'));
  f := replace(f, '{bulan_romawi}', roman[extract(month from p_date)::int]);
  f := replace(f, '{bulan}', to_char(p_date, 'MM'));
  f := replace(f, '{tahun}', to_char(p_date, 'YYYY'));
  f := replace(f, '{kode}', coalesce(nullif(g.code, ''), 'UMUM'));
  f := replace(f, '{jenis}', coalesce(p_type, '00'));
  f := replace(f, '{singkatan}', abbr);
  return f;
end $$;

revoke all on function public._number_scope(uuid, text, date), public._format_number(uuid, text, date, int) from public, anon, authenticated;

create or replace function public.preview_document_number(p_group uuid default null, p_type text default null, p_date date default null) returns text
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_date, (now() at time zone 'Asia/Jakarta')::date); n int; num text;
begin
  if auth.uid() is null or coalesce(public.current_role() in ('super_admin','admin','secretary'), false) = false then raise exception 'Tidak berwenang'; end if;
  select coalesce(last_no, 0) into n from public.document_counters where scope = public._number_scope(p_group, p_type, d);
  n := coalesce(n, 0);
  loop
    n := n + 1;
    num := public._format_number(p_group, p_type, d, n);
    exit when not exists (select 1 from public.documents where lower(btrim(document_number)) = lower(btrim(num)));
  end loop;
  return num;
end $$;

create or replace function public.next_document_number(p_group uuid default null, p_type text default null, p_date date default null) returns text
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_date, (now() at time zone 'Asia/Jakarta')::date); n int; num text; sc text;
begin
  if auth.uid() is null or coalesce(public.current_role() in ('super_admin','admin','secretary'), false) = false then raise exception 'Tidak berwenang'; end if;
  sc := public._number_scope(p_group, p_type, d);
  loop
    insert into public.document_counters(scope, last_no) values (sc, 1)
      on conflict (scope) do update set last_no = public.document_counters.last_no + 1
      returning last_no into n;
    num := public._format_number(p_group, p_type, d, n);
    exit when not exists (select 1 from public.documents where lower(btrim(document_number)) = lower(btrim(num)));
  end loop;
  return num;
end $$;

revoke all on function public.preview_document_number(uuid, text, date), public.next_document_number(uuid, text, date) from public, anon;
grant execute on function public.preview_document_number(uuid, text, date), public.next_document_number(uuid, text, date) to authenticated;

-- Format nomor bawaan 6 instansi (hanya bila belum diatur): 001/04/BPH/XI/2026 = urutan/jenis/kode instansi/bulan/tahun
update public.document_groups
set number_format = '{no}/{jenis}/{kode}/{bulan_romawi}/{tahun}'
where coalesce(number_format, '') = ''
  and lower(btrim(name)) in (
    'himpunan mahasiswa teknik elektro', 'badan pengurus harian', 'departemen riset dan teknologi',
    'departemen pengembangan sumber daya manusia', 'departemen komunikasi dan informasi', 'departemen ekonomi dan bisnis');

------------------------------------------------------------------
-- Hanya admin / super admin yang boleh MENGUBAH jenis surat setelah surat dibuat
-- (menetapkan jenis saat unggah awal tetap diperbolehkan untuk sekretaris).
------------------------------------------------------------------
create or replace function public.guard_letter_type() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.letter_type is distinct from old.letter_type
     and auth.uid() is not null
     and coalesce(public.current_role() in ('super_admin', 'admin'), false) = false then
    raise exception 'Hanya admin atau super admin yang dapat mengubah jenis surat';
  end if;
  return new;
end $$;

drop trigger if exists documents_guard_letter_type on public.documents;
create trigger documents_guard_letter_type before update on public.documents
  for each row execute function public.guard_letter_type();
