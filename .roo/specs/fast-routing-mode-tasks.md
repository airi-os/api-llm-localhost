# Fast Routing Mode Implementation Tasks

## Task List

- [ ] Update `RoutingMode` type to include `'fast'` in router.ts
- [ ] Add `getModelPool` import to router.ts
- [ ] Add fast pool filtering logic in `routeRequest()` function
- [ ] Add `AUTO_FAST_MODEL_ID` constant in proxy.ts
- [ ] Update `/models` endpoint to include auto-fast model
- [ ] Update `/models/:id` handler for auto-fast
- [ ] Update AGENTS.md to document auto-fast endpoint
- [ ] Create router-fast-mode.test.ts with unit tests
- [ ] Run all tests to verify changes work correctly

## Implementation Notes

### Step 1: Update RoutingMode type

File: `server/src/services/router.ts`, line 162

Change:
```typescript
export type RoutingMode = 'balanced' | 'smart';
```
To:
```typescript
export type RoutingMode = 'balanced' | 'smart' | 'fast';
```

### Step 2: Add fast pool filtering

File: `server/src/services/router.ts`, around line 527

Add import for `getModelPool` and `ModelPool`:
```typescript
import { getModelPool } from '../routes/fallback.js';
import { ModelPool } from '@freellmapi/shared/types.js';
```

Update the filtering logic:
```typescript
const filteredChain = routingMode === 'balanced'
  ? chain.filter(entry => {
      // existing balanced exclusions
    })
  : routingMode === 'fast'
  ? chain.filter(entry => getModelPool(entry.platform, entry.model_id) === ModelPool.Fast)
  : chain;
```

### Step 3: Add AUTO_FAST_MODEL_ID

File: `server/src/routes/proxy.ts`, around line 223

```typescript
const AUTO_FAST_MODEL_ID = 'freellmapi/auto-fast';
```

### Step 4: Update /models endpoint

File: `server/src/routes/proxy.ts`, around line 252

Add to the models array:
```typescript
{
  id: AUTO_FAST_MODEL_ID,
  object: 'model',
  created: 0,
  owned_by: 'freellmapi',
  name: 'Auto Fast (Speed Router)',
  context_window: 128000,
},
```

### Step 5: Update /models/:id handler

File: `server/src/routes/proxy.ts`, around line 282

Update the condition:
```typescript
if (id === AUTO_MODEL_ID || id === AUTO_SMART_MODEL_ID || id === AUTO_FAST_MODEL_ID) {
```

### Step 6: Update AGENTS.md

File: `AGENTS.md`, around line 19

Add documentation for auto-fast:
```markdown
**Auto routing modes** (use as the model name in API requests):
- `freellmapi/auto` — default; balanced routing optimizing for speed, reliability, and intelligence
- `freellmapi/auto-smart` — prioritizes model capability (60% intelligence weight) for complex reasoning tasks
- `freellmapi/auto-fast` — routes to lowest latency models (models with `-fast` suffix)
```

### Step 7: Create tests

File: `server/src/__tests__/services/router-fast-mode.test.ts`

Test cases:
1. Fast mode only includes fast pool models
2. Fast mode excludes non-fast models
3. Fast mode uses Thompson sampling
4. Fast mode respects rate limits
5. Fast mode applies penalties