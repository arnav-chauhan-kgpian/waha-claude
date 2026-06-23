import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fastifyStatic from "@fastify/static";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function registerOnboarding(app: FastifyInstance) {
  await app.register(fastifyStatic, {
    root: resolve(__dirname, "../public"),
    prefix: "/",
    index: ["signup.html"],
  });
}
