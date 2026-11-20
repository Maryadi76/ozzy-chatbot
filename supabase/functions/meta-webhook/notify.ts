// Notifikasi eskalasi ke admin: Telegram (opsional) dan/atau webhook bebas (opsional).

import type { Config, Conversation, Lead } from "./types.ts";
import { CHANNEL_NAMA } from "./prompt.ts";

export interface Alert {
  brandNama: string;
  conv: Conversation;
  alasan: string;
  ringkasan: string;
  lead: Lead;
  pesanTerakhir: string;
}

export function formatAlert(a: Alert): string {
  const l = a.lead;
  const baris = [
    `🔔 ESKALASI — ${a.brandNama} (${CHANNEL_NAMA[a.conv.channel]})`,
    `Alasan: ${a.alasan.replace(/_/g, " ")}`,
    `Customer: ${a.conv.nama_customer || l.nama || "-"} (${a.conv.user_id})`,
    a.ringkasan ? `Ringkasan: ${a.ringkasan}` : "",
    l.instansi ? `Instansi: ${l.instansi}` : "",
    l.produk ? `Produk: ${l.produk}` : "",
    l.jumlah_pcs ? `Jumlah: ${l.jumlah_pcs} pcs` : "",
    l.warna ? `Warna: ${l.warna}` : "",
    l.deadline ? `Deadline: ${l.deadline}` : "",
    l.kota ? `Kota: ${l.kota}` : "",
    `Pesan terakhir: "${a.pesanTerakhir.slice(0, 300)}"`,
    "Bot tetap menemani customer sampai admin membalas. Balas langsung dari inbox Meta Business Suite / aplikasi; setelah itu bot diam di chat ini.",
  ];
  return baris.filter(Boolean).join("\n");
}

export async function sendAlert(f: typeof fetch, cfg: Config, a: Alert, log: (...x: unknown[]) => void) {
  const text = formatAlert(a);
  const tugas: Promise<unknown>[] = [];
  if (cfg.telegramToken && cfg.telegramChatId) {
    tugas.push(
      f(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text, disable_web_page_preview: true }),
      }),
    );
  }
  if (cfg.alertWebhookUrl) {
    tugas.push(
      f(cfg.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ...a }),
      }),
    );
  }
  const hasil = await Promise.allSettled(tugas);
  for (const h of hasil) if (h.status === "rejected") log("Notifikasi gagal:", h.reason);
}
