-- SIGNATURE HUB HMTE UMBandung
-- Alur persetujuan (tolak/revisi, banyak penandatangan), penomoran otomatis, verifikasi publik via fungsi,
-- riwayat verifikasi, pengaturan bersama, surat masuk + disposisi, dan pemicu notifikasi opsional.
-- Jalankan SETELAH schema.sql, account-setup.sql, esign-setup.sql (terbaru), dan features-setup.sql. Aman diulang.

------------------------------------------------------------------
-- 1. Kolom tambahan
------------------------------------------------------------------
alter table public.documents
  add column if not exists sign_mode text not null default 'sequential',
  add column if not exists reject_reason text,
  add column if not exists rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists revision int not null default 1,
  add column if not exists public_access boolean not null default true;

alter table public.documents drop constraint if exists documents_sign_mode_check;
alter table public.documents add constraint documents_sign_mode_check check (sign_mode in ('sequential','parallel'));

alter table public.signature_owners add column if not exists phone text;

alter table public.document_groups
  add column if not exists code text,
  add column if not exists number_format text,
  add column if not exists reset_period text;
alter table public.document_groups drop constraint if exists document_groups_reset_period_check;
alter table public.document_groups add constraint document_groups_reset_period_check check (reset_period is null or reset_period in ('month','year','never'));

