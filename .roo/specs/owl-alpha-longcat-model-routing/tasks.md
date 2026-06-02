# Tasks: Owl Alpha + LongCat Model-Level Routing

## Phase 1: Router Changes (`server/src/services/router.ts`)

- [x] **T1.1: Add balanced mode exclusion constants**
  - Add `EXCLUDED_FROM_BALANCED` set containing `'longcat'`
  - Add `EXCLUDED_MODELS_FROM_BALANCED` map with `openrouter → Set(['owl-alpha'])`

- [x] **T1.2: Add balanced mode exclusion filter in `routeRequest()`**
  - After building the chain, in balanced mode (`routingMode === 'balanced'`):
    - Filter out entries where `platform` is in `EXCLUDED_FROM_BALANCED`
    - Filter out entries where `platform` + `model_id` is in `EXCLUDED_MODELS_FROM_BALANCED`
  - Smart mode does NOT apply this exclusion (these models are available via preference)

- [x] **T1.3: Extract reusable `hasValidKeys()` helper**
  - Create a function that takes `(platform, modelId, limits, estimatedTokens)` and returns boolean
  - Queries keys with `enabled = 1 AND status != 'invalid'`
  - Checks `!isOnCooldown() && canMakeRequest() && canUseTokens()` for at least one key
  - Refactor existing LongCat preference check to use this helper

- [x] **T1.4: Add Owl Alpha smart preference check**
  - After the existing LongCat preference block in smart mode:
    - Query `openrouter` keys for the `owl-alpha` model
    - Use `hasValidKeys()` to validate at least one key has capacity
    - If valid: move `openrouter/owl-alpha` entry to front of sorted chain (after LongCat entries if both are preferred)
    - Preserve relative score order among preferred entries
    - Log: `[Router] Owl Alpha preference active — moving openrouter/owl-alpha to front`

## Phase 2: Proxy Changes (`server/src/routes/proxy.ts`)

- [ ] **T2.1: Add Owl Alpha sticky cooldown check**
  - After the existing LongCat sticky cooldown block (~line 1209-1221):
    - Check if the sticky model's `platform === 'openrouter'` AND `model_id === 'owl-alpha'`
    - If within `LONGCAT_STICKY_COOLDOWN_MS`: add the specific `owl-alpha` model DB ID to `skipModels`
    - Log the cooldown activation

- [ ] **T2.2: Change LongCat truncation handling to model-level**
  - Line ~1308-1318: Replace `banPlatformFromSession('longcat')` + `addProviderModelsToSkipModels(skipModels, 'longcat')` with `skipModels.add(route.modelDbId)`
  - Update log message to say "skipping model LongCat-2.0-Preview" instead of "banning LongCat provider"

- [ ] **T2.3: Add Owl Alpha truncation handling (model-level)**
  - In the truncation check block (~line 1303-1318):
    - Add condition for `route.platform === 'openrouter' && route.modelId === 'owl-alpha'`
    - Use `skipModels.add(route.modelDbId)` (model-level, NOT platform-level)
    - Log: "Truncated stream content detected from Owl Alpha — skipping model openrouter/owl-alpha for session"

- [ ] **T2.4: Change LongCat mid-stream 5xx handling to model-level**
  - Line ~1376-1387: Replace `banPlatformFromSession('longcat')` + `addProviderModelsToSkipModels(skipModels, 'longcat')` with `skipModels.add(route.modelDbId)`
  - Clear sticky if pinned to the specific model (check `route.modelId === 'LongCat-2.0-Preview'`)

- [ ] **T2.5: Add Owl Alpha mid-stream 5xx handling (model-level)**
  - In the mid-stream 5xx block (~line 1376-1387):
    - Add condition for `route.platform === 'openrouter' && route.modelId === 'owl-alpha'`
    - Use `skipModels.add(route.modelDbId)` (model-level)
    - Clear sticky if pinned to the specific model

- [ ] **T2.6: Change LongCat mid-stream truncation handling to model-level**
  - Line ~1403-1413: Replace `banPlatformFromSession('longcat')` + `addProviderModelsToSkipModels(skipModels, 'longcat')` with `skipModels.add(route.modelDbId)`

