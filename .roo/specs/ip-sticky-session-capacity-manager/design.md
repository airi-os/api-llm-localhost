# IP Pool Capacity Manager — Design

## 1. Problem Statement

The current sticky session system in `freellmapi-alpha` tracks `sessionKey → { modelDbId, keyId }` with a 30-minute TTL. This prevents model-switching mid-conversation (which causes hallucination) but has **no concept of IP-level capacity**.

When integrating with `vadash/llm-proxy`, each outbound request can be routed through a rotating proxy worker that generates a deterministic fake IP (`SHA-256(proxyIndex + domain)` → first 4 octets). The number of concurrent sessions a provider can handle is constrained by the number of **distinct outbound IPs** in the rotation pool, not just the number of API keys.

**The gap**: freellmapi-alpha's sticky system can assign more concurrent sessions to a provider than the IP pool can support, because it doesn't track IP occupancy. If 10 sessions are sticky to the same provider but only 3 proxy IPs exist, 7 sessions will share IPs and potentially trigger provider rate limits or bans.

## 2. Goals

1. **IP-aware capacity tracking**: Model concurrent session count against available outbound IPs
2. **Capacity formulas**:
   - Normal providers: `max_concurrent = api_keys × available_ips` (1 key per IP simultaneously)
   - LongCat: `max_concurrent = available_ips` (1 session per IP, key-agnostic)
3. **In-memory only**: No SQLite persistence (follows `ratelimit.ts` pattern)
4. **Non-blocking**: When capacity is full, fall through to other providers rather than rejecting
5. **Deterministic IP selection**: Same session always maps to same IP (proxy modulo pattern)
6. **Graceful degradation**: If `PROXY_IP_COUNT` is unset, skip IP capacity checks entirely

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     handleChatCompletion                     │
│                                                             │
│  1. getStickyModel() → preferredModelDbId                  │
│  2. getStickyKey() → preferredKeyId                        │
│  3. ┌──────────────────────────────────────────────┐       │
│  │  NEW: checkIpCapacity(platform, modelDbId, keyId)│       │
│  │  - Is there an available IP for this assignment? │       │
│  │  - If no: clear sticky preference for this       │       │
│  │    session so bandit can route elsewhere         │       │
│  └──────────────────────────────────────────────┘       │
│  4. routeRequest(preferredModelDbId, preferredKeyId)       │
│  5. On success:                                             │
│     setStickyModel()                                        │
│     NEW: allocateIp(sessionKey, platform, modelDbId, keyId)│
│  6. On completion/error:                                    │
│     NEW: releaseIp(sessionKey)                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                  IpPoolCapacity Service                      │
│                                                             │
│  ipPool: Map<ipIndex, { sessionKey, platform, expiry }>    │
│  sessionIpMap: Map<sessionKey, ipIndex>                    │
│                                                             │
│  allocateIp(sessionKey, platform, keyId) → ipIndex | -1    │
│  releaseIp(sessionKey)                                      │
│  getCapacity(platform) → { used, max }                     │
│  getIpForKey(platform, keyId) → ipIndex (deterministic)    │
└─────────────────────────────────────────────────────────────┘
```

## 4. Capacity Model

### 4.1 Normal Providers (e.g., google, groq, cerebras)

Each API key can use one IP at a time. With `K` keys and `N` proxy IPs:

```
max_concurrent = K × N
```

IP assignment: `ipIndex = keyId % N` (deterministic per key)

This means each key always uses the same IP, and the total capacity scales linearly with both keys and IPs.

### 4.2 LongCat Provider

LongCat is special: capacity is IP-bound regardless of key count. With `N` proxy IPs:

```
max_concurrent = N
```

IP assignment: `ipIndex = hash(sessionKey) % N` (deterministic per session)

This ensures each session gets a distinct IP, and total LongCat concurrency never exceeds the IP pool size.

### 4.3 Configuration

| Variable | Default | Description |
|---|---|---|
| `PROXY_IP_COUNT` | *(unset = disabled)* | Number of available rotating proxy IPs. When unset, IP capacity checks are skipped entirely. |
| `PROXY_IP_CAPACITY_TTL_MS` | `30 * 60 * 1000` (30 min) | TTL for IP allocation entries, matching sticky session TTL. |
| `PROXY_IP_LONGCAT_MODE` | `strict` | LongCat capacity mode: `strict` = IP-bound only, `relaxed` = same as normal providers. |

## 5. IP Selection Strategy

Unlike llm-proxy's stateless `SHA-256(proxyIndex + domain)` approach (where the proxy worker index is known at request time), freellmapi-alpha needs a **stateful allocation** because:

1. Multiple concurrent sessions compete for the same IP pool
2. The same session must reuse the same IP across retries (sticky)
3. IPs must be released when sessions complete

**Allocation algorithm**:

```
function allocateIp(sessionKey, platform, keyId):
  // Check if session already has an IP (re-entrant / retry)
  if sessionIpMap.has(sessionKey):
    return sessionIpMap.get(sessionKey)

  if platform === 'longcat':
    // LongCat: hash-based session distribution
    ipIndex = hash(sessionKey) % ipCount
    // If that IP is taken, linear probe for next available
    for i in 0..ipCount-1:
      candidate = (ipIndex + i) % ipCount
      if !ipPool.has(candidate) || ipPool.get(candidate).expiry < now:
        allocate candidate → sessionKey
        return candidate
    return -1 // no IP available
  else:
    // Normal: key-based deterministic assignment
    ipIndex = keyId % ipCount
    // Check if this (platform, keyId, ipIndex) slot is free
    // Multiple sessions can share the same key+ip up to a limit
    currentUsage = count entries in ipPool where entry.ipIndex === ipIndex
    if currentUsage < ipCount:
      allocate ipIndex → sessionKey
      return ipIndex
    return -1 // capacity full
