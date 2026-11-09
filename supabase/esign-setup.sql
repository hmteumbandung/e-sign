-- SIGNATURE HUB HMTE UMBandung
-- Fitur Penandatanganan Elektronik. Jalankan SETELAH schema.sql dan account-setup.sql.
-- Aman dijalankan berulang kali.

------------------------------------------------------------------
-- 1. Kolom tambahan
------------------------------------------------------------------
alter table public.documents
  add column if not exists original_sha256 text,        -- SHA-256 PDF sebelum ditandatangani
  add column if not exists original_file_path text,     -- path PDF asli (file_path = PDF bertanda tangan)
  add column if not exists signed_at timestamptz,
  add column if not exists signed_by uuid references auth.users(id),
  add column if not exists signer_user_id uuid references auth.users(id), -- akun yang ditugaskan menandatangani
  add column if not exists signature_position jsonb,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id),
  add column if not exists revoked_reason text;

-- Hubungan pengurus -> akun login. Hanya admin yang boleh mengisi (lihat trigger di bawah).
alter table public.signature_owners
  add column if not exists user_id uuid references auth.users(id) on delete set null;
create unique index if not exists signature_owners_user_id_key
  on public.signature_owners(user_id) where user_id is not null;

------------------------------------------------------------------
-- 2. Penjaga data dokumen (validasi sisi server)
--    - hash harus 64 heksadesimal
--    - status 'verified' hanya oleh admin, atau oleh penandatangan yang DITUGASKAN
--    - dokumen terverifikasi tidak dapat diubah isinya; hanya boleh dicabut oleh admin
--    - dokumen yang dicabut bersifat final
--    Eksekusi dari SQL Editor / service role (auth.uid() null) tidak dibatasi.
------------------------------------------------------------------
create or replace function public.documents_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r text := public.current_role();
  uid uuid := auth.uid();
  is_admin boolean := coalesce(r in ('super_admin','admin'), false);
  hex_re constant text := '^[0-9a-f]{64}$';
