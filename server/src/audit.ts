import { db } from "./db.js";

export function recordSend(
  userId: number,
  chatId: string,
  text: string,
  wahaMessageId: string | null
): { id: number; sentAt: number } {
  const sentAt = Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `INSERT INTO audit_log (user_id, chat_id, text, waha_message_id, sent_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, chatId, text, wahaMessageId, sentAt);
  return { id: Number(info.lastInsertRowid), sentAt };
}

export function countSendsInWindow(userId: number, windowSeconds: number): number {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND sent_at >= ?"
    )
    .get(userId, since) as { n: number };
  return row.n;
}
