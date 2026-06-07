// IP Pool Capacity Manager
//
// Tracks outbound IP allocation for sticky sessions, ensuring concurrency
// does not exceed the available rotating proxy IP pool.
//
// Capacity model:
//   - Each IP slot serves 1 session at a time (conservative).
//   - LongCat: 1 session per IP (IP-bound regardless of key count).
//
// When PROXY_IP_COUNT is unset or 0, all capacity checks pass through
// (backward compatible — no IP awareness).
//
// In-memory only, following the same pattern as ratelimit.ts.

import { getWorkerCount as getTopologyWorkerCount, isDynamicTopologyAvailable } from "./proxyTopology.js";
import crypto from "crypto";

/**
 * Short hash of an API key for logging — exposes only the first 12 hex chars
 * of a SHA-256 digest, sufficient for correlation without leaking the key.
 */
function shortHashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Result of an IP allocation attempt for a given API key.
 * The `kind` field preserves the failure reason atomically.
 */
export type AllocationResult =
  | { kind: "allocated"; ipIndex: number }
  | { kind: "bypass" }
  | { kind: "key_busy" }
  | { kind: "capacity_exhausted" };

// Set of ipIndex values currently in use
const ipPool = new Set<number>();

// apiKey → ipIndex (for "is this key active?" lookups)
const apiKeyToWorker = new Map<string, number>();

// ipIndex → apiKey (for "is this worker available?" lookups)
const workerToApiKey = new Map<number, string>();

const DEFAULT_TTL_MS = 30 * 60 * 1000; // matches STICKY_TTL_MS

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Returns the configured number of proxy workers.
 *
 * Fallback chain:
 *   1. Dynamic topology (if available at startup)
 *   2. PROXY_IP_COUNT env var (backward compatibility)
 *   0. 0 (disabled)
 *
 * Uses isDynamicTopologyAvailable() rather than count > 0 because a
 * zero-worker topology is still dynamically available (intentionally
 * disables IP capacity limits).
 */
