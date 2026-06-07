# API Key Sticky Routing — Tasks

## Overview

This document defines the implementation tasks for replacing session-key-based IP allocation with API-key-based worker assignment.

**Caller verification**: The only call sites for `allocateIp`/`releaseIp` are `server/src/routes/proxy.ts` and the test file. No other consumers exist. The old API can be safely removed.

## Phase 1: Capacity Service Refactor

### T1.1 — Add bidirectional maps

Add the new state maps to `ipPoolCapacity.ts`:

```typescript
// apiKey → ipIndex (for "is this key active?" lookups)
const apiKeyToWorker = new Map<string, number>();

// ipIndex → apiKey (for "is this worker available?" lookups)
const workerToApiKey = new Map<number, string>();
```

Both maps must be maintained in sync on every operation.

### T1.2 — Add AllocationResult discriminated union

```typescript
type AllocationResult =
  | { kind: 'allocated'; ipIndex: number }
  | { kind: 'bypass' }
  | { kind: 'key_busy' }
  | { kind: 'capacity_exhausted' };
```

The `kind` field preserves the failure reason atomically — no need for a second `isKeyActive()` call after allocation.

### T1.3 — Implement allocateIpForKey()

```typescript
export function allocateIpForKey(apiKey: string): AllocationResult
```

Logic:
1. If `!isStickyRoutingEnabled()` → return `{ kind: 'bypass' }`
2. If `apiKeyToWorker.has(apiKey)` → return `{ kind: 'key_busy' }`
3. Scan `workerToApiKey` for first free slot (ipIndex not in map)
4. If no free slot → return `{ kind: 'capacity_exhausted' }`
5. Set `apiKeyToWorker.set(apiKey, ipIndex)` and `workerToApiKey.set(ipIndex, apiKey)`
6. Return `{ kind: 'allocated', ipIndex }`

All operations must be synchronous (no await).

### T1.4 — Implement releaseIpForKey()

```typescript
export function releaseIpForKey(apiKey: string): void
```

Logic:
1. Get `ipIndex = apiKeyToWorker.get(apiKey)`
2. If undefined, no-op
3. Verify `workerToApiKey.get(ipIndex) === apiKey` (prevent deleting reallocated slot)
4. Delete both map entries
5. No-op if already released

### T1.5 — Implement helper functions

```typescript
export function isKeyActive(apiKey: string): boolean
export function isWorkerAssigned(ipIndex: number): boolean
```

### T1.6 — Remove sessionKey-based allocation logic

Remove from `ipPoolCapacity.ts`:
- `allocateIp(sessionKey, platform, keyId)` function
- `releaseIp(sessionKey)` function
- `sessionIpMap` (the old sessionKey→ipIndex map)

**Do NOT remove**:
- `ipPool` or `IpAllocation` interface — these are used for capacity reporting APIs
- `getIpCapacityStatus()` — still used for analytics
- `hasIpCapacity()` — still used for pre-flight checks
- `getWorkerCount()` — still used for capacity calculations

Update imports in `proxy.ts` to remove old function references.

### T1.7 — Add test hooks

```typescript
export function _resetAssignments(): void
export function _getActiveAssignmentCount(): number
```

`_resetAssignments()` clears both maps. `_getActiveAssignmentCount()` returns `apiKeyToWorker.size`.

### T1.8 — Add isStickyRoutingEnabled() helper

```typescript
export function isStickyRoutingEnabled(): boolean {
  const raw = process.env.PROXY_IP_COUNT;
  if (raw === undefined || raw.trim() === '') {
    return isDynamicTopologyAvailable();
  }
  const envCount = Number(raw);
  return Number.isInteger(envCount) && envCount >= 0;
}
```

