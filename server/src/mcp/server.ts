import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "../config.js";
import { findUserByToken, type User } from "../users.js";
import { extractBearer } from "../auth.js";
import { waha } from "../waha.js";
import {
  ensureSession,
  getQrOrStatus,
  getStatus,
  listChatsWithNames,
  listMessagesWithNames,
} from "../service.js";
import { countSendsInWindow, recordSend } from "../audit.js";

function buildServer(user: User): McpServer {
  const server = new McpServer({
    name: "whatsapp-via-waha",
    version: "0.1.0",
  });

  const text = (obj: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  });

  const qrResponse = (
    status: string,
    qr?: { mimetype: string; data: string }
  ) => {
    const summary = {
      status,
      next:
        status === "WORKING"
          ? "Already connected."
          : qr
            ? "Show this QR to the user. They should open WhatsApp → Settings → Linked devices → Link a device and scan it. Then call whatsapp_status to poll for WORKING."
            : "Not ready yet. Wait a few seconds and call get_qr or whatsapp_status; the QR appears when status is SCAN_QR_CODE.",
    };
    if (!qr) return text(summary);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        { type: "image" as const, data: qr.data, mimeType: qr.mimetype },
      ],
    };
  };

  server.tool(
    "connect_whatsapp",
    "Create or start this user's WhatsApp session and return a QR image (rendered inline) for them to scan. If already connected, returns the current status. Call again to refresh the QR.",
    {},
    async () => {
      await ensureSession(user);
      const out = await getQrOrStatus(user);
      return qrResponse(out.status, out.qr);
    }
  );

  server.tool(
    "get_qr",
    "Get the current QR code (rendered as an inline image). Use this to refresh a QR that has expired or to recover a QR if the previous tool call's image was lost.",
    {},
    async () => {
      const out = await getQrOrStatus(user);
      return qrResponse(out.status, out.qr);
    }
  );

  server.tool(
    "whatsapp_status",
    "Get the current WhatsApp connection status (SCAN_QR_CODE, WORKING, STARTING, STOPPED, FAILED, NEW).",
    {},
    async () => text(await getStatus(user))
  );

  server.tool(
    "list_chats",
    "List the user's recent WhatsApp chats with id, name, lastMessageAt, and unreadCount. Names for 1:1 chats are stitched in from the user's WhatsApp contacts.",
    { limit: z.number().int().min(1).optional() },
    async ({ limit }) => {
      const chats = await listChatsWithNames(user, limit ?? 0);
      return text(chats);
    }
  );

  server.tool(
    "get_messages",
    "Get recent messages from a specific chat. chatId looks like 12345@c.us / 12345@s.whatsapp.net (user) or 12345@g.us (group). Each message includes a human-readable `author` resolved from the user's contacts.",
    {
      chatId: z.string().min(3),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ chatId, limit }) => {
      const messages = await listMessagesWithNames(user, chatId, limit ?? 50);
      return text(messages);
    }
  );

  server.tool(
    "summarize_unread",
    "Fetch unread chats with their latest messages. The caller (Claude) should categorize them into: Action Required, Awaiting Replies, Important Updates, Low Priority.",
    {
      limit_chats: z.number().int().min(1).max(50).optional(),
      messages_per_chat: z.number().int().min(1).max(50).optional(),
    },
    async ({ limit_chats, messages_per_chat }) => {
      const chats = await listChatsWithNames(user, limit_chats ?? 20);
      const unread = chats.filter((c) => (c.unreadCount ?? 0) > 0);
      const enriched = await Promise.all(
        unread.map(async (c) => {
          if (!c.id) return { ...c, recent: [] };
          const msgs = await listMessagesWithNames(user, c.id, messages_per_chat ?? 10);
          return { ...c, recent: msgs };
        })
      );
      return text({
        instruction:
          "Group these into Action Required / Awaiting Replies / Important Updates / Low Priority. Use the user's own messages (fromMe=true) to detect awaiting-reply state.",
        unread_chats: enriched,
      });
    }
  );

  server.tool(
    "draft_reply",
    "Fetch recent history for a chat so Claude can compose a draft reply. Does NOT send. Returns the draft instruction back to Claude along with context.",
    {
      chatId: z.string().min(3),
      instruction: z.string().min(1).max(2000),
      history_limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ chatId, instruction, history_limit }) => {
      const messages = await listMessagesWithNames(user, chatId, history_limit ?? 30);
      return text({
        chatId,
        instruction,
        recent_messages: messages,
        next: "Compose the draft, show it to the user, and only call send_message after explicit confirmation.",
      });
    }
  );

  server.tool(
    "send_message",
    "Send a WhatsApp text message to the given chatId. Only call this AFTER the user has explicitly confirmed the draft text.",
    {
      chatId: z.string().min(3),
      text: z.string().min(1).max(8000),
    },
    async ({ chatId, text: body }) => {
      const used = countSendsInWindow(user.id, config.sendWindowSeconds);
      if (used >= config.sendMaxPerWindow) {
        return text({
          ok: false,
          error: "rate_limited",
          limit: config.sendMaxPerWindow,
          window_seconds: config.sendWindowSeconds,
        });
      }
      const result: any = await waha.sendText(user.session_name, chatId, body);
      const wahaMessageId =
        result?.key?.id ?? result?.id?._serialized ?? result?.id?.id ?? result?.id ?? result?._id ?? null;
      const audit = recordSend(user.id, chatId, body, wahaMessageId);
      return text({
        ok: true,
        sentAt: audit.sentAt,
        audit_id: audit.id,
        waha_message_id: wahaMessageId,
      });
    }
  );

  server.tool(
    "disconnect_whatsapp",
    "Stop this user's WhatsApp session.",
    {},
    async () => text(await waha.stop(user.session_name))
  );

  return server;
}

async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  const token = extractBearer(req);
  const user = token ? findUserByToken(token) : null;
  if (!user) {
    reply
      .code(401)
      .header("WWW-Authenticate", 'Bearer realm="whatsapp-mcp"')
      .send({ error: "unauthorized" });
    return null;
  }
  return user;
}

export async function registerMcp(app: FastifyInstance) {
  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticate(req, reply);
    if (!user) return;

    const server = buildServer(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.raw.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);
}
