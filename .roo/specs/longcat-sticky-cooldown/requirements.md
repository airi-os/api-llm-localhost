# Requirements: LongCat Sticky Session Cooldown Safeguard

## Overview

Add a **cooldown safeguard** for the LongCat provider's sticky sessions: when a sticky session is pinned to a LongCat model AND the session was used within the last 3 minutes, **exclude LongCat entirely from the bandit router** for all other sessions. The current sticky session stays pinned to its LongCat model+key — only that session may use LongCat. All other sessions (both `auto` and `auto-smart`) must route to non-LongCat providers during the cooldown window.

## Context

The existing sticky sessions feature lives in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:13-16):

- **In-memory Map** (`stickySessionMap`) stores `{ modelDbId, keyId?, bannedPlatforms?, consecutiveFailures?, lastUsed }` keyed by SHA-1 hash of `routingMode + firstUserMessage`
- **30-min TTL** with 500-entry max and eviction
- **`getStickyModel()`** — looks up the pinned model DB ID for a session
- **`getStickyKey()`** — looks up the pinned key ID for a session (LongCat-specific)
- **`setStickyModel()`** — stores model/key after every successful response, updates `lastUsed`

The proxy handler in [`handleChatCompletion()`](server/src/routes/proxy.ts:1098) determines `preferredModel` and `preferredKeyId` from sticky session lookups, then passes them to [`routeRequest()`](server/src/services/router.ts:458). The router forces the preferred model to position 0 regardless of bandit score.

**The problem**: LongCat does not like multiple sessions or multiple API keys from the same IP. When the bandit router freely picks LongCat for other sessions (or the smart-mode boost moves LongCat to the front), it can route multiple sessions to LongCat simultaneously, triggering IP-level throttling on LongCat's side.

**The solution**: When a LongCat sticky session is "hot" (used within 3 minutes), add all LongCat models to `skipModels` so the bandit router cannot route any other session to LongCat. The current sticky session keeps its pinned LongCat route. After the 3-minute cooldown expires, LongCat becomes available to the bandit router again.

## Functional Requirements

### FR-1: Cooldown Detection

When determining `preferredModel` and `preferredKeyId` in [`handleChatCompletion()`](server/src/routes/proxy.ts:1098), the system must check whether the sticky session's pinned model is on the **LongCat** platform AND whether `lastUsed` is within the last **3 minutes** (180,000 ms). Both conditions must be true for the cooldown to activate.

### FR-2: Cooldown Behavior — Exclude LongCat from Bandit Router

When the cooldown is active (FR-1 conditions met), the system must:
1. **Keep** `preferredModel` and `preferredKeyId` intact — the current sticky session stays pinned to its LongCat model+key
2. **Add all LongCat models to `skipModels`** — this prevents the bandit router from routing any other session to LongCat
3. Log the cooldown activation: `[Sticky] LongCat cooldown active — excluding LongCat from bandit routing for other sessions | session=<key> | lastUsed=<age]ms ago`

### FR-3: Cooldown Expiry

After the 3-minute window elapses (i.e., `Date.now() - entry.lastUsed > 180,000`), LongCat is automatically available to the bandit router again because the cooldown check no longer triggers. No explicit "cooldown clear" action is needed.

### FR-4: Sticky Session Preserves LongCat Access

The current sticky session's `preferredModel` and `preferredKeyId` are never cleared by the cooldown. The sticky session always routes to its pinned LongCat model+key regardless of cooldown state. The cooldown only affects the bandit router's ability to route *other* sessions to LongCat.

### FR-5: Successful Response Updates lastUsed

When a request succeeds, [`setStickyModel()`](server/src/routes/proxy.ts:253) updates `lastUsed` to `Date.now()`. This resets the 3-minute cooldown window. No additional code is needed — existing behavior handles this.

### FR-6: Provider-Specific — LongCat Only

This cooldown safeguard applies **only** to the LongCat provider. Sticky sessions pinned to other providers do not trigger any cooldown exclusion.

### FR-7: Interaction with Existing Bans

If the session already has LongCat banned via `bannedPlatforms`, the existing ban logic already adds LongCat models to `skipModels`. The cooldown check must not duplicate or interfere with ban logic. If LongCat is already in `skipModels` (from a ban), the cooldown check should still log but not re-add.

### FR-8: Interaction with Smart Mode LongCat Boost

In smart routing mode, [`routeRequest()`](server/src/services/router.ts:499-527) moves LongCat entries to the front of the sorted list. When LongCat models are in `skipModels`, they are skipped in the routing loop (line 539: `if (skipModels?.has(entry.model_db_id)) continue;`), so the smart-mode boost is effectively neutralized for the cooldown duration. No changes to the router are needed — `skipModels` already handles this.

### FR-9: Applies to Both Routing Modes

The cooldown exclusion applies to both `auto` (balanced) and `auto-smart` routing modes. Any request that goes through the bandit router (i.e., no explicit `model` field) is subject to the LongCat exclusion during cooldown.

## Non-Functional Requirements

### NFR-1: No Database Schema Changes

The cooldown is purely time-based, using the existing `lastUsed` field in `stickySessionMap`. No database schema changes are required.

### NFR-2: No New State or Data Structures

No new Map, Set, or other data structure is needed. The cooldown check reads `lastUsed` from the existing `stickySessionMap` entry and adds to the existing `skipModels` Set.

### NFR-3: Router Changes Required

The router's `skipModels` check in `routeRequest()` was modified to allow a sticky session's preferred model to bypass the skip. The check at line 539 now reads:

```typescript
if (skipModels?.has(entry.model_db_id) && entry.model_db_id !== preferredModelDbId) continue;
```

This ensures the sticky session's LongCat model is never skipped even when LongCat is in `skipModels`, while other sessions correctly skip LongCat models during cooldown.

### NFR-4: No UI Changes

This is a backend-only feature. No client-side changes are needed.

### NFR-5: Configurable Cooldown Window

The 3-minute cooldown window must be defined as a named constant (`LONGCAT_STICKY_COOLDOWN_MS = 3 * 60 * 1000`) at the top of [`proxy.ts`](server/src/routes/proxy.ts:1) alongside existing constants like `STICKY_TTL_MS`.

### NFR-6: Backward Compatibility

Existing sessions on non-LongCat providers are unaffected. Sessions without a sticky entry don't trigger the cooldown.

## Files Requiring Modification

| # | File | Change Type | Description |
|---|---|---|---|
| 1 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:17) | Edit | Add `LONGCAT_STICKY_COOLDOWN_MS` constant |
| 2 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1243) | Edit | Replace existing cooldown logic: instead of clearing `preferredModel`/`preferredKeyId`, add LongCat models to `skipModels` |
| 3 | [`server/src/__tests__/routes/proxy-tools.test.ts`](server/src/__tests__/routes/proxy-tools.test.ts) | Edit | Update unit tests to match new behavior |

## Out of Scope

- Cooldown safeguards for providers other than LongCat
- Persistent cooldown state across server restarts (in-memory only)
- Client-side UI changes or configuration
- Changes to the Thompson Sampling algorithm or bandit scoring
- Changes to rate limiting logic
- Changes to the router's LongCat smart-mode boost logic (skipModels handles it)
- Making the cooldown window configurable via admin API or environment variable (constant only)