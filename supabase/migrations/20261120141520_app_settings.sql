-- Pengaturan API (Claude, Meta, Telegram) yang diisi dari webapp admin.
-- Nilai rahasia hanya bisa DITULIS oleh admin; tidak bisa dibaca kembali dari browser.
-- Edge Function membacanya dengan service role.

create table if not exists public.app_settings (
  key text primary key check (key in (
    'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'META_VERIFY_TOKEN', 'META_APP_SECRET', 'META_APP_ID', 'IG_APP_SECRET', 'GRAPH_VERSION',
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ALERT_WEBHOOK_URL'
  )),
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.app_settings enable row level security;
comment on table public.app_settings is 'ozzy-chatbot';
-- Tanpa policy & tanpa grant: anon/authenticated tidak bisa akses tabel langsung.
revoke all on public.app_settings from anon, authenticated;

-- Simpan / hapus satu pengaturan (hanya admin). value kosong = hapus.
create or replace function public.set_app_setting(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Hanya admin' using errcode = '42501';
  end if;
  if coalesce(trim(p_value), '') = '' then
    delete from public.app_settings where key = p_key;
  else
    insert into public.app_settings (key, value, updated_at, updated_by)
    values (p_key, trim(p_value), now(), auth.jwt() ->> 'email')
    on conflict (key) do update
      set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  end if;
end;
$$;

-- Status pengaturan untuk webapp: nilai rahasia hanya ditampilkan 4 karakter terakhir.
create or replace function public.app_settings_status()
returns table (key text, is_set boolean, preview text, updated_at timestamptz, updated_by text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Hanya admin' using errcode = '42501';
  end if;
  return query
    select s.key, true,
      case when s.key in ('ANTHROPIC_MODEL', 'META_APP_ID', 'TELEGRAM_CHAT_ID', 'GRAPH_VERSION')
           then s.value
           else '••••' || right(s.value, 4) end,
      s.updated_at, s.updated_by
    from public.app_settings s;
end;
$$;

revoke all on function public.set_app_setting(text, text) from public, anon;
revoke all on function public.app_settings_status() from public, anon;
grant execute on function public.set_app_setting(text, text) to authenticated;
grant execute on function public.app_settings_status() to authenticated;
