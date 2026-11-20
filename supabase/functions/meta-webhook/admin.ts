// Endpoint untuk webapp admin: POST /functions/v1/meta-webhook/admin
// Header: Authorization: Bearer <access token login Supabase>. Hanya email di tabel admins.
//
// Aksi:
//   status    → status konfigurasi (secret yang sudah diisi, model, URL webhook)
//   prompt    → teks system prompt untuk brand/channel tertentu
//   simulate  → jawaban AI untuk riwayat chat simulasi (tidak dikirim ke Meta, tidak disimpan)
//   reply     → kirim balasan manual admin ke customer lewat Meta, lalu bot diam N jam

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Account, Brand, Channel, Config, Handover, StoredMessage } from "./types.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { rencanaHandover } from "./flow.ts";
import { decide } from "./ai.ts";
import { sendText } from "./channels.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JAM = 3_600_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const CHANNELS: Channel[] = ["instagram", "messenger", "whatsapp"];

export async function handleAdmin(req: Request, db: SupabaseClient, config: Config): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  // --- Autentikasi: harus login & terdaftar di tabel admins ---
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Belum login" }, 401);
  const { data: u, error: uErr } = await db.auth.getUser(jwt);
  const email = u?.user?.email?.toLowerCase();
  if (uErr || !email) return json({ error: "Sesi login tidak valid" }, 401);
  const { data: admin } = await db.from("admins").select("email").eq("email", email).maybeSingle();
  if (!admin) return json({ error: "Email ini belum terdaftar sebagai admin" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body harus JSON" }, 400);
  }

  try {
    switch (body.action) {
      case "status":
        return json(status(req, config));
      case "prompt":
        return json({ prompt: await promptFor(db, body) });
      case "simulate":
        return json(await simulate(db, config, body));
      case "reply":
        return json(await reply(db, config, body));
      default:
        return json({ error: "Aksi tidak dikenal" }, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 400);
  }
}

function status(req: Request, c: Config) {
  const url = new URL(req.url);
  const base = `https://${url.host}/functions/v1/meta-webhook`;
  return {
    webhook_url: base,
    secrets: {
      ANTHROPIC_API_KEY: Boolean(c.anthropicKey),
      META_VERIFY_TOKEN: Boolean(c.verifyToken),
      META_APP_SECRET: c.appSecrets.length > 0,
      META_APP_ID: Boolean(c.appId),
      TELEGRAM: Boolean(c.telegramToken && c.telegramChatId),
    },
    model: c.anthropicModel,
    graph_version: c.graphVersion,
    debounce_ms: c.debounceMs,
  };
}

async function loadBrand(db: SupabaseClient, id: unknown): Promise<Brand> {
  const { data, error } = await db.from("brands").select("*").eq("id", String(id ?? "")).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Brand tidak ditemukan");
  return data as Brand;
}

async function loadKb(db: SupabaseClient, brandId: string) {
  const { data, error } = await db
    .from("knowledge")
    .select("kategori, judul, isi")
    .eq("brand_id", brandId)
    .eq("aktif", true)
    .order("urutan", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

function pickChannel(v: unknown): Channel {
  return CHANNELS.includes(v as Channel) ? (v as Channel) : "instagram";
}

function pickHandover(v: unknown): Handover {
  return v === "ditawarkan" || v === "diminta" || v === "lanjut_bot" ? v : null;
}

function simNow(v: unknown): Date {
  const d = typeof v === "string" ? new Date(v) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function promptFor(db: SupabaseClient, b: Record<string, unknown>) {
  const brand = await loadBrand(db, b.brand_id);
  return buildSystemPrompt({
    brand,
    kb: await loadKb(db, brand.id),
    channel: pickChannel(b.channel),
    now: simNow(b.now),
    firstContact: Boolean(b.first_contact ?? true),
    handover: pickHandover(b.handover),
  });
}

/** Jalankan AI pada riwayat simulasi. Tidak menyimpan apa pun & tidak mengirim ke Meta. */
async function simulate(db: SupabaseClient, config: Config, b: Record<string, unknown>) {
  if (!config.anthropicKey) throw new Error("API key Claude belum diisi (menu Pengaturan API)");
  const brand = await loadBrand(db, b.brand_id);
  const channel = pickChannel(b.channel);
  const handover = pickHandover(b.handover);
  const raw = Array.isArray(b.history) ? b.history.slice(-30) : [];
  const history: StoredMessage[] = raw.map((m: Record<string, unknown>) => ({
    conversation_id: "simulasi",
    role: m.role === "bot" || m.role === "admin" ? m.role : "user",
    text: String(m.text ?? "").slice(0, 2000),
    attachments: m.attach ? [{ type: "image" }] : [],
  }));
  if (!history.length || history.at(-1)!.role !== "user") throw new Error("Pesan terakhir harus dari customer");

  const t0 = Date.now();
  const decision = await decide(fetch, {
    apiKey: config.anthropicKey,
    model: config.anthropicModel,
    system: buildSystemPrompt({
      brand,
      kb: await loadKb(db, brand.id),
      channel,
      now: simNow(b.now),
      firstContact: !history.some((m) => m.role !== "user"),
      handover,
    }),
    history,
  });
  const rencana = rencanaHandover(
    decision.eskalasi,
    decision.alasan_eskalasi,
    handover,
    brand.tawarkan_pilihan_admin,
    typeof b.handover_alasan === "string" ? b.handover_alasan : null,
  );
  return { decision, rencana, ms: Date.now() - t0 };
}

/** Admin membalas dari webapp → dikirim ke customer lewat akun Meta yang sama. */
async function reply(db: SupabaseClient, config: Config, b: Record<string, unknown>) {
  const text = String(b.text ?? "").trim();
  if (!text) throw new Error("Pesan kosong");
  const { data: conv, error } = await db.from("conversations").select("*").eq("id", String(b.conversation_id ?? ""))
    .maybeSingle();
  if (error) throw error;
  if (!conv) throw new Error("Percakapan tidak ditemukan");

  const { data: acc } = await db.from("accounts").select("*").eq("channel", conv.channel).eq(
    "account_id",
    conv.account_id,
  ).maybeSingle();
  const account = acc as Account | null;
  if (!account || !account.aktif) throw new Error("Akun sosmed untuk percakapan ini tidak aktif / belum terdaftar");

  const mid = await sendText(fetch, account, conv.user_id, text, config.graphVersion);
  // Simpan dengan mid agar echo dari Meta dikenali (tidak dihitung dua kali).
  await db.from("messages").insert({ conversation_id: conv.id, role: "admin", text, attachments: [], mid });

  const brand = await loadBrand(db, conv.brand_id);
  const until = new Date(Date.now() + brand.pause_jam_setelah_admin * JAM).toISOString();
  await db.from("conversations").update({ status: "human", human_until: until, handover: null }).eq("id", conv.id);
  await db.from("escalations").update({ status: "diproses" }).eq("conversation_id", conv.id).in("status", [
    "ditawarkan",
    "baru",
  ]);
  return { ok: true, mid, human_until: until };
}
