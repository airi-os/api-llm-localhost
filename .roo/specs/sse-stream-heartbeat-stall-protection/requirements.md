# Requirements: SSE Stream Heartbeats and Stall Protection

## Overview

Improve the stability of streaming connections (`stream: true`) handled by the proxy. During long generations, upstream providers may stall — either taking too long to return the first token or freezing mid-generation. This can cause intermediate reverse proxies (Nginx, Apache, Cloudflare) to terminate the connection due to idle timeouts. Additionally, completely hung upstream connections can leak socket descriptors and degrade server capacity. This specification introduces a background heartbeat (SSE comments) and an active stall-detection timeout.

## Context

The streaming execution path lives in [`handleChatCompletion()`](server/src/routes/proxy.ts:1061) inside the `if (stream)` block (lines 1279–1538). The current flow:

1. Creates an `AsyncGenerator` via [`route.provider.streamChatCompletion()`](server/src/providers/base.ts:60)
2. Iterates `for await (const chunk of gen)` — no timeout or keep-alive mechanism exists
3. Writes SSE frames to `res` via `res.write()`
4. On success, writes `[DONE]` and calls `res.end()`
5. On error, writes an error frame and calls `res.end()`

**The problem**: If the upstream provider stalls (no chunk yielded for an extended period), the proxy simply waits indefinitely. This causes:
- Intermediate proxies (Nginx, Cloudflare) to kill the connection on idle timeouts (typically 30–60s)
- Socket descriptor leaks if the upstream never closes the connection
- Client-side timeouts with no structured error signal

**The solution**: Add a periodic heartbeat interval that writes SSE comments during idle periods, and a stall-detection timeout that gracefully terminates the stream if no data arrives within a threshold.

## Functional Requirements

### FR-1: SSE Keep-Alive Heartbeats

While a stream is active but waiting for the upstream provider to yield data, the proxy must periodically write empty SSE comments (e.g., `: keep-alive\n\n`) to the client response. These comments are ignored by standard SSE clients (such as `EventSource`) but keep the underlying TCP socket active, resetting intermediate proxy idle timeouts.

- **Heartbeat interval**: 15 seconds (`KEEPALIVE_INTERVAL_MS = 15000`)
- **Format**: SSE comment line `: keep-alive\n\n` — per the SSE spec, lines starting with `:` are comments and ignored by EventSource parsers
- **Trigger condition**: The heartbeat fires on a `setInterval` timer regardless of whether data is flowing. When data IS flowing, the heartbeat write is harmless (SSE clients ignore comments). When data is NOT flowing, the heartbeat prevents idle-proxy disconnects.

### FR-2: Stream Stall Detection

The proxy must monitor the interval between incoming chunks from the upstream provider. If no chunk is yielded within a specified threshold, the connection must be deemed stalled.

- **Stall threshold**: 45 seconds (`MAX_STREAM_STALL_MS = 45000`)
- **Detection mechanism**: Track `lastChunkTimestamp = Date.now()`. On each chunk from the generator, reset the timestamp. The heartbeat interval callback checks `Date.now() - lastChunkTimestamp > MAX_STREAM_STALL_MS`.
- **Stall behavior**: When a stall is detected:
  1. Log a warning: `[Proxy] Stream stalled for <ms>ms — aborting socket`
  2. Clear the heartbeat interval timer
  3. Write a structured timeout error frame to the client:
     - For Responses API streams: emit a `response.failed` event via [`writeResponseStreamEvent()`](server/src/routes/proxy.ts:798)
     - For Chat Completion streams: write `data: {"error":{"message":"Upstream stream stalled","type":"stream_timeout"}}\n\n` followed by `data: [DONE]\n\n`
  4. Call `res.end()` to close the socket
  5. Return from the handler (no retry on stall — the stream is already partially delivered)

### FR-3: Client-Disconnect Cleanup

If the client terminates the connection prematurely (e.g., closing the browser tab or aborting the client-side fetch), the proxy must immediately clear all background timers and abort any pending upstream fetch requests.

- **Detection**: Attach a `req.on('close', ...)` listener that calls the cleanup routine
- **Cleanup routine**: A `cleanupStream()` function that:
  1. Clears the heartbeat `setInterval` timer (sets `heartbeatInterval = null`)
  2. This is the same cleanup function called on stall detection and on successful stream completion

### FR-4: Heartbeat Write Failure Handling

If a client abruptly closes the socket, writing `: keep-alive\n\n` may throw an EPIPE or ECONNRESET error. The heartbeat write must be wrapped in a `try/catch` block. On write failure:

