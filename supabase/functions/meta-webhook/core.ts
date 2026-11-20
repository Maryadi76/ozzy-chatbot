// Alur utama bot: verifikasi webhook → simpan pesan → tunggu pesan beruntun →
// tanya Claude → kirim balasan (+ tombol pilihan admin) → catat lead → notifikasi admin.

import type {
  Account,
  BotDecision,
  Brand,
  Conversation,
  Deps,
  InboundEvent,
  QuickReply,
} from "./types.ts";
import { parseWebhook, SendError, sendText, sendTyping } from "./channels.ts";
import { decide } from "./ai.ts";
import { BATAS_WA_TOMBOL, buildSystemPrompt, formatForChannel, splitMessage } from "./prompt.ts";
import { bacaPilihan, rencanaHandover, type RencanaHandover, TOMBOL_PILIHAN, teksKonfirmasiAdmin } from "./flow.ts";
import { sendAlert } from "./notify.ts";

const JAM = 3_600_000;

export const BALASAN_CADANGAN =
  "Terima kasih Kak, pesannya sudah kami terima. Admin kami akan segera membalas di sini ya 🙏";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);

    // 1) Verifikasi webhook (saat mendaftarkan Callback URL di Meta App)
    if (req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      if (!mode) return new Response("ok", { status: 200 });
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      if (mode === "subscribe" && token && token === deps.config.verifyToken) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // 2) Validasi tanda tangan Meta (X-Hub-Signature-256)
    const raw = await req.text();
    if (!deps.config.skipSignature) {
      const ok = await verifySignature(raw, req.headers.get("x-hub-signature-256"), deps.config.appSecrets);
      if (!ok) return new Response("Invalid signature", { status: 401 });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    // 3) Balas 200 secepatnya; proses di latar belakang agar Meta tidak mengirim ulang.
    for (const ev of parseWebhook(body)) {
      deps.waitUntil(
        processEvent(deps, ev).catch((e) => deps.log("Gagal memproses event", ev.channel, ev.mid, e)),
      );
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  };
}

export async function verifySignature(raw: string, header: string | null, secrets: string[]): Promise<boolean> {
  if (!header || !header.startsWith("sha256=") || secrets.length === 0) return false;
  const expected = header.slice(7).toLowerCase();
  const enc = new TextEncoder();
  for (const secret of secrets) {
    if (!secret) continue;
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
    const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
    if (timingSafeEqual(hex, expected)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PROSES SATU EVENT
// ---------------------------------------------------------------------------

/** Bot hanya diam bila admin BENAR-BENAR membalas manual (status human). */
export function humanActive(conv: Conversation, now: Date): boolean {
  if (conv.status !== "human") return false;
  if (!conv.human_until) return true; // diambil alih tanpa batas waktu
  return new Date(conv.human_until).getTime() > now.getTime();
}

export async function processEvent(deps: Deps, ev: InboundEvent): Promise<void> {
  const { store, log } = deps;

  const account = await store.getAccount(ev.channel, ev.accountId);
  if (!account || !account.aktif) {
    log(`Akun ${ev.channel}:${ev.accountId} belum terdaftar/aktif di tabel accounts — pesan diabaikan.`);
    return;
  }
  const brand = await store.getBrand(account.brand_id);
  if (!brand) return;

  const conv = await store.upsertConversation({
    channel: ev.channel,
    account_id: ev.accountId,
    user_id: ev.userId,
    brand_id: brand.id,
    nama_customer: ev.userName,
  });

  if (ev.isEcho) return handleEcho(deps, ev, conv, brand);

  // Simpan pesan customer (mid unik → webhook yang dikirim ulang tidak dibalas dua kali)
  const baru = await store.insertMessage({
    conversation_id: conv.id,
    role: "user",
    text: ev.text,
    attachments: ev.attachments,
    mid: ev.mid,
  });
  if (!baru) return;
  await store.updateConversation(conv.id, { last_user_at: deps.now().toISOString() });

  if (!brand.bot_aktif) return;

  if (conv.status === "human") {
    if (humanActive(conv, deps.now())) return; // admin sedang menangani langsung
    conv.status = "bot";
    conv.handover = null;
    await store.updateConversation(conv.id, { status: "bot", human_until: null, handover: null });
  }

  // Tombol yang ditekan customer diproses langsung (tanpa menunggu pesan beruntun).
  const pilihan = bacaPilihan(ev.payload, ev.text);
  if (pilihan === "admin") return pilihAdmin(deps, account, brand, conv, ev);
  if (pilihan === "lanjut") {
    await store.updateEscalations(conv.id, ["ditawarkan"], "ditolak");
    await store.updateConversation(conv.id, { handover: "lanjut_bot" });
    return balasDenganAI(deps, account, brand, conv.id, ev);
  }

  // Tunggu sebentar: customer sering mengirim beberapa pesan beruntun ("halo", "kak", "mau tanya…")
  await deps.sleep(deps.config.debounceMs);
  if (!(await masihTerbaru(deps, conv.id, ev.mid))) return;
  return balasDenganAI(deps, account, brand, conv.id, ev);
}

async function balasDenganAI(deps: Deps, account: Account, brand: Brand, convId: string, ev: InboundEvent) {
  const { store, log } = deps;
  const conv = await store.getConversation(convId);
  if (!conv || humanActive(conv, deps.now())) return;

  // Pengaman: batasi jumlah balasan bot per jam per percakapan
  const sejak = new Date(deps.now().getTime() - JAM).toISOString();
  if ((await store.countBotMessagesSince(conv.id, sejak)) >= deps.config.maxBotRepliesPerHour) {
    log(`Batas balasan per jam tercapai untuk percakapan ${conv.id}`);
    return;
  }

  await sendTyping(deps.fetch, account, ev.userId, ev.mid, deps.config.graphVersion);

  const [kb, history] = await Promise.all([
    store.getKnowledge(brand.id),
    store.recentMessages(conv.id, deps.config.historyLimit),
  ]);
  const firstContact = !history.some((m) => m.role !== "user");

  let decision: BotDecision;
  let aiGagal = false;
  try {
    decision = await decide(deps.fetch, {
      apiKey: deps.config.anthropicKey,
      model: deps.config.anthropicModel,
      system: buildSystemPrompt({
        brand,
        kb,
        channel: ev.channel,
        now: deps.now(),
        firstContact,
        handover: conv.handover ?? null,
      }),
      history,
    });
  } catch (e) {
    log("AI gagal, kirim balasan cadangan + teruskan ke admin:", e);
    aiGagal = true;
    decision = {
      balasan: BALASAN_CADANGAN,
      eskalasi: true,
      alasan_eskalasi: "lainnya",
      intent: "lainnya",
      ringkasan: "Bot gagal membuat balasan (AI error). Mohon dibalas manual.",
      lead: {},
    };
  }

  // Ada pesan baru masuk selama AI berpikir? Biarkan proses pesan terbaru yang membalas.
  if (!(await masihTerbaru(deps, conv.id, ev.mid))) return;
  const sebelumKirim = (await store.getConversation(conv.id)) ?? conv;
  if (humanActive(sebelumKirim, deps.now())) return;

  const rencana: RencanaHandover = aiGagal
    ? (sebelumKirim.handover === "diminta" ? "sudah_diteruskan" : "teruskan")
    : rencanaHandover(
      decision.eskalasi,
      decision.alasan_eskalasi,
      sebelumKirim.handover,
      brand.tawarkan_pilihan_admin,
      sebelumKirim.handover_alasan,
    );

  await kirimBalasan(
    deps,
    account,
    sebelumKirim,
    ev.userId,
    decision.balasan,
    rencana === "tawarkan" ? TOMBOL_PILIHAN : undefined,
  );
  await catatHasil(deps, brand, sebelumKirim, decision, rencana, history.at(-1)?.text ?? ev.text);
}

/** Customer menekan "Teruskan ke admin": konfirmasi pasti + notifikasi. Bot tetap aktif sampai admin membalas. */
async function pilihAdmin(deps: Deps, account: Account, brand: Brand, conv: Conversation, ev: InboundEvent) {
  const sudah = conv.handover === "diminta";
  await kirimBalasan(deps, account, conv, ev.userId, teksKonfirmasiAdmin(brand, sudah));
  if (sudah) return;
  const history = await deps.store.recentMessages(conv.id, deps.config.historyLimit);
  const pesanTerakhir = [...history].reverse().find((m) => m.role === "user" && m.mid !== ev.mid)?.text ?? ev.text;
  await teruskanKeAdmin(
    deps,
    brand,
    conv,
    conv.handover_alasan || "minta_admin",
    conv.handover_ringkasan || conv.ringkasan || "Customer minta diteruskan ke admin.",
    pesanTerakhir,
  );
  await deps.store.updateConversation(conv.id, { last_bot_at: deps.now().toISOString() });
}

async function teruskanKeAdmin(
  deps: Deps,
  brand: Brand,
  conv: Conversation,
  alasan: string,
  ringkasan: string,
  pesanTerakhir: string,
) {
  const { store } = deps;
  const diubah = await store.updateEscalations(conv.id, ["ditawarkan"], "baru");
  if (diubah === 0) await store.insertEscalation({ conversation_id: conv.id, alasan, ringkasan, status: "baru" });
  const patch: Partial<Conversation> = { handover: "diminta", handover_alasan: alasan, handover_ringkasan: ringkasan };
  await store.updateConversation(conv.id, patch);
  await sendAlert(
    deps.fetch,
    deps.config,
    { brandNama: brand.nama, conv: { ...conv, ...patch }, alasan, ringkasan, lead: conv.lead ?? {}, pesanTerakhir },
    deps.log,
  );
}

async function masihTerbaru(deps: Deps, conversationId: string, mid: string): Promise<boolean> {
  const latest = await deps.store.latestUserMessage(conversationId);
  return !latest || latest.mid === mid;
}

async function kirimBalasan(
  deps: Deps,
  account: Account,
  conv: Conversation,
  userId: string,
  teks: string,
  tombol?: QuickReply[],
) {
  const rapi = formatForChannel(teks, account.channel);
  const bagian = splitMessage(rapi, account.channel);
  // Pesan WhatsApp bertombol maksimal 1024 karakter: pecah bagian terakhir bila perlu.
  if (tombol?.length && account.channel === "whatsapp") {
    const akhir = bagian.pop() ?? "";
    bagian.push(...splitMessage(akhir, "whatsapp", BATAS_WA_TOMBOL));
  }
  for (let i = 0; i < bagian.length; i++) {
    const pakaiTombol = tombol?.length && i === bagian.length - 1 ? tombol : undefined;
    let mid: string | null;
    try {
      mid = await sendText(deps.fetch, account, userId, bagian[i], deps.config.graphVersion, pakaiTombol);
    } catch (e) {
      if (!pakaiTombol || !(e instanceof SendError)) throw e;
      // Tombol ditolak (mis. fitur tidak tersedia): kirim tanpa tombol. Teks balasan sudah menawarkan pilihan.
      deps.log("Tombol gagal dikirim, ulangi tanpa tombol:", e.detail);
      mid = await sendText(deps.fetch, account, userId, bagian[i], deps.config.graphVersion);
    }
    // Simpan segera setelah terkirim agar echo pesan ini dikenali sebagai bot, bukan admin.
    await deps.store.insertMessage({
      conversation_id: conv.id,
      role: "bot",
      text: bagian[i],
      attachments: [],
      mid: mid ?? null,
    });
  }
}

async function catatHasil(
  deps: Deps,
  brand: Brand,
  conv: Conversation,
  d: BotDecision,
  rencana: RencanaHandover,
  pesanTerakhir: string,
) {
  const { store } = deps;
  const lead = { ...(conv.lead ?? {}), ...d.lead };
  const patch: Partial<Conversation> = {
    last_bot_at: deps.now().toISOString(),
    intent: d.intent,
    ringkasan: d.ringkasan || conv.ringkasan || null,
    lead,
  };
  if (!conv.nama_customer && lead.nama) patch.nama_customer = lead.nama;
  await store.updateConversation(conv.id, patch);

  const alasan = d.alasan_eskalasi || "lainnya";
  if (rencana === "tawarkan") {
    // Catat sebagai "ditawarkan" (belum ada notifikasi). Tawaran ulang tidak membuat baris baru.
    if (conv.handover !== "ditawarkan") {
      await store.insertEscalation({ conversation_id: conv.id, alasan, ringkasan: d.ringkasan, status: "ditawarkan" });
    }
    await store.updateConversation(conv.id, {
      handover: "ditawarkan",
      handover_alasan: alasan,
      handover_ringkasan: d.ringkasan,
    });
  } else if (rencana === "teruskan") {
    await teruskanKeAdmin(deps, brand, { ...conv, ...patch }, alasan, d.ringkasan, pesanTerakhir);
  }
}

// ---------------------------------------------------------------------------
// ECHO: pesan yang dikirim akun bisnis. Jika bukan dari bot → admin ambil alih.
// ---------------------------------------------------------------------------

async function handleEcho(deps: Deps, ev: InboundEvent, conv: Conversation, brand: Brand) {
  const { store, config } = deps;
  if (ev.appId && config.appId && ev.appId === config.appId) return; // dikirim oleh bot ini

  let dikenal = await store.findMessageByMid(ev.mid);
  if (!dikenal) {
    // Echo bisa tiba sebelum bot selesai menyimpan mid. Beri jeda lalu cek lagi.
    await deps.sleep(config.echoGraceMs);
    dikenal = await store.findMessageByMid(ev.mid);
  }
  if (dikenal) return;

  const disimpan = await store.insertMessage({
    conversation_id: conv.id,
    role: "admin",
    text: ev.text,
    attachments: ev.attachments,
    mid: ev.mid,
  });
  if (!disimpan) return;

  const until = new Date(deps.now().getTime() + brand.pause_jam_setelah_admin * JAM).toISOString();
  await store.updateConversation(conv.id, { status: "human", human_until: until, handover: null });
  await store.updateEscalations(conv.id, ["ditawarkan", "baru"], "diproses");
  deps.log(`Admin membalas manual di ${ev.channel}:${ev.userId} → bot diam sampai ${until}`);
}