**Validation rules**:
- `PROXY_IP_COUNT=3` → enabled (valid positive integer)
- `PROXY_IP_COUNT=0` → enabled (valid zero, means zero capacity)
- `PROXY_IP_COUNT=abc` → disabled (not a valid integer)
- `PROXY_IP_COUNT=-1` → disabled (negative integer)
- `PROXY_IP_COUNT=` (empty) → disabled (empty string check before Number())
- `PROXY_IP_COUNT` unset → disabled (unless topology available)

**Important**: The empty string check (`raw.trim() === ''`) must come before `Number(raw)` because `Number('')` returns `0`, which would incorrectly treat empty string as enabled with zero capacity.

This is the single source of truth for disabled-mode check. Use this instead of `isIpCapacityEnabled()` in the allocation logic.

## Phase 2: Router Integration

### T2.1 — Locate request paths

Find both request handling paths in `server/src/routes/proxy.ts`:
- Streaming: `/responses` route
- Non-streaming: `/chat/completions` route

### T2.2 — Extract API key

The API key is available via `getUnifiedApiKey()`. This is already called during authentication. Store it in a variable accessible to the allocation/release logic.

### T2.3 — Acquire slot before execution

Before request execution begins:

```typescript
const apiKey = getUnifiedApiKey();
const result = allocateIpForKey(apiKey);

// result.kind === 'allocated' or 'bypass' — proceed with request
// result.kind === 'key_busy' or 'capacity_exhausted' — handled below
```

### T2.4 — Handle both request paths

Apply the same allocation pattern to both:
- Streaming `/responses` handler
- Non-streaming `/chat/completions` handler

### T2.5 — Add finally release

Wrap request execution in try/finally using the `shouldRelease` pattern:

```typescript
const result = allocateIpForKey(apiKey);
const shouldRelease = result.kind === 'allocated';

if (result.kind === 'bypass') {
  // proceed without sticky routing
} else if (result.kind === 'key_busy') {
  return res.status(409).json({
    error: { message: 'An active request already exists for this API key.', type: 'key_busy' },
  });
} else if (result.kind === 'capacity_exhausted') {
  return res.status(503)
    .set('Retry-After', '5')
    .json({
      error: { message: 'No proxy workers available. All slots are occupied.', type: 'capacity_exhausted' },
    });
}

try {
  // execute request
} finally {
  if (shouldRelease) {
    releaseIpForKey(apiKey);
  }
}
```

**Why `shouldRelease`?** When `result.kind === 'bypass'`, the key is not in `apiKeyToWorker`, so calling `releaseIpForKey()` would be a no-op. The `shouldRelease` flag avoids this unnecessary map lookup on the bypass path.

This must be applied to ALL exit paths:
- Success response
- Error response
- Exception thrown

### T2.6 — Remove old allocation calls

Remove existing calls to `allocateIp(sessionKey, ...)` and `releaseIp(sessionKey)`. These are replaced by the new pattern.

## Phase 3: Logging

### T3.1 — Add shortHashKey helper

```typescript
import crypto from 'crypto';

function shortHashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}
```

### T3.2 — Log assignment

```typescript
console.log(`Worker ${ipIndex} assigned to key ${shortHashKey(apiKey)}`);
```

### T3.3 — Log release

```typescript
console.log(`Worker ${ipIndex} released by key ${shortHashKey(apiKey)}`);
```

### T3.4 — Log rejection (key_busy)

```typescript
console.warn(`Request rejected: key ${shortHashKey(apiKey)} already has active worker`);
```

### T3.5 — Log rejection (capacity_exhausted)

```typescript
console.warn(`Request rejected: capacity exhausted (all ${workerCount} workers occupied)`);
```

## Phase 4: Tests

### T4.1 — Single allocation success

```typescript
it('allocates worker for first request', () => {
  _resetAssignments();
  const result = allocateIpForKey('key-1');
  expect(result.kind).toBe('allocated');
  expect(result.ipIndex).toBeGreaterThanOrEqual(0);
});
```

### T4.2 — Same key concurrent → 409

