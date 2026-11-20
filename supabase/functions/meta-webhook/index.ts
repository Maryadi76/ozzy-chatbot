// Entry point Supabase Edge Function: meta-webhook
// URL webhook: https://<PROJECT_REF>.supabase.co/functions/v1/meta-webhook
// Deploy:      supabase functions deploy meta-webhook --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";
import { createHandler } from "./core.ts";
import { SupabaseStore } from "./supabase_store.ts";
import { handleAdmin } from "./admin.ts";
import type { Config } from "./types.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const angka = (k: string, d: number) => {
  const n = Number(env(k));
  return Number.isFinite(n) && env(k) !== "" ? n : d;
};

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const store = new SupabaseStore(db);

// Pengaturan API diisi dari webapp (tabel app_settings). Secret Supabase (env) hanya cadangan.
const config: Config = {
  appSecrets: [],
  verifyToken: "",
  anthropicKey: "",
  anthropicModel: "claude-haiku-5-5",
  graphVersion: "v25.0",
  debounceMs: angka("DEBOUNCE_MS", 5000),
  echoGraceMs: angka("ECHO_GRACE_MS", 3000),
  maxBotRepliesPerHour: angka("MAX_BOT_REPLIES_PER_HOUR", 20),
  historyLimit: angka("HISTORY_LIMIT", 20),
};

let settingsLoadedAt = 0;
async function refreshConfig(force = false) {
  if (!force && Date.now() - settingsLoadedAt < 30_000) return;
  const s: Record<string, string> = {};
  const { data, error } = await db.from("app_settings").select("key, value");
  if (error) console.log("[meta-webhook] Gagal membaca app_settings:", error.message);
  for (const row of data ?? []) s[row.key] = row.value;
  const get = (k: string, d = "") => s[k] || env(k) || d;
  Object.assign(config, {
    appSecrets: [get("META_APP_SECRET"), get("IG_APP_SECRET")].filter(Boolean),
    appId: get("META_APP_ID") || undefined,
    verifyToken: get("META_VERIFY_TOKEN"),
    anthropicKey: get("ANTHROPIC_API_KEY"),
    anthropicModel: get("ANTHROPIC_MODEL", "claude-haiku-5-5"),
    graphVersion: get("GRAPH_VERSION", "v25.0"),
    telegramToken: get("TELEGRAM_BOT_TOKEN") || undefined,
    telegramChatId: get("TELEGRAM_CHAT_ID") || undefined,
    alertWebhookUrl: get("ALERT_WEBHOOK_URL") || undefined,
  });
  settingsLoadedAt = Date.now();
}

// deno-lint-ignore no-explicit-any
const edge = (globalThis as any).EdgeRuntime as { waitUntil?: (p: Promise<unknown>) => void } | undefined;

const handler = createHandler({
  store,
  config,
  fetch: (input, init) => fetch(input, init),
  waitUntil: (p) => (edge?.waitUntil ? edge.waitUntil(p) : void p),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
  log: (...args) => console.log("[meta-webhook]", ...args),
});

// /meta-webhook/admin → API webapp admin; selain itu → webhook Meta.
Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/admin")) {
    await refreshConfig(true); // admin baru saja mengubah pengaturan: selalu ambil yang terbaru
    return handleAdmin(req, db, config);
  }
  await refreshConfig();
  return handler(req);
});
