// Implementasi Store memakai Supabase (service role, berjalan di Edge Function).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type {
  Account,
  Brand,
  Channel,
  Conversation,
  EscalationStatus,
  KnowledgeItem,
  StoredMessage,
  Store,
} from "./types.ts";

export class SupabaseStore implements Store {
  db: SupabaseClient;
  constructor(db: SupabaseClient) {
    this.db = db;
  }

  async getAccount(channel: Channel, accountId: string): Promise<Account | null> {
    const { data, error } = await this.db
      .from("accounts")
      .select("*")
      .eq("channel", channel)
      .eq("account_id", accountId)
      .maybeSingle();
    if (error) throw error;
    return data as Account | null;
  }

  async getBrand(id: string): Promise<Brand | null> {
    const { data, error } = await this.db.from("brands").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data as Brand | null;
  }

  async getKnowledge(brandId: string): Promise<KnowledgeItem[]> {
    const { data, error } = await this.db
      .from("knowledge")
      .select("kategori, judul, isi")
      .eq("brand_id", brandId)
      .eq("aktif", true)
      .order("urutan", { ascending: true });
    if (error) throw error;
    return (data ?? []) as KnowledgeItem[];
  }

  async upsertConversation(input: {
    channel: Channel;
    account_id: string;
    user_id: string;
    brand_id: string;
    nama_customer?: string;
  }): Promise<Conversation> {
    const row: Record<string, unknown> = {
      channel: input.channel,
      account_id: input.account_id,
      user_id: input.user_id,
      brand_id: input.brand_id,
    };
    if (input.nama_customer) row.nama_customer = input.nama_customer;
    const { data, error } = await this.db
      .from("conversations")
      .upsert(row, { onConflict: "channel,account_id,user_id" })
      .select("*")
      .single();
    if (error) throw error;
    return data as Conversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { data, error } = await this.db.from("conversations").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data as Conversation | null;
  }

  async updateConversation(id: string, patch: Partial<Conversation>): Promise<void> {
    const { error } = await this.db.from("conversations").update(patch).eq("id", id);
    if (error) throw error;
  }

  async insertMessage(msg: StoredMessage): Promise<boolean> {
    const { error } = await this.db.from("messages").insert({
      conversation_id: msg.conversation_id,
      role: msg.role,
      text: msg.text,
      attachments: msg.attachments ?? [],
      mid: msg.mid ?? null,
    });
    if (error) {
      if (error.code === "23505") return false; // mid sudah ada
      throw error;
    }
    return true;
  }

  async findMessageByMid(mid: string): Promise<StoredMessage | null> {
    const { data, error } = await this.db.from("messages").select("*").eq("mid", mid).maybeSingle();
    if (error) throw error;
    return data as StoredMessage | null;
  }

  async recentMessages(conversationId: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await this.db
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as StoredMessage[]).reverse();
  }

  async latestUserMessage(conversationId: string): Promise<StoredMessage | null> {
    const { data, error } = await this.db
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as StoredMessage | null;
  }

  async countBotMessagesSince(conversationId: string, sinceIso: string): Promise<number> {
    const { count, error } = await this.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId)
      .eq("role", "bot")
      .gte("created_at", sinceIso);
    if (error) throw error;
    return count ?? 0;
  }

  async insertEscalation(e: {
    conversation_id: string;
    alasan: string;
    ringkasan: string;
    status: EscalationStatus;
  }): Promise<void> {
    const { error } = await this.db.from("escalations").insert(e);
    if (error) throw error;
  }

  async updateEscalations(conversationId: string, from: EscalationStatus[], to: EscalationStatus): Promise<number> {
    const { data, error } = await this.db
      .from("escalations")
      .update({ status: to })
      .eq("conversation_id", conversationId)
      .in("status", from)
      .select("id");
    if (error) throw error;
    return (data ?? []).length;
  }
}