------------------------------------------------------------------
-- 2. Penandatangan per dokumen (banyak penandatangan, berurutan atau paralel)
------------------------------------------------------------------
create table if not exists public.document_signers (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  step int not null check (step between 1 and 8),
  owner_id uuid references public.signature_owners(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  signer_name text not null,
  signer_position text,
  status text not null default 'waiting' check (status in ('waiting','pending','signed','rejected')),
  signed_at timestamptz,
  note text,
  file_path text,
  sha256 text,
  created_at timestamptz not null default now(),
  unique (document_id, step)
);
create unique index if not exists document_signers_doc_owner_key on public.document_signers(document_id, owner_id) where owner_id is not null;
create index if not exists document_signers_user_idx on public.document_signers(user_id) where status = 'pending';

alter table public.document_signers enable row level security;
drop policy if exists "authenticated read document signers" on public.document_signers;
create policy "authenticated read document signers" on public.document_signers for select to authenticated using (true);
-- Penulisan hanya lewat fungsi di bawah (set_document_signers, sign_document_step, reject_document, resubmit_document),
-- kecuali admin yang mencatat dokumen yang langsung ditandatangani saat diunggah di menu Penandatanganan.
drop policy if exists "admin insert signed step" on public.document_signers;
create policy "admin insert signed step" on public.document_signers for insert to authenticated
  with check (public.current_role() in ('super_admin','admin') and status = 'signed');

-- Dokumen lama: satu baris penandatangan dari kolom signer_name / signer_user_id
insert into public.document_signers (document_id, step, owner_id, user_id, signer_name, signer_position, status, signed_at, sha256, file_path)
select d.id, 1, o.id, coalesce(d.signer_user_id, o.user_id), coalesce(nullif(btrim(d.signer_name), ''), '(belum ditentukan)'), o.position,
  case when d.status in ('verified','revoked') then 'signed' when d.status = 'pending' then 'pending' else 'waiting' end,
  d.signed_at, d.sha256, d.file_path
from public.documents d
left join lateral (
  select * from public.signature_owners o
  where (d.signer_user_id is not null and o.user_id = d.signer_user_id) or o.full_name = d.signer_name
  order by (o.user_id = d.signer_user_id) desc nulls last limit 1
) o on true
where not exists (select 1 from public.document_signers s where s.document_id = d.id);

------------------------------------------------------------------
-- 3. Pengaturan bersama (teks footer, format nomor) dan rahasia internal
------------------------------------------------------------------
create table if not exists public.app_settings (
  key text primary key,
  value text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create table if not exists public.private_settings (key text primary key, value text not null);  -- tanpa policy: hanya fungsi internal
create table if not exists public.document_counters (scope text primary key, last_no int not null default 0);  -- tanpa policy
alter table public.app_settings enable row level security;
alter table public.private_settings enable row level security;
alter table public.document_counters enable row level security;

drop policy if exists "authenticated read settings" on public.app_settings;
drop policy if exists "staff insert footer setting" on public.app_settings;
drop policy if exists "staff update footer setting" on public.app_settings;
drop policy if exists "admin manage settings" on public.app_settings;
create policy "authenticated read settings" on public.app_settings for select to authenticated using (true);
create policy "staff insert footer setting" on public.app_settings for insert to authenticated
  with check (key = 'footer_text' and public.current_role() in ('super_admin','admin','secretary'));
create policy "staff update footer setting" on public.app_settings for update to authenticated
  using (key = 'footer_text' and public.current_role() in ('super_admin','admin','secretary'))
  with check (key = 'footer_text' and public.current_role() in ('super_admin','admin','secretary'));
create policy "admin manage settings" on public.app_settings for all to authenticated
  using (public.current_role() in ('super_admin','admin')) with check (public.current_role() in ('super_admin','admin'));

insert into public.app_settings(key, value) values
  ('number_format', '{no}/HMTE/{bulan_romawi}/{tahun}'),
  ('number_reset', 'month'),
  ('number_pad', '3'),
  ('reminder_days', '3'),
  ('footer_text', '')
on conflict (key) do nothing;

------------------------------------------------------------------
-- 4. Penomoran surat otomatis (atomik, tanpa nomor ganda)
--    Token: {no} {bulan} {bulan_romawi} {tahun} {kode}. Urutan berlanjut per kelompok dan per bulan/tahun/selamanya.
------------------------------------------------------------------
create or replace function public._setting(p_key text, p_default text) returns text
language sql stable security definer set search_path = public as
$$ select coalesce((select value from public.app_settings where key = p_key), p_default) $$;

create or replace function public._number_scope(p_group uuid, p_date date) returns text
language plpgsql stable security definer set search_path = public as $$
declare g public.document_groups%rowtype; rs text; per text;
begin
  if p_group is not null then select * into g from public.document_groups where id = p_group; end if;
  rs := coalesce(g.reset_period, public._setting('number_reset', 'month'));
  per := case rs when 'month' then to_char(p_date, 'YYYY-MM') when 'year' then to_char(p_date, 'YYYY') else 'all' end;
  return coalesce(p_group::text, 'none') || ':' || per;
end $$;

create or replace function public._format_number(p_group uuid, p_date date, p_no int) returns text
language plpgsql stable security definer set search_path = public as $$
declare g public.document_groups%rowtype; f text; pad int;
  roman text[] := array['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
begin
  if p_group is not null then select * into g from public.document_groups where id = p_group; end if;
  f := coalesce(nullif(g.number_format, ''), public._setting('number_format', '{no}/HMTE/{bulan_romawi}/{tahun}'));
  pad := coalesce(nullif(public._setting('number_pad', '3'), '')::int, 3);
  f := replace(f, '{no}', lpad(p_no::text, pad, '0'));
  f := replace(f, '{bulan_romawi}', roman[extract(month from p_date)::int]);
  f := replace(f, '{bulan}', to_char(p_date, 'MM'));
  f := replace(f, '{tahun}', to_char(p_date, 'YYYY'));
  f := replace(f, '{kode}', coalesce(nullif(g.code, ''), 'UMUM'));
  return f;
end $$;

revoke all on function public._setting(text, text), public._number_scope(uuid, date), public._format_number(uuid, date, int) from public, anon, authenticated;

create or replace function public.preview_document_number(p_group uuid default null, p_date date default null) returns text
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_date, (now() at time zone 'Asia/Jakarta')::date); n int; num text;
begin
  if auth.uid() is null or coalesce(public.current_role() in ('super_admin','admin','secretary'), false) = false then raise exception 'Tidak berwenang'; end if;
  select coalesce(last_no, 0) into n from public.document_counters where scope = public._number_scope(p_group, d);
  n := coalesce(n, 0);
  loop
    n := n + 1;
    num := public._format_number(p_group, d, n);
    exit when not exists (select 1 from public.documents where lower(btrim(document_number)) = lower(btrim(num)));
  end loop;
  return num;
end $$;

create or replace function public.next_document_number(p_group uuid default null, p_date date default null) returns text
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_date, (now() at time zone 'Asia/Jakarta')::date); n int; num text; sc text;
begin
  if auth.uid() is null or coalesce(public.current_role() in ('super_admin','admin','secretary'), false) = false then raise exception 'Tidak berwenang'; end if;
  sc := public._number_scope(p_group, d);
  loop
    insert into public.document_counters(scope, last_no) values (sc, 1)
      on conflict (scope) do update set last_no = public.document_counters.last_no + 1
      returning last_no into n;
    num := public._format_number(p_group, d, n);
    exit when not exists (select 1 from public.documents where lower(btrim(document_number)) = lower(btrim(num)));
  end loop;
  return num;
end $$;

revoke all on function public.preview_document_number(uuid, date), public.next_document_number(uuid, date) from public, anon;
grant execute on function public.preview_document_number(uuid, date), public.next_document_number(uuid, date) to authenticated;

-- Nomor surat BOLEH sama: pembatasan nomor ganda sengaja dihapus.
drop trigger if exists documents_unique_number_trg on public.documents;
drop function if exists public.documents_unique_number();

------------------------------------------------------------------
-- 5. Alur persetujuan
------------------------------------------------------------------
-- 5a. Atur penandatangan (admin/sekretaris). Hanya selama belum ada yang menandatangani.
create or replace function public.set_document_signers(p_doc uuid, p_signers jsonb, p_mode text default 'sequential')
returns void language plpgsql security definer set search_path = public as $$
declare d public.documents%rowtype; item jsonb; i int := 0; o public.signature_owners%rowtype;
begin
  if auth.uid() is null or coalesce(public.current_role() in ('super_admin','admin','secretary'), false) = false then
    raise exception 'Hanya admin atau sekretaris yang dapat mengatur penandatangan';
  end if;
  if p_mode not in ('sequential','parallel') then raise exception 'Mode penandatanganan tidak valid'; end if;
  select * into d from public.documents where id = p_doc for update;
  if not found then raise exception 'Dokumen tidak ditemukan'; end if;
  if d.status not in ('draft','pending','rejected','archived') then raise exception 'Dokumen berstatus % tidak dapat diubah penandatangannya', d.status; end if;
  if d.status = 'pending' and exists (select 1 from public.document_signers where document_id = p_doc and status = 'signed') then
    raise exception 'Sudah ada penandatangan yang menandatangani. Tolak dokumen terlebih dahulu, lalu ubah penandatangan dan ajukan ulang';
  end if;
  if jsonb_typeof(p_signers) <> 'array' or jsonb_array_length(p_signers) not between 1 and 8 then raise exception 'Tentukan 1 sampai 8 penandatangan'; end if;

  delete from public.document_signers where document_id = p_doc;
  for item in select * from jsonb_array_elements(p_signers) loop
    i := i + 1;
    select * into o from public.signature_owners where id = (item->>'owner_id')::uuid;
    if not found then raise exception 'Pengurus tidak ditemukan'; end if;
    if o.status <> 'active' then raise exception 'Pengurus % tidak aktif', o.full_name; end if;
    insert into public.document_signers(document_id, step, owner_id, user_id, signer_name, signer_position, status)
    values (p_doc, i, o.id, o.user_id, o.full_name, o.position,
      case when d.status = 'pending' and (p_mode = 'parallel' or i = 1) then 'pending' else 'waiting' end);
  end loop;

  update public.documents
     set sign_mode = p_mode,
         signer_name = (select signer_name from public.document_signers where document_id = p_doc and step = 1),
         signer_user_id = (select user_id from public.document_signers where document_id = p_doc and step = 1)
   where id = p_doc;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'document.signers', 'document', p_doc,
    jsonb_build_object('document_number', d.document_number, 'mode', p_mode, 'count', i));
