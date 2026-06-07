# Fallback Retry Threshold - Requirements

## Context

The freellmapi proxy server implements multi-provider fallback routing. When a provider fails, it attempts the next available provider. The current `MAX_RETRIES = 20` is too high, causing excessive latency during multi-provider outages. Additionally, mid-stream errors (after HTTP 200 headers are sent) need standardized SSE error frame propagation.

## Problem Statement

1. **High Fallback Retry Threshold**: `MAX_RETRIES = 20` causes runaway latency during cascading provider outages
2. **Mid-Stream Error Handling**: When streams fail after headers are sent, error propagation should be standardized via SSE error frames

## Requirements

### Phase 1: Configurable Retry Threshold

- [ ] Replace hardcoded `const MAX_RETRIES = 20;` (line 288 in `proxy.ts`) with environment variable-backed configuration
- [ ] Default value: `5` (safer than current 20)
- [ ] Environment variable name: `MAX_FALLBACK_RETRIES`
- [ ] Add to `.env.example` with documentation

### Phase 2: Standardized Mid-Stream Error Propagation

- [ ] Update generic mid-stream error handler (line 1603) to include status code from `getErrorStatus(err) ?? 502`
- [ ] Update keepalive stall handler to use `requestAbortController.abort()` pattern for cleaner control flow
- [ ] Ensure SSE error frames follow OpenAI-compatible format: `data: {"error": {...}}\n\n`

### Phase 3: Verification

- [ ] Run existing test suite: `pnpm --filter server vitest run src/__tests__/routes/stream-heartbeat-stall.test.ts`

## Technical Details

### Current State

- `MAX_RETRIES` at line 288: `const MAX_RETRIES = 20;`
- Keepalive timer at lines 1343-1374 handles stall detection
- Generic error payload at line 1603: `{ error: { message: "Provider error (${route.displayName}): stream interrupted", type: "stream_error" } }`
- `getErrorStatus(err)` function exists at lines 487-494

### Target Changes

1. **proxy.ts line 288**:
   ```typescript
   // Before
   const MAX_RETRIES = 20;
   
   // After
   const MAX_RETRIES = parseInt(process.env.MAX_FALLBACK_RETRIES ?? '5', 10);
   ```

2. **proxy.ts line 1603** (generic error handler):
   ```typescript
   // Before
   const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
   
   // After
   const status = getErrorStatus(err) ?? 502;
   const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error', status } };
   ```

3. **Keepalive stall handler** (lines 1343-1374):
   - Introduce `requestAbortController` for cleaner abort signal propagation
   - Use `requestAbortController.abort()` instead of directly writing to response in setInterval callback

4. **.env.example**:
   ```bash
   # Maximum serial fallback attempts before giving up and returning an error (default: 5)
   MAX_FALLBACK_RETRIES=5
   ```

## Non-Functional Requirements

- Backward compatible: existing deployments without `MAX_FALLBACK_RETRIES` env var will use default of 5
- No breaking changes to API response format
- Existing tests should pass without modification