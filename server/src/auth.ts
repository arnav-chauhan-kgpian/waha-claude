import type { FastifyReply, FastifyRequest } from "fastify";
import { findUserByToken, type User } from "./users.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}

export function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
  const token = extractBearer(req);
  const user = token ? findUserByToken(token) : null;
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  req.user = user;
  return user;
}