1. Call `cleanupStream()` to clear the interval timer
2. Do NOT attempt to write an error frame (the socket is already gone)
3. The `req.on('close')` listener will also fire, but `cleanupStream()` is idempotent (checks `heartbeatInterval !== null` before clearing)

### FR-5: Successful Stream Completion Cleanup

When the `for await` loop completes successfully, the heartbeat interval must be cleared via `cleanupStream()` before writing the final `[DONE]` frame and calling `res.end()`. This prevents the heartbeat from firing after the response is finished.

### FR-6: Stream Error Cleanup

When a `catch (streamErr)` is triggered, `cleanupStream()` must be called before any error-frame writing. This prevents the heartbeat from interfering with the error response.

### FR-7: Constants Configuration

Both `KEEPALIVE_INTERVAL_MS` and `MAX_STREAM_STALL_MS` must be defined as named constants at the top of [`proxy.ts`](server/src/routes/proxy.ts:1), alongside existing constants like `STICKY_TTL_MS`. This makes the values easy to locate and adjust.

### FR-8: Pre-Stream Heartbeat Behavior

The heartbeat interval must be set up **before** entering the `for await` loop. This means heartbeats will fire during the initial TTFB wait period (before `streamStarted = true`), which is exactly when they are most needed — the client connection is idle while waiting for the first chunk.

However, the SSE comment `: keep-alive\n\n` must only be written **after** the SSE headers have been sent (i.e., after `streamStarted = true`). If the heartbeat fires before headers are sent, it should skip the write but still check for stall detection. Writing to `res` before headers would cause malformed HTTP output.

**Alternative approach**: Start the heartbeat interval only after `streamStarted = true` is set. This avoids the pre-header issue but means no keep-alive during the very first TTFB wait. Given that the stall detector still runs (it checks `lastChunkTimestamp`), the risk is minimal — if TTFB exceeds 45s, the stall detector will terminate the connection.

**Chosen approach**: Start the heartbeat interval immediately (before the `for await` loop). In the heartbeat callback, only write the SSE comment if `streamStarted === true`. The stall check runs regardless of `streamStarted` state. This provides stall protection from the start and keep-alive protection once headers are sent.

## Non-Functional Requirements

### NFR-1: No Database Schema Changes

This feature is purely runtime (timers and in-request state). No database schema changes are required.

### NFR-2: No New Persistent State

No new Map, Set, or other persistent data structure is needed. All state (`lastChunkTimestamp`, `heartbeatInterval`) is local to the request handler scope.

### NFR-3: No Provider Interface Changes

The [`streamChatCompletion()`](server/src/providers/base.ts:60) `AsyncGenerator` interface is unchanged. The heartbeat and stall detection are implemented entirely in the proxy routing layer.

### NFR-4: Idempotent Cleanup

The `cleanupStream()` function must be safe to call multiple times. It checks whether `heartbeatInterval` is non-null before clearing, preventing double-clear errors.

### NFR-5: No UI Changes

This is a backend-only feature. No client-side changes are needed.

### NFR-6: Backward Compatibility

Existing SSE clients that ignore comment lines (per the SSE specification) will not be affected. Clients that do not implement SSE comment filtering will see the `: keep-alive` lines as unknown events with no data, which is harmless.

### NFR-7: Race Condition Safety

If the stall monitor triggers at the exact moment the generator yields a chunk, a race condition could occur where both the stall handler and the normal chunk processing try to write to `res`. The cleanup routine must set `heartbeatInterval = null` immediately, ensuring the stall callback cannot execute twice. Additionally, the `for await` loop must check whether the stream has already been terminated by the stall handler before writing chunks.

## Files Requiring Modification

| # | File | Change Type | Description |
|---|---|---|---|
| 1 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1) | Edit | Add `KEEPALIVE_INTERVAL_MS` and `MAX_STREAM_STALL_MS` constants |
| 2 | [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:1279) | Edit | Add heartbeat interval, stall detection, client-disconnect listener, and cleanup logic inside the streaming block of `handleChatCompletion()` |
| 3 | [`server/src/__tests__/routes/proxy-tools.test.ts`](server/src/__tests__/routes/proxy-tools.test.ts) | Edit | Add unit tests for heartbeat emission, stall detection, and client-disconnect cleanup |

## Out of Scope

- Making heartbeat interval or stall threshold configurable via admin API or environment variable (constants only for now)
- Upstream fetch request abortion on stall (the `AsyncGenerator` will be garbage-collected when the handler returns)
- Heartbeat support for non-streaming (non-SSE) responses
- Changes to provider implementations
- Retry logic for stalled streams (the stream is already partially delivered to the client)