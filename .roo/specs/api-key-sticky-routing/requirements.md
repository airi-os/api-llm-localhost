# API Key Sticky Routing

## Overview

This document defines the requirements for replacing the session-key-based IP allocation model with an API-key-based sticky routing model. The change shifts the allocation unit from `sessionKey` (message hash) to the authenticated API key identity, ensuring that each active API key exclusively owns one proxy worker/IP at a time.

## Background

The current `ipPoolCapacity.ts` allocates proxy IPs based on `sessionKey` (a hash of the first user message). This means:

- Multiple concurrent requests from the same API key with different messages get different IPs
- The same message from different API keys could hash to the same session and share an IP
- No enforcement of "one active request per key"

The new model allocates by API key identity, enforcing a strict 1:1 relationship between active API keys and proxy workers.

## Q&A Answers (Source of Truth)

The following answers were provided during the design discussion and form the basis for all requirements:

- **Q1 (Can one API key use all available IPs?)**: NO — one key = one IP, sticky lock
- **Q2 (Per-key concurrency limit)**: FIXED at 1 — one key at a time
- **Q3 (When pool exhausted)**: Whichever response code leads to temporarily excluding the model from the pool
- **Q4 (Can two requests from same key share same IP?)**: NO — strict no
- **Q5 (Capacity = workerCount?)**: YES — workercount. Can scale to 100 workers from one account.

## REQ-KS1: Key-Worker Binding Invariant

An API key may have at most **one active request** at any time.

When a request arrives for an API key that already has an active request in progress, the new request must be **rejected** with an appropriate error response.

The binding between API key and worker is **sticky** — once a worker is assigned to a key, that key exclusively owns it until the request completes or fails.

## REQ-KS2: Worker-to-Key Mutual Exclusion

A proxy worker/IP may be assigned to **at most one API key** at a time.

When a worker is assigned to a key, it is unavailable for other keys until released.

## REQ-KS3: Capacity Equals Worker Count

Maximum concurrent active requests equals the topology `workerCount`.

With 3 workers deployed: maximum 3 concurrent active API keys.
With 10 workers deployed: maximum 10 concurrent active API keys.
With 100 workers deployed: maximum 100 concurrent active API keys.

No configuration needed — capacity is derived from topology discovery.

## REQ-KS4: Immediate Release on Completion

Worker assignments must be released immediately when request execution completes or fails.

There is no TTL-based expiration for active assignments — the release is event-driven.

### REQ-KS4.1: Guaranteed Cleanup

Worker release must occur in a `finally` block or equivalent guaranteed cleanup mechanism to prevent worker leaks when exceptions occur.

The critical failure mode to prevent:

```
allocate worker
↓
upstream throws
↓
release never executes
↓
worker leaked forever
```

## REQ-KS5: Reject on Capacity Exhaustion

When all workers are occupied and a new request arrives for an unassigned key, the request must be rejected.

The rejection response must be:

```
HTTP 503 Service Unavailable
Retry-After: 5
Content-Type: application/json

{
  "error": {
    "message": "No proxy workers available. All slots are occupied.",
    "type": "capacity_exhausted"
  }
}
```

The `Retry-After` value is fixed at 5 seconds. This is a conservative estimate that accounts for typical request completion times.

## REQ-KS6: Reject on Key Already Active

When a request arrives for an API key that already has an active worker assignment, the request must be rejected.

This is distinct from capacity exhaustion (REQ-KS5). This is the "key already busy" case.

The rejection response must be:

```
HTTP 409 Conflict
Content-Type: application/json

{
  "error": {
    "message": "An active request already exists for this API key.",
    "type": "key_busy"
  }
}
```

## REQ-KS7: Topology-Driven Capacity

The system must use `getWorkerCount()` from `proxyTopology.ts` as the capacity source.

Capacity behavior depends on topology availability:

| Situation | Behavior |
|-----------|----------|
| Topology available, workerCount > 0 | Enabled, capacity = workerCount |
| Topology available, workerCount = 0 | Enabled, zero capacity, 503 on any request |
| Topology unavailable, PROXY_IP_COUNT set | Enabled, capacity = PROXY_IP_COUNT |
| Topology unavailable, PROXY_IP_COUNT = 0 | Enabled, zero capacity, 503 on any request |
| Topology unavailable, PROXY_IP_COUNT unset | Disabled mode (see REQ-KS9) |

## REQ-KS8: No Concurrent Requests for Same Key

Two simultaneous requests using the same API key must never acquire separate workers concurrently.

This is the core invariant: the allocation unit is the API key, not the session.

## REQ-KS9: Disabled Mode

When both topology is unavailable AND `PROXY_IP_COUNT` is unset, sticky routing is disabled.

