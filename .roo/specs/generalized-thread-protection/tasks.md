# Tasks: Generalized Thread Protection (Exclusive Model Sessions)

## Implementation Tasks

- [ ] T-1: Rename `LONGCAT_STICKY_COOLDOWN_MS` to `THREAD_COOLDOWN_MS` in [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts:18) and update all references throughout the file
- [ ] T-2: Remove the hardcoded LongCat cooldown block (the `if (preferredModel)` block checking `prefRow?.platform === 'longcat'` and calling `addProviderModelsToSkipModels(skipModels, 'longcat')`)
- [ ] T-3: Remove the hardcoded Owl Alpha cooldown block (the `if (preferredModel)` block checking `prefRow?.platform === 'openrouter' && prefRow?.model_id === 'owl-alpha'` and calling `skipModels.add(preferredModel)`)
- [ ] T-4: Insert the generalized thread protection scanner at the same location where the removed blocks were, after the session ban sticky override and before the retry loop — including the `activeCooldownModels` collection loop, the exhaustion protection SQL query, and the conditional `skipModels` addition
- [ ] T-5: Verify the execution order of the `skipModels` pipeline: session bans → transient cooldowns → global cooldown sticky override → session ban sticky override → thread protection scanner → retry loop
- [ ] T-6: Create [`server/src/__tests__/routes/thread-protection.test.ts`](server/src/__tests__/routes/thread-protection.test.ts) with unit tests covering: dynamic exclusivity, exhaustion bypass, self-preservation, expired entries, and multiple busy models
- [ ] T-7: Run the existing test suite to confirm no regressions in routing, fallback, or provider-session-ban tests
- [ ] T-8: Manual smoke test: send two concurrent requests from different sessions and verify thread protection logs appear correctly, and that the second session routes to an alternative model