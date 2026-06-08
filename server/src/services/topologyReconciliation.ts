// Topology Reconciliation Service — Active Self-Healing
//
// On server startup, detects topology drift and actively repairs it by:
// 1. Computing required worker count from DB (max enabled keys per platform)
// 2. Comparing against current topology worker count
// 3. If drift detected: redeploying via reconcile-topology script
// 4. Logging success/failure (non-blocking — server continues in degraded mode)

import {
  getWorkerCount as getTopologyWorkerCount,
  isDynamicTopologyAvailable,
} from "./proxyTopology.js";
import { getRequiredWorkerCount } from "./capacityService.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

export async function reconcileTopology(): Promise<void> {
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

  // Drift detected — actively repair in the background
  console.log(
    `[reconcile] Drift detected: ${actualWorkerCount} workers < ${expectedWorkerCount} expected`,
  );
  console.log("[reconcile] Initiating automatic repair in the background...");

  const scriptPath = path.join(projectRoot, "scripts", "reconcile-topology.ts");

  // Run asynchronously to avoid blocking the event loop and server startup
  const child = spawn("npx", ["tsx", scriptPath], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error(`[reconcile] Failed to start reconciliation process: ${err.message}`);
    console.error(`[reconcile] Run manually: pnpm run reconcile-topology`);
  });

  child.on("close", (code) => {
    if (code === 0) {
      console.log("[reconcile] Repair completed successfully");
    } else {
      console.error(
        `[reconcile] Repair failed with exit code ${code}. ` +
        `Server operating with degraded topology (${actualWorkerCount}/${expectedWorkerCount} workers). ` +
        `Run: pnpm run reconcile-topology`,
      );
    }
  });
}
