# Requirements: PR #13 Code Review Fix Delegation

## Problem Statement

PR #13 "generalized thread protection scanner integration" was merged with multiple code review issues identified by Qodo, Gemini Code Assist, Sourcery, and CodeRabbit. This spec documents all verified issues and provides a prioritized fix plan.

## Verification Summary

All issues were verified against the actual codebase. Each issue below includes the file, line numbers, and exact description of the defect.

---

## Critical Bugs (P0 — Data Loss / Incorrect Behavior)

### BUG-01: SQL Parenthesis Mismatch in `refreshStatsCache()` — Extra Closing Paren

**File:** [`server/src/services/router.ts:184`](server/src/services/router.ts:184)
**Reviewers:** Qodo, Gemini Code Assist

The `SUM()` in the recency-weighted SQL has an extra closing parenthesis. The `MAX(0, MIN(1.0, ...))` nesting has 3 opening parens but 4 closing parens. SQLite may tolerate this (it does — it treats the extra `)` as closing the `SUM(`), but the resulting expression is semantically wrong: the `SUM` aggregate wraps only `MAX(0, MIN(1.0, ...))` instead of the full `MAX(0, MIN(1.0, 1.0 - ...))` expression. The `total` column will always be 0 or NULL because `MIN(1.0, 1.0 - days_ago/7.0)` is capped at 1.0, then `MAX(0, 1.0)` = 1.0, and the extra `)` closes the SUM prematurely.

**Actual (broken):**
```sql
SUM(MAX(0, MIN(1.0, 1.0 - (julianday('now') - julianday(created_at)) / 7.0)))) as total,
```

**Fix:** Remove the extra closing paren so the `SUM(` has exactly one closing `)`:
```sql
SUM(MAX(0, MIN(1.0, 1.0 - (julianday('now') - julianday(created_at)) / 7.0))) as total,
```

The same issue exists on line 186 for the `successes` aggregate:
```sql
-- Broken:
THEN MAX(0, MIN(1.0, 1.0 - (julianday('now') - julianday(created_at)) / 7.0)))
-- Fixed:
THEN MAX(0, MIN(1.0, 1.0 - (julianday('now') - julianday(created_at)) / 7.0))
```

**Impact:** Recency-weighted analytics scores are incorrect. Thompson sampling uses these scores for routing decisions, causing suboptimal model selection.

---

### BUG-02: Wrapped Error Throw Silently Swallowed in Streaming Catch Blocks

**Files:**
- [`server/src/providers/cloudflare.ts:123-127`](server/src/providers/cloudflare.ts:123)
- [`server/src/providers/cohere.ts:114-118`](server/src/providers/cohere.ts:114)
- [`server/src/providers/openai-compat.ts:130-134`](server/src/providers/openai-compat.ts:130)

**Reviewers:** Qodo, Sourcery

In all three providers, the streaming `for await` loop has this pattern:
```typescript
try {
  const parsed = JSON.parse(data) as ChatCompletionChunk;
  if (this.isWrappedError(parsed)) {
    this.throwWrappedError(parsed);  // <-- this throw is caught below
  }
  yield parsed;
} catch {
  // Skip malformed chunks
}
```

The `throwWrappedError()` call is inside the `try` block. The `catch {}` clause catches ALL exceptions — including the wrapped error throw — and silently discards it. Wrapped errors (HTTP 200 responses containing error payloads) will never propagate to the proxy route's error handler.

**Reference implementation (correct):** [`server/src/providers/google.ts:358-366`](server/src/providers/google.ts:358) — Google's provider checks `isWrappedError` AFTER the parse `try/catch`, so the throw is outside the catch scope:
```typescript
try {
  chunk = JSON.parse(raw) as GeminiResponse;
} catch {
  continue;  // only catches parse errors
}
if (this.isWrappedError(chunk)) {
  this.throwWrappedError(chunk);  // outside try/catch — propagates correctly
}
```

**Fix:** Move the `isWrappedError` check and `throwWrappedError` call outside the parse `try/catch` block in all three providers, matching the Google provider pattern.

**Impact:** Providers returning error payloads with HTTP 200 status will silently yield no chunks instead of throwing, causing empty responses or misleading success signals.

---

### BUG-03: `Number()` Conversion Without NaN Validation in `throwWrappedError()`