export function getWorkerCount(): number {
  if (isDynamicTopologyAvailable()) {
    return getTopologyWorkerCount();
  }

  const raw = process.env.PROXY_IP_COUNT;
  const count = raw ? parseInt(raw, 10) : 0;
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** @deprecated Use getWorkerCount() instead. */
export function getIpCount(): number {
  return getWorkerCount();
}

/** True when PROXY_IP_COUNT is set to a positive integer. */
export function isIpCapacityEnabled(): boolean {
  return getWorkerCount() > 0;
}

/**
 * Check if sticky routing is enabled.
/**
 * Check if sticky routing is enabled.
 * Returns true when either dynamic topology is available or PROXY_IP_COUNT is a valid non-negative integer.
 * Invalid PROXY_IP_COUNT values (e.g. "abc", "-1") fall back to dynamic topology availability.
 */
export function isStickyRoutingEnabled(): boolean {
  const raw = process.env.PROXY_IP_COUNT;
  if (raw === undefined || raw.trim() === '') {
    return isDynamicTopologyAvailable();
  }
  const envCount = Number(raw);
  if (!Number.isInteger(envCount) || envCount < 0) {
    // Invalid value — fall back to dynamic topology
    return isDynamicTopologyAvailable();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Allocation / Release
// ---------------------------------------------------------------------------

/**
 * Acquire a worker for an API key.
 * Returns a discriminated union to preserve the result kind atomically.
 *
 * @param apiKey - The API key to bind to a worker
 * @returns AllocationResult with kind 'allocated', 'bypass', 'key_busy', or 'capacity_exhausted'
 */
export function allocateIpForKey(apiKey: string): AllocationResult {
  // 0. If API key is empty/falsy → bypass (no key to bind to a worker)
  if (!apiKey) {
    return { kind: 'bypass' };
  }

  // 1. If sticky routing is disabled → bypass
  if (!isStickyRoutingEnabled()) {
    return { kind: 'bypass' };
  }

  // 2. If this key already has an active worker → key_busy
  if (apiKeyToWorker.has(apiKey)) {
    console.warn(`Request rejected: key ${shortHashKey(apiKey)} already has active worker`);
    return { kind: 'key_busy' };
  }

  // 3. Find first free worker slot
  const workerCount = getWorkerCount();
  let freeIpIndex: number | undefined;

  for (let i = 0; i < workerCount; i++) {
    if (!workerToApiKey.has(i)) {
      freeIpIndex = i;
      break;
    }
  }

  // 4. If no free slot → capacity_exhausted
  if (freeIpIndex === undefined) {
    console.warn(`Request rejected: capacity exhausted (all ${workerCount} workers occupied)`);
    return { kind: 'capacity_exhausted' };
  }

  // 5. Bind key to worker (both maps in sync)
  apiKeyToWorker.set(apiKey, freeIpIndex);
  workerToApiKey.set(freeIpIndex, apiKey);
  ipPool.add(freeIpIndex);

  console.log(`Worker ${freeIpIndex} assigned to key ${shortHashKey(apiKey)}`);
  return { kind: 'allocated', ipIndex: freeIpIndex };
}

/**
 * Release the worker held by an API key.
 * No-op if the key has no active assignment.
 */
export function releaseIpForKey(apiKey: string): void {
  // 1. Get the worker's ipIndex for this key
  const ipIndex = apiKeyToWorker.get(apiKey);

  // 2. If key has no assignment, no-op
  if (ipIndex === undefined) {
    return;
  }

  // 3. Verify the workerToApiKey entry matches (prevents deleting reallocated slot)
  if (workerToApiKey.get(ipIndex) !== apiKey) {
    return;
  }

  // 4. Delete from all maps
  apiKeyToWorker.delete(apiKey);
  workerToApiKey.delete(ipIndex);
  console.log(`Worker ${ipIndex} released by key ${shortHashKey(apiKey)}`);
  ipPool.delete(ipIndex);
}

/**
 * Check if an API key has an active worker assignment.
 */
export function isKeyActive(apiKey: string): boolean {
  return apiKeyToWorker.has(apiKey);
}

/**
 * Check if a specific worker is currently assigned.
 */
export function isWorkerAssigned(ipIndex: number): boolean {
  return workerToApiKey.has(ipIndex);
}

// ---------------------------------------------------------------------------
// Deprecated sessionKey-based API (for backward compatibility during T2.6 migration)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use allocateIpForKey() instead. This function is a no-op stub
 * maintained for backward compatibility during the T2.6 migration.
 *
 * Allocate an IP for a session. In the new API-key-based system, this is a no-op
 * that returns 0 (success sentinel) since capacity is managed per-key, not per-session.
 *
 * @returns Always returns 0 (success sentinel) - no actual allocation occurs
 */
export function allocateIp(
  _sessionKey: string,
  _platform: string,
  _keyId: number,
  _ttlMs = DEFAULT_TTL_MS,
): number {
  // No-op: capacity is now managed per API key, not per session
  // Return 0 (success sentinel) to maintain backward compatibility
  return 0;
}

/**
 * @deprecated Use releaseIpForKey() instead. This function is a no-op stub
 * maintained for backward compatibility during the T2.6 migration.
 *
 * Release the IP held by a session. In the new API-key-based system, this is a no-op
 * since capacity is managed per-key, not per-session.
 */
export function releaseIp(_sessionKey: string): void {
  // No-op: capacity is now managed per API key, not per session
}

// ---------------------------------------------------------------------------
// Capacity Queries
// ---------------------------------------------------------------------------

/**
 * Check whether there is IP capacity available in the global pool.
 * Returns true when PROXY_IP_COUNT is unset (no limit).
 *
 * Note: This checks global pool occupancy (any platform), consistent with
 * allocateIp which treats all occupied slots as unavailable.
 */
export function hasIpCapacity(apiKey?: string): boolean {
  if (!isIpCapacityEnabled()) return true;

  // If this key already has an allocation, it can always proceed
  if (apiKey && apiKeyToWorker.has(apiKey)) {
    return true;
  }

  // Check if there's room for a new key
  const workerCount = getWorkerCount();
  const assignedCount = workerToApiKey.size;
  return assignedCount < workerCount;
}

/**
 * Return current IP usage for a platform.
 * When IP capacity is disabled, returns { used: 0, max: 0 }.
 *
 * Note: max is the global ipCount (shared across platforms).
 * used is the number of assigned workers.
 */
export function getIpCapacityStatus(_platform: string): { used: number; max: number } {
  if (!isIpCapacityEnabled()) return { used: 0, max: 0 };

  const ipCount = getWorkerCount();
  const used = workerToApiKey.size;
  return { used, max: ipCount };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Remove all expired allocations. Called periodically or on-demand.
 *
 * Note: In the new API-key-based system, expiration is handled by the
 * caller via releaseIpForKey(). This function is a no-op but kept for
 * interface compatibility.
 */
export function cleanupExpired(): void {
  // No-op: expiration is handled by the caller via releaseIpForKey()
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/** Reset all state. For tests only. */
export function _reset(): void {
  ipPool.clear();
  apiKeyToWorker.clear();
  workerToApiKey.clear();
}

/** Direct access to internal pool. For tests only. */
export function _getIpPool(): Set<number> {
  return ipPool;
}

/** Direct access to apiKeyToWorker map. For tests only. */
export function _getApiKeyToWorkerMap(): Map<string, number> {
  return apiKeyToWorker;
}

/** Reset all sticky routing state. For tests only. */
export function _resetAssignments(): void {
  apiKeyToWorker.clear();
  workerToApiKey.clear();
}

/** Get the count of active API key assignments. For tests only. */
export function _getActiveAssignmentCount(): number {
  return apiKeyToWorker.size;
}
