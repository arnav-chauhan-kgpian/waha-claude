#!/usr/bin/env node
// One-command self-host setup. Cross-platform. Stdlib + Docker only.
//
//   node setup.mjs                 # configure everything it finds, no questions
//   node setup.mjs --email me@x    # pin the local signup id (default: auto-generated)
//   node setup.mjs --skip-global   # don't touch ~/.claude.json (Claude Code user scope)
//   node setup.mjs --skip-desktop  # don't touch Claude Desktop's config
//
// What it does (all automatic — no prompts):
//   1. Verifies Docker is installed and runnable.
//   2. Creates .env with strong random WAHA_API_KEY and INVITE_CODE if missing.
//   3. `docker compose up -d --build` (pulls WAHA, builds backend).
//   4. Waits for the backend to become healthy.
//   5. Signs you up (auto-generated local email) and mints a token.
//   6. Registers the WhatsApp connector with EVERY Claude it finds:
//        • Claude Code  — user scope (~/.claude.json) so it works from ANY directory,
//                         plus this repo's .mcp.json for project scope.
//        • Claude Desktop — merged into claude_desktop_config.json.
//      and prints the claude.ai (web) tunnel steps.
//
// Re-runs are safe: if .mcp.json already has a token, it's reused; every registration
// step is idempotent (it overwrites only the `whatsapp` entry, leaving the rest alone).

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const PORT = 8080;
const BASE = `http://localhost:${PORT}`;

// --- tiny arg parser ---------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
if (flag("help")) {
  console.log("Usage: node setup.mjs [--email me@example.com] [--skip-global] [--skip-desktop]");
  process.exit(0);
}

function tryExec(cmd) {
  try { execSync(cmd, { stdio: "ignore" }); return true; } catch { return false; }
}

function findDocker() {
  // On Windows, prefer the absolute path so we don't need shell:true (which
  // triggers a Node deprecation warning when args are also passed).
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Program Files\\Docker\\Docker\\resources\\docker.exe",
    ];
    for (const c of candidates) {
      if (existsSync(c) && tryExec(`"${c}" --version`)) return c;
    }
  }
  if (tryExec("docker --version")) return "docker";
  return null;
}

// Locate the Claude Code CLI so we can register at user scope the supported way.
// Returns an absolute path / "claude", or null if it isn't installed.
function findClaude() {
  const home = homedir();
  const candidates = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localApp = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    candidates.push(
      join(appData, "npm", "claude.cmd"),
      join(localApp, "Programs", "claude", "claude.exe"),
      join(home, ".local", "bin", "claude.exe"),
    );
  } else {
    candidates.push(
      join(home, ".local", "bin", "claude"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    );
  }
  for (const c of candidates) {
    if (existsSync(c) && tryExec(`"${c}" --version`)) return c;
  }
  if (tryExec("claude --version")) return "claude";
  return null;
}

function readEnv() {
  if (!existsSync(".env")) return {};
  return Object.fromEntries(
    readFileSync(".env", "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      })
  );
}

function writeEnv(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  writeFileSync(".env", lines.join("\n") + "\n");
}

async function pollHealth(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch { /* connection refused while it boots */ }
    await wait(1500);
  }
  return false;
}

// --- JSON config helpers -----------------------------------------------------
function mergeJsonConfig(path, mutate, { backup = false } = {}) {
  let cfg = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { ok: false, reason: `${path} exists but isn't valid JSON` };
    }
    if (backup) {
      try { copyFileSync(path, `${path}.bak`); } catch { /* best effort */ }
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  mutate(cfg);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return { ok: true, path };
}

function claudeDesktopConfigPath() {
  if (process.platform === "darwin") {
    return `${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`;
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? `${homedir()}\\AppData\\Roaming`;
    return `${appData}\\Claude\\claude_desktop_config.json`;
  }
  return `${homedir()}/.config/Claude/claude_desktop_config.json`;
}

const claudeCodeUserConfigPath = () => join(homedir(), ".claude.json");

// Register the connector for Claude Code at USER scope so it's available from
// every directory ("whole Claude"). Prefer the CLI (it handles locking); fall
// back to editing ~/.claude.json directly with a backup.
function registerClaudeCodeUser(server) {
  const claude = findClaude();
  if (claude) {
    // Replace any prior entry, then add fresh.
    spawnSync(claude, ["mcp", "remove", "--scope", "user", "whatsapp"], { stdio: "ignore" });
    const r = spawnSync(claude, [
      "mcp", "add", "--scope", "user", "--transport", "http",
      "whatsapp", server.url, "--header", `Authorization: Bearer ${server.headers.Authorization.slice("Bearer ".length)}`,
    ], { stdio: "ignore" });
    if (r.status === 0) return { ok: true, how: `claude mcp add --scope user (${claude})` };
    // fall through to direct edit if the CLI call failed
  }
  const path = claudeCodeUserConfigPath();
  const res = mergeJsonConfig(path, (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.whatsapp = server;
  }, { backup: true });
  if (!res.ok) return { ok: false, how: res.reason };
  return { ok: true, how: `edited ${path} (backup at ${path}.bak)`, restart: true };
}

function registerClaudeDesktop(server) {
  const path = claudeDesktopConfigPath();
  // Only configure Desktop if it's actually installed (config dir present).
  if (!existsSync(dirname(path))) return { ok: false, how: "not installed" };
  const res = mergeJsonConfig(path, (cfg) => {
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.whatsapp = server;
  });
  if (!res.ok) return { ok: false, how: res.reason };
  return { ok: true, how: path, restart: true };
}

