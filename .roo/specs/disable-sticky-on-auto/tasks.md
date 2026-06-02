# Tasks: Disable Sticky Threads on Auto Endpoint

## Task List

- [x] **T1: Modify `getSessionKey()` in `server/src/routes/proxy.ts`** — Add an early return for `routingMode === 'balanced'` that returns an empty string, disabling all sticky session operations for the auto/balanced endpoint. This is the single code change that cascades through all sticky functions.

- [x] **T2: Add balanced-mode sticky skip tests in `server/src/__tests__/routes/provider-session-ban.test.ts`** — Add a new `describe` block verifying that balanced mode skips sticky operations:
  - `getStickyModel()` returns `undefined` for balanced mode even when a smart-mode sticky entry exists for the same messages
  - `isSessionBannedFromPlatform()` returns `false` for balanced mode
  - `banPlatformFromSession()` does not create entries for balanced mode
  - `setStickyModel()` does not create entries for balanced mode
  - `getSessionKey()` returns `''` for balanced mode

- [x] **T3: Run existing test suite** — Verify all existing tests in `provider-session-ban.test.ts` and `full-flow.test.ts` still pass after the change.

- [ ] **T4: Manual smoke test** — Send a request to `freellmapi/auto` and confirm logs show `[Sticky] miss key= | msgs=... → free routing` (empty key prefix) rather than a sticky hit. Send a follow-up request with the same first user message and confirm it routes freely again rather than pinning.