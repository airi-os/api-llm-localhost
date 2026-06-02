# Requirements: Provider 5xx Session Ban

## Overview

This spec implements **differentiated ban behavior** for LongCat vs non-LongCat providers:

1. **LongCat 5xx/truncation ban**: When a sticky session receives a 5xx error or truncated response from LongCat, immediately ban the entire `longcat` platform for the session. The session falls back to the next best model via normal routing. The ban lasts for the session TTL (30 minutes).

2. **Non-LongCat 5xx/model skip**: When a sticky session receives a 5xx error from a non-LongCat provider, skip only the failed model (via `skipModels.add(route.modelDbId)`). No provider-wide ban is recorded. The session continues with other models from the same provider if available.

3. **Truncation detection**: When a truncated response is detected from any provider, ban that provider for the session using `banPlatformFromSession()`. For LongCat, this also adds LongCat models to `skipModels`. For non-LongCat, only the specific model is affected.

**Key distinction**: LongCat uses `banPlatformFromSession()` for immediate platform-wide exclusion, while non-LongCat errors only add the specific failed model to `skipModels`. The `recordConsecutiveFailure()` and `consecutiveFailures` counter have been removed (they were dead code).

## Context

The existing sticky sessions feature lives in [`server/src/routes/proxy.ts`](../server/src/routes/proxy.ts:16). It uses an SHA-1 hash of `routingMode + firstUserMessage` to identify sessions, and stores `{ modelDbId, keyId?, bannedPlatforms?, lastUsed }` with a 30-min TTL and 500-entry max.

The existing LongCat session ban ([`longcat-session-ban` spec](../longcat-session-ban/)) added `bannedPlatforms`, `banPlatformFromSession()`, `isSessionBannedFromPlatform()`, `addLongcatModelsToSkipModels()`, and `isTruncatedResponse()`. This spec implements the final behavior: LongCat uses immediate platform bans via `banPlatformFromSession()`, while non-LongCat 5xx errors only skip the specific failed model.

The retry loop in `handleChatCompletion()` now handles LongCat and non-LongCat errors differently:
- LongCat 5xx/truncation: calls `banPlatformFromSession()` and `addProviderModelsToSkipModels()` for immediate platform exclusion
- Non-LongCat 5xx: only adds the specific model to `skipModels` (no platform ban)

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Detect 5xx errors (500, 502, 503, 504) from any provider during the retry loop. Detection uses the existing `getErrorStatus()` helper to check the HTTP status code. | Must |
| FR-2 | For **LongCat** 5xx errors: immediately ban the `longcat` platform for the session via `banPlatformFromSession()`. Add all LongCat models to `skipModels`. Clear `preferredModel` and `preferredKeyId`. | Must |
| FR-3 | For **non-LongCat** 5xx errors: add only the failed model to `skipModels` (via `skipModels.add(route.modelDbId)`). Do NOT ban the provider — other models from the same provider remain available. | Must |
| FR-4 | For **truncation detection**: when `isTruncatedResponse()` detects truncation from any provider, call `banPlatformFromSession()` for that provider. For LongCat, also add LongCat models to `skipModels`. | Must |
| FR-5 | On ban, clear `preferredModel` and `preferredKeyId` if they point to the banned provider, so the router picks the next best model via normal routing. | Must |
| FR-6 | Ban persists for the session TTL (30 minutes, same as `STICKY_TTL_MS`). No separate TTL — the existing sticky session expiry clears everything including bans. | Must |
| FR-7 | Ban is stored in the existing `bannedPlatforms` Set in `stickySessionMap`. The `banPlatformFromSession()` and `isSessionBannedFromPlatform()` functions are reused. | Must |
| FR-8 | The `isTruncatedResponse()` function is retained and generalized — it checks response content/error messages from any provider for truncation patterns. | Must |
| FR-9 | The ban check in pre-routing (lines 1141-1152) should check for any banned platform, not just LongCat. The existing `isSessionBannedFromPlatform()` call should check the platform of the `preferredModel` dynamically. | Must |
| FR-10 | Logging — log when a provider is banned, when LongCat is banned vs non-LongCat model skip, and when truncation is detected. | Should |

## Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | No changes to the router (`router.ts`). The existing `skipModels` mechanism handles routing around banned providers. |
| NFR-2 | No changes to the database schema. All state is in-memory in `stickySessionMap`. |
| NFR-3 | Backward compatible: existing sticky session entries without `bannedPlatforms` field default to no bans. |
| NFR-4 | Non-sticky sessions are unaffected. The ban logic only applies when a sticky session exists. |

## Out of Scope

- Persistent bans across server restarts (in-memory only, same as existing sticky sessions)
- Configurable threshold for 5xx ban (hardcoded to immediate ban for LongCat, model skip for non-LongCat)
- Configurable threshold for truncation ban (any single truncation triggers ban)
- Bans for non-5xx errors (4xx client errors do not trigger bans)
- Changes to the Thompson Sampling algorithm
- Changes to rate limiting logic
- Client-side UI changes
- Configuration UI for enabling/disabling bans per provider