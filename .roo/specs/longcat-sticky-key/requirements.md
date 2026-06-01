# Requirements: LongCat Sticky Key Sessions

## Overview

Extend the existing sticky sessions feature to support **sticky keys** for the LongCat provider. Currently, sticky sessions only pin the **model** (which model DB ID to use). For LongCat specifically, the system should also prefer using the **same API key** within a session, because LongCat benefits from session continuity at the key level (same key = same session context on their server side).

## Context

The existing sticky sessions feature lives entirely in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:13-74):
- **In-memory Map** (`stickySessionMap`) stores `{ modelDbId, lastUsed }` keyed by SHA-1 hash of `routingMode + firstUserMessage`
- **30-min TTL** with 500-entry max and eviction
- **`getStickyModel()`** — looks up the model DB ID for a session
- **`setStickyModel()`** — stores after every successful response
- **`clearStickyModel()`** — removes on non-retryable errors

The router ([`server/src/services/router.ts`](server/src/services/router.ts:457-564)) uses `preferredModelDbId` to force a model to the front of the chain, but key selection happens independently via round-robin within the selected model's available keys.

## Functional Requirements

### FR-1: Sticky Session Map Extension
The `stickySessionMap` value type must be extended to also store the `keyId` that was successfully used, in addition to `modelDbId` and `lastUsed`. The key ID is available in the `RouteResult` returned by `routeRequest()`.

### FR-2: Store Key ID on Success
`setStickyModel()` must be updated to also store the `keyId` from the successful route result. The function signature must accept the key ID as an additional parameter.

### FR-3: Retrieve Sticky Key
A new function `getStickyKey()` must be added that returns the stored `keyId` for a session (or `undefined` if no sticky session exists or the session has expired). This follows the same pattern as `getStickyModel()`.

### FR-4: Clear Sticky Key on Error
`clearStickyModel()` must also clear the stored key ID when a non-retryable error occurs. No separate clear function is needed — the existing `clearStickyModel()` already removes the entire map entry.

### FR-5: Router Accepts Preferred Key ID
The `routeRequest()` function in [`server/src/services/router.ts`](server/src/services/router.ts:457-564) must accept an optional `preferredKeyId` parameter. When set, and the selected model has a key matching that ID available (not on cooldown, not rate-limited, within limits), that key should be used instead of the normal round-robin selection.

### FR-6: Provider-Specific Activation
Sticky key behavior must only apply to the **LongCat** provider. This can be achieved by:
- Passing the `preferredKeyId` to `routeRequest()` only when the sticky session's stored model maps to the LongCat platform
- The proxy layer (not the router) is responsible for determining whether to pass a preferred key ID, keeping the router provider-agnostic

### FR-7: Key Failure Handling
If the sticky key becomes invalid (auth error, key disabled, etc.), the system must:
1. Clear the sticky session entry (both model and key) — existing `clearStickyModel()` behavior
2. Fall back to normal routing for subsequent requests in that session
3. Establish a new sticky session with whatever key/model succeeds on retry

### FR-8: Key Rotation Safety
If a key is rotated (new key added, old key disabled/deleted), the sticky key ID will no longer be found in the available keys list. The router must gracefully skip the preferred key and fall back to round-robin when the preferred key ID is not available.

### FR-9: Existing Behavior Preserved
All existing sticky session behavior for non-LongCat providers must remain unchanged. Non-LongCat providers must not be affected by this feature.

## Non-Functional Requirements

### NFR-1: No Database Schema Changes
The sticky session map is purely in-memory. No database schema changes are required.

### NFR-2: No UI Changes
This is a backend-only feature. No client-side changes are needed.

### NFR-3: Backward Compatibility
Existing sessions without a key ID in the map (from before this feature or for non-LongCat providers) must continue to work. The `keyId` field in the map value must be optional.

### NFR-4: Thread Safety
The existing `stickySessionMap` is a plain `Map` with no locking (single-threaded Node.js). The extended map follows the same pattern — no additional concurrency concerns.

### NFR-5: Minimal Performance Impact
The sticky key lookup adds one optional parameter check in the router's key selection loop. No additional I/O or computation beyond what already exists.

## Files Requiring Modification

| # | File | Change Type | Description |
|---|---|---|---|
| 1 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:16) | Edit | Extend `stickySessionMap` value type to include optional `keyId` |
| 2 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:34-52) | Edit | Add `getStickyKey()` function |
| 3 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:62-74) | Edit | Update `setStickyModel()` to accept and store `keyId` |
| 4 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1007-1016) | Edit | Pass `preferredKeyId` to `routeRequest()` for LongCat |
| 5 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1127) | Edit | Pass `keyId` to `setStickyModel()` on success |
| 6 | [`server/src/services/router.ts`](server/src/services/router.ts:457) | Edit | Add `preferredKeyId` parameter to `routeRequest()` |
| 7 | [`server/src/services/router.ts`](server/src/services/router.ts:528-540) | Edit | Prefer the `preferredKeyId` in key selection loop when available |

## Out of Scope

- Sticky keys for providers other than LongCat (though the architecture should make it easy to extend later)
- Persistent sticky sessions across server restarts (in-memory only, same as existing sticky sessions)
- Client-side UI changes
- Configuration UI for enabling/disabling sticky keys per provider (hardcoded to LongCat only)
- Changes to the Thompson Sampling algorithm
- Changes to rate limiting logic
