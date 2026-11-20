-- Pindahkan is_admin() ke schema private agar tidak bisa dipanggil lewat REST /rpc.
create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_admin()
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
revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

do $$
declare p record;
begin
  for p in
    select tablename, policyname, cmd from pg_policies
    where schemaname = 'public' and policyname like 'admin %'
  loop
    if p.cmd in ('SELECT', 'DELETE') then
      execute format('alter policy %I on public.%I using (private.is_admin())', p.policyname, p.tablename);
    elsif p.cmd = 'INSERT' then
      execute format('alter policy %I on public.%I with check (private.is_admin())', p.policyname, p.tablename);
    else
      execute format('alter policy %I on public.%I using (private.is_admin()) with check (private.is_admin())', p.policyname, p.tablename);
    end if;
  end loop;
end $$;

drop function public.is_admin();
