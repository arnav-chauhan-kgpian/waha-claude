import { setConnected, type User } from "./users.js";
import { waha, type WahaMessage, type WahaStatus } from "./waha.js";

export type StatusResult = { status: WahaStatus | "NEW"; phone_number?: string | null };

// `me.id` formats observed across engines: "12345@c.us", "12345:1@c.us" (multi-device),
// "12345@s.whatsapp.net". Strip everything after @ then everything after :.
function phoneFromMeId(meId: string | undefined | null): string | null {
  if (!meId) return null;
  const before = meId.split("@")[0];
  return before.split(":")[0] || null;
}

export async function ensureSession(user: User): Promise<StatusResult> {
  const existing = await waha.getSession(user.session_name);
  if (!existing) {
    const s = await waha.createAndStart(user.session_name);
    return { status: s.status };
  }
  if (existing.status === "FAILED") {
    // Wipe and recreate so the new noweb.store config applies.
    await waha.deleteSession(user.session_name);
    const s = await waha.createAndStart(user.session_name);
    return { status: s.status };
  }
  if (existing.status === "STOPPED") {
    const s = await waha.start(user.session_name);
    return { status: s.status };
  }
  if (existing.status === "WORKING") {
    const phone = phoneFromMeId(existing.me?.id);
    if (phone && user.phone_number !== phone) setConnected(user.id, phone);
    return { status: existing.status, phone_number: phone };
  }
  return { status: existing.status };
}

export async function getStatus(user: User): Promise<StatusResult> {
  const s = await waha.getSession(user.session_name);
  if (!s) return { status: "NEW" };
  if (s.status === "WORKING") {
    const phone = phoneFromMeId(s.me?.id);
    if (phone && user.phone_number !== phone) setConnected(user.id, phone);
    return { status: s.status, phone_number: phone };
  }
  return { status: s.status };
}

export async function getQrOrStatus(
  user: User
): Promise<{ qr?: { mimetype: string; data: string }; status: WahaStatus | "NEW" }> {
  const status = await getStatus(user);
  if (status.status === "WORKING" || status.status === "STOPPED" || status.status === "NEW" || status.status === "FAILED") {
    return { status: status.status };
  }
  // SCAN_QR_CODE or STARTING. WAHA may 404/422 during STARTING — treat as "not ready".
  try {
    const qr = await waha.qrPngBase64(user.session_name);
    return { qr, status: status.status };
  } catch {
    return { status: status.status };
  }
}

// WAHA returns different shapes per engine (NOWEB vs WEBJS). Try multiple keys.
function pickFirst<T = unknown>(...candidates: (T | undefined | null)[]): T | null {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== "") return c as T;
  }
  return null;
}

export function normalizeMessages(msgs: WahaMessage[]) {
  return msgs.map((m: any) => ({
    id: pickFirst<string>(m.id?._serialized, m.id?.id, m.id, m._id),
    author: pickFirst<string>(m.notifyName, m.author, m.from, m.participant),
    text: pickFirst<string>(m.body, m.text, m.caption) ?? "",
    timestamp: pickFirst<number>(m.timestamp, m.t, m.messageTimestamp),
    fromMe: !!m.fromMe,
  }));
}

