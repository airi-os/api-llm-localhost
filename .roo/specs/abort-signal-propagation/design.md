# Abort Signal Propagation - Design

## Feature Name
**abort-signal-propagation** - Immediate Stream Abort on Client Disconnect & Stall Detection

## Overview

This design details how `AbortSignal` propagates from the HTTP request layer through the provider interface to the underlying `fetch()` call, enabling immediate stream termination on client disconnect or stall detection.

## Architecture

### Signal Flow Diagram

```
Client Request
  |
  v
proxy.ts: handleChatCompletion()
  |
  +-- Creates: requestAbortController = new AbortController()
  |
  +-- Passes: signal: requestAbortController.signal
  |           in CompletionOptions
  |
  v
BaseProvider.fetchWithTimeout()
  |
  +-- Combines: AbortSignal.any([timeoutSignal, parentSignal])
  |
  v
fetch(url, { signal: combinedSignal })
  |
  +-- Abort triggers: reader.read() rejects with AbortError
  |                   generator terminates
  |                   cleanup() runs
  |
  v
Termination Sources:
  [1] Client disconnect --> res 'close' --> cleanup() --> requestAbortController.abort()
  [2] Stall detection  --> keepalive timer --> requestAbortController.abort()
  [3] Timeout          --> timeoutMs expires --> controller.abort()
```

### Component Interactions

| Component | Responsibility | Key Methods |
|-----------|---------------|-------------|
| `proxy.ts` | Creates AbortController, passes signal, handles cleanup | `handleChatCompletion()` |
| `base.ts` | Combines signals, provides fetch utility | `fetchWithTimeout()` |
| `openai-compat.ts` | Forwards signal to fetchWithTimeout | `chatCompletion()`, `streamChatCompletion()` |
| `google.ts` | Forwards signal to fetchWithTimeout | `chatCompletion()`, `streamChatCompletion()` |
| `cohere.ts` | Forwards signal to fetchWithTimeout | `chatCompletion()`, `streamChatCompletion()` |
| `cloudflare.ts` | Forwards signal to fetchWithTimeout | `chatCompletion()`, `streamChatCompletion()` |

## Detailed Design

### REQ-1: CompletionOptions Signal Field

**File**: `server/src/providers/base.ts`

Add `signal?: AbortSignal` to the `CompletionOptions` interface:

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

**File**: `server/src/providers/base.ts`

Modify `fetchWithTimeout` to combine the local timeout signal with any passed-in parent signal:

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

**Key behavior**:
- `AbortSignal.any()` creates a signal that aborts when ANY input signal aborts
- The local timeout signal still works independently
- The parent signal can abort at any time (including during body streaming)
- When either signal aborts, `fetch()` is cancelled and `reader.read()` rejects with `AbortError`

### REQ-3: Provider Signal Forwarding

**Files**: 
- `server/src/providers/openai-compat.ts`
- `server/src/providers/google.ts`
- `server/src/providers/cohere.ts`
- `server/src/providers/cloudflare.ts`

Each provider's `chatCompletion` and `streamChatCompletion` methods MUST pass `signal: options?.signal` to `fetchWithTimeout`.

**Example for OpenAICompatProvider** (`openai-compat.ts`):

```typescript
// In chatCompletion (line ~47):
const res = await BaseProvider.fetchWithTimeout(
  url,
  {
    method: 'POST',
    headers: { /* ... */ },
    body: JSON.stringify({ /* ... */ }),
    signal: options?.signal, // NEW: forward signal
  },
  30000,
);

// In streamChatCompletion (line ~87):
const res = await BaseProvider.fetchWithTimeout(
  url,
  {
    method: 'POST',
    headers: { /* ... */ },
    body: JSON.stringify({ /* ... */ }),
    signal: options?.signal, // NEW: forward signal
  },
  30000,
);
```

Apply the same pattern to `GoogleProvider`, `CohereProvider`, and `CloudflareProvider`.

### REQ-4: AbortController in proxy.ts

**File**: `server/src/routes/proxy.ts`

Create an `AbortController` before calling `streamChatCompletion` and pass its signal:

```typescript
// Around line 1329, before the generator call:
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
    signal: requestAbortController.signal, // NEW: pass signal to generator
  },
);
```

### REQ-5: Stall Detection Abort

**File**: `server/src/routes/proxy.ts`

When the keepalive timer detects a stall, call `requestAbortController.abort()`:

