# Tasks: Shared Temporary Cooldowns for Concurrent Failure Mitigation

## Implementation Tasks

- [ ] **T-1**: Declare `transientModelCooldowns` Map and `TRANSIENT_COOLDOWN_MS` constant at module level in [`proxy.ts`](server/src/routes/proxy.ts:16) near the existing `stickySessionMap` declaration
- [ ] **T-2**: Export `transientModelCooldowns` and `TRANSIENT_COOLDOWN_MS` from [`proxy.ts`](server/src/routes/proxy.ts:170) in the existing export block for test access
- [ ] **T-3**: Add pre-routing cooldown injection logic inside [`handleChatCompletion()`](server/src/routes/proxy.ts:1061) — after `skipModels` initialization at [line 1179](server/src/routes/proxy.ts:1179) and before the retry loop at [line 1245](server/src/routes/proxy.ts:1245). Iterate `transientModelCooldowns`, prune expired entries, and add active cooldowns to `skipModels`
- [ ] **T-4**: Add sticky session override logic — after cooldown injection, check if `preferredModel` is on global cooldown and clear `preferredModel`/`preferredKeyId` if so. Place this after the existing session-ban platform check at [line 1195](server/src/routes/proxy.ts:1195)
- [ ] **T-5**: Register global cooldown in the retry loop catch block at [line 1570](server/src/routes/proxy.ts:1570) — when `errStatus` is `5xx` or `undefined` (connection failure) and `isRetryableError(err)` is true, set `transientModelCooldowns.set(route.modelDbId, Date.now() + TRANSIENT_COOLDOWN_MS)` and add to local `skipModels`
- [ ] **T-6**: Register global cooldown for mid-stream `5xx` errors in the streaming error handler at [line 1392](server/src/routes/proxy.ts:1392) — when `streamErrStatus` is ban-eligible, set `transientModelCooldowns.set(route.modelDbId, Date.now() + TRANSIENT_COOLDOWN_MS)` alongside the existing `skipModels.add()`
- [ ] **T-7**: Create test file `server/src/__tests__/routes/transient-cooldown.test.ts` with unit tests for:
  - Cooldown injection and expired entry pruning
  - Cooldown registration on `5xx` errors (and exclusion for `429`/`401`/`400`)
  - Sticky session override when preferred model is on global cooldown
  - Auto-recovery after cooldown expiry
- [ ] **T-8**: Run existing test suite to verify no regressions in [`proxy-tools.test.ts`](server/src/__tests__/routes/proxy-tools.test.ts), [`provider-session-ban.test.ts`](server/src/__tests__/routes/provider-session-ban.test.ts), and [`router.test.ts`](server/src/__tests__/services/router.test.ts)