```

**Simplified approach** (initial implementation):

For the first version, use a simpler model:
- Each IP can serve up to `ceil(keyCount / ipCount)` sessions for normal providers
- Each IP can serve exactly 1 session for LongCat
- Allocation is first-available (not deterministic per key), but sticky per session

## 6. Integration Points in proxy.ts

### 6.1 Before Routing (capacity check)

In `handleChatCompletion()`, after getting sticky model/key but before calling `routeRequest()`:

```typescript
// If the sticky preferred model's platform is at IP capacity,
// clear the sticky preference so the bandit can route elsewhere
if (preferredModel) {
  const db = getDb();
  const prefRow = db.prepare('SELECT platform FROM models WHERE id = ?').get(preferredModel);
  if (prefRow && !hasIpCapacity(prefRow.platform, preferredKeyId)) {
    preferredModel = undefined;
    preferredKeyId = undefined;
  }
}
```

### 6.2 After Successful Response (IP allocation)

After `setStickyModel()` on success (streaming line ~1472, non-streaming line ~1649):

```typescript
if (sessionKey) {
  allocateIp(sessionKey, route.platform, route.keyId);
}
```

### 6.3 On Request Completion (IP release)

In the `finally` blocks (streaming line ~1612, non-streaming line ~1665):

```typescript
if (sessionKey) {
  releaseIp(sessionKey);
}
```

## 7. Service Module: `ipPoolCapacity.ts`

New file: `server/src/services/ipPoolCapacity.ts`

```typescript
interface IpAllocation {
  sessionKey: string;
  platform: string;
  keyId: number;
  allocatedAt: number;
  expiresAt: number;
}

// ipIndex → IpAllocation
const ipPool = new Map<number, IpAllocation>();
// sessionKey → ipIndex (for release)
const sessionIpMap = new Map<string, number>();

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function getIpCount(): number {
  const raw = process.env.PROXY_IP_COUNT;
  const count = raw ? parseInt(raw, 10) : 0;
  return Number.isInteger(count) && count > 0 ? count : 0;
}

export function isIpCapacityEnabled(): boolean {
  return getIpCount() > 0;
}

export function allocateIp(
  sessionKey: string,
  platform: string,
  keyId: number,
  ttlMs = DEFAULT_TTL_MS,
): number {
  if (!isIpCapacityEnabled()) return -1;
  const ipCount = getIpCount();

  // Re-entrant: session already has an IP
  const existing = sessionIpMap.get(sessionKey);
  if (existing !== undefined && ipPool.has(existing)) {
    return existing;
  }

  const now = Date.now();

  // LongCat: 1 session per IP
  if (platform === 'longcat') {
    for (let i = 0; i < ipCount; i++) {
      const alloc = ipPool.get(i);
      if (!alloc || alloc.expiresAt < now) {
        ipPool.set(i, { sessionKey, platform, keyId, allocatedAt: now, expiresAt: now + ttlMs });
        sessionIpMap.set(sessionKey, i);
        return i;
      }
    }
    return -1; // all IPs occupied
  }

  // Normal: key-based allocation, multiple keys can share IPs
  // Each IP can serve up to ceil(keyCount / ipCount) but we don't know keyCount here
  // Simple model: each IP serves 1 session at a time (conservative)
  const keyOffset = keyId % ipCount;
  for (let i = 0; i < ipCount; i++) {
    const candidate = (keyOffset + i) % ipCount;
    const alloc = ipPool.get(candidate);
    if (!alloc || alloc.expiresAt < now) {
      ipPool.set(candidate, { sessionKey, platform, keyId, allocatedAt: now, expiresAt: now + ttlMs });
      sessionIpMap.set(sessionKey, candidate);
      return candidate;
    }
  }
  return -1;
}

