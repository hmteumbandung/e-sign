-- SIGNATURE HUB HMTE UMBandung
-- Fitur tambahan: kelompok surat, kode singkat QR, hapus dokumen terverifikasi, hapus data pengurus/tanda tangan,
-- profil & hapus akun. Jalankan SETELAH schema.sql, account-setup.sql, dan esign-setup.sql (versi terbaru).
-- Aman dijalankan berulang kali.

------------------------------------------------------------------
-- 1. Kelompok surat
------------------------------------------------------------------
create table if not exists public.document_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  color text not null default '#2563EB' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  description text check (description is null or length(description) <= 160),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists document_groups_name_key on public.document_groups (lower(btrim(name)));

alter table public.documents
  add column if not exists group_id uuid references public.document_groups(id) on delete set null;
create index if not exists documents_group_id_idx on public.documents(group_id);

alter table public.document_groups enable row level security;
drop policy if exists "authenticated read groups" on public.document_groups;
drop policy if exists "staff manage groups" on public.document_groups;
create policy "authenticated read groups" on public.document_groups for select to authenticated using (true);
create policy "staff manage groups" on public.document_groups for all to authenticated
  using (public.current_role() in ('super_admin','admin','secretary'))
  with check (public.current_role() in ('super_admin','admin','secretary'));

------------------------------------------------------------------
-- 2. Kode singkat (10 karakter) yang tampil di bawah QR. Dipakai pada halaman Verifikasi.
--    Sama dengan: 10 karakter pertama verification_id tanpa tanda hubung, huruf besar.
------------------------------------------------------------------
alter table public.documents add column if not exists short_code text;

create or replace function public.documents_set_short_code()
returns trigger language plpgsql as $$
begin
  new.short_code := upper(left(replace(new.verification_id::text, '-', ''), 10));
  return new;
end $$;

drop trigger if exists documents_short_code_trg on public.documents;
create trigger documents_short_code_trg before insert or update of verification_id on public.documents
  for each row execute function public.documents_set_short_code();

update public.documents
set short_code = upper(left(replace(verification_id::text, '-', ''), 10))
where short_code is distinct from upper(left(replace(verification_id::text, '-', ''), 10));

create index if not exists documents_short_code_idx on public.documents(short_code);

------------------------------------------------------------------
-- 3. Hapus dokumen (admin). Wajib alasan untuk dokumen terverifikasi/dicabut; tercatat di audit_logs.
--    Mengembalikan path file agar klien dapat menghapusnya dari storage.
------------------------------------------------------------------
create or replace function public.delete_document(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d public.documents%rowtype;
begin
  if auth.uid() is null or coalesce(public.current_role() in ('super_admin','admin'), false) = false then
    raise exception 'Hanya admin yang dapat menghapus dokumen bertanda tangan';
  end if;
  select * into d from public.documents where id = p_id;
  if not found then raise exception 'Dokumen tidak ditemukan'; end if;
  if d.status in ('verified','revoked') and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Alasan penghapusan wajib diisi';
  end if;
  perform set_config('app.delete_reason', coalesce(btrim(p_reason), ''), true);
  delete from public.documents where id = p_id;
  perform set_config('app.delete_reason', '', true);
  return jsonb_build_object('file_path', d.file_path, 'original_file_path', d.original_file_path);
end $$;

revoke all on function public.delete_document(uuid, text) from public, anon;
grant execute on function public.delete_document(uuid, text) to authenticated;

------------------------------------------------------------------
-- 4. Audit penghapusan data pengurus / tanda tangan
------------------------------------------------------------------
create or replace function public.log_signer_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'signer.delete', 'signature_owner', old.id,
      jsonb_build_object('full_name', old.full_name, 'position', old.position, 'had_signature', old.signature_path is not null));
    return old;
  elsif old.signature_path is distinct from new.signature_path then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'signer.signature', 'signature_owner', new.id,
      jsonb_build_object('full_name', new.full_name, 'position', new.position,
        'change', case when new.signature_path is null then 'dihapus' when old.signature_path is null then 'diunggah' else 'diganti' end));
  end if;
  return new;
end $$;

drop trigger if exists signature_owners_audit_trg on public.signature_owners;
create trigger signature_owners_audit_trg after update or delete on public.signature_owners
  for each row execute function public.log_signer_change();

