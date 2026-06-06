# Safeguard Bypasses - Implementation Tasks

## Phase 1: Preserve Ban History in Sticky Sessions

- [ ] **1.1** Update `stickySessionMap` type definition to make `modelDbId` optional
  - File: [`server/src/routes/proxy.ts:18`](server/src/routes/proxy.ts:18)
  - Change: `modelDbId: number` → `modelDbId?: number`

- [ ] **1.2** Modify `clearStickyModel()` function to preserve `bannedPlatforms`
  - File: [`server/src/routes/proxy.ts:181-186`](server/src/routes/proxy.ts:181)
  - Change: Replace `stickySessionMap.delete(key)` with logic that clears `modelDbId` and `keyId` but preserves `bannedPlatforms`

## Phase 2: Break the Preferred Model Retry Loop Deadlock

- [ ] **2.1** Add `preferredModel` clearing in non-rate-limit error handler
  - File: [`server/src/routes/proxy.ts:1740-1743`](server/src/routes/proxy.ts:1740)
  - Location: Inside the `if (shouldSkipModelOnRetry(err))` block
  - Change: When `preferredModel === route.modelDbId`, set `preferredModel = undefined` and `preferredKeyId = undefined`

- [ ] **2.2** Add key exhaustion check in rate-limit error handler
  - File: [`server/src/routes/proxy.ts:1745-1747`](server/src/routes/proxy.ts:1745)
  - Location: Inside the `if (isRateLimitError(err))` block
  - Change: Check if preferred model has valid keys remaining; if not, clear `preferredModel` and `preferredKeyId`

## Phase 3: Verification

- [ ] **3.1** Run existing test suite for provider-session-ban
  - Command: `pnpm --filter server vitest run src/__tests__/routes/provider-session-ban.test.ts`
  - Expected: All tests pass

- [ ] **3.2** Verify TypeScript compilation
  - Command: `pnpm --filter server build`
  - Expected: No type errors

## Implementation Notes

### Phase 1.2 - clearStickyModel Implementation

```typescript
function clearStickyModel(messages: ChatMessage[], routingMode: RoutingMode) {
  const key = getSessionKey(messages, routingMode);
  if (!key) return;
  const entry = stickySessionMap.get(key);
  if (!entry) return;
  
  // Preserve bannedPlatforms, clear only model/key
  entry.modelDbId = undefined;
  entry.keyId = undefined;
  entry.lastUsed = Date.now();
}
```

### Phase 2.1 - Non-rate-limit Error Handler

```typescript
if (shouldSkipModelOnRetry(err)) {
  skipModels.add(route.modelDbId);
  
  // Clear preferred model if it matches the failed model
  if (preferredModel === route.modelDbId) {
    preferredModel = undefined;
    preferredKeyId = undefined;
  }
}
```

### Phase 2.2 - Rate-limit Error Handler

```typescript
if (isRateLimitError(err)) {
  setCooldown(route.platform, route.modelId, route.keyId, 120_000);
  
  // Check if preferred model has valid keys remaining
  if (preferredModel === route.modelDbId) {
    const hasValidKeysForPreferred = checkValidKeysRemaining(route);
    if (!hasValidKeysForPreferred) {
      preferredModel = undefined;
      preferredKeyId = undefined;
    }
  }
}
```

Note: The `checkValidKeysRemaining` function needs to be implemented or the logic needs to be inlined. See the `hasValidKeys` function in [`router.ts:550-561`](server/src/services/router.ts:550) for reference.