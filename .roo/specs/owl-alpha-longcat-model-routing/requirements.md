# Requirements: Owl Alpha + LongCat Model-Level Routing

## Overview

Treat Owl Alpha (`openrouter/owl-alpha`) identically to LongCat (`longcat/LongCat-2.0-Preview`) in the smart routing system, with model-level (not provider-level) banning for both. Exclude both from the balanced auto router entirely.

## Context

- **Owl Alpha** is a model under the `openrouter` platform: `openrouter/owl-alpha`
- **LongCat** is a separate platform: `longcat/LongCat-2.0-Preview`
- Both are frontier-tier free models with similar agentic capabilities
- LongCat currently has provider-level banning (entire `longcat` platform banned on errors) — this needs to shift to model-level banning since LongCat may add more models in the future
- Owl Alpha needs model-level banning (only `openrouter/owl-alpha` banned, not all of `openrouter`)
- Both should be excluded from `freellmapi/auto` (balanced) routing
- Both should be preferred in `freellmapi/auto-smart` routing when valid (non-cooldown) keys exist
- Sticky session cooldown should protect both platforms' models from being hit by other sessions

## Requirements

### REQ-1: Exclude Owl Alpha and LongCat from Balanced Auto Routing

**Priority:** Must Have

The `freellmapi/auto` (balanced routing mode) must never route to:
- Any model on the `longcat` platform (currently only `LongCat-2.0-Preview`)
- The `openrouter/owl-alpha` model

This applies to all sessions, including sticky sessions. The balanced router should completely ignore these models/platforms.

**Acceptance Criteria:**
- `freellmapi/auto` requests never resolve to `longcat/LongCat-2.0-Preview`
- `freellmapi/auto` requests never resolve to `openrouter/owl-alpha`
- Explicit model requests (e.g., `model: "openrouter/owl-alpha"`) still work in balanced mode
- Other `openrouter/*` models remain available in balanced mode

### REQ-2: Smart Auto Preference for Owl Alpha and LongCat

**Priority:** Must Have

The `freellmapi/auto-smart` routing mode must prefer Owl Alpha and LongCat models when:
1. At least one API key exists for the platform/model
2. At least one key is NOT on cooldown (not in the 429 penalty list)
3. At least one key has capacity (passes rate-limit checks)

When these conditions are met, Owl Alpha and LongCat models should be moved to the front of the routing chain, preserving their relative Thompson-sampling score order.

**Acceptance Criteria:**
- When valid LongCat keys exist, `longcat/LongCat-2.0-Preview` appears at the front of the sorted chain in smart mode
- When valid Owl Alpha keys exist (i.e., keys for `openrouter` platform that can reach `owl-alpha`), `openrouter/owl-alpha` appears at the front of the sorted chain in smart mode
- When no valid keys exist (all on cooldown or no keys configured), these models fall back to normal bandit scoring
- The preference check uses the same capacity validation as the existing LongCat preference logic (`canMakeRequest`, `canUseTokens`, `isOnCooldown`)

### REQ-3: Sticky Session Cooldown for Owl Alpha and LongCat

**Priority:** Must Have

When a session has a recent sticky session on LongCat or Owl Alpha (within the cooldown window), other sessions should not be routed to these models.

The existing `LONGCAT_STICKY_COOLDOWN_MS` (3 minutes) applies. During the cooldown window:
- The current sticky session keeps its pinned route
- All other sessions skip LongCat and Owl Alpha models

**Acceptance Criteria:**
- After a session uses LongCat, other sessions skip LongCat models for `LONGCAT_STICKY_COOLDOWN_MS`
- After a session uses Owl Alpha, other sessions skip `openrouter/owl-alpha` for `LONGCAT_STICKY_COOLDOWN_MS`
- The sticky session itself is NOT affected — it keeps its pinned model
- After the cooldown expires, these models become available to all sessions again

### REQ-4: Model-Level Banning for LongCat (Migration from Provider-Level)

**Priority:** Must Have

Change LongCat error handling from provider-level banning to model-level banning:
- On 5xx/retryable errors from `longcat/LongCat-2.0-Preview`, only skip `longcat/LongCat-2.0-Preview` for the session
- Do NOT ban the entire `longcat` platform
- This prepares for future LongCat models that may be added independently

**Acceptance Criteria:**
- When `longcat/LongCat-2.0-Preview` returns a 5xx error, only that specific model is added to `skipModels` for the session
- Other models on the `longcat` platform (when added in the future) remain available
- Truncation errors from `longcat/LongCat-2.0-Preview` skip only that model
- Mid-stream retryable errors from `longcat/LongCat-2.0-Preview` skip only that model
- The `banPlatformFromSession` call is replaced with `skipModels.add(modelDbId)` for LongCat

### REQ-5: Model-Level Banning for Owl Alpha

**Priority:** Must Have

Owl Alpha uses model-level banning (same as the new LongCat behavior):
- On 5xx/retryable errors from `openrouter/owl-alpha`, only skip `openrouter/owl-alpha` for the session
- Do NOT ban the entire `openrouter` platform
- Other `openrouter/*` models remain available

**Acceptance Criteria:**
- When `openrouter/owl-alpha` returns a 5xx error, only that specific model is added to `skipModels` for the session
- Other `openrouter/*` models remain available for the session
- Truncation errors from `openrouter/owl-alpha` skip only that model
- Mid-stream retryable errors from `openrouter/owl-alpha` skip only that model

### REQ-6: Valid Key Check for Preference

**Priority:** Must Have

The smart auto preference logic must validate that keys are not on cooldown before preferring a model. A key that has been penalized by the rate-limit system (429 cooldown) should not count as a valid key for the preference check.

**Acceptance Criteria:**
- The preference check queries keys with `status != 'invalid'` AND `enabled = 1`
- The preference check validates at least one key passes `isOnCooldown()` (returns false)
- The preference check validates at least one key passes `canMakeRequest()` and `canUseTokens()`
- If all keys are on cooldown, the model is NOT preferred (falls back to normal bandit scoring)

## Out of Scope

- Adding new API endpoints or modifying the external API contract
- Changing the Thompson sampling algorithm
- Modifying rate-limit penalty decay logic
- Adding new platforms or models
- Changing the sticky session TTL

## Dependencies

- Existing LongCat smart auto preference logic in [`server/src/services/router.ts`](../server/src/services/router.ts)
- Existing LongCat sticky cooldown logic in [`server/src/routes/proxy.ts`](../server/src/routes/proxy.ts)
- Existing provider-level ban logic in [`server/src/routes/proxy.ts`](../server/src/routes/proxy.ts)
- Owl Alpha model seeded in [`server/src/db/index.ts`](../server/src/db/index.ts) via `migrateModelsV15`
- LongCat model seeded in [`server/src/db/index.ts`](../server/src/db/index.ts) via `migrateModelsV16`