export function releaseIp(sessionKey: string): void {
  const ipIndex = sessionIpMap.get(sessionKey);
  if (ipIndex !== undefined) {
    ipPool.delete(ipIndex);
    sessionIpMap.delete(sessionKey);
  }
}

export function hasIpCapacity(platform: string, keyId: number): boolean {
  if (!isIpCapacityEnabled()) return true; // no limit if disabled
  const ipCount = getIpCount();
  const now = Date.now();

  if (platform === 'longcat') {
    // Check if any IP is free
    for (let i = 0; i < ipCount; i++) {
      const alloc = ipPool.get(i);
      if (!alloc || alloc.expiresAt < now) return true;
    }
    return false;
  }

  // Normal: check if key's preferred IP slot is free
  const keyOffset = keyId % ipCount;
  for (let i = 0; i < ipCount; i++) {
    const candidate = (keyOffset + i) % ipCount;
    const alloc = ipPool.get(candidate);
    if (!alloc || alloc.expiresAt < now) return true;
  }
  return false;
}

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

export function cleanupExpired(): void {
  const now = Date.now();
  for (const [ipIndex, alloc] of ipPool) {
    if (alloc.expiresAt < now) {
      sessionIpMap.delete(alloc.sessionKey);
      ipPool.delete(ipIndex);
    }
  }
}

// Exported for testing
export function _reset(): void {
  ipPool.clear();
  sessionIpMap.clear();
}

export function _getIpPool(): Map<number, IpAllocation> {
  return ipPool;
}

export function _getSessionIpMap(): Map<string, number> {
  return sessionIpMap;
}
```

## 8. Configuration Changes

### 8.1 `.env.example`

Add:

```bash
# Number of available rotating proxy IPs (from llm-proxy pool).
# When unset, IP capacity checks are skipped.
PROXY_IP_COUNT=3
```

### 8.2 No Database Changes

The IP capacity manager is purely in-memory, following the same pattern as `ratelimit.ts`. No SQLite schema changes needed.

## 9. Error Handling

| Scenario | Behavior |
|---|---|
| `PROXY_IP_COUNT` unset | All capacity checks pass through (backward compatible) |
| `PROXY_IP_COUNT` = 0 or invalid | Same as unset — disabled |
| All IPs occupied for platform | `hasIpCapacity()` returns false → sticky preference cleared → bandit routes elsewhere |
| IP allocation fails mid-request | Request still proceeds (capacity is advisory, not mandatory) |
| Session without IP completes | `releaseIp()` is a no-op (no allocation to release) |

## 10. Testing Strategy

### 10.1 Unit Tests (new file: `server/src/__tests__/services/ipPoolCapacity.test.ts`)

- `allocateIp()` returns valid IP index when pool has space
- `allocateIp()` returns -1 when pool is full
- `allocateIp()` is re-entrant (same session gets same IP on retry)
- `releaseIp()` frees the IP for reuse
- `hasIpCapacity()` returns true when space available, false when full
- LongCat mode: 1 session per IP
- Normal mode: key-based allocation
- `cleanupExpired()` removes stale entries
- Disabled when `PROXY_IP_COUNT` unset

### 10.2 Integration Tests (modify existing proxy tests)

- When IP capacity is full, sticky preference is cleared
- On successful response, IP is allocated
- On request completion, IP is released
- Capacity status is accurate under concurrent requests

## 11. Implementation Roadmap

1. Create `server/src/services/ipPoolCapacity.ts` (the service module)
2. Add `PROXY_IP_COUNT` to `.env.example`
3. Integrate capacity check in `handleChatCompletion()` before routing
4. Integrate IP allocation on success (streaming + non-streaming paths)
5. Integrate IP release in finally blocks (streaming + non-streaming paths)
6. Write unit tests for `ipPoolCapacity.ts`
7. Update integration tests in proxy test suite

## 12. Open Questions

1. **Should IP capacity be advisory or mandatory?** Current design: advisory (clears sticky preference but doesn't block requests). Alternative: return 429 when all IPs full.
2. **Normal provider capacity model**: Is 1-session-per-IP too conservative? Should it be `keys × ips` as the formula suggests?
3. **LongCat `relaxed` mode**: Is there a use case where LongCat should use the normal provider formula?
4. **Periodic cleanup**: Should we add a `setInterval` cleanup like `ratelimit.ts`, or rely on lazy eviction? (Recommendation: lazy eviction is sufficient since TTL is 30 min and the pool is small)
