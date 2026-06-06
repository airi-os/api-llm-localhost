# Abort Signal Propagation - Requirements

## Feature Name
**abort-signal-propagation** - Immediate Stream Abort on Client Disconnect & Stall Detection

## Problem Statement

The current implementation suffers from **zombie requests** that can hang for hours due to:

1. **Stalled body reads**: When network stalls occur during stream body consumption, the `reader.read()` promise never resolves or rejects, leaving the underlying HTTP connection open indefinitely.

2. **Client disconnects without cleanup**: When a client disconnects mid-stream, the server continues processing the upstream request, wasting resources and causing memory leaks.

3. **Resource exhaustion**: Prolonged zombie requests can exhaust server resources (file descriptors, memory, connection pools), leading to cascading failures.

## Goals

### Primary Goals

1. **Immediate stream abort on client disconnect**
   - When a client closes the connection, the underlying HTTP stream must be aborted within milliseconds
   - No orphaned upstream requests should continue after client disconnect

2. **Immediate stream abort on stall detection**
   - When the keepalive timer detects a stream stall (no data within `MAX_STREAM_STALL_MS`), the upstream request must be aborted
   - The abort must propagate through the entire call stack to the network layer

3. **Clean resource cleanup**
   - All resources (timers, generators, request slots) must be released on any termination path
   - The `activeRequests` Set must be properly cleaned up to prevent slot leaks

### Non-Goals

- This is NOT about adding new retry logic
- This is NOT about changing routing behavior
- This is NOT about adding new error types

## Technical Requirements

### REQ-1: AbortSignal Support in CompletionOptions

The `CompletionOptions` interface in `server/src/providers/base.ts` MUST include an optional `signal` property of type `AbortSignal`:

```typescript
export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  signal?: AbortSignal; // NEW: parent abort signal
}
```

### REQ-2: fetchWithTimeout Signal Combination

The `fetchWithTimeout` method in `server/src/providers/base.ts` MUST combine the local handshake timeout signal with any passed-in parent abort signal using `AbortSignal.any()`:

```typescript
protected static async fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Combine parent signal with local handshake timeout signal
  const signals: AbortSignal[] = [controller.signal];
  if (init.signal) {
    signals.push(init.signal);
  }
  const combinedSignal = AbortSignal.any(signals);

  try {
    return await fetch(url, { ...init, signal: combinedSignal });
  } finally {
    clearTimeout(timeout);
  }
}
```

**Rationale**: `AbortSignal.any()` is available natively in Node.js v22.22.3. When either signal aborts, the combined signal aborts, ensuring that:
- The handshake timeout still works independently
- The parent signal can abort the request at any time (including during body streaming)

### REQ-3: Provider Signal Forwarding

All provider implementations MUST forward the `signal` option from `CompletionOptions` to `fetchWithTimeout`:

- `OpenAICompatProvider` (`server/src/providers/openai-compat.ts`)
- `GoogleProvider` (`server/src/providers/google.ts`)
- `CohereProvider` (`server/src/providers/cohere.ts`)
- `CloudflareProvider` (`server/src/providers/cloudflare.ts`)

Each provider's `chatCompletion` and `streamChatCompletion` methods MUST pass `signal: options?.signal` to `fetchWithTimeout`.

### REQ-4: AbortController in proxy.ts

The `handleChatCompletion` function in `server/src/routes/proxy.ts` MUST:

1. Create an `AbortController` before calling `streamChatCompletion`
2. Pass the controller's signal in `CompletionOptions`
3. Call `controller.abort()` when:
   - The keepalive timer detects a stall
   - The client disconnects (via the `close` event or cleanup)

```typescript
const requestAbortController = new AbortController();

const gen = route.provider.streamChatCompletion(
  route.apiKey, normalizedMessages, route.modelId,
  { 
    temperature, 
    max_tokens, 
    top_p, 
    tools, 
    tool_choice, 
    parallel_tool_calls, 
    signal: requestAbortController.signal // Pass signal to generator
  },
);
```

### REQ-5: Stall Detection Abort

When the keepalive timer detects a stall (`elapsed >= MAX_STREAM_STALL_MS`), the implementation MUST:

1. Set `stalled = true`
2. Call `requestAbortController.abort()` to abort the underlying fetch
3. Call `cleanup()` to clear the timer and attempt generator cleanup
4. Send an appropriate error response to the client if stream started

### REQ-6: Client Disconnect Handling

The cleanup function MUST be called on client disconnect:

```typescript
const cleanup = () => {
  clearInterval(keepaliveTimer);
  requestAbortController.abort(); // Abort underlying fetch
  try { gen.return(); } catch { /* already closed */ }
};

res.on('close', cleanup);
```

### REQ-7: Active Request Cleanup

The `activeRequests` Set MUST be cleaned up in all termination paths:

- Normal completion
- Stream stall
- Client disconnect
- Any error

This ensures the Active-Request Safeguard slot is always released.

## Verification Requirements

### VER-1: Unit Tests

Existing server tests MUST pass without regression:
```bash
pnpm --filter server test
```

### VER-2: Integration Test (Future)

A dedicated integration test SHOULD be created to verify stream cleanup under artificial latency:
```bash
pnpm --filter server vitest run src/__tests__/routes/stream-heartbeat-stall.test.ts
```

## Acceptance Criteria

| ID | Criterion | Verification Method |
|----|-----------|---------------------|
| AC-1 | `CompletionOptions` includes `signal?: AbortSignal` | TypeScript compilation |
| AC-2 | `fetchWithTimeout` combines signals using `AbortSignal.any()` | Code review |
| AC-3 | All providers forward `signal` to `fetchWithTimeout` | Code review |
| AC-4 | `proxy.ts` creates `AbortController` for stream requests | Code review |
| AC-5 | Stall detection calls `requestAbortController.abort()` | Code review |
| AC-6 | Client disconnect triggers abort via cleanup | Code review |
| AC-7 | `activeRequests` is cleaned up on all termination paths | Code review |
| AC-8 | All existing tests pass | `pnpm --filter server test` |

## Dependencies

- Node.js v22.22.3+ (for native `AbortSignal.any()` support)
- No new external dependencies required

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `AbortSignal.any()` not available in older Node versions | Project is pinned to v22.22.3 |
| Generator cleanup race conditions | `gen.return()` is called in try/catch to handle already-closed generators |
| Signal already aborted | `AbortController.abort()` is idempotent - calling multiple times is safe |