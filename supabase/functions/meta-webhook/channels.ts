// Adapter channel: membaca payload webhook Meta dan mengirim balasan lewat Send API.
// Instagram & Messenger: Messenger Platform. WhatsApp: WhatsApp Cloud API.

import type { Account, Attachment, Channel, InboundEvent, QuickReply } from "./types.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

// ---------------------------------------------------------------------------
// PARSE WEBHOOK
// ---------------------------------------------------------------------------

export function parseWebhook(body: Json): InboundEvent[] {
  if (!body || typeof body !== "object") return [];
  switch (body.object) {
    case "page":
      return parseMessengerLike(body, "messenger");
    case "instagram":
      return parseMessengerLike(body, "instagram");
    case "whatsapp_business_account":
      return parseWhatsApp(body);
    default:
      return [];
  }
}

function parseMessengerLike(body: Json, channel: Channel): InboundEvent[] {
  const out: InboundEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      const postback = m.postback;
      if (!msg && !postback) continue; // read, delivery, reaction, dll. diabaikan
      if (msg?.is_deleted || msg?.is_unsupported) continue;

      const isEcho = Boolean(msg?.is_echo);
      const accountId = String(isEcho ? m.sender?.id : m.recipient?.id ?? entry.id);
      const userId = String(isEcho ? m.recipient?.id : m.sender?.id);
      if (!accountId || !userId || accountId === "undefined" || userId === "undefined") continue;

      const attachments: Attachment[] = (msg?.attachments ?? []).map((a: Json) => ({
        type: String(a.type ?? "file"),
        url: a.payload?.url,
      }));

      let text = String(msg?.text ?? postback?.title ?? postback?.payload ?? "");
      if (msg?.quick_reply?.payload && !text) text = String(msg.quick_reply.payload);
      if (msg?.reply_to?.story) text = `[Membalas story] ${text}`.trim();
      if (attachments.some((a) => a.type === "story_mention")) {
        text = `[Customer menyebut akun kita di story] ${text}`.trim();
      }

      const payload = msg?.quick_reply?.payload ?? postback?.payload;
      out.push({
        channel,
        accountId,
        userId,
        mid: String(msg?.mid ?? postback?.mid ?? `${userId}-${m.timestamp}`),
        text,
        attachments,
        isEcho,
        payload: payload !== undefined ? String(payload) : undefined,
        appId: msg?.app_id ? String(msg.app_id) : undefined,
        timestamp: Number(m.timestamp ?? Date.now()),
      });
    }
  }
  return out;
}

function parseWhatsApp(body: Json): InboundEvent[] {
  const out: InboundEvent[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const accountId = String(v.metadata?.phone_number_id ?? "");
      if (!accountId) continue;
      const names: Record<string, string> = {};
      for (const c of v.contacts ?? []) names[c.wa_id] = c.profile?.name;

      // Pesan dari customer
      for (const m of v.messages ?? []) {
        const { text, attachments, payload } = waContent(m);
        out.push({
          channel: "whatsapp",
          accountId,
          userId: String(m.from),
          mid: String(m.id),
          text,
          attachments,
          isEcho: false,
          payload,
          userName: names[m.from],
          timestamp: Number(m.timestamp ?? 0) * 1000 || Date.now(),
        });
      }

      // Mode coexistence (WhatsApp Business App + API): pesan yang dikirim admin dari aplikasi
      for (const m of v.message_echoes ?? []) {
        const { text, attachments } = waContent(m);
        out.push({
          channel: "whatsapp",
          accountId,
          userId: String(m.to),
          mid: String(m.id),
          text,
          attachments,
          isEcho: true,
          timestamp: Number(m.timestamp ?? 0) * 1000 || Date.now(),
        });
      }
    }
  }
  return out;
}

