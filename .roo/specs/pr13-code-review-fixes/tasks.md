# Tasks: PR #13 Code Review Fixes

## Task List

- [ ] BUG-01: Fix SQL parenthesis mismatch in `refreshStatsCache()`
- [ ] BUG-02: Fix wrapped error propagation in cloudflare, cohere, and openai-compat providers
- [ ] BUG-03: Add NaN guard in `base.ts` `throwWrappedError()`
- [ ] BUG-04: Replace hardcoded longcat/owl-alpha references in proxy.ts with rules engine calls
- [x] BUG-05: Abort upstream provider stream on stall detection
- [x] BUG-06: Fix cooldown guard to use routable chain instead of `models WHERE enabled = 1`
- [ ] BUG-07: Remove stray debug scripts from repo root
- [ ] BUG-08: Complete the truncated `generalized-thread-protection/requirements.md`
- [ ] BUG-09: Fix malformed SQL in `router.test.ts`
- [x] BUG-10: Remove double semicolon in proxy.ts
