-- SIGNATURE HUB HMTE UMBandung - initial schema
create extension if not exists pgcrypto;

create table if not exists public.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null default '',
 role text not null default 'viewer' check (role in ('super_admin','admin','secretary','signer','viewer')),
 created_at timestamptz not null default now()
);

create table if not exists public.signature_owners (
 id uuid primary key default gen_random_uuid(),
 full_name text not null,
 student_id text,
 position text not null,
 department text,
 period text,
 status text not null default 'active' check(status in ('active','inactive','archived')),
 signature_path text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists public.documents (
 id uuid primary key default gen_random_uuid(),
 document_number text not null,
 title text not null,
 signer_name text,
 issued_at date,
 status text not null default 'pending' check(status in ('draft','pending','verified','rejected','revoked','archived')),
 verification_id uuid not null unique default gen_random_uuid(),
 sha256 text,
 file_path text,
 created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid references auth.users(id),
 action text not null,
 entity_type text not null,
 entity_id uuid,
 details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.signature_owners enable row level security;
alter table public.documents enable row level security;
alter table public.audit_logs enable row level security;

create or replace function public.current_role()
returns text language sql stable security definer set search_path = public
as $$ select role from public.profiles where id = auth.uid() $$;

create policy "profiles read self or admins" on public.profiles for select to authenticated
using (id = auth.uid() or public.current_role() in ('super_admin','admin'));
create policy "admins manage profiles" on public.profiles for all to authenticated
using (public.current_role() in ('super_admin','admin'))
with check (public.current_role() in ('super_admin','admin'));

create policy "authenticated read signers" on public.signature_owners for select to authenticated using (true);
create policy "admins manage signers" on public.signature_owners for all to authenticated
using (public.current_role() in ('super_admin','admin','secretary'))
with check (public.current_role() in ('super_admin','admin','secretary'));

-- Public verification exposes metadata only. Do not grant public access to storage objects.
create policy "public verify document metadata" on public.documents for select to anon, authenticated using (true);
create policy "admins manage documents" on public.documents for all to authenticated
using (public.current_role() in ('super_admin','admin','secretary'))
with check (public.current_role() in ('super_admin','admin','secretary'));

create policy "admins read audit" on public.audit_logs for select to authenticated
using (public.current_role() in ('super_admin','admin'));
create policy "authenticated insert audit" on public.audit_logs for insert to authenticated
with check (actor_id = auth.uid());

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values
 ('documents','documents',false,10485760,array['application/pdf']),
 ('signature-files','signature-files',false,2097152,array['image/png'])
on conflict (id) do nothing;

create policy "authorized users upload documents" on storage.objects for insert to authenticated
with check (bucket_id in ('documents','signature-files') and public.current_role() in ('super_admin','admin','secretary'));
create policy "authorized users read private files" on storage.objects for select to authenticated
using (bucket_id in ('documents','signature-files') and public.current_role() in ('super_admin','admin','secretary','signer'));
create policy "admins delete private files" on storage.objects for delete to authenticated
using (bucket_id in ('documents','signature-files') and public.current_role() in ('super_admin','admin'));

-- IMPORTANT:
-- 1) Assign the first super_admin manually after creating the Auth user:
--    insert into public.profiles(id,full_name,role) values ('AUTH-USER-UUID','Nama Admin','super_admin');
-- 2) Review RLS policies and public verification disclosure before production.
-- 3) For real digital signatures, integrate a recognized PSrE / certificate-based signing workflow.
