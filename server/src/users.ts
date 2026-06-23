import { createHash, randomBytes } from "node:crypto";
import { db } from "./db.js";

export type User = {
  id: number;
  email: string;
  session_name: string;
  phone_number: string | null;
  connected_at: number | null;
  created_at: number;
};

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function createUser(email: string): { user: User; token: string } {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existing) throw new Error("EMAIL_TAKEN");

  const token = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT INTO users (email, token_hash, session_name, phone_number, connected_at, created_at)
       VALUES (?, ?, '', NULL, NULL, ?)`
    )
    .run(normalizedEmail, hash(token), now);

  const id = Number(info.lastInsertRowid);
  const session_name = `u_${id}`;
  db.prepare("UPDATE users SET session_name = ? WHERE id = ?").run(session_name, id);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
  return { user, token };
}

export function findUserByToken(token: string): User | null {
  if (!token) return null;
  const row = db
    .prepare("SELECT * FROM users WHERE token_hash = ?")
    .get(hash(token)) as User | undefined;
  return row ?? null;
}

export function setConnected(userId: number, phone: string | null) {
  db.prepare(
    "UPDATE users SET phone_number = ?, connected_at = ? WHERE id = ?"
  ).run(phone, Math.floor(Date.now() / 1000), userId);
}
