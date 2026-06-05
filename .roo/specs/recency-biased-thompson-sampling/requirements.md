# Requirements: Recency-Biased Thompson Sampling (Time-Decay Aggregation)

## Overview

The Thompson Sampling router currently computes each model's success rate as a flat average over a 7-day window. Historical successes from days ago can mask a sudden, persistent outage occurring right now. This feature introduces a time-decay weighting mechanism so recent requests carry significantly more statistical weight than older requests, enabling the router to react dynamically to changes in provider health.

---

## Requirements

### R-1: Linear Time-Decay Weighting

The SQL query aggregating historical requests in [`refreshStatsCache()`](server/src/services/router.ts:174) must calculate a weight for each logged request based on its age. Newer requests must be assigned a weight closer to `1.0`, while requests approaching the limit of the analytics window (7 days) must decay toward `0.0`.

**Formula**: `MIN(1.0, MAX(0.0, 1.0 - (julianday('now') - julianday(created_at)) / 7.0))`

- Request logged just now → weight ≈ `1.0`
- Request logged 3.5 days ago → weight ≈ `0.5`
- Request logged 7 days ago → weight ≈ `0.0`
- The `MIN(1.0, ...)` upper bound protects against system clock drift anomalies
- The `MAX(0.0, ...)` lower bound prevents negative weights

### R-2: Backward Compatibility with Beta Sampling

The calculated weighted successes and weighted totals must be mapped safely to the alpha and beta parameters of the Beta distribution sampler. Because the sampler expects positive numbers, the weighted sums must be safely bounded using `Math.max(0.1, ...)` to guarantee that floating-point variance or rounding margins do not result in non-positive alpha/beta arguments.

**Affected functions**:
- [`thompsonSampleScore()`](server/src/services/router.ts:264)
- [`smartSampleScore()`](server/src/services/router.ts:293)
- [`getAnalyticsScore()`](server/src/services/router.ts:212)
- [`getSmartAnalyticsScore()`](server/src/services/router.ts:241)

### R-3: Zero-Extension Portability

The implementation must use standard, widely supported SQLite date functions — specifically `julianday()` — to calculate the age of requests. This avoids relying on platform-specific external SQL mathematical extensions like `EXP()` that may not be available in all SQLite builds.

---

## Constraints

- **No schema changes**: The `requests` table schema remains unchanged. The `created_at` column (TEXT, ISO-8601) already stores timestamps suitable for `julianday()` computation.
- **No new dependencies**: The change is purely a SQL query modification and a TypeScript safety guard — no new packages or external extensions required.
- **Cache TTL unchanged**: The `ANALYTICS_CACHE_TTL_MS` (60 seconds) and `ANALYTICS_WINDOW_MS` (7 days) constants remain the same.

---

## Test Cases

### T-1: Outage Sensitivity Under High Baseline Volume

**Setup**:
1. Seed the database with 1,000 successful requests for Model A spread over days 1–5 of the 7-day window.
2. Record 15 consecutive failures for Model A in the last 10 minutes of Day 7.

**Execution**: Trigger `refreshStatsCache()` and observe the computed `successes` and `total` for Model A.

**Expected Behavior**: Under a flat average, 15 failures against 1,000 successes yields ~98.5% success rate. With linear decay, the 1,000 old requests have an average weight < 0.3 (totaling ~300 effective runs), while the 15 failures carry weight ≈ 1.0 (totaling ~15 effective runs). The effective success rate is noticeably depressed, causing the Thompson Sampling score to drop quickly and deprioritize the model.

### T-2: Safe Fractional Evaluation

**Setup**: Record 1 success with a recency weight of `0.2`.

**Execution**: Call `thompsonSampleScore()`.

**Expected Behavior**: The function must evaluate without mathematical exceptions (division by zero, negative Gamma shapes) and return a valid score between `0.0` and `2.0`.

---

## Edge Cases & Risks

| Risk | Mitigation |
|------|------------|
| System clock drift backward → weight > 1.0 | `MIN(1.0, MAX(0.0, ...))` double-bounds the weight |
| Floating-point rounding → alpha/beta ≤ 0 | `Math.max(0.1, ...)` guard on Beta parameters |
| Very low weighted totals → high prior influence | Acceptable — priors are designed for low-data scenarios |
| Dashboard `successRate` display shows fractional totals | Update display to show weighted success rate or add a note |