- [ ] **T2.7: Add Owl Alpha mid-stream truncation handling (model-level)**
  - In the mid-stream truncation block (~line 1389-1432):
    - Add condition for `route.platform === 'openrouter' && route.modelId === 'owl-alpha'`
    - Use `skipModels.add(route.modelDbId)` (model-level)

- [ ] **T2.8: Change LongCat mid-stream retryable error handling to model-level**
  - Line ~1434-1466: Replace `banPlatformFromSession('longcat')` + `addProviderModelsToSkipModels(skipModels, 'longcat')` with `skipModels.add(route.modelDbId)`

- [ ] **T2.9: Add Owl Alpha mid-stream retryable error handling (model-level)**
  - In the mid-stream retryable error block (~line 1434-1466):
    - Add condition for `route.platform === 'openrouter' && route.modelId === 'owl-alpha'`
    - Use `skipModels.add(route.modelDbId)` (model-level)

- [ ] **T2.10: Change LongCat non-stream 5xx handling to model-level**
  - Line ~1536-1553: Replace `banPlatformFromSession('longcat')` + `addProviderModelsToSkipModels(skipModels, 'longcat')` with `skipModels.add(route.modelDbId)`
  - Clear sticky if pinned to the specific model

- [ ] **T2.11: Add Owl Alpha non-stream 5xx handling (model-level)**
  - In the non-stream 5xx block (~line 1531-1553):
    - Add condition for `route.platform === 'openrouter' && route.modelId === 'owl-alpha'`
    - Use `skipModels.add(route.modelDbId)` (model-level)
    - Clear sticky if pinned to the specific model

- [ ] **T2.12: Change LongCat non-stream retryable error handling to model-level**
  - Line ~1557-1569: Replace `banPlatformFromSession('longcat')` + `addProviderModelsToSkipModels(skipModels, 'longcat')` with `skipModels.add(route.modelDbId)`
  - Clear sticky if pinned to the specific model

- [ ] **T2.13: Add Owl Alpha non-stream retryable error handling (model-level)**
  - In the non-stream retryable error block (~line 1555-1581):
    - Add condition for `route.platform === 'openrouter' && route.modelId === 'owl-alpha'`
    - Use `skipModels.add(route.modelDbId)` (model-level)
    - Clear sticky if pinned to the specific model

## Phase 3: Testing

- [ ] **T3.1: Verify balanced auto excludes LongCat and Owl Alpha**
  - Add test: `freellmapi/auto` with valid longcat/owl-alpha keys → routes to other models
  - Add test: `freellmapi/auto` with ONLY longcat/owl-alpha keys → returns 429

- [ ] **T3.2: Verify smart auto prefers LongCat and Owl Alpha**
  - Add test: `freellmapi/auto-smart` with valid longcat keys → longcat at front of chain
  - Add test: `freellmapi/auto-smart` with valid openrouter keys → owl-alpha at front of chain
  - Add test: `freellmapi/auto-smart` with all keys on cooldown → normal bandit scoring

- [ ] **T3.3: Verify sticky cooldown works for both**
  - Add test: Session uses LongCat → other sessions skip LongCat for cooldown window
  - Add test: Session uses Owl Alpha → other sessions skip Owl Alpha for cooldown window

- [ ] **T3.4: Verify model-level banning**
  - Add test: LongCat 5xx → only LongCat-2.0-Preview skipped, other longcat models (future) available
  - Add test: Owl Alpha 5xx → only owl-alpha skipped, other openrouter models available
  - Add test: Owl Alpha truncation → only owl-alpha skipped
  - Add test: LongCat truncation → only LongCat-2.0-Preview skipped

- [ ] **T3.5: Verify explicit model requests still work**
  - Add test: `model: "longcat/LongCat-2.0-Preview"` in balanced mode → routes to LongCat
  - Add test: `model: "openrouter/owl-alpha"` in balanced mode → routes to Owl Alpha