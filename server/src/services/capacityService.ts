// Capacity Service — Single source of truth for worker count
//
// The required worker count is derived exclusively from the database:
//   max(enabled API keys per platform)
//
// This service is used by:
// - topologyReconciliation.ts (startup self-healing)
// - reconcile-topology.ts (standalone reconciliation)
// - deploy-proxy.ts (initial deployment)
// - verify-deploy.ts (deployment verification)

import { getDb } from "../db/index.js";

/**
 * Returns the required worker count based on the maximum number of
 * enabled API keys across all provider platforms.
 *
 * SQL: SELECT MAX(key_count) FROM (
 *        SELECT COUNT(*) as key_count FROM api_keys WHERE enabled = 1 GROUP BY platform
 *      )
 *
 * Falls back to 1 if no keys exist (minimum viable pool).
 */
export function getRequiredWorkerCount(): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(key_count) as max_count FROM (
      SELECT COUNT(*) as key_count FROM api_keys WHERE enabled = 1 GROUP BY platform
    )
  `).get() as { max_count: number | null };
  return row?.max_count && row.max_count > 0 ? row.max_count : 1;
}
