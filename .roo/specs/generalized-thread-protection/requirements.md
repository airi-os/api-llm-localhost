# Requirements: Generalized Thread Protection Scanner

## Problem Statement

The proxy route handler (`server/src/routes/proxy.ts`) contains 6+ hardcoded branches that special-case the `longcat` platform by name. These inline checks are scattered across the retry loop, streaming error handling, and sticky-session logic. The thread protection service (`server/src/services/threadProtection.ts`) already provides a clean `getProtectionLevel()` / `evaluateThreadProtection()` API with a decision matrix, but `proxy.ts` bypasses it in most code paths and instead hardcodes `if (protection === 'provider-ban')` comparisons that implicitly depend on the platform name being `longcat`.

This creates several problems:

1. **Platform-specific logic is duplicated** — the same "is this provider-ban?" check appears in at least 6 places in `proxy.ts` (streaming mid-stream errors, non-streaming retryable errors, active-request safeguards, provider-ban sticky cooldowns, 5xx handling, and truncation handling).
2. **Adding a new protected platform requires touching proxy.ts** — any new platform that needs `provider-ban` behavior (e.g., `owl-alpha`) currently requires finding and updating every hardcoded branch.
3. **The protection level is only checked at the error-response layer** — the active-request safeguard and sticky cooldown logic in `proxy.ts` call `getProtectionLevel()` directly rather than using the `evaluateThreadProtection()` decision matrix, creating inconsistency.
4. **No single source of truth** — the `threadProtection.ts` service defines the decision matrix, but `proxy.ts` re-implements fragments of it inline.

## User Stories / Use Cases

### UC-1: Configure protection via environment variable
As a deployer, I want to set `THREAD_PROTECTION_PLATFORMS=longcat:provider-ban,owl-alpha:provider-ban,groq:model-skip` and have all protection decisions in the proxy route handler respect this configuration — without modifying any TypeScript source code.

### UC-2: Add a new protected platform without touching proxy.ts
As a developer, I want to add a new platform (e.g., `owl-alpha`) to the protection list and have the proxy's retry logic, streaming error handling, active-request safeguards, and sticky cooldowns all automatically apply the correct behavior (provider-ban vs model-skip) without any changes to `proxy.ts`.

### UC-3: Disable protection for a platform
As a deployer, I want to set a platform's level to `off` (e.g., `longcat:off`) and have the proxy skip all thread protection logic for that platform — no provider bans, no model skips, no active-request exclusions.

### UC-4: Uniform error handling across all error types
As a developer, I want a single `evaluateThreadProtection()` call to determine the action for any error context (5xx, truncation, retryable, mid-stream, pre-stream) rather than having separate inline checks scattered across the retry loop.

### UC-5: Active-request safeguard uses the rules engine
As a deployer, I want the active-request safeguard (which excludes provider-ban platforms from bandit routing when another session is actively using them) to be driven by the same `getProtectionLevel()` / `evaluateThreadProtection()` rules engine rather than a separate inline check.

### UC-6: Sticky cooldown respects configurable protection levels
As a deployer, I want the provider-ban sticky cooldown logic (which excludes a platform from bandit routing for a short window after use) to apply to all platforms configured as `provider-ban`, not just `longcat`.

## Acceptance Criteria

1. **No hardcoded platform checks in proxy.ts** — There must be zero occurrences of hardcoded platform names (e.g., `longcat`, `owl-alpha`) in `proxy.ts`. All protection decisions must flow through `getProtectionLevel()` or `evaluateThreadProtection()` from `threadProtection.ts`.

2. **Rules engine drives all protection decisions** — The `evaluateThreadProtection()` function in `threadProtection.ts` must be the single decision point for what action to take on an error. The proxy must pass an `ErrorContext` and act on the returned `ThreadProtectionAction`.

3. **All 6+ hardcoded branches are removed or replaced** — Every inline `if (protection === 'provider-ban')` check in `proxy.ts` must be replaced with a call to the rules engine or a helper that delegates to it.

4. **Active-request safeguard is generalized** — The active-request safeguard loop in `proxy.ts` must use `getProtectionLevel()` to determine which platforms to exclude, not a hardcoded list.

