# Design: PR #13 Code Review Fixes

## Overview

This spec addresses 10 verified bugs found during code review of PR #13. The fixes are organized into three tiers: critical bugs (P0), behavioral regressions (P1), and code quality (P2).

## Architecture

The fixes touch four areas of the codebase:

```
server/src/
  services/router.ts       ← BUG-01 (SQL parenthesis)
  providers/
    base.ts                ← BUG-03 (Number() NaN)
    cloudflare.ts          ← BUG-02 (wrapped error catch)
    cohere.ts              ← BUG-02 (wrapped error catch)
    openai-compat.ts       ← BUG-02 (wrapped error catch)
  routes/proxy.ts          ← BUG-04 (hardcoded refs), BUG-05 (stall abort),
                              BUG-06 (cooldown guard), BUG-10 (double semicolon)
  __tests__/
    services/router.test.ts ← BUG-09 (malformed SQL)
```

## Design Decisions

### BUG-01: SQL Parenthesis Fix

**Decision:** Direct fix — remove the extra closing parenthesis.

The SQL in `refreshStatsCache()` at [`server/src/services/router.ts:184`](server/src/services/router.ts:184) has:
```sql
SUM(MAX(0, MIN(1.0, 1.0 - (julianday('now') - julianday(created_at)) / 7.0)))) as total,
```

The nesting should be `SUM(MAX(0, MIN(1.0, expr)))` — 3 opening parens, 3 closing. Currently has 4 closing. Remove one `)` from the end.

Same fix for `successes` on line 186.

**Testing:** Add a unit test that inserts requests with known timestamps and verifies the recency-weighted `total` and `successes` values match expected calculations.

### BUG-02: Wrapped Error Propagation

**Decision:** Restructure the streaming parse loop to match the Google provider pattern. **✅ FIXED** — applied to cloudflare, cohere, and openai-compat providers.

The Google provider ([`server/src/providers/google.ts:358-366`](server/src/providers/google.ts:358)) correctly separates parse error handling from wrapped error detection:

```typescript
// Google (correct):
try {
  chunk = JSON.parse(raw) as GeminiResponse;
} catch {
  continue;  // only catches parse errors
}
if (this.isWrappedError(chunk)) {
  this.throwWrappedError(chunk);  // outside try/catch — propagates
}
```

The bug in cloudflare, cohere, and openai-compat was that `isWrappedError` was INSIDE the try/catch, causing wrapped errors to be silently swallowed:

```typescript
// BUGGY pattern (before fix):
try {
  parsed = JSON.parse(data) as ChatCompletionChunk;
  if (this.isWrappedError(parsed)) {    // ← inside try/catch
    this.throwWrappedError(parsed);      // ← caught by catch below, silently lost
  }
} catch {
  continue;
}
yield parsed;
```

The fix moves `isWrappedError`/`throwWrappedError` outside the try/catch so they propagate to the caller. The current code in cloudflare/cohere/openai-compat now matches this pattern:

```typescript
// Fixed pattern (current code):
let parsed: ChatCompletionChunk;
try {
  parsed = JSON.parse(data) as ChatCompletionChunk;
} catch {
  continue;  // Skip malformed chunks
}
if (this.isWrappedError(parsed)) {
  this.throwWrappedError(parsed);  // propagates to caller
}
yield parsed;
```

**Testing:** Add a test that mocks a provider to return `{"error": {"message": "rate limited", "code": 429}}` with HTTP 200, and verify that the stream throws a `ProviderApiError` instead of silently completing.

### BUG-03: Number() NaN Guard

**Decision:** Guard with `Number.isFinite()` check.

In [`server/src/providers/base.ts:144`](server/src/providers/base.ts:144), the `throwWrappedError()` method converts the error payload's `code` field to a number without validation. Non-numeric codes (e.g., `"RATE_LIMIT"`) produce `NaN`.

Fix:
```typescript
const rawCode = (errPayload as Record<string, unknown>).code;
const parsedCode = typeof rawCode === 'number' ? rawCode : Number(rawCode);
error.status =
  typeof errPayload === 'object' && errPayload !== null && 'code' in (errPayload as Record<string, unknown>)
    ? (Number.isFinite(parsedCode) ? parsedCode : 200)
    : 200;
```

**Testing:** Add test cases for numeric code (429), string-numeric code ("429"), non-numeric code ("RATE_LIMIT"), and missing code (undefined).