**File:** [`server/src/providers/base.ts:144`](server/src/providers/base.ts:144)
**Reviewers:** Sourcery

```typescript
error.status =
  typeof errPayload === 'object' && errPayload !== null && 'code' in (errPayload as Record<string, unknown>)
    ? Number((errPayload as Record<string, unknown>).code)
    : 200;
```

If the upstream error payload has a non-numeric `code` field (e.g., `"code": "RATE_LIMIT"` or `"code": "INVALID_ARGUMENT"`), `Number("RATE_LIMIT")` yields `NaN`. The error's `.status` becomes `NaN`, which will fail status comparisons like `status >= 500` (always false for NaN), causing the error to be misclassified.

**Fix:** Add a NaN guard:
```typescript
const rawCode = (errPayload as Record<string, unknown>).code;
const parsedCode = typeof rawCode === 'number' ? rawCode : Number(rawCode);
error.status =
  typeof errPayload === 'object' && errPayload !== null && 'code' in (errPayload as Record<string, unknown>)
    ? (Number.isFinite(parsedCode) ? parsedCode : 200)
    : 200;
```

**Impact:** Non-numeric error codes from upstream providers (e.g., Google's `resource_exhausted` string codes) will cause the error to be classified as status 200 instead of a proper error, breaking retry/fallback logic.

---

## High Priority Bugs (P1 — Behavioral Regressions)

### BUG-04: Hardcoded LongCat/Owl Alpha References Remain Despite Generalized Thread Protection

**File:** [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts)
**Reviewers:** CodeRabbit, Sourcery

The PR claimed to replace hardcoded platform checks with `evaluateThreadProtection()` calls, but the following locations still contain hardcoded `route.platform === 'longcat'` and `route.platform === 'openrouter' && route.modelId === 'owl-alpha'` checks:

| Line | Context |
|------|---------|
| 1353 | Truncated stream content detection |
| 1357 | Owl Alpha truncated stream detection |
| 1427 | Mid-stream 5xx failure classification |
| 1439 | Owl Alpha mid-stream 5xx classification |
| 1472 | Mid-stream truncation error classification |
| 1476 | Owl Alpha mid-stream truncation classification |
| 1506 | Mid-stream retryable error — LongCat provider ban |
| 1640 | Pre-stream 5xx failure classification |
| 1652 | Owl Alpha pre-stream 5xx classification |
| 1673 | Pre-stream retryable error — LongCat model ban |
| 1685 | Owl Alpha pre-stream retryable error ban |

Additionally, the active-request safeguards at lines 1219-1256 are entirely hardcoded:
- Lines 1219-1233: `otherSessionUsingLongCat` check
- Lines 1235-1256: `otherSessionUsingOwl` check

**Impact:** The generalized thread protection rules engine cannot function — the code still has special-case branches for specific providers, meaning the rules engine is either unused or its decisions are overridden by hardcoded logic.

**Note:** This is the largest fix and may warrant its own sub-spec. The fix involves:
1. Reading the thread protection rules engine to understand its API
2. Replacing all hardcoded `route.platform === 'longcat'` checks with calls to the rules engine
3. Replacing the hardcoded active-request safeguards with rules-engine-driven logic
4. Ensuring the rules engine's default rules match the current hardcoded behavior

---

### BUG-05: Stall Detection Does Not Abort Upstream Provider Stream

**File:** [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts) — streaming section
**Reviewers:** Qodo

When the stall timer fires (no chunks received within `MAX_STREAM_STALL_MS`), the code:
1. Writes an error SSE frame to the client
2. Calls `res.end()` to close the HTTP response

However, it does NOT abort/destroy/cancel the upstream provider's async iterator (`gen`). The `for await (const chunk of gen)` loop at line 1322 continues running in the background, consuming provider resources indefinitely.

**Impact:** Stalled upstream streams leak — they continue reading from the provider even after the client has been told the stream timed out. Under load, this can exhaust connections and memory.

**Fix:** Use an `AbortController` to cancel the upstream stream when the stall timer fires. Pass the signal to `streamChatCompletion()`, or break out of the `for await` loop and call `gen.return()` to clean up.

---

### BUG-06: Cooldown Guard Checks Wrong Model Set

**File:** [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts) — cooldown guard section
**Reviewers:** CodeRabbit

The transient model cooldown guard compares against `models WHERE enabled = 1` rather than the actual routable fallback chain. This means:
- Models that are enabled but have no available keys will still be considered "routable" by the cooldown guard
- Models that are disabled but temporarily cooldown'd won't be properly excluded

**Impact:** Cooldown protection may incorrectly skip or include models, reducing the effectiveness of the transient cooldown mechanism.

---

## Code Quality Issues (P2 — Cleanup)

### BUG-07: Stray Debug Scripts in Repo Root

**Files:**
- `do_fix.py` — incomplete Python script for mutating proxy.ts
- `fix_streaming.py` — incomplete helper script
- `fix.py` — another incomplete helper script

**Reviewers:** Sourcery

These are development artifacts that should not be in the repository.

**Fix:** Delete these files or move them to a `.gitignore`'d directory.

---

### BUG-08: Incomplete Spec Document

**File:** [`.roo/specs/generalized-thread-protection/requirements.md`](.roo/specs/generalized-thread-protection/requirements.md)

The requirements.md is truncated mid-sentence at line 5. The full requirements for the generalized thread protection feature are not documented.

**Fix:** Complete the requirements document with full problem statement, user stories, and acceptance criteria.

---

### BUG-09: `router.test.ts` Has Malformed SQL in Test Fixtures

**File:** [`server/src/__tests__/services/router.test.ts:29-33`](server/src/__tests__/services/router.test.ts:29)

```typescript
db.prepare(`
  INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
  VALUES (?,
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);
```

There are two `VALUES` clauses — the first is truncated (`VALUES (?,`) and the second is the actual values. This is a copy-paste error. The test may still pass if SQLite ignores the malformed first VALUES, but it's fragile and misleading.

**Fix:** Remove the truncated first `VALUES (?,` line.

---

### BUG-10: Double Semicolon in `proxy.ts`

**File:** [`server/src/routes/proxy.ts:1557`](server/src/routes/proxy.ts:1557)

```typescript
res.write('data: [DONE]\n\n');
```

Followed by another statement terminator. While not a bug (the extra `;` is a no-op), it's a code smell from a previous edit.

**Fix:** Remove the extra semicolon.

---

## Priority Order

| Priority | Bug | Effort | Impact |
|----------|-----|--------|--------|
| P0 | BUG-01: SQL parenthesis mismatch | Trivial | Analytics/routing scores wrong |
| P0 | BUG-02: Wrapped error swallowed | Small | Silent data loss on streaming |
| P0 | BUG-03: Number() NaN risk | Trivial | Error misclassification |
| P1 | BUG-04: Hardcoded longcat refs | Large | Rules engine non-functional |
| P1 | BUG-05: Stall doesn't abort upstream | Small | Resource leak |
| P1 | BUG-06: Cooldown guard wrong set | Small | Cooldown ineffective |
| P2 | BUG-07: Stray debug scripts | Trivial | Repo cleanliness |
| P2 | BUG-08: Incomplete spec | Medium | Documentation gap |
| P2 | BUG-09: Malformed test SQL | Trivial | Test fragility |
| P2 | BUG-10: Double semicolon | Trivial | Code smell |

---

## Acceptance Criteria

- [ ] BUG-01: `refreshStatsCache()` SQL produces correct recency-weighted totals (verified by unit test)
- [ ] BUG-02: Wrapped errors in cloudflare, cohere, and openai-compat streaming paths propagate to the error handler (verified by unit test with mock provider returning HTTP 200 + error body)
- [ ] BUG-03: Non-numeric error codes default to status 200 instead of NaN (verified by unit test)
- [ ] BUG-04: No hardcoded `route.platform === 'longcat'` or `route.platform === 'openrouter' && route.modelId === 'owl-alpha'` checks remain in proxy.ts
- [ ] BUG-05: Upstream provider stream is aborted when stall timer fires (verified by test checking iterator cleanup)
- [ ] BUG-06: Cooldown guard uses the actual routable chain, not `models WHERE enabled = 1`
- [ ] BUG-07: `do_fix.py`, `fix_streaming.py`, `fix.py` removed from repo root
- [ ] BUG-08: `.roo/specs/generalized-thread-protection/requirements.md` is complete
- [ ] BUG-09: `router.test.ts` INSERT statement has exactly one VALUES clause
- [ ] BUG-10: No double semicolons in proxy.ts
