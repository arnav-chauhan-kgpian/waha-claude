# Claude-only WhatsApp assistant — Design

A WhatsApp assistant that lives entirely inside Claude. Users never install Docker, never install WAHA, never see API keys, and never touch a REST API. The **only** non-Claude interaction is a one-time browser visit to copy a bearer token; everything else happens in chat.

## 1. Architecture

```
┌────────────────────────────────────────────────┐
│  USER'S OWN CLAUDE                             │
│  (Claude.ai / Claude Desktop / Claude Code)    │
└────────────────┬───────────────────────────────┘
                 │  MCP / Streamable HTTP
                 │  Authorization: Bearer <user-token>
                 ▼
┌────────────────────────────────────────────────┐
│  WhatsApp Tool API                             │
│   • POST /signup     (browser, one-time only)  │
│   • GET  /healthz                              │
│   • {POST,GET,DELETE} /mcp  (Claude only)      │
│   No other routes exist.                       │
└────────────────┬───────────────────────────────┘
                 │  HTTP (private VNet)
                 │  X-Api-Key: <waha-key>
                 ▼
┌────────────────────────────────────────────────┐
│  WAHA Plus on AKS                              │
│  One session per user. Name: u_<id>.           │
│  Never "default". Never shared.                │
└────────────────┬───────────────────────────────┘
                 ▼
              WhatsApp
```

Hard rule: **no REST data routes.** Anything operational (connect, status, chats, messages, send, disconnect) is reachable only through `/mcp`. The previous `/connect`, `/qr`, `/status`, `/chats`, `/messages`, `/send`, `/disconnect` routes are gone.

## 2. Database schema (SQLite, `data/app.db`)

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL,
  session_name  TEXT NOT NULL UNIQUE,   -- u_<id>
  phone_number  TEXT,
  connected_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_users_token ON users(token_hash);

CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  chat_id         TEXT NOT NULL,
  text            TEXT NOT NULL,
  waha_message_id TEXT,
  sent_at         INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_audit_user_time ON audit_log(user_id, sent_at);
```

Token = 32 random bytes, shown once, stored only as SHA-256.
Audit log = every WhatsApp send, for both accountability and rate-limit accounting.

## 3. HTTP surface

| Method | Path                    | Who calls it      | Purpose |
|--------|-------------------------|-------------------|---------|
| GET    | `/healthz`              | ops               | liveness |
| GET    | `/signup/required`      | signup page       | reports whether invite code is required |
| POST   | `/signup`               | signup page       | `{email, invite_code?}` → `{token, mcp_url}` (token shown once) |
| POST,GET,DELETE | `/mcp`         | Claude (any)      | Streamable HTTP MCP transport |
| GET    | `/` and `/signup.html`  | browser           | the signup page |

That's the whole surface. No other paths.

## 4. MCP tools (the Claude-facing surface)

| Tool                  | Input                                              | Behavior |
|-----------------------|----------------------------------------------------|----------|
| `connect_whatsapp`    | —                                                  | Create/start session; return QR as an **inline image content block** so Claude renders it for the user. |
| `get_qr`              | —                                                  | Refresh the QR (also inline image). |
| `whatsapp_status`     | —                                                  | `SCAN_QR_CODE` / `WORKING` / `STARTING` / `STOPPED` / `FAILED` / `NEW`. |
| `list_chats`          | `{ limit?: number }`                               | Recent chats. |
| `get_messages`        | `{ chatId, limit? }`                               | Recent messages. |
| `summarize_unread`    | `{ limit_chats?, messages_per_chat? }`             | Raw unread-chat snippets; Claude categorizes (Action Required / Awaiting Replies / Important Updates / Low Priority). |
| `draft_reply`         | `{ chatId, instruction, history_limit? }`          | Returns history + instruction; Claude composes the draft. **Does not send.** |
| `send_message`        | `{ chatId, text }`                                 | Sends. Rate-limited (default 30/min/user). Recorded in audit_log. Claude must confirm with the user first. |
| `disconnect_whatsapp` | —                                                  | Stop the session. |

`summarize_unread` and `draft_reply` are **context-only**: the LLM work lives in the user's Claude. This server never needs an Anthropic API key.

## 5. WAHA Plus endpoints (verified)

Auth: `X-Api-Key: <WAHA_API_KEY>`.

| Purpose             | Method | Path |
|---------------------|--------|------|
| Create + start      | POST   | `/api/sessions`  body `{ name, start: true }` |
| Get status          | GET    | `/api/sessions/{name}` |
| Stop                | POST   | `/api/sessions/{name}/stop` |
| QR (base64 PNG)     | GET    | `/api/{name}/auth/qr?format=image` (Accept: application/json) |
| List chats          | GET    | `/api/{name}/chats?limit=N&sortBy=messageTimestamp&sortOrder=desc` |
| Chat messages       | GET    | `/api/{name}/chats/{chatId}/messages?limit=N&downloadMedia=false` |
| Send text           | POST   | `/api/sendText`  body `{ session, chatId, text }` |

States: `STARTING → SCAN_QR_CODE → WORKING` (or `FAILED` / `STOPPED`).

## 6. Auth model

- One token per user, issued by `POST /signup`. Returned in plaintext exactly once; stored only as SHA-256.
- Every `/mcp` request carries `Authorization: Bearer <token>`. The server resolves user → `session_name`. **No request body or query parameter can override the session** — there is no path by which one user can reach another's WhatsApp.
- WAHA URL and `WAHA_API_KEY` live only in the backend's env. They are never sent to Claude, never serialized in MCP responses, never logged (Fastify logger redacts `Authorization` and `X-Api-Key`).
- Optional `INVITE_CODE` env gates signup; without it set, anyone with the URL can register.
- Token rotation: delete the row + signup again. No `/rotate_token` route by design — keeps the surface minimal.

## 7. Hard product rules (encoded in MCP tool descriptions)

1. **Never auto-send.** Claude must show the draft and only call `send_message` after explicit confirmation ("yes", "send", "ok send it"). Implicit reactions don't count.
2. **One chat per confirmation.** Don't batch-send to multiple chats from a single approval.
3. **Resolve names via `list_chats`.** Never invent a chatId. If multiple chats match, ask the user.
4. **On `FAILED`.** Report it. Offer `disconnect_whatsapp` and reconnect; don't silently retry.
5. **Server-enforced rate limit on send.** `send_message` returns `rate_limited` after 30 sends/minute by default (env-tunable). Audit log records every send regardless.