```typescript
it('rejects same key concurrent request with 409', () => {
  _resetAssignments();
  allocateIpForKey('key-1');
  const result = allocateIpForKey('key-1');
  expect(result.kind).toBe('key_busy');
});
```

### T4.3 — Different keys until full

```typescript
it('allocates different workers for different keys', () => {
  _resetAssignments();
  const r1 = allocateIpForKey('key-1');
  const r2 = allocateIpForKey('key-2');
  expect(r1.kind).toBe('allocated');
  expect(r2.kind).toBe('allocated');
  expect(r1.ipIndex).not.toBe(r2.ipIndex);
});
```

### T4.4 — Pool exhausted → 503

```typescript
it('rejects new key when pool is full with 503', () => {
  _resetAssignments();
  // Fill all slots
  for (let i = 0; i < workerCount; i++) {
    allocateIpForKey(`key-${i}`);
  }
  const result = allocateIpForKey('key-overflow');
  expect(result.kind).toBe('capacity_exhausted');
});
```

### T4.5 — Release restores capacity

```typescript
it('releases worker and restores capacity', () => {
  _resetAssignments();
  const r1 = allocateIpForKey('key-1');
  expect(r1.kind).toBe('allocated');
  releaseIpForKey('key-1');
  const r2 = allocateIpForKey('key-2');
  expect(r2.kind).toBe('allocated');
});
```

### T4.6 — Exception path releases slot

```typescript
it('releases worker even when request throws', () => {
  _resetAssignments();
  allocateIpForKey('key-1');
  // Simulate exception
  try {
    throw new Error('simulated');
  } finally {
    releaseIpForKey('key-1');
  }
  expect(_getActiveAssignmentCount()).toBe(0);
});
```

### T4.7 — Disabled mode bypass

```typescript
it('bypasses allocation when sticky routing is disabled', () => {
  _resetAssignments();
  // When disabled (no topology, no PROXY_IP_COUNT), returns bypass
  const result = allocateIpForKey('key-1');
  expect(result.kind).toBe('bypass');
});
```

### T4.8 — workerCount=0 → 503 (not bypass)

```typescript
it('returns capacity_exhausted when workerCount=0', () => {
  _resetAssignments();
  // Set workerCount to 0 via env (valid topology with zero capacity)
  const result = allocateIpForKey('key-1');
  expect(result.kind).toBe('capacity_exhausted');
});
```

### T4.9 — No worker leaks after failures

```typescript
it('no worker leaks after key_busy rejection', () => {
  _resetAssignments();
  allocateIpForKey('key-1');
  allocateIpForKey('key-1'); // rejected
  expect(_getActiveAssignmentCount()).toBe(1);
});

it('no worker leaks after capacity_exhausted rejection', () => {
  _resetAssignments();
  for (let i = 0; i < workerCount; i++) {
    allocateIpForKey(`key-${i}`);
  }
  allocateIpForKey('key-overflow'); // rejected
  expect(_getActiveAssignmentCount()).toBe(workerCount);
});
```

### T4.10 — Router integration: 409 on concurrent same-key requests

Integration test that simulates two concurrent requests with the same API key:
1. First request acquires slot successfully
2. Second request (while first is in-flight) gets 409
3. After first completes, third request succeeds

```typescript
it('returns 409 for concurrent same-key requests', async () => {
  _resetAssignments();
  
  // Simulate in-flight request
  const firstResult = allocateIpForKey('test-key');
  expect(firstResult.kind).toBe('allocated');
  
  // Second request should be rejected
  const secondResult = allocateIpForKey('test-key');
  expect(secondResult.kind).toBe('key_busy');
  
  // Release and retry should succeed
  releaseIpForKey('test-key');
  const thirdResult = allocateIpForKey('test-key');
  expect(thirdResult.kind).toBe('allocated');
});
```

### T4.11 — Router integration: 503 when all workers occupied

Integration test that verifies 503 response when all workers are occupied:
1. Fill all worker slots with different keys
2. Next request gets 503
3. After one releases, new request succeeds

