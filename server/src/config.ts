import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

export const config = {
  port: Number(process.env.PORT ?? 8080),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`,
  wahaUrl: required("WAHA_URL").replace(/\/+$/, ""),
  wahaApiKey: required("WAHA_API_KEY"),
  dataDir,
  dbPath: resolve(dataDir, "app.db"),
  // Optional gate: when set, /signup requires { invite_code: "<value>" }.
  inviteCode: process.env.INVITE_CODE ?? null,
  // Per-user /send rate limit. Token bucket: maxSends per windowSeconds.
  sendMaxPerWindow: Number(process.env.SEND_MAX_PER_WINDOW ?? 30),
  sendWindowSeconds: Number(process.env.SEND_WINDOW_SECONDS ?? 60),
};
