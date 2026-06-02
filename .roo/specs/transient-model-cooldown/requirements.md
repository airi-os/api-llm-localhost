# Requirements: Shared Temporary Cooldowns for Concurrent Failure Mitigation

## Problem Statement

When a model fails with a transient error (HTTP `5xx` or connection timeout), the proxy currently only adds it to the local `skipModels` set for the active request's retry loop. Multiple concurrent requests arriving during an outage each independently attempt to route through the failing model before falling back. This creates unnecessary upstream traffic and degrades proxy performance during transient provider outages.

## Requirements

### R-1: Cross-Request Transient Failure State
The proxy must maintain a lightweight, shared, in-memory collection of temporarily disabled model IDs that have recently returned severe, non-auth, retryable errors (specifically HTTP `5xx` or connection timeouts). This state must be visible to all incoming requests, not just the request that encountered the failure.

### R-2: Short-Lived Global Cooldown Window
A globally cooled-down model must be skipped by all incoming requests for a brief duration (15 seconds). This window is intentionally short to allow rapid recovery if the upstream issue is transient, without waiting for the 60-second analytics stats cache refresh.

### R-3: Integration with Existing Routing Logic
The shared cooldown state must seamlessly feed into the `skipModels` set passed to `routeRequest()`, ensuring the Thompson Sampling router naturally bypasses degraded models without changing the core routing algorithm.

### R-4: Sticky Session Precedence
If a session is pinned to a model via sticky session but that model is currently on global cooldown, the global cooldown must take precedence. The `preferredModel` must be cleared so the session falls back immediately, preventing hang-ups on a degraded model.

### R-5: Auto-Recovery via Expiry
Cooldown entries must auto-expire after the configured window. Expired entries must be pruned during pre-routing checks so models become available again without manual intervention.

### R-6: All-Models-Exhausted Safety
In extreme scenarios where all configured models are on global cooldown, the existing `routeRequest()` behavior of throwing an "All models exhausted" error is acceptable. This falls back to the client as HTTP `503` or `429` — no special handling needed beyond what already exists.

## Scope

- **In scope**: Module-level `Map` in `proxy.ts`, pre-routing injection into `skipModels`, cooldown registration on `5xx`/connection failures, sticky session override when preferred model is on cooldown, expiry pruning
- **Out of scope**: Persistent cooldown storage (DB/Redis), per-provider cooldown differentiation, cooldown duration configuration via API, analytics/metrics integration

## Acceptance Criteria

1. When Request A encounters a `5xx` from Model X and activates the global cooldown, a subsequent Request B arriving within 15 seconds skips Model X entirely and routes directly to an alternative model
2. After 15 seconds, the cooldown expires and Model X is eligible for routing again without manual intervention
3. If a sticky session is pinned to a model on global cooldown, the `preferredModel` is cleared and the session falls back to free routing
4. The `routeRequest()` function receives the merged `skipModels` set (local + global cooldowns) without any changes to its signature or algorithm
5. Non-`5xx` errors (auth errors, rate limits, client errors) do not trigger global cooldowns