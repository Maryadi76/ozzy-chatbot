# Ozzy Chatbot: Supabase + GitHub + Vercel

Bot balasan otomatis Instagram DM, Facebook Messenger, dan WhatsApp untuk **Ozzy Clothing** dan **Hemca**, lengkap dengan webapp admin.

| Bagian | Lokasi |
|---|---|
| **Webapp admin** | https://ozzy-chat-admin.vercel.app (folder `webapp/`, deploy otomatis oleh Vercel dari GitHub) |
| **Webhook Meta** (Callback URL) | `https://hfajdpkirsrewjsouybu.supabase.co/functions/v1/meta-webhook` |
| Bot / Edge Function | `supabase/functions/meta-webhook/` (deploy otomatis oleh GitHub Actions) |
| Database | Supabase project *DevMarketingOzzy's Project* (`hfajdpkirsrewjsouybu`) |

```
Customer (IG / FB / WA) ─► Meta ─► Edge Function meta-webhook ─► Claude ─► balasan + tombol
                                         │  baca: brands, knowledge, accounts, app_settings
                                         ▼
                                   Supabase DB ◄──── Webapp admin (Vercel)
```

## Semua kunci & token diisi dari webapp

Kunci dan token **tidak perlu** diisi di Supabase Dashboard, Vercel, atau GitHub.

| Menu webapp | Isi |
|---|---|
| **Pengaturan API** | API key Claude, model AI, Meta App ID / App Secret / Verify token, Instagram App Secret, Telegram |
| **Akun sosmed** | ID + access token tiap akun IG, Halaman FB, dan nomor WA, beserta brand-nya |
| **Pengaturan bot** / **Knowledge base** | Gaya balasan, aturan, dan data produk tiap brand |

Nilai rahasia disimpan di tabel `app_settings` / `accounts`. Hanya Edge Function (service role) yang bisa membacanya; webapp hanya menampilkan 4 karakter terakhir. Secret di Supabase Dashboard tetap dipakai sebagai cadangan bila pengaturan di webapp kosong.

## Deploy otomatis

- **Webapp (Vercel)**: setiap push ke branch `main` → Vercel men-deploy folder `webapp/`.
- **Bot (Supabase)**: setiap push yang mengubah `supabase/functions/**` → GitHub Actions (`.github/workflows/deploy-supabase.yml`) men-deploy `meta-webhook`. Butuh satu secret repo GitHub: `SUPABASE_ACCESS_TOKEN` (Supabase → Account → Access Tokens).
- **Database**: migrasi ada di `supabase/migrations/` dan sudah diterapkan. Skema awal (`chatbot_init`) dibuat sebelum repo ini; ambil dengan `supabase db pull` bila perlu.

## Pertama kali pakai

1. Buka webapp → login (admin: email yang terdaftar di tabel `admins`).
2. **Pengaturan API** → isi API key Claude → klik **Tes koneksi Claude**.
3. **Pengaturan API** → isi Meta App Secret, App ID, dan Verify token (tombol *Acak* membuat token sekaligus menyalinnya).
4. Meta App → Webhooks: Callback URL diisi URL webhook di atas, Verify token diisi sama.
   Subscribe: Page → `messages`, `messaging_postbacks`, `message_echoes`; Instagram → `messages`; WhatsApp → `messages`.
5. **Akun sosmed** → tambahkan akun IG / Halaman FB / nomor WA.
6. Tes DM dari akun tester → chat muncul di **Inbox**. Untuk semua customer: Business Verification + App Review, lalu App **Live**.
7. Supabase → Authentication → URL Configuration → Site URL: `https://ozzy-chat-admin.vercel.app` (agar link konfirmasi email admin baru tidak ke localhost).

## Struktur
```
webapp/                       webapp admin (HTML statis + supabase-js)
supabase/functions/meta-webhook/
  index.ts        entry + pemuat pengaturan dari DB
  core.ts         alur pesan, debounce, eskalasi, echo admin
  channels.ts     parse webhook & Send API (IG/FB/WA)
  ai.ts           Claude (structured output JSON)
  prompt.ts flow.ts notify.ts supabase_store.ts types.ts
  admin.ts        API webapp: status, simulator, balas sebagai admin
supabase/migrations/          RLS admin, app_settings, dsb.
.github/workflows/            deploy Edge Function otomatis
```
