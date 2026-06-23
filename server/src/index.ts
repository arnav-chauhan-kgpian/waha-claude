import Fastify from "fastify";
import { config } from "./config.js";
import { registerRoutes } from "./http/routes.js";
import { registerOnboarding } from "./http/onboarding.js";
import { registerMcp } from "./mcp/server.js";

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers['x-api-key']"],
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  await registerMcp(app);
  await registerRoutes(app);
  await registerOnboarding(app);

  app.get("/healthz", async () => ({ ok: true }));

  app.setErrorHandler((err: any, _req, reply) => {
    app.log.error(err);
    const status = err?.statusCode ?? 500;
    reply.code(status).send({ error: err?.message ?? "internal_error" });
  });

  await app.listen({ host: "0.0.0.0", port: config.port });
  app.log.info(`Tool API on ${config.publicBaseUrl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