```typescript
// Around line 1349-1371, in the keepalive timer:
const keepaliveTimer = setInterval(() => {
  const elapsed = Date.now() - streamStartTime;
  
  if (elapsed >= streamKeepaliveConfig.MAX_STREAM_STALL_MS) {
    stalled = true;
    requestAbortController.abort(); // NEW: abort underlying fetch
    cleanup();
    // ... send error response ...
  }
}, streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS);
```

### REQ-6: Client Disconnect Handling

**File**: `server/src/routes/proxy.ts`

Modify the cleanup function to abort the underlying fetch:

```typescript
// Around line 1340-1343:
const cleanup = () => {
  clearInterval(keepaliveTimer);
  requestAbortController.abort(); // NEW: abort underlying fetch
  try { gen.return(); } catch { /* already closed */ }
};
```

The `res.on('close', cleanup)` at line 1378 remains unchanged - it will now trigger the abort.

### REQ-7: Active Request Cleanup

**File**: `server/src/routes/proxy.ts`

The existing `finally` blocks at lines 1625-1634 (stream) and 1678-1688 (non-stream) already clean up `activeRequests`. Ensure they remain intact:

```typescript
} finally {
  if (sessionKey) {
    for (const active of activeRequests) {
      if (active.sessionKey === sessionKey && active.platform === route.platform && active.modelId === route.modelId) {
        activeRequests.delete(active);
        break;
      }
    }
  }
}
```

## State Machine

### AbortController Lifecycle

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
                    v                                         │
              ┌──────────┐                                    │
    ┌────────▶│  IDLE    │◀────────────────────────┐         │
    │         └────┬─────┘                         │         │
    │              │                               │         │
    │              │ requestAbortController.abort() │         │
    │              │ (client disconnect, stall)     │         │
    │              │                               │         │
    │              v                               │         │
    │         ┌──────────┐                         │         │
    │         │ ABORTED  │─────────────────────────┘         │
    │         └──────────┘   (idempotent - safe to call       │
    │                          multiple times)               │
    │                                                         │
    │         ┌──────────┐                                    │
    └─────────│ COMPLETE │◀── Normal stream completion       │
              └──────────┘                                    │
