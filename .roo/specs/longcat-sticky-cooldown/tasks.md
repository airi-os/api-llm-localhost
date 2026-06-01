# Tasks: LongCat Sticky Session Cooldown Safeguard

## Task List

- [x] Add `LONGCAT_STICKY_COOLDOWN_MS` constant (3 * 60 * 1000) after `STICKY_TTL_MS` in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:17)
- [x] Add cooldown check logic in [`handleChatCompletion()`](server/src/routes/proxy.ts:1240) — after ban check clears `preferredModel`, before the retry loop: if `preferredModel` is on `longcat` platform AND `stickySessionMap` entry's `lastUsed` is within `LONGCAT_STICKY_COOLDOWN_MS`, set `preferredModel = undefined` and `preferredKeyId = undefined` with log message
- [x] Add unit tests in [`server/src/__tests__/routes/proxy-tools.test.ts`](server/src/__tests__/routes/proxy-tools.test.ts) covering: cooldown active (suppresses preference), cooldown expired (preserves preference), non-LongCat provider (no cooldown), ban precedence over cooldown, no sticky session (no effect), explicit model request (cooldown doesn't apply)
- [x] Run existing test suite to verify no regressions: `pnpm --filter server test`
- [ ] Manual smoke test: send rapid requests to a LongCat-pinned session and verify that requests within 3 min bypass sticky preference while requests after 3 min resume it