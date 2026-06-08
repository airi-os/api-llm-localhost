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

import { detectDrift } from "./lib/reconcile-core.js";

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

if (isDryRun) {
  console.log("=== DRY RUN — no changes will be made ===\n");
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

  // Delegate to shared reconcile logic (handles deploy + verify)
  const { reconcile: sharedReconcile } = await import("./lib/reconcile-core.js");
  await sharedReconcile();
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await reconcile();
    process.exit(0);
  } catch (err) {
    console.error("[reconcile] Fatal error:", err);
    process.exit(1);
  }
}

main();