```

### Signal Combination Logic

```
                    ┌─────────────────────┐
                    │  init.signal?      │
                    │  (parent signal)   │
                    └─────────┬───────────┘
                              │
                              │ (if exists)
                              │
                              v
                    ┌─────────────────────┐
                    │  AbortSignal.any(   │
                    │    [controller.sig, │
                    │     parentSignal]   │
                    └─────────┬───────────┘
                              │
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              v               v               v
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │ Timeout  │   │  Client  │   │  Stall   │
        │ Expires  │   │Disconnect│   │Detected  │
        └────┬─────┘   └────┬─────┘   └────┬─────┘
             │              │              │
             └──────────────┼──────────────┘
                            │
                            v
                    ┌─────────────────────┐
                    │  Combined Signal    │
                    │  ABORTS             │
                    │  fetch() cancelled  │
                    │  reader.read()      │
                    │  rejects           │
                    └─────────────────────┘
```

## Sequence Diagrams

### Scenario 1: Client Disconnect

```
Client          proxy.ts         fetch()         Provider
  │                │                │                │
  │──HTTP Request─▶│                │                │
  │                │──fetch()──────▶│                │
  │                │                │──HTTP Request─▶│
  │                │                │◀──Response─────│
  │                │◀─Stream Start──│                │
  │◀─Stream Data──│                │                │
  │                │                │                │
  │✗ (disconnect) │                │                │
  │                │                │                │
  │                │ res.on('close')│                │
  │                │   triggers     │                │
  │                │   cleanup()    │                │
  │                │                │                │
  │                │ requestAbort   │                │
  │                │ .abort()       │                │
  │                │                │                │
  │                │                │◀─[TCP RST]─────│
  │                │                │  fetch()       │
  │                │                │  rejects       │
  │                │                │                │
  │                │ gen.return()   │                │
  │                │   called       │                │
  │                │                │                │
  │                │ activeRequests│                │
  │                │   cleaned     │                │
```

### Scenario 2: Stream Stall Detection

```
Client          proxy.ts         fetch()         Provider
  │                │                │                │
  │──HTTP Request─▶│                │                │
  │                │──fetch()──────▶│                │
  │                │                │──HTTP Request─▶│
  │                │                │◀──Response─────│
  │                │◀─Stream Start──│                │
  │◀─Stream Data──│                │                │
  │                │                │                │
  │                │ (no data for   │                │
  │                │  60 seconds)   │                │
  │                │                │                │
  │                │ keepaliveTimer │                │
  │                │ fires         │                │
  │                │                │                │
  │                │ elapsed >=     │                │
  │                │ MAX_STALL_MS   │                │
  │                │                │                │
  │                │ stalled = true │                │
  │                │                │                │
  │                │ requestAbort   │                │
  │                │ .abort()       │                │
  │                │                │                │
  │                │ cleanup()      │                │
  │                │                │                │
  │                │                │◀─[TCP RST]─────│
  │                │                │  fetch()       │
  │                │                │  rejects       │
  │                │                │                │
  │                │ gen.return()   │                │
  │                │   called       │                │
  │                │                │                │
  │                │ activeRequests │                │
  │                │   cleaned     │                │
```

### Scenario 3: Normal Completion

```
Client          proxy.ts         fetch()         Provider
  │                │                │                │
  │──HTTP Request─▶│                │                │
  │                │──fetch()──────▶│                │
  │                │                │──HTTP Request─▶│
  │                │                │◀──Response─────│
  │                │◀─Stream Start──│                │
  │◀─Stream Data──│                │                │
  │◀─Stream Data──│                │                │
  │◀─Stream Data──│                │                │
  │                │                │◀──[DONE]───────│
  │                │                │  fetch()       │
  │                │                │  completes     │
  │                │                │                │
  │                │ gen.next()     │                │
  │                │ returns done   │                │
  │                │                │                │
  │                │ cleanup()      │                │
  │                │ (timer cleared,│                │
  │                │  gen closed)   │                │
  │                │                │                │
  │                │ activeRequests │                │
  │                │   cleaned     │                │
```

## Error Handling

### AbortError Propagation

When `requestAbortController.abort()` is called:

1. The combined signal in `fetchWithTimeout` aborts
2. `fetch()` throws an `AbortError`
3. The provider's `streamChatCompletion` catches the error
4. The generator terminates gracefully via `gen.return()`
5. `proxy.ts` handles any cleanup errors in try/catch

### Idempotency

- `AbortController.abort()` is idempotent - calling multiple times is safe
- The cleanup function can be called multiple times without side effects
- `gen.return()` is wrapped in try/catch to handle already-closed generators

### Error Response Handling

When abort occurs mid-stream:

1. If headers already sent: send error chunk and close stream
2. If headers not sent: send error response with appropriate status code
3. Always clean up `activeRequests` in the `finally` block

## Testing Strategy

### Unit Tests

All existing tests must pass:
```bash
pnpm --filter server test
```

### Manual Verification

1. **Client disconnect test**:
   - Start a streaming request
   - Cancel mid-stream (Ctrl+C in curl)
   - Verify upstream request is aborted within 1 second

2. **Stall detection test**:
   - Configure artificial latency on provider
   - Start a streaming request
   - Verify stall is detected and request aborted after 60 seconds

### Future Integration Test

A dedicated test file should be created:
```bash
pnpm --filter server vitest run src/__tests__/routes/stream-heartbeat-stall.test.ts
```

This test would:
- Mock the provider to simulate stalls
- Verify cleanup is called on stall detection
- Verify `activeRequests` is cleaned up

## Implementation Checklist

- [ ] Add `signal?: AbortSignal` to `CompletionOptions` in `base.ts`
- [ ] Modify `fetchWithTimeout` to combine signals using `AbortSignal.any()`
- [ ] Update `OpenAICompatProvider` to forward signal to `fetchWithTimeout`
- [ ] Update `GoogleProvider` to forward signal to `fetchWithTimeout`
- [ ] Update `CohereProvider` to forward signal to `fetchWithTimeout`
- [ ] Update `CloudflareProvider` to forward signal to `fetchWithTimeout`
- [ ] Create `requestAbortController` in `proxy.ts` before stream call
- [ ] Pass `signal: requestAbortController.signal` to `streamChatCompletion`
- [ ] Add `requestAbortController.abort()` to stall detection block
- [ ] Add `requestAbortController.abort()` to cleanup function
- [ ] Verify `activeRequests` cleanup in all finally blocks
- [ ] Run existing tests: `pnpm --filter server test`