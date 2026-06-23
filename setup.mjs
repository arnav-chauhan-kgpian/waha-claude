#!/usr/bin/env node
// One-command self-host setup. Cross-platform. Stdlib + Docker only.
//
//   node setup.mjs
//
// What it does:
//   1. Verifies Docker is installed and runnable.
//   2. Creates .env with strong random WAHA_API_KEY and INVITE_CODE if missing.
//   3. `docker compose up -d --build` (pulls WAHA, builds backend).
//   4. Waits for the backend to become healthy.
//   5. Signs you up with the email you provide, mints a token.
//   6. Writes .mcp.json so Claude Code (launched from this dir) picks it up.
//   7. Prints copy-paste config for Claude Desktop and Claude.ai web too.
//
// Re-runs are safe: if .mcp.json already has a token, it's reused.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { setTimeout as wait } from "node:timers/promises";

const PORT = 8080;
const BASE = `http://localhost:${PORT}`;

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

async function ask(prompt, def = "") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? ` [${def}]` : "";
  const v = (await rl.question(`${prompt}${suffix}: `)).trim();
  rl.close();
  return v || def;
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

function isClaudeDesktopInstalled() {
  // We treat "Claude config dir exists" as "the app has been run at least once".
  return existsSync(dirname(claudeDesktopConfigPath()));
}

async function maybeInstallDesktopConfig(mcpConfig) {
  const path = claudeDesktopConfigPath();
  let existing = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      console.log(`\n${path} exists but isn't valid JSON. Skipping Desktop install — fix the file first and re-run.`);
      return false;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers.whatsapp = mcpConfig.mcpServers.whatsapp;
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
  return true;
}

async function main() {
  console.log("WhatsApp Assistant — self-host setup\n");

  // 1. Docker
  const docker = findDocker();
  if (!docker) {
    console.error("Docker not found. Install Docker Desktop from https://www.docker.com/products/docker-desktop/, then open a fresh terminal and re-run this script.");
    process.exit(1);
  }
  if (!tryExec(`${docker} info`)) {
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
    const email = await ask("Your email (anything — used only as a local account id)", "me@example.com");
    const resp = await fetch(`${BASE}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, invite_code: env.INVITE_CODE }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 409) {
        console.error(`\nThat email already exists in this backend's database. Either pick a different email and re-run, or wipe the local state:\n  ${docker} compose down -v\n  (then delete server/data/ if you're outside Docker)\n  node setup.mjs`);
      } else {
        console.error(`\nSignup failed (HTTP ${resp.status}): ${body}`);
      }
      process.exit(1);
    }
    ({ token } = await resp.json());
  }

  // 6. Write .mcp.json
  const mcpConfig = {
    mcpServers: {
      whatsapp: {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  writeFileSync(".mcp.json", JSON.stringify(mcpConfig, null, 2) + "\n");
  console.log("Wrote .mcp.json (Claude Code will pick it up when launched from this directory).\n");

  // 7. Wire up the Claude clients the user actually uses
  console.log("================================================================");
  console.log("Backend ready at " + BASE);
  console.log("================================================================\n");
  console.log("Which Claude do you use?");
  console.log("  1) Claude Desktop          (recommended — works locally, no tunnel)");
  console.log("  2) Claude.ai (web)         (needs a Cloudflare Tunnel)");
  console.log("  3) Claude Code CLI         (.mcp.json already wired in this dir)");
  console.log("  4) All / I'll decide later (print configs for everything)\n");
  const choice = await ask("Pick 1/2/3/4", "1");

  const printDesktopBlock = () => {
    console.log("\nClaude Desktop config block (already merged if you picked 1):");
    console.log("  File: " + claudeDesktopConfigPath());
    console.log(JSON.stringify(mcpConfig, null, 2));
  };
  const printWebBlock = () => {
    console.log("\nClaude.ai web setup:");
    console.log("  1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    console.log("  2. In a separate terminal: cloudflared tunnel --url " + BASE);
    console.log("  3. Copy the printed https://<random>.trycloudflare.com URL.");
    console.log("  4. claude.ai → Settings → Connectors → Add custom connector:");
    console.log("     URL:    <that URL>/mcp");
    console.log("     Header: Authorization: Bearer <token from .mcp.json>");
  };
  const printCliNote = () => {
    console.log("\nClaude Code CLI: `.mcp.json` is in this directory. From a fresh");
    console.log("terminal where the `claude` command is on PATH, run:");
    console.log("    cd " + process.cwd());
    console.log("    claude");
    console.log("Then ask: Connect my WhatsApp");
  };

  if (choice === "1" || choice === "4") {
    if (!isClaudeDesktopInstalled() && choice === "1") {
      console.log("\nClaude Desktop config dir not found at " + dirname(claudeDesktopConfigPath()));
      console.log("Install Claude Desktop from https://claude.ai/download, run it once, then re-run this script.");
    } else {
      const installed = await maybeInstallDesktopConfig(mcpConfig);
      if (installed) {
        console.log("\nMerged the WhatsApp connector into Claude Desktop's config.");
        console.log("→ Restart Claude Desktop, then ask it: \"Connect my WhatsApp\".");
      }
    }
    if (choice === "4") printDesktopBlock();
  }

  if (choice === "2" || choice === "4") {
    printWebBlock();
  }

  if (choice === "3" || choice === "4") {
    printCliNote();
  }

  console.log("\nUseful:");
  console.log("  docker compose logs -f backend      # tail logs");
  console.log("  docker compose down                 # stop, keep data");
  console.log("  docker compose down -v              # stop and wipe everything");
}

main().catch((e) => {
  console.error("\nsetup failed:", e?.message || e);
  process.exit(1);
});
