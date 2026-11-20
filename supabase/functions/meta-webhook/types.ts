// Tipe bersama bot chat Ozzy (Edge Function meta-webhook & admin-api).

export type Channel = "instagram" | "messenger" | "whatsapp";
export type Handover = "ditawarkan" | "diminta" | "lanjut_bot" | null;
export type EscalationStatus = "ditawarkan" | "baru" | "diproses" | "selesai" | "ditolak";

export interface QuickReply {
  title: string;
  payload: string;
}

export interface Attachment {
  type: string;
  url?: string;
  mediaId?: string;
  caption?: string;
}

export interface InboundEvent {
  channel: Channel;
  accountId: string;
  userId: string;
  mid: string;
  text: string;
  attachments: Attachment[];
  isEcho: boolean;
  payload?: string;
  appId?: string;
  userName?: string;
  timestamp: number;
}

export interface Account {
  id: string;
  channel: Channel;
  account_id: string;
  brand_id: string;
  label: string;
  access_token: string;
  api: "facebook" | "instagram";
  send_as_id: string | null;
  aktif: boolean;
}

export interface Brand {
  id: string;
  nama: string;
  bot_aktif: boolean;
  nama_bot: string;
  deskripsi_bisnis: string;
  gaya_bahasa: string;
  jam_kerja: string;
  ambang_pcs_eskalasi: number;
  pause_jam_setelah_admin: number;
  tawarkan_pilihan_admin: boolean;
  perkenalkan_bot?: boolean;
  aturan_tambahan: string;
}

export interface KnowledgeItem {
  kategori: string;
  judul: string;
  isi: string;
}

export interface Lead {
  nama?: string;
  instansi?: string;
  segmen?: string;
  produk?: string;
  jumlah_pcs?: number;
  warna?: string;
  deadline?: string;
  kota?: string;
  kontak?: string;
}

export interface Conversation {
  id: string;
  channel: Channel;
  account_id: string;
  user_id: string;
  brand_id: string;
  nama_customer?: string | null;
  status: "bot" | "human";
  human_until?: string | null;
  handover?: Handover;
  handover_alasan?: string | null;
  handover_ringkasan?: string | null;
  intent?: string | null;
  ringkasan?: string | null;
  lead?: Lead;
  last_user_at?: string | null;
  last_bot_at?: string | null;
}

export interface StoredMessage {
  id?: number;
  conversation_id: string;
  role: "user" | "bot" | "admin";
  text: string;
  attachments?: Attachment[];
  mid?: string | null;
  created_at?: string;
}

export interface BotDecision {
  balasan: string;
  eskalasi: boolean;
  alasan_eskalasi?: string;
  intent: string;
  ringkasan: string;
  lead: Lead;
}

export interface Config {
  appSecrets: string[];
  appId?: string;
  verifyToken: string;
  anthropicKey: string;
  anthropicModel: string;
  graphVersion: string;
  debounceMs: number;
  echoGraceMs: number;
  maxBotRepliesPerHour: number;
  historyLimit: number;
  telegramToken?: string;
  telegramChatId?: string;
  alertWebhookUrl?: string;
  skipSignature?: boolean;
}

export interface Store {
  getAccount(channel: Channel, accountId: string): Promise<Account | null>;
  getBrand(id: string): Promise<Brand | null>;
  getKnowledge(brandId: string): Promise<KnowledgeItem[]>;
  upsertConversation(input: {
    channel: Channel;
    account_id: string;
    user_id: string;
    brand_id: string;
    nama_customer?: string;
  }): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  updateConversation(id: string, patch: Partial<Conversation>): Promise<void>;
  insertMessage(msg: StoredMessage): Promise<boolean>;
  findMessageByMid(mid: string): Promise<StoredMessage | null>;
  recentMessages(conversationId: string, limit: number): Promise<StoredMessage[]>;
  latestUserMessage(conversationId: string): Promise<StoredMessage | null>;
  countBotMessagesSince(conversationId: string, sinceIso: string): Promise<number>;
  insertEscalation(e: { conversation_id: string; alasan: string; ringkasan: string; status: EscalationStatus }): Promise<void>;
  updateEscalations(conversationId: string, from: EscalationStatus[], to: EscalationStatus): Promise<number>;
}

export interface Deps {
  store: Store;
  config: Config;
  fetch: typeof fetch;
  waitUntil: (p: Promise<unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (...args: unknown[]) => void;
}