```typescript
it('returns 503 when all workers are occupied', async () => {
  _resetAssignments();
  
  // Fill all slots
  const keys = Array.from({ length: workerCount }, (_, i) => `key-${i}`);
  keys.forEach(key => {
    const result = allocateIpForKey(key);
    expect(result.kind).toBe('allocated');
  });
  
  // Next request should be rejected
  const overflowResult = allocateIpForKey('key-overflow');
  expect(overflowResult.kind).toBe('capacity_exhausted');
  
  // Release one and retry should succeed
  releaseIpForKey('key-0');
  const retryResult = allocateIpForKey('key-overflow');
  expect(retryResult.kind).toBe('allocated');
});
```

### T4.12 — Router integration: Exception cleanup

Integration test that verifies worker is released even when request throws:
1. Allocate slot
2. Simulate exception during request
3. Verify slot is released and available for new request

```typescript
it('releases worker on exception', async () => {
  _resetAssignments();
  
  // Allocate
  const result = allocateIpForKey('test-key');
  expect(result.kind).toBe('allocated');
  
  // Simulate request that throws
  let exceptionThrown = false;
  try {
    throw new Error('simulated upstream error');
  } catch (e) {
    exceptionThrown = true;
  } finally {
    releaseIpForKey('test-key');
  }
  expect(exceptionThrown).toBe(true);
  
  // Slot should be available
  expect(_getActiveAssignmentCount()).toBe(0);
  const newResult = allocateIpForKey('test-key');
  expect(newResult.kind).toBe('allocated');
});
```

### T4.13 — Invalid PROXY_IP_COUNT values → disabled mode

Test that invalid `PROXY_IP_COUNT` values result in bypass mode:

```typescript
it('treats invalid PROXY_IP_COUNT as disabled', () => {
  _resetAssignments();
  
  // Test various invalid values
  const invalidValues = ['abc', '-1', '1.5', ''];
  
  invalidValues.forEach(value => {
    process.env.PROXY_IP_COUNT = value;
    const result = allocateIpForKey('key-1');
    expect(result.kind).toBe('bypass');
  });
  
  // Clean up
  delete process.env.PROXY_IP_COUNT;
});

it('accepts valid PROXY_IP_COUNT values', () => {
  _resetAssignments();
  
  // Valid positive integer
  process.env.PROXY_IP_COUNT = '3';
  const result = allocateIpForKey('key-1');
  expect(result.kind).toBe('allocated');
  
  // Valid zero
  process.env.PROXY_IP_COUNT = '0';
  _resetAssignments();
  const zeroResult = allocateIpForKey('key-1');
  expect(zeroResult.kind).toBe('capacity_exhausted');
  
  // Clean up
  delete process.env.PROXY_IP_COUNT;
});
```

## Phase 5: Cleanup

### T5.1 — Remove sessionKey allocation logic

Clean up any remaining references to `sessionKey` in the allocation context. The `sessionKey` variable may still exist for other purposes (sticky routing), but it should no longer be passed to IP allocation functions.

### T5.2 — Update imports

Verify all imports in `proxy.ts` are correct after removing old functions.

### T5.3 — Verify no remaining callers

Search for any remaining calls to `allocateIp` or `releaseIp` (without `ForKey` suffix) to ensure all call sites are migrated.

## Dependencies

Tasks must be completed in order within each phase. Phases can be interleaved:

```
Phase 1 (T1.1-T1.8) → Phase 2 (T2.1-T2.6) → Phase 3 (T3.1-T3.5) → Phase 4 (T4.1-T4.13) → Phase 5 (T5.1-T5.3)
```

## Verification

After all tasks complete:
- All existing tests pass (except those testing old sessionKey behavior, which are replaced)
- New tests cover all scenarios in the test matrix
- No TypeScript compilation errors
- Manual verification: send concurrent requests from same API key → second gets 409