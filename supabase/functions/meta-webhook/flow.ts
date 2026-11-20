// Aturan serah-terima ke admin (murni, dipakai bot asli dan simulator).
//
// Alur:
//   AI menilai perlu admin ──► bot tetap menjawab + tombol [Teruskan ke admin] [Lanjut chat]
//        ├─ customer tekan "Teruskan ke admin" → konfirmasi + notifikasi admin; bot TETAP membalas
//        │                                       sampai admin benar-benar membalas manual
//        └─ customer tekan "Lanjut chat"       → bot lanjut melayani
//   Customer sendiri minta admin ("mau ngobrol sama admin") → langsung diteruskan, tanpa tombol.
//   Admin membalas manual → bot diam di chat itu selama pause_jam_setelah_admin.

import type { Brand, Handover, QuickReply } from "./types.ts";

export const TOMBOL = {
  admin: { title: "Teruskan ke admin", payload: "HANDOVER_ADMIN" },
  lanjut: { title: "Lanjut chat", payload: "LANJUT_BOT" },
} as const satisfies Record<string, QuickReply>;

export const TOMBOL_PILIHAN: QuickReply[] = [TOMBOL.admin, TOMBOL.lanjut];

export type Pilihan = "admin" | "lanjut" | null;

/** Baca tombol yang ditekan customer (payload), atau teks yang persis sama dengan label tombol. */
export function bacaPilihan(payload: string | undefined, text: string): Pilihan {
  if (payload === TOMBOL.admin.payload) return "admin";
  if (payload === TOMBOL.lanjut.payload) return "lanjut";
  const t = text.trim().toLowerCase();
  if (t === TOMBOL.admin.title.toLowerCase()) return "admin";
  if (t === TOMBOL.lanjut.title.toLowerCase()) return "lanjut";
  return null;
}

export type RencanaHandover =
  | "tidak" // jawab biasa
  | "tawarkan" // jawab + tampilkan tombol pilihan
  | "teruskan" // langsung teruskan ke admin + notifikasi (customer sendiri yang minta / tombol dimatikan)
  | "sudah_diteruskan"; // admin sudah dinotifikasi sebelumnya: jawab saja, jangan notifikasi ulang

export function rencanaHandover(
  eskalasi: boolean,
  alasan: string | undefined,
  handover: Handover | undefined,
  tawarkanPilihan: boolean,
  alasanSebelumnya?: string | null,
): RencanaHandover {
  if (!eskalasi) return "tidak";
  if (handover === "diminta") return "sudah_diteruskan";
  if (alasan === "minta_admin" || !tawarkanPilihan) return "teruskan";
  // Customer sudah memilih lanjut chat untuk alasan yang sama: jangan tawarkan berulang-ulang.
  if (handover === "lanjut_bot" && alasan === alasanSebelumnya) return "tidak";
  return "tawarkan";
}

/** Balasan pasti (tanpa AI) saat customer menekan "Teruskan ke admin". */
export function teksKonfirmasiAdmin(brand: Brand, sudahDiteruskan = false): string {
  if (brand.perkenalkan_bot !== true) {
    // Gaya admin manusia (default)
    if (sudahDiteruskan) {
      return "Sudah saya sampaikan ke tim ya Kak, mohon ditunggu sebentar 🙏 Kalau ada yang mau ditanyakan dulu, boleh langsung tulis di sini.";
    }
    return `Siap Kak, sudah saya sampaikan ke tim admin. Nanti dibalas langsung di chat ini pada jam kerja (${brand.jam_kerja}) ya. Kalau ada yang mau ditanyakan sambil nunggu, tanya aja Kak.`;
  }
  if (sudahDiteruskan) {
    return `Chat ini sudah diteruskan ke admin ${brand.nama} ya Kak, mohon ditunggu. Sambil menunggu, Kakak tetap bisa tanya ke saya di sini.`;
  }
  return `Siap Kak, chat ini sudah saya teruskan ke admin ${brand.nama}. Admin akan membalas di sini pada jam kerja (${brand.jam_kerja}). Sambil menunggu, Kakak tetap bisa tanya ke saya ya.`;
}
