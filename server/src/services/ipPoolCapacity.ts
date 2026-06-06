// IP Pool Capacity Manager
//
// Tracks outbound IP allocation for sticky sessions, ensuring concurrency
// does not exceed the available rotating proxy IP pool.
//
// Capacity model:
//   - Normal providers: each key gets a deterministic IP (keyId % ipCount).
//     Each IP serves 1 session at a time (conservative).
//   - LongCat: 1 session per IP (IP-bound regardless of key count).
//
// When PROXY_IP_COUNT is unset or 0, all capacity checks pass through
// (backward compatible — no IP awareness).
//
// In-memory only, following the same pattern as ratelimit.ts.

interface IpAllocation {
  sessionKey: string;
  platform: string;
  keyId: number;
  allocatedAt: number;
  expiresAt: number;
}

// ipIndex → IpAllocation
const ipPool = new Map<number, IpAllocation>();

// sessionKey → ipIndex (for release and re-entrant lookups)
const sessionIpMap = new Map<string, number>();

const DEFAULT_TTL_MS = 30 * 60 * 1000; // matches STICKY_TTL_MS

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Returns the configured number of proxy IPs.
 * Reads PROXY_IP_COUNT from env. Returns 0 when unset, 0, or invalid.
 */
export function getIpCount(): number {
  const raw = process.env.PROXY_IP_COUNT;
  const count = raw ? parseInt(raw, 10) : 0;
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** True when PROXY_IP_COUNT is set to a positive integer. */
export function isIpCapacityEnabled(): boolean {
  return getIpCount() > 0;
}

// ---------------------------------------------------------------------------
// Allocation / Release
// ---------------------------------------------------------------------------

/**
 * Allocate an IP for a session.
 *
 * @returns ipIndex (0-based) on success, -1 if no IP available.
 *
 * Re-entrant: if the session already holds an IP, returns the existing index.
 * Lazy eviction: expired allocations are treated as free.
 */
export function allocateIp(
  sessionKey: string,
  platform: string,
  keyId: number,
  ttlMs = DEFAULT_TTL_MS,
): number {
  if (!isIpCapacityEnabled()) return -1;

  const ipCount = getIpCount();
  const now = Date.now();

  // Re-entrant: session already has an IP
  const existing = sessionIpMap.get(sessionKey);
  if (existing !== undefined) {
    const alloc = ipPool.get(existing);
    if (alloc && alloc.expiresAt >= now) {
      // Update allocation details if platform/key changed (e.g., fallback routing)
      alloc.platform = platform;
      alloc.keyId = keyId;
      alloc.expiresAt = now + ttlMs;
      return existing;
    }
    // Expired or inconsistent — clean up and fall through to reallocate
    ipPool.delete(existing);
    sessionIpMap.delete(sessionKey);
  }

  if (platform === 'longcat') {
    // LongCat: 1 session per IP. First-available allocation.
    for (let i = 0; i < ipCount; i++) {
      const alloc = ipPool.get(i);
      if (!alloc || alloc.expiresAt < now) {
        ipPool.set(i, {
          sessionKey,
          platform,
          keyId,
          allocatedAt: now,
          expiresAt: now + ttlMs,
        });
        sessionIpMap.set(sessionKey, i);
        return i;
      }
    }
    return -1; // all IPs occupied
  }

  // Normal providers: key-based deterministic starting point.
  // keyId % ipCount gives a preferred IP; linear probe finds next free slot.
  const keyOffset = keyId % ipCount;
  for (let i = 0; i < ipCount; i++) {
    const candidate = (keyOffset + i) % ipCount;
    const alloc = ipPool.get(candidate);
    if (!alloc || alloc.expiresAt < now) {
      ipPool.set(candidate, {
        sessionKey,
        platform,
        keyId,
        allocatedAt: now,
        expiresAt: now + ttlMs,
      });
      sessionIpMap.set(sessionKey, candidate);
      return candidate;
    }
  }
  return -1; // all IPs occupied
}

/**
 * Release the IP held by a session.
 * No-op if the session has no allocation.
 */
export function releaseIp(sessionKey: string): void {
  const ipIndex = sessionIpMap.get(sessionKey);
  if (ipIndex !== undefined) {
    const alloc = ipPool.get(ipIndex);
    // Only delete from ipPool if the allocation belongs to this session
    // (prevents deleting a reallocated IP from a different session)
    if (alloc && alloc.sessionKey === sessionKey) {
      ipPool.delete(ipIndex);
    }
    sessionIpMap.delete(sessionKey);
  }
}

// ---------------------------------------------------------------------------
// Capacity Queries
// ---------------------------------------------------------------------------

/**
 * Check whether a platform/key combination has IP capacity available.
 * Returns true when PROXY_IP_COUNT is unset (no limit).
 */
export function hasIpCapacity(platform: string, keyId: number): boolean {
  if (!isIpCapacityEnabled()) return true;

  const ipCount = getIpCount();
  const now = Date.now();

  if (platform === 'longcat') {
    for (let i = 0; i < ipCount; i++) {
      const alloc = ipPool.get(i);
      if (!alloc || alloc.expiresAt < now) return true;
    }
    return false;
  }

  // Normal: check if any IP in the key's probe sequence is free.
  // Only count allocations for the same platform as occupying capacity.
  const keyOffset = keyId % ipCount;
  for (let i = 0; i < ipCount; i++) {
    const candidate = (keyOffset + i) % ipCount;
    const alloc = ipPool.get(candidate);
    if (!alloc || alloc.expiresAt < now) return true;
    // Occupied by same platform — this slot is taken, continue probing
    if (alloc.platform === platform) continue;
    // Occupied by different platform — doesn't contend, slot is usable
    return true;
  }
  return false;
}

/**
 * Return current IP usage for a platform.
 * When IP capacity is disabled, returns { used: 0, max: 0 }.
 */
export function getIpCapacityStatus(platform: string): { used: number; max: number } {
  if (!isIpCapacityEnabled()) return { used: 0, max: 0 };

  const ipCount = getIpCount();
  const now = Date.now();
  let used = 0;
  for (const [, alloc] of ipPool) {
    if (alloc.platform === platform && alloc.expiresAt >= now) used++;
  }
  return { used, max: ipCount };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Remove all expired allocations. Called periodically or on-demand.
 */
export function cleanupExpired(): void {
  const now = Date.now();
  for (const [ipIndex, alloc] of ipPool) {
    if (alloc.expiresAt < now) {
      sessionIpMap.delete(alloc.sessionKey);
      ipPool.delete(ipIndex);
    }
  }
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/** Reset all state. For tests only. */
export function _reset(): void {
  ipPool.clear();
  sessionIpMap.clear();
}

/** Direct access to internal pool. For tests only. */
export function _getIpPool(): Map<number, IpAllocation> {
  return ipPool;
}

/** Direct access to session map. For tests only. */
export function _getSessionIpMap(): Map<string, number> {
  return sessionIpMap;
}