begin
  -- SQL Editor / service role (auth.uid() null) dan fungsi penghapusan akun (flag lokal transaksi) tidak dibatasi.
  if uid is null or coalesce(current_setting('app.account_deletion', true), '') = 'on' then return new; end if;

  if new.sha256 is not null and new.sha256 !~ hex_re then
    raise exception 'sha256 harus 64 karakter heksadesimal huruf kecil';
  end if;
  if new.original_sha256 is not null and new.original_sha256 !~ hex_re then
    raise exception 'original_sha256 harus 64 karakter heksadesimal huruf kecil';
  end if;

  if tg_op = 'INSERT' then
    if new.status in ('verified','revoked') and not is_admin then
      raise exception 'Hanya admin yang dapat membuat dokumen langsung berstatus %', new.status;
    end if;
    if new.status = 'revoked' then
      raise exception 'Dokumen baru tidak boleh berstatus revoked';
    end if;
    if new.status = 'verified' then
      if new.sha256 is null or new.original_sha256 is null or new.file_path is null then
        raise exception 'Dokumen terverifikasi wajib memiliki sha256, original_sha256, dan file_path';
      end if;
      new.signed_by := uid;
      new.signed_at := coalesce(new.signed_at, now());
    else
      new.signed_by := null;
      new.signed_at := null;
    end if;
    new.revoked_at := null; new.revoked_by := null; new.revoked_reason := null;
    return new;
  end if;

  -- UPDATE
  if new.verification_id is distinct from old.verification_id then
    raise exception 'verification_id tidak boleh diubah';
  end if;
  if old.status = 'revoked' then
    -- hanya pengelompokan (group_id) yang boleh berubah pada dokumen yang sudah dicabut
    if (to_jsonb(new) - 'group_id') is distinct from (to_jsonb(old) - 'group_id') then
      raise exception 'Dokumen yang sudah dicabut bersifat final';
    end if;
    return new;
  end if;

  if old.status = 'verified' then
    if new.status not in ('verified','revoked') then
      raise exception 'Dokumen terverifikasi hanya dapat dicabut';
    end if;
    if new.sha256 is distinct from old.sha256 or new.original_sha256 is distinct from old.original_sha256
       or new.file_path is distinct from old.file_path or new.original_file_path is distinct from old.original_file_path
       or new.signed_at is distinct from old.signed_at or new.signed_by is distinct from old.signed_by
       or new.document_number is distinct from old.document_number or new.title is distinct from old.title
       or new.signer_name is distinct from old.signer_name or new.signer_user_id is distinct from old.signer_user_id
       or new.signature_position is distinct from old.signature_position then
      raise exception 'Isi dokumen terverifikasi tidak dapat diubah';
    end if;
    if new.status = 'revoked' then
      if not is_admin then raise exception 'Hanya admin yang dapat mencabut dokumen'; end if;
      if coalesce(btrim(new.revoked_reason), '') = '' then raise exception 'Alasan pencabutan wajib diisi'; end if;
      new.revoked_at := now();
      new.revoked_by := uid;
    else
      new.revoked_at := null; new.revoked_by := null; new.revoked_reason := null;
    end if;
    return new;
  end if;

  -- old.status belum terverifikasi
  if new.status = 'revoked' then
    raise exception 'Hanya dokumen terverifikasi yang dapat dicabut';
  end if;
  new.revoked_at := null; new.revoked_by := null; new.revoked_reason := null;

  if new.status = 'verified' then
    if not (is_admin or (r = 'signer' and old.signer_user_id = uid and old.status = 'pending')) then
      raise exception 'Anda tidak berwenang menandatangani dokumen ini';
    end if;
    if r = 'signer' and (new.document_number is distinct from old.document_number or new.title is distinct from old.title
       or new.signer_name is distinct from old.signer_name or new.signer_user_id is distinct from old.signer_user_id) then
      raise exception 'Penandatangan tidak boleh mengubah data surat';
    end if;
    if new.sha256 is null or new.original_sha256 is null or new.file_path is null then
      raise exception 'Dokumen terverifikasi wajib memiliki sha256, original_sha256, dan file_path';
    end if;
    new.signed_by := uid;
    new.signed_at := coalesce(new.signed_at, now());
  else
    if r = 'signer' then raise exception 'Penandatangan tidak boleh mengubah dokumen selain menandatangani'; end if;
    new.signed_by := old.signed_by;
    new.signed_at := old.signed_at;
  end if;
  return new;
end $$;

drop trigger if exists documents_guard_trg on public.documents;
create trigger documents_guard_trg before insert or update on public.documents
  for each row execute function public.documents_guard();

-- Penandatangan yang ditugaskan boleh mengubah dokumen miliknya yang masih pending (dibatasi trigger di atas).
drop policy if exists "assigned signer signs documents" on public.documents;
create policy "assigned signer signs documents" on public.documents for update to authenticated
  using (public.current_role() = 'signer' and signer_user_id = auth.uid() and status = 'pending')
  with check (public.current_role() = 'signer' and signer_user_id = auth.uid());

------------------------------------------------------------------
-- 3. Audit log otomatis (tidak bergantung pada klien)
------------------------------------------------------------------
create or replace function public.log_document_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), case when new.status = 'verified' then 'document.sign' else 'document.create' end, 'document', new.id,
      jsonb_build_object('document_number', new.document_number, 'status', new.status, 'verification_id', new.verification_id, 'sha256', new.sha256));
  elsif tg_op = 'DELETE' then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'document.delete', 'document', old.id,
      jsonb_build_object('document_number', old.document_number, 'title', old.title, 'status', old.status, 'verification_id', old.verification_id, 'sha256', old.sha256,
        'reason', nullif(current_setting('app.delete_reason', true), '')));
    return old;
  elsif old.status is distinct from new.status then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(),
      case new.status when 'verified' then 'document.sign' when 'revoked' then 'document.revoke' else 'document.status' end,
      'document', new.id,
      jsonb_build_object('document_number', new.document_number, 'from', old.status, 'to', new.status,
        'verification_id', new.verification_id, 'sha256', new.sha256, 'reason', new.revoked_reason));
  elsif new.document_number is distinct from old.document_number or new.title is distinct from old.title
     or new.signer_name is distinct from old.signer_name or new.signer_user_id is distinct from old.signer_user_id
     or new.sha256 is distinct from old.sha256 then
    insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'document.update', 'document', new.id,
      jsonb_build_object('document_number', new.document_number, 'verification_id', new.verification_id,
        'before', jsonb_build_object('document_number', old.document_number, 'title', old.title, 'signer_name', old.signer_name, 'sha256', old.sha256),
        'after', jsonb_build_object('document_number', new.document_number, 'title', new.title, 'signer_name', new.signer_name, 'sha256', new.sha256)));
  end if;
  return new;
