# Requirements: LongCat Sticky Session Cooldown Safeguard

## Overview

Add a **cooldown safeguard** for the LongCat provider's sticky sessions: when a sticky session is pinned to a LongCat model AND the session was used within the last 3 minutes, bypass the sticky model/key preference for that request only and let the bandit router pick freely. The sticky session entry itself stays intact — if the bandit router picks LongCat again organically, that's fine. After the 3-minute cooldown window expires, sticky session preference resumes normally.

## Context

The existing sticky sessions feature lives in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:13-16):

- **In-memory Map** (`stickySessionMap`) stores `{ modelDbId, keyId?, bannedPlatforms?, consecutiveFailures?, lastUsed }` keyed by SHA-1 hash of `routingMode + firstUserMessage`
- **30-min TTL** with 500-entry max and eviction
- **`getStickyModel()`** — looks up the pinned model DB ID for a session
- **`getStickyKey()`** — looks up the pinned key ID for a session (LongCat-specific)
- **`setStickyModel()`** — stores model/key after every successful response, updates `lastUsed`

The proxy handler in [`handleChatCompletion()`](server/src/routes/proxy.ts:1098) determines `preferredModel` and `preferredKeyId` from sticky session lookups, then passes them to [`routeRequest()`](server/src/services/router.ts:458). The router forces the preferred model to position 0 regardless of bandit score, and the preferred key is tried first before round-robin.

**The problem**: LongCat benefits from sticky keys for session continuity, but rapid-fire requests within a short window (e.g., a user sending multiple messages in quick succession) all get pinned to the same LongCat key. This can overwhelm LongCat's per-key rate limits or trigger throttling on their side. Giving the bandit router a chance to distribute load during high-frequency bursts improves overall reliability while preserving sticky session benefits for normal conversation pacing.

## Functional Requirements

### FR-1: Cooldown Detection

When determining `preferredModel` and `preferredKeyId` in [`handleChatCompletion()`](server/src/routes/proxy.ts:1098), the system must check whether the sticky session's pinned model is on the **LongCat** platform AND whether `lastUsed` is within the last **3 minutes** (180,000 ms). Both conditions must be true for the cooldown to activate.

### FR-2: Cooldown Behavior — Temporary Bypass

When the cooldown is active (FR-1 conditions met), the system must:
1. Set `preferredModel = undefined` for this request only — the bandit router picks freely based on scores
2. Set `preferredKeyId = undefined` for this request only — no sticky key preference
3. **NOT** modify or delete the `stickySessionMap` entry — the session remains intact
4. Log the bypass: `[Sticky] LongCat cooldown active — bypassing sticky preference for session=<key> | lastUsed=<age>ms ago`

### FR-3: Cooldown Expiry

After the 3-minute window elapses (i.e., `Date.now() - entry.lastUsed > 180,000`), sticky session preference for LongCat resumes normally. No explicit "cooldown clear" action is needed — the check is purely time-based on each request.

### FR-4: Bandit Router Freedom

When the cooldown bypasses sticky preference, the bandit router may still route to LongCat organically (if LongCat scores highest in Thompson Sampling). This is acceptable and expected — the safeguard prevents *forced* pinning, not *organic* routing.

### FR-5: Successful Response Updates lastUsed

When a request succeeds (regardless of whether it was routed via sticky preference or bandit freedom), [`setStickyModel()`](server/src/routes/proxy.ts:253) updates `lastUsed` to `Date.now()`. This means each successful response resets the 3-minute cooldown window, preventing indefinite bypass for active conversations.

### FR-6: Provider-Specific — LongCat Only

This cooldown safeguard applies **only** to the LongCat provider. Sticky sessions pinned to other providers (Groq, Cerebras, Google, etc.) must continue to use their sticky preference immediately, regardless of `lastUsed` age.

### FR-7: Interaction with Existing Bans

If the session already has LongCat banned via `bannedPlatforms`, the existing ban logic takes precedence — `preferredModel` and `preferredKeyId` are already cleared by the ban check. The cooldown safeguard is irrelevant when LongCat is already banned for the session. The cooldown check must not override or interfere with ban logic.

### FR-8: Interaction with Smart Mode LongCat Boost

In smart routing mode, [`routeRequest()`](server/src/services/router.ts:499-527) moves LongCat entries to the front of the sorted list when any LongCat key has capacity. When the cooldown bypasses sticky preference (`preferredModel = undefined`), the smart-mode LongCat boost still applies — LongCat gets priority in the bandit order but is not *forced* to position 0 via sticky pinning. This is the intended behavior: the boost gives LongCat a strong chance, but other models can still win via Thompson Sampling.

## Non-Functional Requirements

### NFR-1: No Database Schema Changes

The cooldown is purely time-based, using the existing `lastUsed` field in `stickySessionMap`. No database schema changes are required.

### NFR-2: No New State or Data Structures

No new Map, Set, or other data structure is needed. The cooldown check reads `lastUsed` from the existing `stickySessionMap` entry and compares it to `Date.now()`.

### NFR-3: No UI Changes

This is a backend-only feature. No client-side changes are needed.

### NFR-4: Minimal Performance Impact

The cooldown check adds one timestamp comparison and one platform lookup per request. No additional I/O or computation beyond what already exists.

### NFR-5: Configurable Cooldown Window

The 3-minute cooldown window must be defined as a named constant (`LONGCAT_STICKY_COOLDOWN_MS = 3 * 60 * 1000`) at the top of [`proxy.ts`](server/src/routes/proxy.ts:1) alongside existing constants like `STICKY_TTL_MS`, making it easy to adjust in the future.

### NFR-6: Backward Compatibility

Existing sessions without a `lastUsed` field (impossible in current code, but defensively) must not trigger the cooldown. The check must handle `lastUsed` being `undefined` or `0` by treating it as "no cooldown — use sticky preference."

## Files Requiring Modification

| # | File | Change Type | Description |
|---|---|---|---|
| 1 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:17) | Edit | Add `LONGCAT_STICKY_COOLDOWN_MS` constant |
| 2 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1198-1212) | Edit | Add cooldown check after sticky model/key lookup, before passing to `routeRequest()` |
| 3 | [`server/src/__tests__/routes/proxy-tools.test.ts`](server/src/__tests__/routes/proxy-tools.test.ts) | Edit | Add unit tests for cooldown logic |

## Out of Scope

- Cooldown safeguards for providers other than LongCat
- Persistent cooldown state across server restarts (in-memory only, same as existing sticky sessions)
- Client-side UI changes or configuration
- Changes to the Thompson Sampling algorithm or bandit scoring
- Changes to rate limiting logic
- Changes to the router's LongCat smart-mode boost logic
- Making the cooldown window configurable via admin API or environment variable (constant only)