# Design: Owl Alpha + LongCat Model-Level Routing

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                     Client Request                          │
│              model: "freellmapi/auto" | "freellmapi/auto-smart"  │
└─────────────┬───────────────────────────────┬───────────────┘
               │                               │
               ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   Balanced Router       │     │   Smart Router          │
│   (auto)                │     │   (auto-smart)          │
│                         │     │                         │
│  - Excludes longcat/*   │     │  - Prefers longcat/*    │
│  - Excludes OR/owl-alpha│     │    and OR/owl-alpha     │
│  - Normal bandit for    │     │    when valid keys exist│
│    everything else      │     │  - Applies sticky       │
│                         │     │    cooldown for both    │
│                         │     │  - Model-level banning  │
│                         │     │    on errors            │
└─────────────┬───────────┘     └───────────┬─────────────┘
               │                               │
               ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│              routeRequest() in router.ts                    │
│                                                             │
│  1. Build chain from fallback_config + models               │
│  2. Score via Thompson sampling                             │
│  3. Apply balanced exclusions (REQ-1)                       │
│  4. Apply smart preferences (REQ-2)                         │
│  5. Apply sticky session pin                                │
│  6. Iterate chain, find first model with valid key          │
└─────────────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│              handleChatCompletion() in proxy.ts             │
│                                                             │
│  - Sticky cooldown check for longcat + owl-alpha (REQ-3)   │
│  - Model-level skipModels on 5xx/retryable (REQ-4, REQ-5)  │
│  - Model-level skipModels on truncation (REQ-4, REQ-5)     │
│  - Model-level skipModels on mid-stream errors (REQ-4, REQ-5)│
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Smart Preference Flow

```text
routeRequest()
   │
   ├─ Build chain (all enabled models from fallback_config)
   ├─ Score all entries via Thompson sampling
   │
   ├─ [BALANCED MODE]
   │   ├─ Filter out entries where platform == 'longcat'
   │   ├─ Filter out entries where platform == 'openrouter' AND model_id == 'owl-alpha'
   │   └─ Continue with remaining chain
   │
   ├─ [SMART MODE]
   │   ├─ Check LongCat preference
   │   │   ├─ Query longcat keys (enabled, not invalid)
   │   │   ├─ Validate: !isOnCooldown && canMakeRequest && canUseTokens
   │   │   └─ If valid keys exist → move longcat entries to front
   │   │
   │   ├─ Check Owl Alpha preference
   │   │   ├─ Query openrouter keys (enabled, not invalid)
   │   │   ├─ Validate: !isOnCooldown && canMakeRequest && canUseTokens
   │   │   └─ If valid keys exist → move openrouter/owl-alpha entry to front
   │   │
   │   └─ Continue with reordered chain
   │
   ├─ Apply sticky session pin (preferredModelDbId)
   └─ Iterate chain for first valid key
```

### Sticky Cooldown Flow

```text
handleChatCompletion()
   │
   ├─ [Existing] Check if sticky model is LongCat
   │   └─ If within cooldown → add longcat platform models to skipModels
   │
   ├─ [NEW] Check if sticky model is Owl Alpha (openrouter/owl-alpha)
   │   └─ If within cooldown → add openrouter/owl-alpha model to skipModels
   │
   └─ Proceed with routing (skipModels applied)
```

### Error Handling Flow (Model-Level)

```text
On 5xx / retryable / truncation error from route:
   │
   ├─ [Existing LongCat] banPlatformFromSession('longcat')
   │   → [CHANGED TO] skipModels.add(modelDbId) for longcat/LongCat-2.0-Preview
   │
   ├─ [NEW Owl Alpha] skipModels.add(modelDbId) for openrouter/owl-alpha
   │
   └─ Retry loop continues with updated skipModels
```

## File Changes

### 1. `server/src/services/router.ts`

**Changes:**
- Add balanced mode exclusion for `longcat` platform and `openrouter/owl-alpha` model
- Add smart mode preference for `openrouter/owl-alpha` (parallel to existing LongCat preference)
- Extract a reusable `hasValidKeys()` helper to avoid duplicating key validation logic

**New constants:**
```typescript
const EXCLUDED_FROM_BALANCED = new Set(['longcat']);
const EXCLUDED_MODELS_FROM_BALANCED = new Map<string, Set<string>>([
  ['openrouter', new Set(['owl-alpha'])],
]);
```

**Modified function: `routeRequest()`**
- After building the chain, in balanced mode: filter out excluded platforms/models
- In smart mode: add Owl Alpha preference check after LongCat preference check

### 2. `server/src/routes/proxy.ts`

**Changes:**
- Add sticky cooldown check for Owl Alpha (when sticky model is `openrouter/owl-alpha`)
- Change LongCat error handling from `banPlatformFromSession('longcat')` to `skipModels.add(modelDbId)`
- Add Owl Alpha error handling: `skipModels.add(modelDbId)` (model-level, not platform-level)

**Modified sections:**
- Lines ~1209-1221: LongCat sticky cooldown → also check for Owl Alpha sticky
- Lines ~1376-1387: Mid-stream 5xx from LongCat → model-level skip
- Lines ~1308-1318: Truncation from LongCat → model-level skip
- Lines ~1403-1413: Truncation from Owl Alpha → model-level skip
- Lines ~1434-1466: Mid-stream retryable from LongCat → model-level skip
- Lines ~1536-1553: Non-stream 5xx from LongCat → model-level skip
- Lines ~1557-1569: Retryable error from LongCat → model-level skip
- Lines ~1308-1318: Truncation from Owl Alpha → model-level skip (new)
- New: Non-stream 5xx from Owl Alpha → model-level skip
- New: Retryable error from Owl Alpha → model-level skip

## Key Design Decisions

### Decision 1: Model-Level vs Provider-Level Banning

**Choice:** Use `skipModels.add(modelDbId)` instead of `banPlatformFromSession()` for both LongCat and Owl Alpha.

**Rationale:**
- LongCat currently has only one model but may add more in the future
- Banning the entire `longcat` platform when one model fails is overly aggressive
- Owl Alpha is one model among many on `openrouter` — banning all of `openrouter` would be catastrophic
- Model-level banning is more precise and allows other models on the same platform to continue working

### Decision 2: Reuse Existing Cooldown Constant

**Choice:** Use the existing `LONGCAT_STICKY_COOLDOWN_MS` (3 minutes) for both LongCat and Owl Alpha cooldown.

**Rationale:**
- Both platforms serve similar free-tier models with similar session isolation concerns
- Adding a separate constant adds complexity without clear benefit
- Can be split later if different cooldown windows are needed

### Decision 3: Balanced Exclusion at Chain Level

**Choice:** Filter excluded models from the chain before scoring in balanced mode, rather than skipping during iteration.

**Rationale:**
- Cleaner separation: excluded models never enter the bandit scoring
- Avoids edge case where an excluded model scores highest but gets skipped, causing unnecessary fallback
- Consistent with how the chain is already filtered (e.g., `skipModels` check during iteration)

### Decision 4: Smart Preference Uses Same Key Validation

**Choice:** The Owl Alpha preference check uses the same `isOnCooldown` + `canMakeRequest` + `canUseTokens` validation as LongCat.

**Rationale:**
- Consistent behavior: both models are treated identically
- The `isOnCooldown` check ensures penalized keys (from 429s) don't trigger preference
- The capacity checks ensure the model is actually routable before preferring it
