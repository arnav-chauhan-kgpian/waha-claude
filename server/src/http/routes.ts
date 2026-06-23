import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUser } from "../users.js";
import { config } from "../config.js";

// This file deliberately exposes ONLY the routes a brand-new user (without a
// token yet) needs to bootstrap onto the MCP server. Everything operational —
// connect / status / chats / messages / send / disconnect — lives in mcp/server.ts
// and is reachable only through Claude.
const SignupSchema = z.object({
  email: z.string().email(),
  invite_code: z.string().optional(),
});

export async function registerRoutes(app: FastifyInstance) {
  app.get("/signup/required", async () => ({
    invite_code_required: !!config.inviteCode,
  }));

  app.post("/signup", async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (config.inviteCode && parsed.data.invite_code !== config.inviteCode) {
      return reply.code(403).send({ error: "invalid_invite_code" });
    }
    try {
      const { user, token } = createUser(parsed.data.email);
      return {
        token,
        session_name: user.session_name,
        mcp_url: `${config.publicBaseUrl}/mcp`,
        message:
          "Save this token now — it is not shown again. Add the MCP server to Claude with Authorization: Bearer <token>.",
      };
    } catch (e: any) {
      if (e.message === "EMAIL_TAKEN") return reply.code(409).send({ error: "email_taken" });
      throw e;
    }
  });
}