// One source of truth for "list chats but with the user's contact names stitched in."
// NOWEB's /chats endpoint returns names only for groups/newsletters; for 1:1 chats
// the name comes from the user's address book, which is exposed via /contacts/all.
export async function listChatsWithNames(user: User, limit?: number) {
  const [rawChats, contacts] = await Promise.all([
    waha.listChats(user.session_name, limit),
    waha.listContacts(user.session_name).catch(() => [] as any[]),
  ]);
  // WAHA returns two entries per contact: one keyed <phone>@c.us with the user's
  // address-book name, and one keyed <lid>@lid with WhatsApp's masked variant.
  // Always prefer the @c.us entry; only fall back to @lid if no @c.us name exists.
  const byPhone = new Map<string, string>();
  for (const c of contacts as any[]) {
    const id: string = c.id ?? "";
    const phone: string = c.phoneNumber ?? id.split("@")[0] ?? "";
    const name: string | undefined = c.name;
    if (!name) continue;
    const preferCus = id.endsWith("@c.us");
    // Index by both the raw phone digits and the full @c.us id so lookups hit regardless of format.
    if (phone && (preferCus || !byPhone.has(phone))) byPhone.set(phone, name);
    if (id && (preferCus || !byPhone.has(id))) byPhone.set(id, name);
  }
  const chats = normalizeChats(rawChats);
  for (const c of chats) {
    if (!c.name && c.id) {
      const phoneDigits = c.id.split("@")[0];
      const stitched = byPhone.get(c.id) ?? byPhone.get(phoneDigits);
      if (stitched) c.name = stitched;
    }
    // If the name is null or the masked form WhatsApp uses for non-saved
    // contacts (digits + ∙ dots), fall back to a formatted phone number.
    if ((!c.name || /∙/.test(c.name)) && c.id) {
      const pretty = formatPhoneFromChatId(c.id);
      if (pretty) c.name = pretty;
    }
  }
  return chats;
}

// Fetch messages for a chat and enrich each message's `author` with a
// human-readable name. For groups, the actual sender lives in
// `_data.participant` (a WhatsApp LID); for 1:1 chats it's just the chat
// partner. We resolve LIDs / phone numbers through the user's contact list.
export async function listMessagesWithNames(
  user: User,
  chatId: string,
  limit: number
) {
  const [raw, contacts] = await Promise.all([
    waha.getMessages(user.session_name, chatId, limit),
    waha.listContacts(user.session_name).catch(() => [] as any[]),
  ]);

  const byPhone = new Map<string, string>();
  const byLid = new Map<string, string>();
  for (const c of contacts as any[]) {
    const id: string = c.id ?? "";
    const lid: string = c.lid ?? "";
    const phone: string = c.phoneNumber ?? "";
    const name = c.name;
    if (!name) continue;
    const preferCus = id.endsWith("@c.us");
    if (phone && (preferCus || !byPhone.has(phone))) byPhone.set(phone, name);
    if (lid && (preferCus || !byLid.has(lid))) byLid.set(lid, name);
  }

  const isGroup = chatId.endsWith("@g.us");
  const base = normalizeMessages(raw);

  return base.map((m, i) => {
    const rawMsg = (raw[i] as any) ?? {};
    let author: string | null = null;
    if (m.fromMe) {
      author = "You";
    } else if (isGroup) {
      const participant: string | undefined =
        rawMsg._data?.participant ??
        rawMsg._data?.key?.participant ??
        rawMsg.participant;
      if (participant) {
        const named =
          (participant.endsWith("@lid") && byLid.get(participant)) ||
          byPhone.get(participant);
        author = named ?? participant;
      } else {
        author = rawMsg.from ?? null;
      }
    } else {
      const partner = rawMsg.from ?? chatId;
      author =
        byPhone.get(partner) ?? formatPhoneFromChatId(partner) ?? partner;
    }
    return { ...m, author };
  });
}

// Turn "918850847822@s.whatsapp.net" into "+91 88508 47822".
// Group / newsletter / channel ids are returned as-is by callers (we only call
// this when we know it's a personal chat).
function formatPhoneFromChatId(chatId: string): string | null {
  const m = chatId.match(/^(\d+)@/);
  if (!m) return null;
  const digits = m[1];
  // India (+91, 10-digit subscriber)
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  // US (+1, 10-digit subscriber)
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // Anything else: just "+<all-digits>" with a thin space every 3 from the right
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `+${grouped}`;
}

export function normalizeChats(chats: any[]) {
  return chats.map((c: any) => ({
    id: pickFirst<string>(c.id?._serialized, c.id?.user, c.id, c.chatId),
    name: pickFirst<string>(c.name, c.formattedTitle, c.subject, c.pushName),
    lastMessageAt: pickFirst<number>(
      c.lastMessageTimestamp,
      c.conversationTimestamp,
      c.timestamp,
      c.t
    ),
    unreadCount: c.unreadCount ?? c.unread ?? 0,
  }));
}
