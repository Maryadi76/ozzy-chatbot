// Pemanggilan Claude (Anthropic SDK) dengan structured output (JSON schema)
// agar hasilnya selalu terstruktur: teks balasan + keputusan eskalasi + data lead.

import Anthropic from "npm:@anthropic-ai/sdk@1.11.0";
import type { BotDecision, Lead, StoredMessage } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export const ALASAN_ESKALASI = [
  "siap_penawaran",
  "nego_harga",
  "komplain",
  "cek_pesanan",
  "minta_admin",
  "info_tidak_tersedia",
  "kirim_file_desain",
  "order_besar",
  "pembayaran",
  "lainnya",
] as const;

export const INTENT = [
  "sapaan",
  "tanya_produk",
  "tanya_harga",
  "tanya_stok_warna",
  "order",
  "cek_pesanan",
  "komplain",
  "lokasi_outlet",
  "di_luar_topik",
  "lainnya",
] as const;

/** Bentuk jawaban AI (dipaksa lewat structured output, jadi selalu JSON valid). */
export const SCHEMA_KEPUTUSAN = {
  type: "object",
  additionalProperties: false,
  properties: {
    balasan: { type: "string", description: "Teks balasan untuk customer, siap kirim apa adanya." },
    eskalasi: { type: "boolean", description: "true jika percakapan perlu dioper ke admin manusia sekarang." },
    alasan_eskalasi: {
      type: "string",
      enum: [...ALASAN_ESKALASI],
      description: "Wajib diisi bila eskalasi = true.",
    },
    intent: { type: "string", enum: [...INTENT], description: "Maksud utama pesan terakhir customer." },
    ringkasan: { type: "string", description: "Satu kalimat ringkasan kebutuhan customer untuk admin." },
    lead: {
      type: "object",
      additionalProperties: false,
      description: "Isi HANYA yang sudah disebut customer di percakapan. Hilangkan field yang belum diketahui.",
      properties: {
          nama: { type: "string" },
          instansi: { type: "string" },
          segmen: { type: "string", description: "perusahaan/instansi/universitas/komunitas/UMKM/organisasi/personal" },
          produk: { type: "string" },
          jumlah_pcs: { type: "integer" },
          warna: { type: "string" },
          deadline: { type: "string" },
          kota: { type: "string" },
          kontak: { type: "string" },
        },
      },
    },
  required: ["balasan", "eskalasi", "intent", "ringkasan", "lead"],
};

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } };

interface ClaudeMessage {
  role: "user" | "assistant";
  content: Block[];
}

/**
 * Susun riwayat chat menjadi format Messages API.
 * - customer → user; bot & admin → assistant (admin diberi label [Admin])
 * - pesan beruntun dengan peran sama digabung
 * - gambar hanya dikirim untuk pesan customer yang belum dibalas (pending)
 */
export function buildMessages(history: StoredMessage[], withImages: boolean): ClaudeMessage[] {
  let lastReplyIdx = -1;
  history.forEach((m, i) => {
    if (m.role !== "user") lastReplyIdx = i;
  });

  const out: ClaudeMessage[] = [];
  history.forEach((m, i) => {
    const role = m.role === "user" ? "user" : "assistant";
    const blocks: Block[] = [];
    const pending = m.role === "user" && i > lastReplyIdx;

    for (const a of m.attachments ?? []) {
      if (withImages && pending && a.type === "image" && a.url) {
        blocks.push({ type: "image", source: { type: "url", url: a.url } });
      } else {
        blocks.push({ type: "text", text: `[Customer mengirim ${labelLampiran(a.type)}]` });
      }
    }
    const teks = m.role === "admin" ? `[Admin] ${m.text}` : m.text;
    if (teks.trim()) blocks.push({ type: "text", text: teks });
    if (blocks.length === 0) return;

    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  });

  while (out.length && out[0].role === "assistant") out.shift();
  return out;
}

function labelLampiran(type: string): string {
  const map: Record<string, string> = {
    image: "gambar",
    video: "video",
    audio: "pesan suara",
    file: "file",
    sticker: "stiker",
    share: "postingan yang dibagikan",
    story_mention: "mention story",
    ig_reel: "reel",
    reel: "reel",
  };
  return map[type] ?? "lampiran";
}

export class AIError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

// Model yang mendukung fallback otomatis di server bila permintaan ditolak filter keamanan.
const dukungFallback = (model: string) => /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);

/** Panggil Claude, kembalikan objek keputusan (JSON) yang sudah di-parse. */
async function callClaude(
  f: typeof fetch,
  apiKey: string,
  model: string,
  system: string,
  messages: ClaudeMessage[],
): Promise<Json> {
  const client = new Anthropic({ apiKey, fetch: f, maxRetries: 1, timeout: 45_000 });
  let res;
  try {
    res = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      system,
      // deno-lint-ignore no-explicit-any
      messages: messages as any,
      // Chat customer: effort rendah = cepat & hemat. Format JSON dijamin oleh structured output.
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA_KEPUTUSAN } },
      ...(dukungFallback(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new AIError(e.status ?? 500, `Anthropic API ${e.status}: ${e.message}`);
    throw e;
  }
  if (res.stop_reason === "refusal") throw new AIError(500, "Model menolak menjawab (refusal)");
  if (res.stop_reason === "max_tokens") throw new AIError(500, "Jawaban model terpotong (max_tokens)");
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new AIError(500, `Jawaban model bukan JSON: ${text.slice(0, 200)}`);
  }
}

export function normalizeDecision(input: Json): BotDecision {
  const lead: Lead = {};
  const raw = input?.lead ?? {};
  for (const k of ["nama", "instansi", "segmen", "produk", "warna", "deadline", "kota", "kontak"] as const) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) lead[k] = v.trim();
  }
  const pcs = Number(raw.jumlah_pcs);
  if (Number.isFinite(pcs) && pcs > 0) lead.jumlah_pcs = Math.round(pcs);

  const eskalasi = Boolean(input?.eskalasi);
  return {
    balasan: String(input?.balasan ?? "").trim(),
    eskalasi,
    alasan_eskalasi: eskalasi ? String(input?.alasan_eskalasi || "lainnya") : undefined,
    intent: String(input?.intent || "lainnya"),
    ringkasan: String(input?.ringkasan ?? "").trim(),
    lead,
  };
}

/** Minta keputusan ke Claude. Jika gambar ditolak (URL kedaluwarsa dsb.), ulangi tanpa gambar. */
export async function decide(
  f: typeof fetch,
  opts: { apiKey: string; model: string; system: string; history: StoredMessage[] },
): Promise<BotDecision> {
  const hasImages = opts.history.some((m) => m.attachments?.some((a) => a.type === "image" && a.url));
  let res: Json;
  try {
    res = await callClaude(f, opts.apiKey, opts.model, opts.system, buildMessages(opts.history, hasImages));
  } catch (e) {
    if (hasImages && e instanceof AIError && e.status === 400) {
      res = await callClaude(f, opts.apiKey, opts.model, opts.system, buildMessages(opts.history, false));
    } else {
      throw e;
    }
  }
  const d = normalizeDecision(res);
  if (!d.balasan) throw new AIError(500, "Balasan kosong dari model");
  return d;
}
