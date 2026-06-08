// Topology Reconciliation Service — Active Self-Healing
//
// On server startup, detects topology drift and actively repairs it by:
// 1. Computing required worker count from DB (max enabled keys per platform)
// 2. Comparing against current topology worker count
// 3. If drift detected: redeploying via reconcile-topology script, verifying
// 4. Blocking server startup until repair is complete (throws on failure)

import {
  getWorkerCount as getTopologyWorkerCount,
  isDynamicTopologyAvailable,
} from "./proxyTopology.js";
import { getRequiredWorkerCount } from "./capacityService.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

export async function reconcileTopology(): Promise<void> {
  // Only reconcile if topology is available
  if (!isDynamicTopologyAvailable()) {
    console.log("[reconcile] Topology not available, skipping reconciliation");
    return;
  }

  const actualWorkerCount = getTopologyWorkerCount();
  const expectedWorkerCount = getRequiredWorkerCount();

  if (actualWorkerCount >= expectedWorkerCount) {
    console.log(
      `[reconcile] No drift: ${actualWorkerCount} workers >= ${expectedWorkerCount} expected`,
    );
    return;
  }

  // Drift detected — actively repair
  console.log(
    `[reconcile] Drift detected: ${actualWorkerCount} workers < ${expectedWorkerCount} expected`,
  );
  console.log("[reconcile] Initiating automatic repair...");

  // Run the reconcile-topology script as a child process
  // This redeploys workers with the required capacity
  const scriptPath = path.join(projectRoot, "scripts", "reconcile-topology.ts");
  const result = spawnSync(
    "npx",
    ["tsx", scriptPath],
    {
      cwd: projectRoot,
      stdio: "inherit",
      timeout: 120_000, // 2 minute timeout for deployment
    },
  );

  if (result.status === 0) {
    console.log("[reconcile] Repair completed successfully");
  } else {
    // Repair failed — server cannot safely operate with insufficient workers
    throw new Error(
      `[reconcile] Repair failed (exit code ${result.status}). ` +
      `Server requires ${expectedWorkerCount} workers but only ${actualWorkerCount} available. ` +
      `Run: pnpm run reconcile-topology`
    );
  }
}
