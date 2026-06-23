import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    token_hash    TEXT NOT NULL,
    session_name  TEXT NOT NULL UNIQUE,
    phone_number  TEXT,
    connected_at  INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token_hash);

  CREATE TABLE IF NOT EXISTS audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    chat_id         TEXT NOT NULL,
    text            TEXT NOT NULL,
    waha_message_id TEXT,
    sent_at         INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log(user_id, sent_at);
`);