end $$;

-- 5b. Tandatangani satu langkah. Klien sudah mengunggah PDF hasil bubuh; di sini status & hash dikunci secara atomik.
create or replace function public.sign_document_step(p_step uuid, p_expected_sha text, p_new_file text, p_new_sha text, p_position jsonb default null, p_signed_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.document_signers%rowtype; d public.documents%rowtype; r text; uid uuid := auth.uid(); remaining int; completed boolean;
begin
  if uid is null then raise exception 'Belum login'; end if;
  r := public.current_role();
  select * into s from public.document_signers where id = p_step;
  if not found then raise exception 'Langkah tanda tangan tidak ditemukan'; end if;
  select * into d from public.documents where id = s.document_id for update;
  select * into s from public.document_signers where id = p_step;
  if d.status <> 'pending' then raise exception 'Dokumen tidak sedang menunggu tanda tangan (status: %)', d.status; end if;
  if s.status <> 'pending' then raise exception 'Giliran penandatangan ini belum tiba atau sudah selesai'; end if;
  if not (coalesce(r in ('super_admin','admin'), false) or (r = 'signer' and s.user_id = uid)) then
    raise exception 'Anda tidak berwenang menandatangani langkah ini';
  end if;
  if d.sha256 is distinct from p_expected_sha then
    raise exception 'Dokumen berubah sejak dimuat (mungkin sudah ditandatangani penandatangan lain). Muat ulang dokumen lalu coba lagi';
  end if;
  if p_new_sha is null or p_new_sha !~ '^[0-9a-f]{64}$' then raise exception 'Hash PDF tidak valid'; end if;
  if p_new_file is null or p_new_file not like d.verification_id::text || '-%-signed.pdf' then raise exception 'Nama file hasil tanda tangan tidak valid'; end if;

  update public.document_signers set status = 'signed', signed_at = p_signed_at, file_path = p_new_file, sha256 = p_new_sha where id = p_step;
  select count(*) into remaining from public.document_signers where document_id = d.id and status in ('pending','waiting');
  completed := remaining = 0;

  perform set_config('app.workflow', 'on', true);
  update public.documents set
    original_file_path = coalesce(original_file_path, file_path),
    original_sha256 = coalesce(original_sha256, sha256),
    file_path = p_new_file,
    sha256 = p_new_sha,
    signature_position = coalesce(p_position, signature_position),
    status = case when completed then 'verified' else status end,
    signed_by = case when completed then uid else signed_by end,
    signed_at = case when completed then p_signed_at else signed_at end,
    issued_at = case when completed then (p_signed_at at time zone 'Asia/Jakarta')::date else issued_at end
  where id = d.id;
  perform set_config('app.workflow', '', true);

  if not completed and d.sign_mode = 'sequential'
     and not exists (select 1 from public.document_signers where document_id = d.id and status = 'pending') then
    update public.document_signers set status = 'pending'
     where id = (select id from public.document_signers where document_id = d.id and status = 'waiting' order by step limit 1);
  end if;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (uid, 'document.sign_step', 'document', d.id,
    jsonb_build_object('document_number', d.document_number, 'step', s.step, 'signer', s.signer_name, 'completed', completed, 'verification_id', d.verification_id));
  return jsonb_build_object('completed', completed, 'status', case when completed then 'verified' else 'pending' end);
end $$;

-- 5c. Tolak / kembalikan dokumen dengan catatan
create or replace function public.reject_document(p_doc uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare d public.documents%rowtype; r text; uid uuid := auth.uid(); s public.document_signers%rowtype;
begin
  if uid is null then raise exception 'Belum login'; end if;
  r := public.current_role();
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Catatan penolakan wajib diisi'; end if;
  select * into d from public.documents where id = p_doc for update;
  if not found then raise exception 'Dokumen tidak ditemukan'; end if;
  if d.status <> 'pending' then raise exception 'Hanya dokumen yang menunggu tanda tangan yang dapat ditolak'; end if;
  select * into s from public.document_signers where document_id = p_doc and status = 'pending' and (user_id = uid or coalesce(r in ('super_admin','admin'), false))
    order by (user_id = uid) desc nulls last, step limit 1;
  if not found then raise exception 'Anda tidak berwenang menolak dokumen ini'; end if;

  update public.document_signers set status = 'rejected', note = btrim(p_reason), signed_at = now() where id = s.id;
  perform set_config('app.workflow', 'on', true);
  update public.documents set status = 'rejected', reject_reason = btrim(p_reason), rejected_by = uid, rejected_at = now() where id = p_doc;
  perform set_config('app.workflow', '', true);
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (uid, 'document.reject', 'document', p_doc,
    jsonb_build_object('document_number', d.document_number, 'step', s.step, 'signer', s.signer_name, 'reason', btrim(p_reason)));
end $$;

-- 5d. Ajukan ulang setelah revisi (admin/sekretaris). Tanda tangan sebagian dari versi lama dibuang.
create or replace function public.resubmit_document(p_doc uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.documents%rowtype; uid uuid := auth.uid();
begin
  if uid is null or coalesce(public.current_role() in ('super_admin','admin','secretary'), false) = false then
    raise exception 'Hanya admin atau sekretaris yang dapat mengajukan ulang dokumen';
  end if;
  select * into d from public.documents where id = p_doc for update;
  if not found then raise exception 'Dokumen tidak ditemukan'; end if;
  if d.status not in ('rejected','draft','archived') then raise exception 'Dokumen berstatus % tidak dapat diajukan ulang', d.status; end if;
  if not exists (select 1 from public.document_signers where document_id = p_doc) then raise exception 'Tentukan penandatangan terlebih dahulu'; end if;

  perform set_config('app.workflow', 'on', true);
  update public.documents set
    status = 'pending', reject_reason = null, rejected_by = null, rejected_at = null,
    revision = revision + 1,
    file_path = case when original_file_path is not null then original_file_path else file_path end,
    sha256 = case when original_file_path is not null then original_sha256 else sha256 end,
    original_file_path = null, original_sha256 = null, signature_position = null
  where id = p_doc;
  perform set_config('app.workflow', '', true);

  update public.document_signers set
    status = case when d.sign_mode = 'parallel' or step = (select min(step) from public.document_signers where document_id = p_doc) then 'pending' else 'waiting' end,
    signed_at = null, file_path = null, sha256 = null, note = null
  where document_id = p_doc;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (uid, 'document.resubmit', 'document', p_doc, jsonb_build_object('document_number', d.document_number, 'revision', d.revision + 1));
end $$;

-- 5e. Hapus dokumen (admin) - versi baru: ikut mengembalikan file hasil tiap langkah tanda tangan
create or replace function public.delete_document(p_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.documents%rowtype; extra text[];
begin
  if auth.uid() is null or coalesce(public.current_role() in ('super_admin','admin'), false) = false then
    raise exception 'Hanya admin yang dapat menghapus dokumen bertanda tangan';
  end if;
  select * into d from public.documents where id = p_id;
  if not found then raise exception 'Dokumen tidak ditemukan'; end if;
  if d.status in ('verified','revoked') and coalesce(btrim(p_reason), '') = '' then raise exception 'Alasan penghapusan wajib diisi'; end if;
  select coalesce(array_agg(file_path), '{}') into extra from public.document_signers where document_id = p_id and file_path is not null;
  perform set_config('app.delete_reason', coalesce(btrim(p_reason), ''), true);
  delete from public.documents where id = p_id;
  perform set_config('app.delete_reason', '', true);
  return jsonb_build_object('file_path', d.file_path, 'original_file_path', d.original_file_path, 'extra_paths', to_jsonb(extra));
end $$;

revoke all on function public.set_document_signers(uuid, jsonb, text), public.sign_document_step(uuid, text, text, text, jsonb, timestamptz),
  public.reject_document(uuid, text), public.resubmit_document(uuid), public.delete_document(uuid, text) from public, anon;
grant execute on function public.set_document_signers(uuid, jsonb, text), public.sign_document_step(uuid, text, text, text, jsonb, timestamptz),
  public.reject_document(uuid, text), public.resubmit_document(uuid), public.delete_document(uuid, text) to authenticated;

------------------------------------------------------------------
-- 6. Verifikasi publik lewat fungsi (tabel dokumen tidak lagi dapat dibaca anonim) + riwayat verifikasi
------------------------------------------------------------------
create table if not exists public.verification_logs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  method text not null default 'manual',
  created_at timestamptz not null default now()
);
create index if not exists verification_logs_doc_idx on public.verification_logs(document_id, created_at desc);
alter table public.verification_logs enable row level security;
drop policy if exists "staff read verification logs" on public.verification_logs;
create policy "staff read verification logs" on public.verification_logs for select to authenticated
  using (public.current_role() in ('super_admin','admin','secretary'));

create or replace function public.verify_document(p_key text, p_method text default 'manual')
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text := btrim(coalesce(p_key, '')); d public.documents%rowtype; sg jsonb; m text;
begin
  m := case when p_method in ('qr','manual','kamera','unggah') then p_method else 'manual' end;
  if k ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into d from public.documents where verification_id = k::uuid;
  elsif k ~* '^[0-9a-f]{10}$' then
    if (select count(*) from public.documents where short_code = upper(k)) > 1 then
      return jsonb_build_object('found', false, 'ambiguous', true);
    end if;
    select * into d from public.documents where short_code = upper(k);
  else
    return jsonb_build_object('found', false);
  end if;
  if not found then return jsonb_build_object('found', false); end if;

  select coalesce(jsonb_agg(jsonb_build_object('step', step, 'name', signer_name, 'position', signer_position, 'status', status, 'signed_at', signed_at) order by step), '[]'::jsonb)
    into sg from public.document_signers where document_id = d.id;
  insert into public.verification_logs(document_id, method) values (d.id, m);

  return jsonb_build_object(
    'found', true, 'document_number', d.document_number, 'title', d.title, 'status', d.status,
    'issued_at', d.issued_at, 'signed_at', d.signed_at,
    'revoked_reason', case when d.status = 'revoked' then d.revoked_reason end, 'revoked_at', d.revoked_at,
    'sha256', d.sha256, 'original_sha256', d.original_sha256,
    'verification_id', d.verification_id, 'short_code', d.short_code, 'signers', sg,
    'downloadable', (d.public_access and d.status = 'verified' and d.file_path is not null),
    'file_path', case when d.public_access and d.status = 'verified' then d.file_path end);
end $$;

revoke all on function public.verify_document(text, text) from public;
grant execute on function public.verify_document(text, text) to anon, authenticated;

-- Tabel dokumen hanya untuk akun login; publik memakai verify_document
drop policy if exists "public verify document metadata" on public.documents;
drop policy if exists "authenticated read documents" on public.documents;
create policy "authenticated read documents" on public.documents for select to authenticated using (true);

-- Publik boleh membaca PDF bertanda tangan milik dokumen terverifikasi yang public_access-nya aktif (pratinjau/unduh di halaman Verifikasi)
drop policy if exists "public read verified documents" on storage.objects;
create policy "public read verified documents" on storage.objects for select to anon, authenticated
using (bucket_id = 'documents' and exists (
  select 1 from public.documents d where d.public_access and d.status = 'verified' and d.file_path = storage.objects.name
));

------------------------------------------------------------------
-- 7. Surat masuk dan disposisi
------------------------------------------------------------------
create table if not exists public.incoming_letters (
  id uuid primary key default gen_random_uuid(),
  agenda_no text,
  letter_number text,
  sender text not null,
  subject text not null,
  letter_date date,
  received_date date not null default (now() at time zone 'Asia/Jakarta')::date,
  priority text not null default 'biasa' check (priority in ('biasa','segera','rahasia')),
  status text not null default 'baru' check (status in ('baru','diproses','selesai')),
  notes text,
  file_path text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.dispositions (
  id uuid primary key default gen_random_uuid(),
  letter_id uuid not null references public.incoming_letters(id) on delete cascade,
  to_owner_id uuid references public.signature_owners(id) on delete set null,
  to_user_id uuid references auth.users(id) on delete set null,
  to_name text not null,
  instruction text not null,
  due_date date,
  status text not null default 'belum' check (status in ('belum','dikerjakan','selesai')),
  response text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dispositions_letter_idx on public.dispositions(letter_id);

alter table public.incoming_letters enable row level security;
alter table public.dispositions enable row level security;
drop policy if exists "staff read incoming letters" on public.incoming_letters;
drop policy if exists "staff manage incoming letters" on public.incoming_letters;
drop policy if exists "staff read dispositions" on public.dispositions;
drop policy if exists "staff manage dispositions" on public.dispositions;
drop policy if exists "assignee update disposition" on public.dispositions;
create policy "staff read incoming letters" on public.incoming_letters for select to authenticated
  using (public.current_role() in ('super_admin','admin','secretary','signer'));
create policy "staff manage incoming letters" on public.incoming_letters for all to authenticated
  using (public.current_role() in ('super_admin','admin','secretary')) with check (public.current_role() in ('super_admin','admin','secretary'));
create policy "staff read dispositions" on public.dispositions for select to authenticated
  using (public.current_role() in ('super_admin','admin','secretary','signer'));
create policy "staff manage dispositions" on public.dispositions for all to authenticated
  using (public.current_role() in ('super_admin','admin','secretary')) with check (public.current_role() in ('super_admin','admin','secretary'));
create policy "assignee update disposition" on public.dispositions for update to authenticated
  using (to_user_id = auth.uid()) with check (to_user_id = auth.uid());

-- Penerima disposisi hanya boleh mengubah status dan tanggapan
create or replace function public.dispositions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(current_setting('app.account_deletion', true), '') = 'on' then return new; end if;
  if coalesce(public.current_role() in ('super_admin','admin','secretary'), false) = false then
    if new.letter_id is distinct from old.letter_id or new.to_name is distinct from old.to_name or new.instruction is distinct from old.instruction
       or new.due_date is distinct from old.due_date or new.to_user_id is distinct from old.to_user_id or new.to_owner_id is distinct from old.to_owner_id then
      raise exception 'Penerima disposisi hanya dapat mengubah status dan tanggapan';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists dispositions_guard_trg on public.dispositions;
create trigger dispositions_guard_trg before update on public.dispositions for each row execute function public.dispositions_guard();

------------------------------------------------------------------
-- 8. Penghapusan akun: versi terbaru (tambahan referensi baru dikosongkan otomatis lewat on delete set null)
------------------------------------------------------------------
create or replace function public._purge_user(p_uid uuid, p_actor uuid)
returns void language plpgsql security definer set search_path = public as $$
declare p public.profiles%rowtype;
begin
  select * into p from public.profiles where id = p_uid;
  if p.role = 'super_admin' and (select count(*) from public.profiles where role = 'super_admin' and status = 'active' and id <> p_uid) = 0 then
    raise exception 'Tidak dapat menghapus Super Admin terakhir. Alihkan peran Super Admin ke akun lain terlebih dahulu.';
  end if;
  perform set_config('app.account_deletion', 'on', true);

  update public.audit_logs
     set details = details || jsonb_build_object('actor_deleted', coalesce(nullif(p.full_name, ''), p.email, 'akun terhapus')), actor_id = null
   where actor_id = p_uid;
  update public.documents set signed_by = null where signed_by = p_uid;
  update public.documents set revoked_by = null where revoked_by = p_uid;
  update public.documents set rejected_by = null where rejected_by = p_uid;
  update public.documents set signer_user_id = null where signer_user_id = p_uid;
  update public.document_groups set created_by = null where created_by = p_uid;
  update public.signature_owners set user_id = null where user_id = p_uid;
  update public.document_signers set user_id = null where user_id = p_uid;
  update public.dispositions set to_user_id = null where to_user_id = p_uid;
  update public.dispositions set created_by = null where created_by = p_uid;
  update public.incoming_letters set created_by = null where created_by = p_uid;
  update public.app_settings set updated_by = null where updated_by = p_uid;
  begin
    update storage.objects set owner = null where owner = p_uid;
  exception when others then null;
  end;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (case when p_actor = p_uid then null else p_actor end, 'account.delete', 'profile', p_uid,
    jsonb_build_object('account_name', p.full_name, 'account_email', p.email, 'role', p.role, 'self', p_actor = p_uid) ||
    case when p_actor = p_uid then jsonb_build_object('actor_deleted', coalesce(nullif(p.full_name, ''), p.email)) else '{}'::jsonb end);

  delete from auth.users where id = p_uid;
  perform set_config('app.account_deletion', '', true);
end $$;
revoke all on function public._purge_user(uuid, uuid) from public, anon, authenticated;

------------------------------------------------------------------
-- 9. Notifikasi otomatis (OPSIONAL). Aktif hanya bila Edge Function sudah dipasang dan private_settings diisi.
--    Lihat README bagian "Notifikasi email / WhatsApp".
------------------------------------------------------------------
create or replace function public.notify_signer() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text; d public.documents%rowtype; body jsonb;
begin
  if new.status <> 'pending' or (tg_op = 'UPDATE' and old.status = 'pending') then return new; end if;
  select value into v_url from public.private_settings where key = 'notify_url';
  if coalesce(v_url, '') = '' then return new; end if;
  select value into v_secret from public.private_settings where key = 'notify_secret';
  select * into d from public.documents where id = new.document_id;
  if d.status <> 'pending' then return new; end if;
  body := jsonb_build_object('type', 'sign_request', 'document_id', d.id, 'document_number', d.document_number, 'title', d.title,
    'step_id', new.id, 'signer_user_id', new.user_id, 'signer_owner_id', new.owner_id, 'signer_name', new.signer_name);
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      using v_url, body, jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', coalesce(v_secret, ''));
  exception when others then null;  -- pg_net belum aktif / gagal kirim: jangan menggagalkan transaksi
  end;
  return new;
end $$;

drop trigger if exists document_signers_notify_trg on public.document_signers;
create trigger document_signers_notify_trg after insert or update of status on public.document_signers
  for each row execute function public.notify_signer();