function waContent(m: Json): { text: string; attachments: Attachment[]; payload?: string } {
  const attachments: Attachment[] = [];
  let text = "";
  let payload: string | undefined;
  switch (m.type) {
    case "text":
      text = m.text?.body ?? "";
      break;
    case "button":
      text = m.button?.text ?? "";
      payload = m.button?.payload;
      break;
    case "interactive": {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
      text = r?.title ?? "";
      payload = r?.id;
      break;
    }
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker": {
      const media = m[m.type] ?? {};
      attachments.push({ type: m.type === "document" ? "file" : m.type, mediaId: media.id, caption: media.caption });
      text = media.caption ?? "";
      break;
    }
    case "location":
      text = `[Lokasi] ${m.location?.name ?? ""} ${m.location?.address ?? ""}`.trim();
      break;
    default:
      text = "";
  }
  return { text, attachments, payload };
}

// ---------------------------------------------------------------------------
// SEND API
// ---------------------------------------------------------------------------

export class SendError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(`Send API gagal (${status}): ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

interface Target {
  url: string;
  token: string;
}

function target(account: Account, graphVersion: string): Target {
  const v = graphVersion;
  switch (account.channel) {
    case "instagram":
      if (account.api === "instagram") {
        return { url: `https://graph.instagram.com/${v}/${account.account_id}/messages`, token: account.access_token };
      }
      return {
        url: `https://graph.facebook.com/${v}/${account.send_as_id || "me"}/messages`,
        token: account.access_token,
      };
    case "messenger":
      return { url: `https://graph.facebook.com/${v}/${account.account_id}/messages`, token: account.access_token };
    case "whatsapp":
      return { url: `https://graph.facebook.com/${v}/${account.account_id}/messages`, token: account.access_token };
  }
}

async function post(f: typeof fetch, t: Target, body: Json): Promise<Json> {
  const res = await f(t.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new SendError(res.status, text.slice(0, 500));
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Kirim satu pesan teks, opsional dengan tombol pilihan:
 * Instagram & Messenger → quick replies; WhatsApp → interactive reply buttons (maks 3, body ≤1024).
 * Mengembalikan message ID dari Meta.
 */
export async function sendText(
  f: typeof fetch,
  account: Account,
  userId: string,
  text: string,
  graphVersion: string,
  buttons?: QuickReply[],
): Promise<string | null> {
  const t = target(account, graphVersion);
  const tombol = (buttons ?? []).map((b) => ({ title: b.title.slice(0, 20), payload: b.payload }));
  if (account.channel === "whatsapp") {
    const body = tombol.length
      ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: userId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text },
          action: { buttons: tombol.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.payload, title: b.title } })) },
        },
      }
      : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: userId,
        type: "text",
        text: { preview_url: true, body: text },
      };
    const r = await post(f, t, body);
    return r?.messages?.[0]?.id ?? null;
  }
  const body: Json = { recipient: { id: userId }, message: { text } };
  if (tombol.length) {
    body.message.quick_replies = tombol.slice(0, 13).map((b) => ({ content_type: "text", title: b.title, payload: b.payload }));
  }
  if (account.channel === "messenger") body.messaging_type = "RESPONSE";
  const r = await post(f, t, body);
  return r?.message_id ?? null;
}

/** Indikator "sedang mengetik" + tandai dibaca. Gagal tidak masalah. */
export async function sendTyping(
  f: typeof fetch,
  account: Account,
  userId: string,
  lastMid: string,
  graphVersion: string,
): Promise<void> {
  const t = target(account, graphVersion);
  try {
    if (account.channel === "whatsapp") {
      await post(f, t, {
        messaging_product: "whatsapp",
        status: "read",
        message_id: lastMid,
        typing_indicator: { type: "text" },
      });
      return;
    }
    if (account.channel === "instagram" && account.api === "instagram") return; // tidak didukung di Instagram Login
    await post(f, t, { recipient: { id: userId }, sender_action: "typing_on" });
  } catch {
    // abaikan
  }
}