In disabled mode:
- Key-worker locking is disabled
- Requests follow existing routing behavior (no sticky routing)
- No worker ownership enforcement
- No capacity limits applied
- All allocation requests return bypass (proceed without worker assignment)

This preserves the existing behavior for deployments that don't use the proxy pool.

### REQ-KS9.1: Zero-Capacity vs Disabled

Zero capacity (workerCount=0 or PROXY_IP_COUNT=0) is **not** the same as disabled mode:

| Mode | workerCount | Behavior |
|------|-------------|----------|
| Enabled, zero capacity | 0 | 503 on all requests |
| Disabled | undefined | Bypass, no capacity checks |

The distinction matters: zero capacity means "I know I have no workers, reject everything", while disabled means "I don't know about the proxy pool, don't interfere with existing behavior".

## REQ-KS10: API Migration

The old `allocateIp(sessionKey, platform, keyId)` and `releaseIp(sessionKey)` functions are removed.

All callers have been audited:
- `server/src/routes/proxy.ts` — migrated to new API
- `server/src/__tests__/services/ipPoolCapacity.test.ts` — tests replaced

The new API is:
- `allocateIpForKey(apiKey: string): AllocationResult`
- `releaseIpForKey(apiKey: string): void`
- `isKeyActive(apiKey: string): boolean`
- `isWorkerAssigned(ipIndex: number): boolean`

### REQ-KS10.1: Bidirectional Assignment Tracking

The service must maintain bidirectional assignment tracking:

```
apiKey → worker
worker → apiKey
```

This enables efficient enforcement of:
- REQ-KS1: "Is this key already active?" → `apiKeyToWorker.get(key)`
- REQ-KS2: "Is this worker available?" → `workerToApiKey.has(worker)`

Single-direction tracking would require O(n) scans to answer these questions.

## REQ-KS11: Error Response Format

All error responses must follow the format specified in REQ-KS5 and REQ-KS6.

Additional requirements:
- Always include `Content-Type: application/json`
- Always include the `type` field for programmatic error handling
- Never expose internal state in error messages

## REQ-KS12: Logging and Observability

The system must log key-worker binding events for debugging:

- When a worker is assigned to a key
- When a worker is released
- When a request is rejected due to capacity exhaustion
- When a request is rejected due to key already active

**Privacy requirement**: Logs must NOT include the full API key value. Use `SHA-256(apiKey).slice(0, 12)` for log readability. The 12-character prefix provides sufficient uniqueness for debugging while avoiding exposure of key format (e.g., `sk-live-abc...`).

## REQ-KS13: Atomic Acquisition

The worker acquisition and key binding must occur atomically.

The sequence:

```
check active key
check free worker
assign worker
```

must be protected against race conditions. Without atomicity:

```
Request A: sees worker free
Request B: sees worker free
Request A: assigns worker
Request B: assigns worker (same worker — violation)
```

Acceptable implementation approaches:
- Mutex / lock per worker
- Single-threaded map update (JavaScript's single-threaded event loop makes this safe for in-memory operations)
- Compare-and-swap pattern

The requirement is that no two concurrent requests can simultaneously acquire the same worker, and no request can acquire a worker while another request for the same key is already active.

## Out of Scope

The following are explicitly out of scope for this specification:

- **Per-key concurrency limits > 1**: The limit is fixed at 1. No configuration needed.
- **Queueing**: Requests are rejected, not queued. No queue implementation.
- **Priority queuing**: No priority levels.
- **Key-to-worker affinity persistence**: The binding is in-memory only. No persistence across server restarts.
- **Multiple workers per key**: Not supported. One key = one worker.
- **Provider-ban / model-skip logic**: This is handled by the existing `threadProtection.ts` (error handling), not this service (concurrency control).
- **Retry-After configuration**: The value is fixed at 5 seconds. No env var override.

## Traceability

| Requirement | Source |
|---|---|
| REQ-KS1 | Q1: NO, Q2: FIXED 1 |
| REQ-KS2 | Q4: strict no |
| REQ-KS3 | Q5: workercount |
| REQ-KS4 | Q&A discussion |
| REQ-KS4.1 | Crash safety (reviewer feedback) |
| REQ-KS5 | Q3: capacity exhaustion response |
| REQ-KS6 | Q1: sticky lock |
| REQ-KS7 | Existing topology integration |
| REQ-KS8 | Q4: strict no |
| REQ-KS9 | Existing backward compat |
| REQ-KS9.1 | Disabled-mode semantics (reviewer feedback) |
| REQ-KS10 | Implementation approach |
| REQ-KS10.1 | Bidirectional tracking (reviewer feedback) |
| REQ-KS11 | Q3: model exclusion behavior |
| REQ-KS12 | Operational observability |
| REQ-KS13 | Atomic acquisition (reviewer feedback) |