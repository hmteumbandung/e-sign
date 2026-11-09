-- SIGNATURE HUB HMTE UMBandung
-- Jalankan SETELAH schema.sql pada Supabase SQL Editor.

-- Tambahan data profil untuk registrasi dan persetujuan akun.
alter table public.profiles
  add column if not exists nim text,
  add column if not exists email text,
  add column if not exists status text not null default 'active';

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check check (status in ('pending','active','suspended'));

-- Akun yang baru mendaftar otomatis dibuat sebagai viewer dan pending.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, nim, email, role, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'nim', ''),
    new.email,
    'viewer',
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

-- Perbarui kebijakan profil: pengguna hanya dapat membaca profil sendiri;
-- admin dapat membaca semua profil; hanya super_admin yang dapat mengubah role/status.
drop policy if exists "profiles read self or admins" on public.profiles;
drop policy if exists "admins manage profiles" on public.profiles;
drop policy if exists "profiles select self or admins" on public.profiles;
drop policy if exists "super admins update profiles" on public.profiles;

create policy "profiles select self or admins"
on public.profiles for select to authenticated
using (
  id = auth.uid()
  or public.current_role() in ('super_admin','admin')
);

create policy "super admins update profiles"
on public.profiles for update to authenticated
using (public.current_role() = 'super_admin')
with check (public.current_role() = 'super_admin');

-- Sinkronkan email akun yang sudah ada sebelum fitur registrasi dipasang.
update public.profiles p
set email = u.email
from auth.users u
where u.id = p.id and p.email is distinct from u.email;

-- Bootstrap: setelah membuat akun pertama melalui halaman /daftar,
-- jalankan query di bawah dan ganti alamat email dengan email Super Admin.
-- Query ini harus dijalankan manual oleh pemilik project di SQL Editor.
--
-- update public.profiles
-- set role = 'super_admin', status = 'active'
-- where id = (select id from auth.users where email = 'email-admin@contoh.com');
