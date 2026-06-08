// Deploy Proxy — Deploys llm-proxy workers to Cloudflare, captures the
// workers.dev URL, and writes LLM_PROXY_URL into the project .env.
//
// Usage:
//   pnpm run deploy-proxy           — deploy and update .env
//   pnpm run deploy-proxy -- --dry-run  — report actions without writing
//
// When called programmatically:
//   deployProxy(3) — deploy exactly 3 proxies (capacity computed externally)
//   deployProxy()  — fall back to PROXY_COUNT env var or default

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile, readEnvFileRaw, updateEnvKey } from "./lib/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const llmProxyRoot = path.join(projectRoot, "llm-proxy");
const llmProxyEnvPath = path.join(llmProxyRoot, ".env");
const frellmapiEnvPath = path.join(projectRoot, ".env");

const DIST_DIR = path.join(llmProxyRoot, "dist");

const DEFAULT_PROXY_COUNT = 1;
const WORKER_NAME_PREFIX = "llm-proxy-";
const WORKER_NAME_PAD = 2;

const DEPLOY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 2000,
  staggerDelayMs: 1000,
} as const;

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

if (isDryRun) {
  console.log("=== DRY RUN — no changes will be made ===\n");
}

// ── Types ─────────────────────────────────────────────────────────────

interface WorkerConfig {
  name: string;
  configPath: string;
  type: "proxy" | "router";
}

interface DeployResult {
  worker: WorkerConfig;
  success: boolean;
  attempts: number;
  error?: string;
  durationMs: number;
}

// ── Env loading ───────────────────────────────────────────────────────

function loadEnv(): Map<string, string> {
  if (!fs.existsSync(llmProxyEnvPath)) {
    console.error(
      "❌ llm-proxy/.env not found. Run `pnpm run setup` first."
    );
    process.exit(1);
  }
  return parseEnvFile(llmProxyEnvPath);
}

function requireEnv(env: Map<string, string>, name: string, minLen: number): string {
  const val = env.get(name);
  if (!val) {
    console.error(`❌ ${name} not set in llm-proxy/.env`);
    process.exit(1);
  }
  if (val.length < minLen) {
    console.error(`❌ ${name} must be at least ${minLen} characters`);
    process.exit(1);
  }
  return val;
}

// ── TOML generation ───────────────────────────────────────────────────

function tomlStringify(obj: Record<string, unknown>, indent: string = ""): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          lines.push(`${indent}[[${key}]]`);
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (v === undefined || v === null) continue;
            lines.push(`${indent}${k} = ${tomlValue(v)}`);
          }
        } else {
          lines.push(`${indent}${key} = ${tomlValue(item)}`);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      lines.push(`${indent}[${key}]`);
      lines.push(tomlStringify(value as Record<string, unknown>, indent));
    } else {
      lines.push(`${indent}${key} = ${tomlValue(value)}`);
    }
  }

  return lines.join("\n");
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value.toString();
  return `"${String(value)}"`;
}

function generateProxyToml(index: number, internalSecret: string): string {
  const name = `${WORKER_NAME_PREFIX}${String(index).padStart(WORKER_NAME_PAD, "0")}`;

  const config: Record<string, unknown> = {
    name,
    main: "../src/worker.ts",
    compatibility_date: "2024-12-01",
    placement: { mode: "off" },
    vars: {
      WORKER_ROLE: "proxy",
      PROXY_INDEX: String(index),
      INTERNAL_AUTH_SECRET: internalSecret,
    },
  };

  return tomlStringify(config);
}

function generateRouterToml(proxyCount: number, internalSecret: string, authKey: string): string {
  const services: Record<string, unknown>[] = [];
  for (let i = 1; i <= proxyCount; i++) {
    services.push({
      binding: `PROXY_${i}`,
      service: `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`,
    });
  }

  const config: Record<string, unknown> = {
    name: "llm-proxy-router",
    main: "../src/worker.ts",
    compatibility_date: "2024-12-01",
    placement: { mode: "smart" },
    vars: {
      WORKER_ROLE: "router",
      AUTH_KEY: authKey,
      INTERNAL_AUTH_SECRET: internalSecret,
      PROXY_COUNT: String(proxyCount),
    },
    services,
  };

  return tomlStringify(config);
}

// ── Wrangler deploy ───────────────────────────────────────────────────