end $$;

drop trigger if exists documents_audit_trg on public.documents;
create trigger documents_audit_trg after insert or update or delete on public.documents
  for each row execute function public.log_document_change();

-- Dokumen terverifikasi / dicabut hanya boleh dihapus oleh admin (lewat fungsi delete_document di features-setup.sql,
-- yang mewajibkan alasan dan mencatatnya di audit). Pengguna lain tetap harus memakai "cabut".
create or replace function public.documents_no_delete_signed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and old.status in ('verified','revoked')
     and coalesce(public.current_role() in ('super_admin','admin'), false) = false then
    raise exception 'Dokumen berstatus % hanya dapat dihapus oleh admin. Gunakan pencabutan untuk membatalkan.', old.status;
  end if;
  return old;
end $$;

drop trigger if exists documents_no_delete_trg on public.documents;
create trigger documents_no_delete_trg before delete on public.documents
  for each row execute function public.documents_no_delete_signed();

-- audit_logs tidak boleh diisi langsung oleh klien (hanya lewat trigger).
drop policy if exists "authenticated insert audit" on public.audit_logs;

------------------------------------------------------------------
-- 4. Hubungan pengurus -> akun hanya oleh admin
------------------------------------------------------------------
create or replace function public.signature_owners_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or coalesce(current_setting('app.account_deletion', true), '') = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    if new.user_id is not null and coalesce(public.current_role() in ('super_admin','admin'), false) = false then
      raise exception 'Hanya admin yang dapat menghubungkan pengurus dengan akun';
    end if;
  elsif new.user_id is distinct from old.user_id and coalesce(public.current_role() in ('super_admin','admin'), false) = false then
    raise exception 'Hanya admin yang dapat menghubungkan pengurus dengan akun';
  end if;
  return new;
end $$;

drop trigger if exists signature_owners_guard_trg on public.signature_owners;
create trigger signature_owners_guard_trg before insert or update on public.signature_owners
  for each row execute function public.signature_owners_guard();

------------------------------------------------------------------
-- 5. Storage
--    * dokumen : admin/secretary/signer dapat membaca; signer dapat mengunggah PDF bertanda tangan
--    * file tanda tangan : hanya admin atau PEMILIKNYA (pengurus yang terhubung ke akun) yang dapat membaca
------------------------------------------------------------------
drop policy if exists "authorized users read private files" on storage.objects;
drop policy if exists "read documents bucket" on storage.objects;
drop policy if exists "read signature files admin or owner" on storage.objects;
drop policy if exists "signers upload signed documents" on storage.objects;

create policy "read documents bucket" on storage.objects for select to authenticated
using (bucket_id = 'documents' and public.current_role() in ('super_admin','admin','secretary','signer'));

create policy "read signature files admin or owner" on storage.objects for select to authenticated
using (
  bucket_id = 'signature-files' and (
    public.current_role() in ('super_admin','admin')
    or exists (select 1 from public.signature_owners o where o.signature_path = storage.objects.name and o.user_id = auth.uid())
  )
);

create policy "signers upload signed documents" on storage.objects for insert to authenticated
with check (bucket_id = 'documents' and public.current_role() = 'signer' and name like '%-signed.pdf');

-- Sekretaris boleh menghapus/mengganti PDF asli (bukan hasil tanda tangan "*-signed.pdf") saat mengelola dokumen pending.
drop policy if exists "secretary delete unsigned files" on storage.objects;
create policy "secretary delete unsigned files" on storage.objects for delete to authenticated
using (bucket_id = 'documents' and public.current_role() = 'secretary' and name not like '%-signed.pdf');
