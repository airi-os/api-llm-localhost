// Reconcile Topology — Detects and fixes topology drift between the number of
// provider API keys and the deployed llm-proxy worker count.
//
// Usage:
//   pnpm run reconcile-topology           — detect drift and redeploy if needed
//   pnpm run reconcile-topology -- --dry-run  — report actions without deploying
//
// Capacity is computed from the database and passed directly to deployProxy(),
// which writes PROXY_COUNT to llm-proxy/.env internally. The env var is never
// the source of truth — it is always written by code.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./lib/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const llmProxyRoot = path.join(projectRoot, "llm-proxy");
const llmProxyEnvPath = path.join(llmProxyRoot, ".env");
const frellmapiEnvPath = path.join(projectRoot, ".env");

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

if (isDryRun) {
  console.log("=== DRY RUN — no changes will be made ===\n");
}

// ── Expected worker count from DB ──────────────────────────────────────

async function getExpectedWorkerCount(): Promise<number> {
  const { initDb } = await import("../server/src/db/index.js");
  const { getRequiredWorkerCount } = await import("../server/src/services/capacityService.js");
  initDb();
  return getRequiredWorkerCount();
}

// ── Topology fetch ─────────────────────────────────────────────────────

interface TopologySnapshot {
  schemaVersion: number;
  topologyId: string;
  topologyGeneratedAt: number;
  workerCount: number;
  proxies: Array<{ id: number; name: string; status: string }>;
}

async function fetchTopologyWorkerCount(
  proxyUrl: string,
  internalAuth: string,
): Promise<{ ok: boolean; workerCount: number }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${proxyUrl}/internal/v1/topology`, {
        method: "GET",
        headers: internalAuth ? { "X-Internal-Auth": internalAuth } : {},
        signal: controller.signal,
      });

      if (!res.ok) {
        console.warn(`[reconcile] topology fetch failed with status ${res.status}`);
        return { ok: false, workerCount: 0 };
      }

      const data: unknown = await res.json();
      if (
        typeof data === "object" &&
        data !== null &&
        "workerCount" in data &&
        typeof (data as TopologySnapshot).workerCount === "number"
      ) {
        return { ok: true, workerCount: (data as TopologySnapshot).workerCount };
      }

      console.warn("[reconcile] invalid topology response");
      return { ok: false, workerCount: 0 };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[reconcile] topology unavailable (${message})`);
    return { ok: false, workerCount: 0 };
  }
}

// ── Drift detection ─────────────────────────────────────

interface DriftResult {
  drifted: boolean;
  actual: number;
  expected: number;
}

async function detectDrift(): Promise<DriftResult> {
  const frellmapiEnv = parseEnvFile(frellmapiEnvPath);
  const proxyUrl = frellmapiEnv.get("LLM_PROXY_URL");
  const internalAuth = frellmapiEnv.get("INTERNAL_AUTH_SECRET") ?? "";

  if (!proxyUrl) {
    console.log("[reconcile] LLM_PROXY_URL not set, skipping drift detection");
    return { drifted: false, actual: 0, expected: 0 };
  }

  const expected = await getExpectedWorkerCount();
  const topology = await fetchTopologyWorkerCount(proxyUrl, internalAuth);

  if (!topology.ok) {
    console.warn("[reconcile] topology unavailable, skipping reconciliation");
    return { drifted: false, actual: 0, expected: 0 };
  }

  const actual = topology.workerCount;

  return {
    drifted: actual < expected,
    actual,
    expected,
  };
}

// ── Reconciliation ─────────────────────────────────────────────────────

async function reconcile(): Promise<void> {
  const drift = await detectDrift();

  if (!drift.drifted) {
    if (drift.actual === 0 && drift.expected === 0) {
      console.log("[reconcile] Skipped (topology unavailable)");
    } else {
      console.log(`[reconcile] No drift detected (${drift.actual} workers)`);
    }
    return;
  }

  console.log(
    `[reconcile] Topology drift detected: ${drift.actual} workers, expected ${drift.expected}`,
  );

  if (isDryRun) {
    console.log(`  [dry-run] Would redeploy llm-proxy with ${drift.expected} workers`);
    return;
  }

  // Deploy with the required capacity — deployProxy writes PROXY_COUNT internally
  console.log(`[reconcile] Redeploying llm-proxy with ${drift.expected} workers...`);
  const { deployProxy } = await import("./deploy-proxy.js");
  await deployProxy(drift.expected);

  // Verify
  const frellmapiEnv = parseEnvFile(frellmapiEnvPath);
  const proxyUrl = frellmapiEnv.get("LLM_PROXY_URL");
  const internalAuth = frellmapiEnv.get("INTERNAL_AUTH_SECRET") ?? "";
  const newTopology = await fetchTopologyWorkerCount(proxyUrl, internalAuth);
  const newActual = newTopology.workerCount;

  if (newActual >= drift.expected) {
    console.log(`[reconcile] Success: ${newActual} workers now available`);
  } else {
    console.error(
      `[reconcile] Warning: ${newActual} workers after redeployment (expected ${drift.expected})`,
    );
    console.error("[reconcile] The redeployment may still be propagating. Check again shortly.");
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await reconcile();
  } catch (err) {
    console.error("[reconcile] Fatal error:", err);
    process.exit(1);
  }
}

main();
