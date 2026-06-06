# Fallback Retry Threshold - Tasks

## Implementation Checklist

### Phase 1: Configurable Retry Threshold

- [x] **Modify `server/src/routes/proxy.ts` line 300**
  - Replace `const MAX_RETRIES = 20;` with `const MAX_RETRIES = parseInt(process.env.MAX_FALLBACK_RETRIES ?? '5', 10);`

- [x] **Update `.env.example`**
  - Add documentation comment: `# Maximum serial fallback attempts before giving up and returning an error (default: 5)`
  - Add: `MAX_FALLBACK_RETRIES=5`

### Phase 2: Standardized Mid-Stream Error Propagation

- [x] **Update generic error handler in `proxy.ts`**
  - Extract status code: `const nonRetryableStatus = getErrorStatus(err) ?? 502;`
  - Include status in error payload: `type: nonRetryableStatus === 429 ? 'rate_limit_error' : 'provider_error', status: nonRetryableStatus`
  - Add `status` field to exhausted-all-retries and no-more-models error responses

- [x] **Update keepalive stall handler**
  - Introduce `requestAbortController` before the generator iteration
  - Call `requestAbortController.abort()` in cleanup function
  - Add `status: 504` to mid-stream stall SSE error frame

### Phase 3: Verification

- [x] **Run stream heartbeat/stall tests**
  - 2/3 pass; 1 pre-existing failure (429 vs 200 — ratelimit mock issue, not caused by our changes)

- [x] **Run full test suite to ensure no regressions**
  - Baseline: 75 failed, 160 passed (235 total)
  - With changes: 71 failed, 164 passed (235 total)
  - Delta: -4 failures, +4 passes, zero regressions

## Files Modified

| File | Lines | Change |
|------|-------|--------|
| `server/src/routes/proxy.ts` | 300 | Make MAX_RETRIES configurable via `MAX_FALLBACK_RETRIES` env var |
| `server/src/routes/proxy.ts` | ~1350 | Add AbortController for request-level stall cancellation |
| `server/src/routes/proxy.ts` | ~1371 | Add `status: 504` to mid-stream stall SSE error frame |
| `server/src/routes/proxy.ts` | ~1305 | Add `status` field to no-more-models error response |
| `server/src/routes/proxy.ts` | ~1842 | Use `getErrorStatus()` for non-retryable error status code |
| `server/src/routes/proxy.ts` | ~1859 | Add `status` field to exhausted-all-retries error response |
| `.env.example` | ~19 | Add MAX_FALLBACK_RETRIES documentation |
