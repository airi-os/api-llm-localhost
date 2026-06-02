# Tasks: Provider 5xx Session Ban

## Implementation Steps

- [x] 1. Add `addProviderModelsToSkipModels()` function in `proxy.ts`
  - Replace the existing `addLongcatModelsToSkipModels()` function
  - Parameters: `skipModels: Set<number>`, `provider: string`
  - Queries DB: `SELECT id FROM models WHERE platform = ? AND enabled = 1` with the provider parameter
  - Adds each model ID to `skipModels`
  - Logs count and IDs

- [x] 2. Update `getStickyKey()` to check `bannedPlatforms` for any platform
  - In `getStickyKey()`, after the TTL check, add:
    - Look up the sticky model's platform via DB query: `SELECT platform FROM models WHERE id = ?`
    - If the model's platform is in `entry.bannedPlatforms`, return `undefined`
    - Log: `[Sticky] key skipped session=... | model platform=... is banned`

- [x] 3. Update pre-routing ban check in `handleChatCompletion()`
  - Replace the LongCat-specific ban check with a generic version:
    - Instead of hardcoding `'longcat'`, look up the `preferredModel`'s platform dynamically
    - If `preferredModel` exists, query its platform from the DB
    - If the session is banned from that platform, add all its models to `skipModels` and clear `preferredModel`/`preferredKeyId`

- [x] 4. Implement differentiated LongCat/non-LongCat error handling in retry loop
  - In the `catch (err)` block:
    - For **LongCat** 5xx errors: call `banPlatformFromSession()` and `addProviderModelsToSkipModels()` for immediate platform exclusion
    - For **non-LongCat** 5xx errors: add only the failed model to `skipModels` via `skipModels.add(route.modelDbId)` (no provider-wide ban)
    - Remove references to `recordConsecutiveFailure()`, `resetConsecutiveFailures()`, `consecutiveFailures` counter (they were dead code)
    - Keep the existing `isAuthError()` handling for auth errors (clear sticky key)
    - Keep the existing `isRetryableError()` / `shouldSkipModelOnRetry()` logic

- [x] 5. Implement generalized truncation detection for all providers
  - In the post-stream truncation check:
    - Remove the `route.platform === 'longcat'` guard
    - Apply `isTruncatedResponse()` check to any provider
    - Call `banPlatformFromSession()` for the detected provider
    - For LongCat, also call `addProviderModelsToSkipModels()`
    - Update log message to use `route.platform` instead of hardcoded `'longcat'`
  - In the mid-stream error handling:
    - Apply `isTruncatedResponse()` to partial stream content for any provider
    - If truncated: call `banPlatformFromSession()` for the detected provider
    - Keep the existing mid-stream error SSE event behavior

- [x] 6. Remove `addLongcatModelsToSkipModels()` function
  - Already replaced by `addProviderModelsToSkipModels()` in step 1
  - Remove it from the exports block

- [x] 7. Update exports block
  - In the exports block:
    - Remove: `addLongcatModelsToSkipModels`
    - Keep: `isTruncatedResponse` (retained for all providers)
    - Add: `addProviderModelsToSkipModels`
    - Remove references to `recordConsecutiveFailure`, `resetConsecutiveFailures`, `resetAllConsecutiveFailures` (dead code)

- [x] 8. Update tests
  - Update imports: replace `addLongcatModelsToSkipModels` with `addProviderModelsToSkipModels`
  - Keep `isTruncatedResponse` import and test suite (it is retained)
  - Add test suite for `addProviderModelsToSkipModels()`:
    - Adds all models of given provider to skipModels
    - Does not add models of other providers
    - Handles empty model list gracefully
  - Add integration test: LongCat 5xx triggers immediate platform ban via `banPlatformFromSession()`
  - Add integration test: non-LongCat 5xx triggers model-level skip only (no platform ban)
  - Add integration test: truncated response from any provider triggers ban via `banPlatformFromSession()`
  - Add integration test: mid-stream truncation from any provider triggers ban
  - Remove tests for `recordConsecutiveFailure()`, `resetConsecutiveFailures()`, `resetAllConsecutiveFailures()` (dead code)

- [x] 9. TypeScript compilation check
  - Run `npx tsc --noEmit` in the `server/` directory
  - Ensure no type errors from the new functions
  - Ensure no errors from removed dead code references

- [x] 10. Run all tests
  - Run `npm test` in the `server/` directory
  - Verify no regressions in router tests, proxy tests, or sticky session behavior
  - Verify all new provider ban tests pass
  - Verify truncation detection tests pass for any provider