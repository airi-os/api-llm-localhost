# Dynamic Pool Routing Requirements

## Overview

Replace the static model pool classification with dynamic, formula-based pool assignment using actual performance metrics. This enables models to be classified based on their real-world performance rather than hardcoded rules.

## Problem Statement

The current static classification in `fallback.ts::getModelPool()` uses hardcoded rules:
- Models ending with `-fast` → Fast pool
- LongCat platform → Smart pool
- Owl Alpha model → Smart pool
- Everything else → Balanced pool

This approach is problematic because:
1. It doesn't reflect actual model performance
2. A model that performs well might be in the "wrong" pool
3. It requires manual updates when new models are added

## Solution

Use the same dynamic `calculateModelPool()` function that already exists in `router.ts` for the UI's pool display in `fallback.ts`.

### Current Implementation in router.ts

```typescript
function calculateModelPool(entry: ChainRow): ModelPool {
  const stats = statsCache?.get(`${entry.platform}:${entry.model_id}`);
  const tokPerSec = stats?.tokPerSec ?? 0;
  const avgTtfbMs = stats?.avgTtfbMs ?? null;

  // Calculate speed score using logarithmic scale
  const speedScore = tokPerSec > 0 ? Math.log(tokPerSec) : 0;
  const ttfbPenalty = avgTtfbMs !== null ? Math.log(avgTtfbMs + 1) * 0.1 : 0;
  const effectiveSpeedScore = speedScore - ttfbPenalty;

  // Classify based on thresholds
  if (effectiveSpeedScore >= FAST_THRESHOLD) return ModelPool.Fast;
  if (effectiveSpeedScore >= BALANCED_THRESHOLD) return ModelPool.Balanced;
  return ModelPool.Smart;
}
```

### Borrowing Rules (Already Implemented)

The borrowing logic in `getModelsForMode()` already implements:
- **Smart mode**: Only smart pool, NEVER borrows
- **Balanced mode**: Balanced pool first, then borrows from fast pool
- **Fast mode**: Fast pool first, then borrows from balanced pool

## Requirements

### R1: Dynamic Pool Calculation for UI

The `fallback.ts` endpoint must use the same dynamic calculation as the router for consistency.

**Current state**: `fallback.ts::getModelPool()` uses static classification
**Required**: Use dynamic calculation based on performance metrics

### R2: Consistent Pool Display

The UI (FallbackPage.tsx) displays models grouped by pool. The pool assignment must match what the router uses for actual routing decisions.

### R3: Handle Missing Metrics

When a model has no performance data (new model, no recent requests):
- Default to Balanced pool (middle tier)
- This ensures new models get a fair chance before being classified

### R4: No Borrowing in UI Display

The UI should show models in their actual pool classification, not with borrowing logic. Borrowing is a routing concern, not a display concern.

## Files to Modify

1. **server/src/routes/fallback.ts**
   - Remove static `getModelPool()` function
   - Import and use `calculateModelPool()` from router.ts
   - Update the pool assignment logic to use dynamic calculation

2. **server/src/__tests__/routes/fallback-pool.test.ts**
   - Update tests to reflect dynamic classification
   - Tests should verify pool assignment based on metrics, not static rules

## Acceptance Criteria

- [ ] `fallback.ts` uses dynamic pool calculation matching `router.ts`
- [ ] UI displays models in correct pools based on performance metrics
- [ ] New models without metrics default to Balanced pool
- [ ] Pool display is consistent with routing behavior
- [ ] All existing tests pass (after updating for dynamic behavior)