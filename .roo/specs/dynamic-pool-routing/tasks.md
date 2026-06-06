# Dynamic Pool Routing Tasks

## Task List

### Task 1: Export calculatePoolFromMetrics from router.ts

**File**: `server/src/services/router.ts`

Create a standalone function that calculates pool from metrics (not requiring a ChainRow):

```typescript
export function calculatePoolFromMetrics(tokPerSec: number, avgTtfbMs: number | null): ModelPool {
  const speedScore = tokPerSec > 0 ? Math.log(tokPerSec) : 0;
  const ttfbPenalty = avgTtfbMs !== null ? Math.log(avgTtfbMs + 1) * 0.1 : 0;
  const effectiveSpeedScore = speedScore - ttfbPenalty;

  if (effectiveSpeedScore >= FAST_THRESHOLD) return ModelPool.Fast;
  if (effectiveSpeedScore >= BALANCED_THRESHOLD) return ModelPool.Balanced;
  return ModelPool.Smart;
}
```

**Acceptance**: Function exported and usable by fallback.ts

---

### Task 2: Update fallback.ts imports

**File**: `server/src/routes/fallback.ts`

Add `calculatePoolFromMetrics` to the import from router.js:

```typescript
import { getAllPenalties, getAnalyticsScores, getAnalyticsScore, getSmartAnalyticsScore, refreshStatsCache, PENALTY_SCORE_WEIGHT, calculatePoolFromMetrics } from '../services/router.js';
```

**Acceptance**: Import statement updated

---

### Task 3: Update pool assignment in fallback.ts

**File**: `server/src/routes/fallback.ts`

In the result mapping (around line 67-109), update the pool assignment:

**Current**:
```typescript
const pool = getModelPool(r.platform, r.model_id);
```

**New**:
```typescript
const analytics = analyticsMap.get(`${r.platform}:${r.model_id}`);
const tokPerSec = analytics?.tokPerSec ?? 0;
const avgTtfbMs = analytics?.avgTtfbMs ?? null;
const pool = calculatePoolFromMetrics(tokPerSec, avgTtfbMs);
```

**Acceptance**: Pool assignment uses dynamic calculation

---

### Task 4: Remove static getModelPool function

**File**: `server/src/routes/fallback.ts`

Remove the static `getModelPool` function (lines 12-22) since it's no longer needed.

**Acceptance**: Static function removed, no references to it remain

---

### Task 5: Update fallback-pool.test.ts

**File**: `server/src/__tests__/routes/fallback-pool.test.ts`

Update tests to verify dynamic classification based on metrics:

1. Test high speed metrics → Fast pool
2. Test medium speed metrics → Balanced pool
3. Test low speed metrics → Smart pool
4. Test no metrics → Balanced pool (default)
5. Test threshold boundaries

**Acceptance**: All tests pass with dynamic classification

---

### Task 6: Run all tests

**Command**: `pnpm --filter server test`

Verify all existing tests pass and new behavior is correct.

**Acceptance**: All tests pass

---

### Task 7: Commit and push

**Commands**:
```bash
git add -A
git commit -m "feat: dynamic pool routing - use formula-based pool assignment"
git push
```

**Acceptance**: Changes committed and pushed