-- Hapus data pengurus & tanda tangan: hanya admin (policy lama mengizinkan sekretaris mengelola baris, tetapi file
-- tanda tangan di storage hanya dapat dihapus admin, sehingga penghapusan dibatasi ke admin).
drop policy if exists "admins delete signers" on public.signature_owners;
drop policy if exists "admins manage signers" on public.signature_owners;
drop policy if exists "staff insert update signers" on public.signature_owners;
drop policy if exists "staff insert signers" on public.signature_owners;
create policy "staff insert signers" on public.signature_owners for insert to authenticated
  with check (public.current_role() in ('super_admin','admin','secretary'));
drop policy if exists "staff update signers" on public.signature_owners;
create policy "staff update signers" on public.signature_owners for update to authenticated
  using (public.current_role() in ('super_admin','admin','secretary'))
  with check (public.current_role() in ('super_admin','admin','secretary'));
create policy "admins delete signers" on public.signature_owners for delete to authenticated
  using (public.current_role() in ('super_admin','admin'));

------------------------------------------------------------------
-- 5. Profil sendiri (nama, NIM) dan sinkron email
--    Pengguna tidak dapat mengubah role/status lewat tabel; hanya lewat fungsi ini.
------------------------------------------------------------------
create or replace function public.update_my_profile(p_full_name text, p_nim text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 or length(p_full_name) > 80 then
    raise exception 'Nama harus 2-80 karakter';
  end if;
  if p_nim is not null and length(p_nim) > 30 then raise exception 'NIM terlalu panjang'; end if;
  update public.profiles set full_name = btrim(p_full_name), nim = nullif(btrim(coalesce(p_nim, '')), '')
  where id = auth.uid();
end $$;

revoke all on function public.update_my_profile(text, text) from public, anon;
grant execute on function public.update_my_profile(text, text) to authenticated;

create or replace function public.sync_profile_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.sync_profile_email();

------------------------------------------------------------------
-- 6. Hapus akun
--    * Dokumen & riwayat yang pernah dibuat akun tetap ada (referensi dikosongkan; nama disimpan di audit).
--    * Super Admin terakhir tidak dapat dihapus.
--    _purge_user bersifat internal (tidak dapat dipanggil dari klien).
------------------------------------------------------------------
create or replace function public._purge_user(p_uid uuid, p_actor uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  p public.profiles%rowtype;
begin
  select * into p from public.profiles where id = p_uid;
  if p.role = 'super_admin' and (select count(*) from public.profiles where role = 'super_admin' and status = 'active' and id <> p_uid) = 0 then
    raise exception 'Tidak dapat menghapus Super Admin terakhir. Alihkan peran Super Admin ke akun lain terlebih dahulu.';
  end if;

  perform set_config('app.account_deletion', 'on', true);  -- melewati penjaga trigger selama transaksi ini

  -- simpan jejak: nama pelaku pada audit lama, lalu lepaskan referensi
  update public.audit_logs
     set details = details || jsonb_build_object('actor_deleted', coalesce(nullif(p.full_name, ''), p.email, 'akun terhapus')),
         actor_id = null
   where actor_id = p_uid;
  update public.documents set signed_by = null where signed_by = p_uid;
  update public.documents set revoked_by = null where revoked_by = p_uid;
  update public.documents set signer_user_id = null where signer_user_id = p_uid;
  update public.document_groups set created_by = null where created_by = p_uid;
  update public.signature_owners set user_id = null where user_id = p_uid;
  begin
    update storage.objects set owner = null where owner = p_uid;
  exception when others then null; -- kolom owner dapat berbeda antarversi Supabase
  end;

  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values (case when p_actor = p_uid then null else p_actor end, 'account.delete', 'profile', p_uid,
    jsonb_build_object('account_name', p.full_name, 'account_email', p.email, 'role', p.role,
      'self', p_actor = p_uid) ||
    case when p_actor = p_uid then jsonb_build_object('actor_deleted', coalesce(nullif(p.full_name, ''), p.email)) else '{}'::jsonb end);

  delete from auth.users where id = p_uid;  -- profiles ikut terhapus (on delete cascade)
  perform set_config('app.account_deletion', '', true);
end $$;

revoke all on function public._purge_user(uuid, uuid) from public, anon, authenticated;

create or replace function public.delete_my_account()
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Belum login'; end if;
  perform public._purge_user(auth.uid(), auth.uid());
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.current_role() is distinct from 'super_admin' then
    raise exception 'Hanya Super Admin yang dapat menghapus akun pengguna';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Untuk menghapus akun sendiri, gunakan menu Akun Saya';
  end if;
  perform public._purge_user(p_user_id, auth.uid());
end $$;

revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
