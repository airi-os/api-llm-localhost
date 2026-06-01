# Tasks: LongCat Sticky Session Cooldown Safeguard

## Task List

- [x] Add `LONGCAT_STICKY_COOLDOWN_MS` constant (3 * 60 * 1000) after `STICKY_TTL_MS` in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:17)
- [x] **Replace** existing cooldown check logic in [`handleChatCompletion()`](server/src/routes/proxy.ts:1243) — instead of clearing `preferredModel`/`preferredKeyId`, add LongCat models to `skipModels` via `addProviderModelsToSkipModels(skipModels, 'longcat')`. Keep `preferredModel`/`preferredKeyId` intact.
- [x] **Modify** `skipModels` check in [`server/src/services/router.ts`](server/src/services/router.ts:539) to exclude the sticky model: `if (skipModels?.has(entry.model_db_id) && entry.model_db_id !== preferredModelDbId) continue;`
- [x] **Update** unit tests in [`server/src/__tests__/routes/proxy-tools.test.ts`](server/src/__tests__/routes/proxy-tools.test.ts) to match new behavior: cooldown adds LongCat to skipModels instead of clearing sticky preference
- [x] Run existing test suite to verify no regressions: `pnpm --filter server test` — all 156 tests pass