### BUG-04: Replace Hardcoded Platform References

**Decision:** This is the largest fix and should be implemented incrementally.

1. First, audit the thread protection rules engine to understand its API and capabilities.
2. Create a mapping from current hardcoded behavior to rules engine configuration.
3. Replace hardcoded checks one at a time, verifying each replacement with existing tests.

The hardcoded references in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts) fall into three categories:

**Category A — Error classification (lines 1353, 1357, 1427, 1439, 1472, 1476, 1640, 1652, 1673, 1685):**
These check `route.platform === 'longcat'` or `route.platform === 'openrouter' && route.modelId === 'owl-alpha'` to decide between model-level ban vs provider-level ban. Replace with a call to the thread protection rules engine: `shouldBanProvider(route.platform, route.modelId, errorCode)`.

**Category B — Sticky clearing (lines 1430-1438, 1442-1450, 1510-1518, 1644-1650, 1676-1682, 1688-1694):**
These clear the sticky preference when the preferred model is from a specific platform. Replace with a generic `clearStickyIfPlatformMatches()` that takes the platform from the route.

**Category C — Active-request safeguards (lines 1219-1256):**
These are entirely hardcoded concurrency guards. Replace with a generic "active request protection" mechanism that the rules engine can configure per-platform.

**Testing:** Each replacement should be verified by the existing test suite. New tests should be added for the rules engine integration.

### BUG-05: Stall Upstream Abort

**Decision:** Use `AbortController` + `break` + `gen.return()`.

In the streaming section of [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts), when the stall timer fires:
1. Set a flag `stalled = true`
2. Break out of the `for await` loop
3. Call `gen.return()` to clean up the async iterator
4. Abort the underlying fetch (if possible via AbortSignal)

```typescript
let stalled = false;
const stallTimer = setTimeout(() => {
  stalled = true;
  // write error frame to client
}, MAX_STREAM_STALL_MS);

for await (const chunk of gen) {
  if (stalled) break;
  // ... process chunk
}
clearTimeout(stallTimer);
if (stalled) {
  gen.return();  // clean up upstream
}
```

**Testing:** Verify that after a stall, the upstream iterator's `return()` is called (mock test).

### BUG-06: Cooldown Guard Model Set

**Decision:** Pass the actual routable chain to the cooldown guard instead of querying `models WHERE enabled = 1`.

The cooldown guard should use the same filtered set that `routeRequest()` uses — models with available keys, not just enabled models.

### BUG-07 through BUG-10: Cleanup

Straightforward deletions and typo fixes. No design decisions needed.

## Data Flow

```
Client Request
    │
    ▼
proxy.ts:handleChatCompletion()
    │
    ├─ Session ban check (skipModels) ←── BUG-04 fix area
    ├─ Active-request safeguards ←──────── BUG-04 fix area
    ├─ routeRequest() ←────────────────── BUG-01 fix area (indirect: stats feed routing)
    │    │
    │    └─ refreshStatsCache() ←──────── BUG-01 fix area (direct: SQL)
    │
    ├─ Retry loop
    │    │
    │    ├─ Provider.streamChatCompletion()
    │    │    │
    │    │    ├─ Parse SSE chunks ←────── BUG-02 fix area
    │    │    ├─ isWrappedError() ←────── BUG-02 fix area
    │    │    └─ throwWrappedError() ←─── BUG-03 fix area
    │    │
    │    ├─ Stall detection ←──────────── BUG-05 fix area
    │    ├─ Error classification ←─────── BUG-04 fix area
    │    └─ Cooldown guard ←───────────── BUG-06 fix area
    │
    └─ Response to client
```

## Risk Assessment

| Fix | Risk | Mitigation |
|-----|------|------------|
| BUG-01 SQL fix | Low — single character change | Unit test with known data |
| BUG-02 wrapped error | Low — structural change, well-understood pattern | Reference google.ts implementation |
| BUG-03 NaN guard | Low — defensive coding | Unit test edge cases |
| BUG-04 hardcoded refs | High — touches core routing logic | Incremental replacement, run full test suite between each |
| BUG-05 stall abort | Medium — async iterator cleanup | Careful testing of cleanup paths |
| BUG-06 cooldown guard | Low — query scope change | Verify with existing cooldown tests |
| BUG-07-10 cleanup | Trivial | Straightforward |
