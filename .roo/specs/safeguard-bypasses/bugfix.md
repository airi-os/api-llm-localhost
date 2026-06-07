# Issue 3: Safeguard Bypasses / Banned Provider Bypass

## Bug Description

When a provider fails during a request, the system should ban that provider and skip all models from that provider in subsequent retry attempts. However, there are two critical bugs that allow banned providers to be retried:

### Bug 1: Sticky Session Clear Erases Ban History

The `clearStickyModel()` function deletes the entire sticky session entry when a non-retryable error occurs. This erases the `bannedPlatforms` history, causing the system to forget that a provider was banned.

**Location**: [`server/src/routes/proxy.ts:181-186`](server/src/routes/proxy.ts:181)

```typescript
function clearStickyModel(messages: ChatMessage[], routingMode: RoutingMode) {
  const key = getSessionKey(messages, routingMode);
  if (!key) return;
  if (!stickySessionMap.has(key)) return;
  stickySessionMap.delete(key);  // BUG: Erases ban history
}
```

### Bug 2: Preferred Model Retry Loop Deadlock

When a model fails and is added to `skipModels`, the retry loop continues to prefer the same model because `preferredModel` is not cleared. The router's [`routeRequest()`](server/src/services/router.ts:674) function has a bypass that skips `skipModels` checks for the preferred model:

```typescript
if (skipModels?.has(entry.model_db_id) && entry.model_db_id !== preferredModelDbId) continue;
```

This creates a deadlock where:
1. Model A fails and is added to `skipModels`
2. The retry loop still prefers Model A
3. The router bypasses `skipModels` for the preferred model
4. Model A is retried and fails again

## Impact

- **User Experience**: Users receive repeated failures from the same broken provider
- **Rate Limiting**: Banned providers can exhaust rate limits without being skipped
- **Trust**: The thread protection safeguards are ineffective

## Root Causes

1. `stickySessionMap` type requires `modelDbId: number` (non-optional), preventing entries that only store ban history
2. `clearStickyModel()` uses `.delete()` instead of preserving `bannedPlatforms`
3. `preferredModel` and `preferredKeyId` are not cleared when a model is added to `skipModels`
4. No key exhaustion check in the rate-limit error handler

## Affected Components

- [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts) - Main proxy routing logic
- [`server/src/services/router.ts`](server/src/services/router.ts) - Model selection with Thompson sampling
- [`server/src/services/threadProtection.ts`](server/src/services/threadProtection.ts) - Thread protection decision matrix

## Related Test Coverage

- [`server/src/__tests__/routes/provider-session-ban.test.ts`](server/src/__tests__/routes/provider-session-ban.test.ts)