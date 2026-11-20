-- Akses webapp admin: hanya email di tabel admins yang bisa membaca/mengubah data bot.
-- Edge Function memakai service role sehingga tidak terpengaruh RLS.

-- 1) Gaya balasan: bot tidak memperkenalkan diri sebagai bot (default)
alter table public.brands add column if not exists perkenalkan_bot boolean not null default false;

-- 2) Daftar admin
create table if not exists public.admins (
  email text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
comment on table public.admins is 'ozzy-chatbot';

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 3) Policy: hanya admin (login) yang boleh
create policy "admin baca admins" on public.admins for select to authenticated using (public.is_admin());
create policy "admin tambah admins" on public.admins for insert to authenticated with check (public.is_admin());
create policy "admin hapus admins" on public.admins for delete to authenticated using (public.is_admin());

create policy "admin baca brands" on public.brands for select to authenticated using (public.is_admin());
create policy "admin ubah brands" on public.brands for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin baca knowledge" on public.knowledge for select to authenticated using (public.is_admin());
create policy "admin tambah knowledge" on public.knowledge for insert to authenticated with check (public.is_admin());
create policy "admin ubah knowledge" on public.knowledge for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin hapus knowledge" on public.knowledge for delete to authenticated using (public.is_admin());

create policy "admin baca conversations" on public.conversations for select to authenticated using (public.is_admin());
create policy "admin ubah conversations" on public.conversations for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admin baca messages" on public.messages for select to authenticated using (public.is_admin());

create policy "admin baca escalations" on public.escalations for select to authenticated using (public.is_admin());
create policy "admin ubah escalations" on public.escalations for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- 4) Akun sosmed: token akses hanya bisa DITULIS dari webapp, tidak bisa dibaca kembali.
create policy "admin baca accounts" on public.accounts for select to authenticated using (public.is_admin());
create policy "admin tambah accounts" on public.accounts for insert to authenticated with check (public.is_admin());
create policy "admin ubah accounts" on public.accounts for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin hapus accounts" on public.accounts for delete to authenticated using (public.is_admin());
revoke select on public.accounts from anon, authenticated;
grant select (id, channel, account_id, brand_id, label, api, send_as_id, aktif, created_at) on public.accounts to authenticated;
create unique index if not exists accounts_channel_account_key on public.accounts (channel, account_id);

-- 5) Inbox realtime
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'conversations') then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;