function runWranglerDeploy(configPath: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const configRel = path.relative(llmProxyRoot, configPath);
  const cmd = `npx wrangler deploy -c ${configRel}`;

  return new Promise((resolve) => {
    const proc = spawn(cmd, { cwd: llmProxyRoot, shell: true, stdio: "pipe" });
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      resolve({
        success: code === 0,
        stdout,
        stderr: code === 0 ? "" : stderr || stdout,
      });
    });
  });
}

async function deployWithRetry(worker: WorkerConfig): Promise<DeployResult> {
  const start = Date.now();
  let lastError = "";

  for (let attempt = 1; attempt <= DEPLOY_CONFIG.maxRetries; attempt++) {
    console.log(`   🔄 ${worker.name} (attempt ${attempt})...`);
    const result = await runWranglerDeploy(worker.configPath);

    if (result.success) {
      return { worker, success: true, attempts: attempt, durationMs: Date.now() - start };
    }

    lastError = result.stderr;

    if (attempt < DEPLOY_CONFIG.maxRetries) {
      const delay = DEPLOY_CONFIG.baseDelayMs * 2 ** (attempt - 1);
      console.log(`   ⚠️  ${worker.name} failed, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { worker, success: false, attempts: DEPLOY_CONFIG.maxRetries, error: lastError, durationMs: Date.now() - start };
}

async function deployParallel(workers: WorkerConfig[]): Promise<DeployResult[]> {
  const tasks = workers.map((worker, index) =>
    (async () => {
      await new Promise((r) => setTimeout(r, index * DEPLOY_CONFIG.staggerDelayMs));
      return deployWithRetry(worker);
    })(),
  );
  return Promise.all(tasks);
}

// ── URL capture ───────────────────────────────────────────────────────

function captureRouterUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/llm-proxy-router\.[a-zA-Z0-9-]+\.workers\.dev/);
  return match ? match[0] : null;
}

// ── Summary ───────────────────────────────────────────────────────────

function printSummary(results: DeployResult[], totalStart: number): void {
  const succeeded = results.filter((r) => r.success).length;
  const totalMs = Date.now() - totalStart;

  console.log("\n┌─────────────────────────────────────────────┐");
  console.log("│ Deploy Summary                              │");
  console.log("├─────────────────────────────────────────────┤");

  for (const r of results) {
    const status = r.success ? "✅" : "❌";
    const name = r.worker.name.padEnd(20);
    const attempts = r.success
      ? `(${r.attempts} attempt${r.attempts > 1 ? "s" : ""}, ${(r.durationMs / 1000).toFixed(1)}s)`
      : `(${r.attempts} attempts)`;

    console.log(`│ ${status} ${name} ${attempts.padEnd(20)} │`);

    if (!r.success && r.error) {
      const errorLine = r.error.split("\n")[0].slice(0, 40);
      console.log(`│    Error: ${errorLine.padEnd(32)} │`);
    }
  }

  console.log("├─────────────────────────────────────────────┤");
  console.log(`${`│ Total: ${succeeded}/${results.length} succeeded in ${(totalMs / 1000).toFixed(1)}s`.padEnd(46)}│`);
  console.log("└─────────────────────────────────────────────┘");
}

// ── Main ──────────────────────────────────────────────────────────────

export async function deployProxy(proxyCount?: number): Promise<void> {
  const env = loadEnv();

  const authKey = requireEnv(env, "AUTH_KEY", 8);
  const internalSecret = requireEnv(env, "INTERNAL_AUTH_SECRET", 32);

  // Use provided capacity, or fall back to env, or default to 1
  const effectiveCount = proxyCount ?? Number(env.get("PROXY_COUNT")) || DEFAULT_PROXY_COUNT;

  // Write the capacity to llm-proxy/.env so the router picks it up
  // This is the ONLY place PROXY_COUNT is written — never user-editable
  updateEnvKey(llmProxyEnvPath, "PROXY_COUNT", String(effectiveCount), false);

  console.log(`🚀 Deploying ${effectiveCount} proxies + router`);

  if (isDryRun) {
    console.log(`  [dry-run] Would generate TOML configs in ${path.relative(projectRoot, DIST_DIR)}`);
    for (let i = 1; i <= effectiveCount; i++) {
      const name = `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`;
      console.log(`  [dry-run] Would deploy proxy: ${name}`);
    }
    console.log(`  [dry-run] Would deploy router: llm-proxy-router`);
    console.log(`  [dry-run] Would capture router URL from wrangler output`);
    console.log(`  [dry-run] Would write LLM_PROXY_URL to .env`);
    console.log("\n✅ Dry run complete. No files were modified.");
    return;
  }

  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  const totalStart = Date.now();
  const allResults: DeployResult[] = [];

  // Generate and deploy proxy workers
  const proxyWorkers: WorkerConfig[] = [];
  for (let i = 1; i <= effectiveCount; i++) {
    const toml = generateProxyToml(i, internalSecret);
    const configPath = path.join(DIST_DIR, `proxy-${String(i).padStart(2, "0")}.toml`);
    fs.writeFileSync(configPath, toml);
    proxyWorkers.push({
      name: `${WORKER_NAME_PREFIX}${String(i).padStart(WORKER_NAME_PAD, "0")}`,
      configPath,
      type: "proxy",
    });
  }

  console.log("\n📦 Phase 1: Deploying proxies...");
  const proxyResults = await deployParallel(proxyWorkers);
  allResults.push(...proxyResults);

  const failedProxies = proxyResults.filter((r) => !r.success);
  if (failedProxies.length > 0) {
    console.error(`\n⚠️  ${failedProxies.length} proxies failed. Continuing to Router...`);
  }

  // Generate and deploy router
  const routerToml = generateRouterToml(effectiveCount, internalSecret, authKey);
  const routerConfigPath = path.join(DIST_DIR, "router.toml");
  fs.writeFileSync(routerConfigPath, routerToml);
  const routerWorker: WorkerConfig = {
    name: "llm-proxy-router",
    configPath: routerConfigPath,
    type: "router",
  };

  console.log("\n📦 Phase 2: Deploying router...");
  const routerResult = await deployWithRetry(routerWorker);
  allResults.push(routerResult);

  // Summary
  printSummary(allResults, totalStart);

  // Capture URL from router deploy output
  if (!routerResult.success) {
    console.error("\n❌ Router deployment failed. Cannot capture URL.");
    console.error("   Manual recovery: deploy the router manually and set LLM_PROXY_URL in .env.");
    process.exit(1);
  }

  // Re-run wrangler deploy to capture output (the deploy already succeeded above,
  // but we need the stdout with the URL). We use `wrangler deploy` which is
  // idempotent — it will just confirm the worker is up to date and print the URL.
  // Actually, we already have the result from deployWithRetry, but runWranglerDeploy
  // doesn't return stdout on success path. Let's run it once more to capture output.
  console.log("\n📡 Capturing router URL...");
  const routerDeployOutput = await runWranglerDeploy(routerConfigPath);

  // Try stdout first, then stderr (wrangler sometimes prints to stderr)
  const wranglerOutput = routerDeployOutput.stdout || routerDeployOutput.stderr || "";
  const routerUrl = captureRouterUrl(wranglerOutput);

  if (!routerUrl) {
    console.error("\n❌ Could not detect router URL from wrangler output.");
    console.error("   Check wrangler deploy output manually.");
    console.error(`   Then set LLM_PROXY_URL in .env, e.g.:`);
    console.error(`   LLM_PROXY_URL=https://llm-proxy-router.<subdomain>.workers.dev`);
    process.exit(1);
  }

  // Validate HTTPS URL
  try {
    const parsed = new URL(routerUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("URL must use HTTPS");
    }
  } catch (err) {
    console.error(`\n❌ Invalid URL captured: ${routerUrl}`);
    console.error("   Set LLM_PROXY_URL manually in .env.");
    process.exit(1);
  }

  console.log(`   ✅ Router URL: ${routerUrl}`);

  // Write LLM_PROXY_URL to .env
  console.log("\n📝 Writing LLM_PROXY_URL to .env...");
  updateEnvKey(frellmapiEnvPath, "LLM_PROXY_URL", routerUrl, false);
  console.log(`   ✅ LLM_PROXY_URL written to .env`);

  const totalFailed = allResults.filter((r) => !r.success).length;
  if (totalFailed > 0) {
    console.error(`\n⚠️  ${totalFailed} worker(s) failed deployment.`);
    process.exit(1);
  }

  console.log(`\n✅ All systems operational.`);
  console.log(`   Configs: ${path.relative(projectRoot, DIST_DIR)}`);
  console.log(`   Router:  ${routerUrl}`);
}

// ── Entry point ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await deployProxy();
    process.exit(0);
  } catch (err) {
    console.error("❌ deploy-proxy failed:", err);
    process.exit(1);
  }
}

// Only run main if executed directly (not imported)
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
