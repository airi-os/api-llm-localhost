# Requirements: Provider 5xx Session Ban

## Overview

This spec generalizes **two** existing LongCat mechanisms to work for all providers:

1. **5xx consecutive failure ban** (new, general): When a sticky session receives **2 consecutive 5xx errors (500, 502, 503, 504)** from the same provider, ban that provider for the session. The session falls back to the next best model via normal routing. The ban lasts for the session TTL (30 minutes).
2. **Truncation detection ban** (existing, now generalized): When a truncated response is detected from **any** provider (not just LongCat), ban that provider for the session using the same `banPlatformFromSession()` mechanism. A truncated response can come back as a 200 with incomplete content — this is independent of 5xx errors.

These are **two independent triggers** that both use the same underlying `bannedPlatforms` infrastructure. A provider can be banned either for 2 consecutive 5xx errors OR for a truncated response. Both mechanisms work for ALL providers.

The LongCat-specific auth error and rate limit ban logic is removed and replaced by the general 5xx consecutive failure mechanism.

## Context

The existing sticky sessions feature lives in [`server/src/routes/proxy.ts`](../server/src/routes/proxy.ts:16). It uses an SHA-1 hash of `routingMode + firstUserMessage` to identify sessions, and stores `{ modelDbId, keyId?, bannedPlatforms?, lastUsed }` with a 30-min TTL and 500-entry max.

The existing LongCat session ban ([`longcat-session-ban` spec](../longcat-session-ban/)) added `bannedPlatforms`, `banPlatformFromSession()`, `isSessionBannedFromPlatform()`, `addLongcatModelsToSkipModels()`, and `isTruncatedResponse()`. This spec generalizes that infrastructure: the `bannedPlatforms` set and ban helper functions are reused, the `isTruncatedResponse()` function is retained and generalized to all providers, and the LongCat-specific auth/rate-limit error detection is replaced by general 5xx consecutive failure tracking.

The retry loop in `handleChatCompletion()` currently has LongCat-specific error handling at lines 1383-1402 that bans LongCat on auth errors and rate-limit errors. This is replaced by general 5xx consecutive failure detection that works for any provider. The truncation detection is retained but generalized from LongCat-only to all providers.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Detect 5xx errors (500, 502, 503, 504) from any provider during the retry loop. Detection uses the existing `getErrorStatus()` helper to check the HTTP status code. | Must |
| FR-2 | Track consecutive 5xx failures per provider within a sticky session. The counter is stored in a new `consecutiveFailures: Map<string, number>` field in the sticky session entry, keyed by provider name. The counter resets on success or when a different provider is used. | Must |
| FR-3 | Ban the provider after **2 consecutive** 5xx failures within the same session. The ban is recorded by adding the provider to the existing `bannedPlatforms` set. | Must |
| FR-4 | On ban, add all models of that provider to `skipModels` for the current retry loop. This uses a new generic `addProviderModelsToSkipModels()` function that queries the DB for all enabled models of the given provider. | Must |
| FR-5 | On ban, clear `preferredModel` and `preferredKeyId` if they point to the banned provider, so the router picks the next best model via normal routing. | Must |
| FR-6 | Ban persists for the session TTL (30 minutes, same as `STICKY_TTL_MS`). No separate TTL — the existing sticky session expiry clears everything including bans and consecutive failure counters. | Must |
| FR-7 | Ban is stored in the existing `bannedPlatforms` Set in `stickySessionMap` (reuses existing infrastructure). The `banPlatformFromSession()` and `isSessionBannedFromPlatform()` functions are reused as-is. | Must |
| FR-8 | Mid-stream 5xx errors also count toward the consecutive failure counter. When a mid-stream error has a 5xx status, it increments the counter and triggers a ban if the threshold is reached. The stream is still ended gracefully (existing behavior). | Must |
| FR-9 | The consecutive counter resets when a different provider succeeds. When a successful response comes from provider B, the consecutive failure counter for provider A is reset to 0. | Must |
| FR-10 | The consecutive counter resets when the same provider succeeds. When a successful response comes from provider A, all consecutive failure counters for that provider are reset to 0. | Must |
| FR-11 | Remove the LongCat-specific **auth error** ban logic (lines 1384-1389) and **rate-limit error** ban logic (lines 1390-1395). The general 5xx consecutive failure mechanism supersedes these. Truncation detection is NOT removed — it is generalized to all providers (see FR-14, FR-15). | Must |
| FR-12 | Logging — log when a provider is banned with the failure count and session key. Log when consecutive failure counter is incremented. Log when counter is reset on success. Log when a provider is banned due to truncation. | Should |
| FR-13 | The ban check in pre-routing (lines 1141-1152) should check for any banned platform, not just LongCat. The existing `isSessionBannedFromPlatform()` call currently hardcodes `'longcat'` — it should check the platform of the `preferredModel` dynamically. | Must |
| FR-14 | Truncation detection applies to **ALL** providers, not just LongCat. When a truncated response is detected from any provider (after stream completes or mid-stream), ban that provider for the session using the same `banPlatformFromSession()` mechanism. The post-stream truncation check (lines 1236-1242) and mid-stream truncation handling (lines 1297-1318) are generalized from `route.platform === 'longcat'` to any platform. | Must |
| FR-15 | The `isTruncatedResponse()` function is retained and generalized — it checks response content/error messages from any provider for truncation patterns. It is NOT removed. | Must |

## Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | No changes to the router (`router.ts`). The existing `skipModels` mechanism handles routing around banned providers. |
| NFR-2 | No changes to the database schema. All state is in-memory in `stickySessionMap`. |
| NFR-3 | Backward compatible: existing sticky session entries without `consecutiveFailures` field default to no tracked failures. |
| NFR-4 | Non-sticky sessions are unaffected. The consecutive failure tracking only applies when a sticky session exists. |

## Out of Scope

- Persistent bans across server restarts (in-memory only, same as existing sticky sessions)
- Configurable threshold for 5xx ban (hardcoded to 2 consecutive failures)
- Configurable threshold for truncation ban (any single truncation triggers ban)
- Bans for non-5xx errors (4xx client errors do not trigger bans)
- Changes to the Thompson Sampling algorithm
- Changes to rate limiting logic
- Client-side UI changes
- Configuration UI for enabling/disabling bans per provider