5. **Sticky cooldown is generalized** — The provider-ban sticky cooldown check in `proxy.ts` must apply to any platform with `provider-ban` protection level, not just `longcat`.

6. **Existing behavior is preserved** — When `THREAD_PROTECTION_PLATFORMS` is unset, `longcat` must still receive `provider-ban` protection and all other platforms must receive `model-skip` (backward-compatible defaults).

7. **No regressions** — All existing tests must pass. The retry loop, streaming, and sticky-session behavior must remain functionally identical for the default configuration.

## Technical Requirements

### TR-1: Rules Engine API

The `threadProtection.ts` service must expose:

- `getProtectionLevel(platform: string): ProtectionLevel` — already exists. Returns `'provider-ban'`, `'model-skip'`, or `'off'` for any platform.
- `evaluateThreadProtection(ctx: ErrorContext): ThreadProtectionAction` — already exists. Maps error context to an action using the decision matrix.
- `parseProtectionConfig(raw: string | undefined): Map<string, ProtectionLevel>` — already exists. Parses `THREAD_PROTECTION_PLATFORMS` env var.

### TR-2: Configuration Format

The `THREAD_PROTECTION_PLATFORMS` environment variable must accept a comma-separated list of `platform:level` pairs:

```
THREAD_PROTECTION_PLATFORMS="longcat:provider-ban,owl-alpha:provider-ban,groq:model-skip"
```

- Platform names are case-insensitive and trimmed.
- Level must be one of: `provider-ban`, `model-skip`, `off`.
- Malformed entries are silently skipped.
- When unset or empty, defaults apply: `longcat → provider-ban`, all others → `model-skip`.

### TR-3: Proxy Refactoring Requirements

`proxy.ts` must be refactored to:

1. **Replace all inline `getProtectionLevel()` calls with `evaluateThreadProtection()`** where the error context is available (5xx, truncation, retryable errors). This means constructing an `ErrorContext` object with `platform`, `kind`, `midStream`, and `modelDbId`, then acting on the `ThreadProtectionAction`.

2. **Extract a helper function** for the common pattern of "should I ban this platform for this session?" that wraps `getProtectionLevel()` + `evaluateThreadProtection()` into a single call. This helper should be used by:
   - The active-request safeguard (currently at the top of `handleChatCompletion`)
   - The provider-ban sticky cooldown check
   - The mid-stream error handler
   - The non-streaming retryable error handler

3. **Remove all hardcoded platform name strings** from `proxy.ts`. The only place platform names should appear is in the `THREAD_PROTECTION_PLATFORMS` env var or the database.

4. **Preserve the existing sticky-session behavior** — `setStickyModel`, `getStickyModel`, `clearStickyModel`, `banPlatformFromSession`, etc. must continue to work identically. The refactoring only changes *how* the protection level is determined, not *what* actions are taken.

### TR-4: Migration Plan

1. **Phase 1 — Add `evaluateThreadProtection()` calls alongside existing checks** (no behavior change). Each hardcoded branch in `proxy.ts` should call `evaluateThreadProtection()` and compare the result with the existing behavior to verify correctness.

2. **Phase 2 — Replace hardcoded branches with rules engine calls**. Once verified, remove the inline `getProtectionLevel()` comparisons and rely solely on `evaluateThreadProtection()`.

3. **Phase 3 — Add tests** for the generalized behavior:
   - A platform configured as `provider-ban` triggers provider-ban on 5xx, truncation, and retryable errors.
   - A platform configured as `model-skip` triggers model-skip on all error types.
   - A platform configured as `off` triggers no protection actions.
   - The active-request safeguard excludes `provider-ban` platforms.
   - The sticky cooldown applies to all `provider-ban` platforms.

4. **Phase 4 — Remove dead code** — After all branches are generalized, remove any now-unused inline protection checks.

### TR-5: Test Requirements

- Unit tests for `parseProtectionConfig()` covering: valid input, empty input, malformed entries, case insensitivity, default fallback.
- Unit tests for `evaluateThreadProtection()` covering all 3 protection levels × 3 error kinds × 2 mid-stream states (18 combinations).
- Integration tests verifying that `proxy.ts` correctly applies protection actions for each configured level.
- Regression tests confirming that the default configuration (`longcat:provider-ban`, others: `model-skip`) produces identical behavior to the current code.