async function main() {
  console.log("WhatsApp Assistant — self-host setup\n");

  // 1. Docker
  const docker = findDocker();
  if (!docker) {
    console.error("Docker not found. Install Docker Desktop from https://www.docker.com/products/docker-desktop/, then open a fresh terminal and re-run this script.");
    process.exit(1);
  }
  if (!tryExec(`"${docker}" info`)) {
    console.error("Docker is installed but not running. Start Docker Desktop and re-run.");
    process.exit(1);
  }

  // 2. .env
  let env = readEnv();
  let envChanged = false;
  if (!env.WAHA_API_KEY) {
    env.WAHA_API_KEY = randomBytes(32).toString("hex");
    envChanged = true;
  }
  if (!env.INVITE_CODE) {
    env.INVITE_CODE = randomBytes(8).toString("hex");
    envChanged = true;
  }
  if (envChanged) {
    writeEnv(env);
    console.log("Created .env with strong random WAHA_API_KEY and INVITE_CODE.\n");
  }

  // 3. docker compose up
  console.log("Starting Docker stack (this pulls WAHA Plus and builds the backend — a few minutes on first run)…\n");
  const up = spawnSync(docker, ["compose", "up", "-d", "--build"], {
    stdio: "inherit",
  });
  if (up.status !== 0) {
    console.error(
      "\n`docker compose up` failed. Likely cause: you haven't logged into Docker with your WAHA Plus credentials. Run:\n  docker login\n(username: `devlikeapro`, password: your WAHA Plus access token from https://waha.devlike.pro/)\nThen re-run this script."
    );
    process.exit(1);
  }

  // 4. Wait for backend
  process.stdout.write("\nWaiting for the backend to come up… ");
  const healthy = await pollHealth();
  if (!healthy) {
    console.error("backend did not become healthy in 90s. Check logs:\n  docker compose logs backend");
    process.exit(1);
  }
  console.log("ready.\n");

  // 5. Sign up (or reuse existing token)
  let token, mcpUrl = `${BASE}/mcp`;
  if (existsSync(".mcp.json")) {
    try {
      const existing = JSON.parse(readFileSync(".mcp.json", "utf8"));
      const cfg = existing.mcpServers?.whatsapp;
      const auth = cfg?.headers?.Authorization;
      if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        token = auth.slice("Bearer ".length);
        mcpUrl = cfg.url || mcpUrl;
        console.log("Reusing existing token from .mcp.json (delete the file to force a new signup).");
      }
    } catch { /* ignore corrupt file */ }
  }

  if (!token) {
    // The email is only a local account id. Auto-generate a unique one so the
    // setup never collides with a previous signup (HTTP 409). Override with --email.
    const email = opt("email", `me+${randomBytes(4).toString("hex")}@example.com`);
    console.log(`Signing up local account: ${email}`);
    const resp = await fetch(`${BASE}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, invite_code: env.INVITE_CODE }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 409) {
        console.error(`\nThat email already exists in this backend's database. Re-run with a different --email, or wipe local state:\n  ${docker} compose down -v\n  node setup.mjs`);
      } else {
        console.error(`\nSignup failed (HTTP ${resp.status}): ${body}`);
      }
      process.exit(1);
    }
    ({ token } = await resp.json());
  }

  // 6. The single connector definition we register everywhere.
  const server = {
    type: "http",
    url: mcpUrl,
    headers: { Authorization: `Bearer ${token}` },
  };
  const mcpConfig = { mcpServers: { whatsapp: server } };

  // 6a. Project scope — this repo's .mcp.json (so `claude` launched here just works).
  writeFileSync(".mcp.json", JSON.stringify(mcpConfig, null, 2) + "\n");

  // 6b. Register with every Claude we can find.
  console.log("\n================================================================");
  console.log("Backend ready at " + BASE + " — registering the connector:");
  console.log("================================================================");

  const results = [];
  results.push(["Claude Code (project: ./.mcp.json)", { ok: true, how: process.cwd() }]);

  if (flag("skip-global")) {
    results.push(["Claude Code (user / global)", { ok: false, how: "skipped (--skip-global)" }]);
  } else {
    results.push(["Claude Code (user / global)", registerClaudeCodeUser(server)]);
  }

  if (flag("skip-desktop")) {
    results.push(["Claude Desktop", { ok: false, how: "skipped (--skip-desktop)" }]);
  } else {
    results.push(["Claude Desktop", registerClaudeDesktop(server)]);
  }

  let needRestart = false;
  for (const [name, r] of results) {
    console.log(`  ${r.ok ? "✓" : "•"} ${name}: ${r.how}`);
    if (r.ok && r.restart) needRestart = true;
  }

  // 6c. Web can't be automated (no localhost from claude.ai) — print the steps.
  console.log("\nClaude.ai (web) — needs a free tunnel:");
  console.log("  1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  console.log("  2. In a separate terminal: cloudflared tunnel --url " + BASE);
  console.log("  3. claude.ai → Settings → Connectors → Add custom connector:");
  console.log("       URL:    https://<random>.trycloudflare.com/mcp");
  console.log("       Header: Authorization: Bearer <token from .mcp.json>");

  console.log("\n----------------------------------------------------------------");
  if (needRestart) {
    console.log("Restart Claude (Desktop / any open Claude Code) to pick up the connector.");
  }
  console.log('Then ask your Claude: "Connect my WhatsApp"');
  console.log("----------------------------------------------------------------");

  console.log("\nUseful:");
  console.log("  docker compose logs -f backend      # tail logs");
  console.log("  docker compose down                 # stop, keep data");
  console.log("  docker compose down -v              # stop and wipe everything");
}

main().catch((e) => {
  console.error("\nsetup failed:", e?.message || e);
  process.exit(1);
});
