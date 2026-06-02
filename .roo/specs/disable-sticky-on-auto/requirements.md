# Requirements: Disable Sticky Threads on Auto Endpoint

## Summary

Disable the sticky session/thread feature on the `freellmapi/auto` (balanced routing) endpoint, keeping it active only on the `freellmapi/auto-smart` (smart routing) endpoint.

## Background

The sticky session system in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts) pins a conversation to the same model and API key across multiple turns. This prevents mid-conversation model switching, which can cause hallucinations or inconsistent tone.

Currently, sticky sessions operate for **both** routing modes:
- `'balanced'` — used by `freellmapi/auto`
- `'smart'` — used by `freellmapi/auto-smart`

The balanced/auto endpoint uses Thompson Sampling with speed-weighted scoring, intentionally exploring different models to find the best throughput. Sticky sessions contradict this design — they prevent exploration by pinning to whatever model happened to serve the first turn.

The smart/auto-smart endpoint prioritizes intelligence and consistency, where sticky sessions are desirable to maintain coherent conversations.

## Requirements

### R1: No sticky model pinning on balanced/auto endpoint
When `routingMode === 'balanced'`, the system must **not** read or write sticky model preferences. Calls to [`getStickyModel()`](server/src/routes/proxy.ts:35) and [`setStickyModel()`](server/src/routes/proxy.ts:199) must be skipped for balanced mode.

### R2: No sticky key pinning on balanced/auto endpoint
When `routingMode === 'balanced'`, the system must **not** read or write sticky API key preferences. Calls to [`getStickyKey()`](server/src/routes/proxy.ts:55) must be skipped for balanced mode.

### R3: No session-level platform bans on balanced/auto endpoint
When `routingMode === 'balanced'`, the system must **not** track or check session-level platform bans. Calls to [`isSessionBannedFromPlatform()`](server/src/routes/proxy.ts:92), [`banPlatformFromSession()`](server/src/routes/proxy.ts:108), and related `skipModels` logic from session bans must be skipped for balanced mode.

### R4: Sticky sessions remain fully active on smart/auto-smart endpoint
All sticky session functionality (model pinning, key pinning, platform bans) must continue working unchanged when `routingMode === 'smart'`.

### R5: Per-request retry skip logic remains for both modes
The `skipModels` and `skipKeys` sets used within a single request's retry loop must continue working for both modes. These are intra-request fallback mechanisms, not cross-request sticky state.

### R6: Existing tests must pass
All existing tests in [`provider-session-ban.test.ts`](server/src/__tests__/routes/provider-session-ban.test.ts) and [`full-flow.test.ts`](server/src/__tests__/integration/full-flow.test.ts) must continue passing. New test cases should verify that balanced mode skips sticky operations.

## Out of Scope

- Changing the routing algorithm for either mode
- Removing the sticky session infrastructure (functions, maps) — they remain available for smart mode
- Modifying the `/v1/models` endpoint or model ID constants
- Changing how `getSessionKey()` hashes messages