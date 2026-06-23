# Local testing

Run the whole stack — WAHA Plus + the backend — on your laptop and exercise it from Claude.

## Prerequisites

- Docker Desktop, running.
- `docker login` already done with your `devlikeapro/waha-plus` credentials so the image can pull. (One-time.)
- A Claude client that talks to HTTP MCP servers. In order of friction:
  - **Claude Code** — easiest, hits `http://localhost` directly.
  - **Claude Desktop** — also fine for localhost.
  - **Claude.ai web** — can't reach localhost; needs a tunnel (see below).

## Start

```bash
cp .env.example .env       # defaults are fine
docker compose up -d
```

This brings up:
- WAHA Plus on `127.0.0.1:3000` (private to your machine).
- Backend on `127.0.0.1:8080`.

Sanity check:
```bash
curl -s http://localhost:8080/healthz                 # → {"ok":true}
curl -s http://localhost:8080/signup/required         # → {"invite_code_required":true}
```

Tail backend logs while you test:
```bash
docker compose logs -f backend
```

## Sign up + grab your token

Open <http://localhost:8080> in a browser.
Email: anything (`me@example.com` is fine). Invite code: `local-dev`. Hit **Get token** and copy the token from the page — it's shown once.

## Wire Claude to the local backend

### Claude Code

```bash
claude mcp add --transport http whatsapp http://localhost:8080/mcp \
  --header "Authorization: Bearer <paste-your-token>"
```

In any Claude Code session, say: **"Connect my WhatsApp."** The QR renders inline. Scan with your phone (WhatsApp → Settings → Linked devices → Link a device). When `whatsapp_status` returns `WORKING`, you're connected.

### Claude Desktop

Edit your Claude Desktop config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add (merge with anything else you already have):

```json
{
  "mcpServers": {
    "whatsapp": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer <paste-your-token>"
      }
    }
  }
}
```

Quit and reopen Claude Desktop, then say "Connect my WhatsApp."

### Claude.ai (web) — needs a tunnel

`localhost` is not reachable from the public internet, so Claude.ai web can't see your backend directly. Easiest fix:

```bash
# install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
cloudflared tunnel --url http://localhost:8080
```

It prints a URL like `https://<random>.trycloudflare.com`. Two small follow-ups:

1. Set `PUBLIC_BASE_URL` in `.env` to that URL and `docker compose up -d` again so the signup page advertises the right MCP URL.
2. In Claude.ai → Settings → Connectors → Add custom connector:
   - URL: `https://<random>.trycloudflare.com/mcp`
   - Header: `Authorization: Bearer <your-token>`

Then go to <https://random.trycloudflare.com/> in a browser and sign up there to mint a fresh token. (Tokens are issued by your local backend either way — the tunnel just exposes it.)

## Dev mode (fast iteration on the backend)

When you're editing backend code and want hot reload, run **only WAHA** in Docker and run the backend with `npm run dev`:

```bash
docker compose up -d waha           # just WAHA

cd server
cp .env.example .env
# edit server/.env: WAHA_URL=http://localhost:3000, WAHA_API_KEY=<same as root .env>
npm install
npm run dev
```

The backend hot-reloads on file change. The data dir is `server/data/`.

## What to test, in order

1. **Connect.** Ask Claude "Connect my WhatsApp." Expect: inline QR image, then `WORKING` after scan.
2. **List chats.** Ask "What's on my WhatsApp?" Expect: a list with names and unread counts.
3. **Summarize.** Ask "Summarize my unread chats." Expect: four-bucket summary (Action Required / Awaiting Replies / Important Updates / Low Priority).
4. **Draft + send.** Ask "Reply to [a contact] that I'll send the proposal tomorrow." Expect: Claude shows a draft and asks "Send?" — say "yes" — message arrives on the other phone.
5. **Audit log.** Confirm every send was recorded:
   ```bash
   docker compose exec backend sqlite3 /app/data/app.db "SELECT * FROM audit_log"
   ```
6. **Rate limit.** Spam `send_message` 31 times in a minute → 31st one should come back as `rate_limited`.
7. **Reconnect.** Ask "Disconnect my WhatsApp," then "Connect my WhatsApp" again — should work end to end.

## Likely first-run hiccup

The very first time `list_chats` or `get_messages` runs against your real WAHA, the field names may not match what the normalizers in [server/src/service.ts](server/src/service.ts) expect. NOWEB and WEBJS return slightly different JSON. Inspect the raw WAHA response:

```bash
curl -sH "X-Api-Key: local-waha-key-change-me" \
  "http://localhost:3000/api/u_1/chats?limit=5" | jq .
```

If a field like `id`, `name`, or `unreadCount` comes through as `null`, add the actual key WAHA used to `normalizeChats` / `normalizeMessages`. Same drill for `get_messages`.

## Tear down

```bash
docker compose down            # stop, keep data
docker compose down -v         # stop and wipe all volumes (fresh start, you'll re-link WhatsApp)
```
