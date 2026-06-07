# Abort Signal Propagation - Tasks

## Feature Name
**abort-signal-propagation** - Immediate Stream Abort on Client Disconnect & Stall Detection

## Implementation Tasks

### Phase 1: Core Signal Support

- [ ] **Add `signal` field to `CompletionOptions`** in `server/src/providers/base.ts`
  - Add `signal?: AbortSignal` to the interface at line 10-18
  - This enables signal propagation through the provider interface

- [ ] **Modify `fetchWithTimeout`** in `server/src/providers/base.ts`
  - Update the method to accept and combine signals using `AbortSignal.any()`
  - Extract parent signal from `init.signal` if present
  - Create combined signal: `AbortSignal.any([controller.signal, parentSignal].filter(Boolean))`
  - Pass combined signal to `fetch()`

### Phase 2: Provider Signal Forwarding

- [ ] **Update `OpenAICompatProvider`** in `server/src/providers/openai-compat.ts`
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `chatCompletion` (line ~47)
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `streamChatCompletion` (line ~87)

- [ ] **Update `GoogleProvider`** in `server/src/providers/google.ts`
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `chatCompletion` (line ~236)
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `streamChatCompletion` (line ~303)

- [ ] **Update `CohereProvider`** in `server/src/providers/cohere.ts`
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `chatCompletion` (line ~36)
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `streamChatCompletion` (line ~82)

- [ ] **Update `CloudflareProvider`** in `server/src/providers/cloudflare.ts`
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `chatCompletion` (line ~40)
  - Add `signal: options?.signal` to `fetchWithTimeout` call in `streamChatCompletion` (line ~81)

### Phase 3: proxy.ts Integration

- [ ] **Create `AbortController` for stream requests** in `server/src/routes/proxy.ts`
  - Add `const requestAbortController = new AbortController();` before the generator call (line ~1329)
  - This controller will manage abort signals for the entire request lifecycle

- [ ] **Pass signal to `streamChatCompletion`** in `server/src/routes/proxy.ts`
  - Add `signal: requestAbortController.signal` to the options object (line ~1330-1333)
  - This propagates the abort signal to the provider

- [ ] **Add abort to stall detection** in `server/src/routes/proxy.ts`
  - Add `requestAbortController.abort();` in the keepalive timer block (line ~1349-1371)
  - This aborts the underlying fetch when stream stalls are detected

- [ ] **Add abort to cleanup function** in `server/src/routes/proxy.ts`
  - Add `requestAbortController.abort();` to the cleanup function (line ~1340-1343)
  - This ensures abort on client disconnect

### Phase 4: Verification

- [ ] **Run existing tests**
  ```bash
  pnpm --filter server test
  ```
  - All existing tests must pass without regression

- [ ] **Verify TypeScript compilation**
  ```bash
  pnpm --filter server build
  ```
  - Ensure no type errors from the signal additions

### Phase 5: Future Integration Test (Optional)

- [ ] **Create integration test** at `server/src/__tests__/routes/stream-heartbeat-stall.test.ts`
  - Mock provider to simulate stalls
  - Verify cleanup is called on stall detection
  - Verify `activeRequests` is cleaned up

## File Changes Summary

| File | Changes |
|------|---------|
| `server/src/providers/base.ts` | Add `signal` to `CompletionOptions`, modify `fetchWithTimeout` |
| `server/src/providers/openai-compat.ts` | Forward signal to `fetchWithTimeout` |
| `server/src/providers/google.ts` | Forward signal to `fetchWithTimeout` |
| `server/src/providers/cohere.ts` | Forward signal to `fetchWithTimeout` |
| `server/src/providers/cloudflare.ts` | Forward signal to `fetchWithTimeout` |
| `server/src/routes/proxy.ts` | Create `AbortController`, pass signal, add abort calls |

## Dependencies

- Node.js v22.22.3+ (for native `AbortSignal.any()` support)
- No new external dependencies required

## Notes

- `AbortController.abort()` is idempotent - safe to call multiple times
- `gen.return()` is already wrapped in try/catch for already-closed generators
- The `activeRequests` cleanup in `finally` blocks already handles all termination paths