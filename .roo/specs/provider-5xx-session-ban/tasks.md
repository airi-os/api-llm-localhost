# Tasks: Provider 5xx Session Ban

## Implementation Steps

- [x] 1. Extend `stickySessionMap` value type in `proxy.ts`
  - Edit line 16: add `consecutiveFailures?: Map<string, number>` to the map value type
  - This is the foundational type change — all other changes depend on it

- [x] 2. Add `recordConsecutiveFailure()` function in `proxy.ts`
  - Add after `banPlatformFromSession()` (after line 115)
  - Parameters: `messages`, `routingMode`, `provider`, `skipModels`, `modelDbId?`
  - Creates sticky entry if needed (when `modelDbId` is provided)
  - Increments `consecutiveFailures` counter for the provider
  - Logs the current count (e.g., `consecutive 5xx for ${provider}: ${count}/2`)
  - If count >= 2: calls `banPlatformFromSession()` logic inline (adds to `bannedPlatforms`, calls `addProviderModelsToSkipModels()`, deletes the consecutive failure entry)
  - Refreshes `lastUsed` TTL

- [x] 3. Add `resetConsecutiveFailures()` function in `proxy.ts`
  - Add after `recordConsecutiveFailure()`
  - Parameters: `messages`, `routingMode`, `provider`
  - Deletes the provider's entry from `consecutiveFailures` map if it exists
  - Logs the reset

- [x] 4. Add `resetAllConsecutiveFailures()` function in `proxy.ts`
  - Add after `resetConsecutiveFailures()`
  - Parameters: `messages`, `routingMode`
  - Clears the entire `consecutiveFailures` map if it has entries
  - Logs the reset

- [x] 5. Add `addProviderModelsToSkipModels()` function in `proxy.ts`
  - Replace the existing `addLongcatModelsToSkipModels()` function (lines 117-126)
  - Parameters: `skipModels: Set<number>`, `provider: string`
  - Queries DB: `SELECT id FROM models WHERE platform = ? AND enabled = 1` with the provider parameter
  - Adds each model ID to `skipModels`
  - Logs count and IDs

- [x] 6. Update `getStickyKey()` to check `bannedPlatforms` for any platform
  - In `getStickyKey()` (lines 54-79), after the TTL check, add:
    - Look up the sticky model's platform via DB query: `SELECT platform FROM models WHERE id = ?`
    - If the model's platform is in `entry.bannedPlatforms`, return `undefined`
    - Log: `[Sticky] key skipped session=... | model platform=... is banned`
  - This generalizes the existing LongCat-specific check that was in the pre-routing section

- [x] 7. Update pre-routing ban check in `handleChatCompletion()`
  - Replace the LongCat-specific ban check (lines 1138-1152) with a generic version:
    - Instead of hardcoding `'longcat'`, look up the `preferredModel`'s platform dynamically
    - If `preferredModel` exists, query its platform from the DB
    - If the session is banned from that platform, add all its models to `skipModels` and clear `preferredModel`/`preferredKeyId`
  - This handles the case where the sticky model points to a banned provider

- [x] 8. Replace LongCat-specific auth/rate-limit error handling with general 5xx consecutive failure detection
  - In the `catch (err)` block (lines 1383-1402), remove the LongCat-specific auth error ban (lines 1384-1389) and rate-limit error ban (lines 1390-1395)
  - Replace with: check if `getErrorStatus(err)` is a 5xx status (500-509)
  - If 5xx: call `recordConsecutiveFailure(normalizedMessages, routingMode, route.platform, skipModels, route.modelDbId)`
  - If the provider was just banned (check `isSessionBannedFromPlatform`), clear `preferredModel` and `preferredKeyId` if they point to the banned provider
  - Keep the existing `isAuthError()` handling for non-LongCat auth errors (clear sticky key)
  - Keep the existing `isRetryableError()` / `shouldSkipModelOnRetry()` logic

- [x] 9. Add success path counter reset
  - In the streaming success path (after `setStickyModel()` around line 1291): add `resetAllConsecutiveFailures(normalizedMessages, routingMode)`
  - In the non-streaming success path (after `setStickyModel()` around line 1362): add `resetAllConsecutiveFailures(normalizedMessages, routingMode)`
  - This ensures that a successful response clears any accumulated failure counters

- [x] 10. Update mid-stream error handling with consecutive failure tracking and generalized truncation detection
  - In the `catch (streamErr)` block for mid-stream errors (around lines 1294-1346):
    - Remove the LongCat-specific truncation handling (lines 1297-1318)
    - Add: check if `getErrorStatus(streamErr)` is a 5xx status
    - If 5xx: call `recordConsecutiveFailure(normalizedMessages, routingMode, route.platform, skipModels, route.modelDbId)`
    - Add: generalized truncation detection for any provider using `isTruncatedResponse()` on partial stream content
    - If truncated: call `banPlatformFromSession(normalizedMessages, routingMode, route.platform, route.modelDbId)`
    - Keep the existing mid-stream error SSE event behavior (send error event + return)

- [x] 11. Generalize post-stream truncation detection to all providers
  - Update the post-stream truncation check (lines 1236-1242):
    - Remove the `route.platform === 'longcat'` guard
    - Apply `isTruncatedResponse()` check to any provider
    - Update log message to use `route.platform` instead of hardcoded `'longcat'`
  - The `isTruncatedResponse()` function itself is NOT modified — it already checks content patterns regardless of provider

- [x] 12. Remove `addLongcatModelsToSkipModels()` function
  - Already replaced by `addProviderModelsToSkipModels()` in step 5
  - Remove it from the exports block

- [x] 13. Update exports block
  - In the exports block (lines 146-157):
    - Remove: `addLongcatModelsToSkipModels`
    - Keep: `isTruncatedResponse` (retained for all providers)
    - Add: `addProviderModelsToSkipModels`, `recordConsecutiveFailure`, `resetConsecutiveFailures`, `resetAllConsecutiveFailures`

- [x] 14. Update tests — rename and rewrite
  - Rename `server/src/__tests__/routes/longcat-session-ban.test.ts` to `provider-session-ban.test.ts`
  - Update imports: replace `addLongcatModelsToSkipModels` with `addProviderModelsToSkipModels`
  - Keep `isTruncatedResponse` import and test suite (it is retained)
  - Update `addLongcatModelsToSkipModels` tests to use `addProviderModelsToSkipModels` with a generic provider parameter
  - Add test suite for `recordConsecutiveFailure()`:
    - Increments counter on first 5xx
    - Bans provider on second consecutive 5xx
    - Adds provider models to skipModels on ban
    - Creates sticky entry if modelDbId provided
    - Does not create entry if no modelDbId and no existing entry
  - Add test suite for `resetConsecutiveFailures()`:
    - Resets counter for specific provider
    - No-op if no sticky session
    - No-op if provider has no counter
  - Add test suite for `resetAllConsecutiveFailures()`:
    - Clears all counters
    - No-op if no sticky session
    - No-op if no consecutive failures
  - Add test suite for `addProviderModelsToSkipModels()`:
    - Adds all models of given provider to skipModels
    - Does not add models of other providers
    - Handles empty model list gracefully
  - Update integration tests to use generic provider names instead of hardcoded 'longcat'
  - Add integration test: two consecutive 503 errors from same provider triggers ban
  - Add integration test: success resets consecutive failure counter
  - Add integration test: 5xx from provider A, success from provider B resets A's counter
  - Add integration test: truncated response from any provider (not just LongCat) triggers ban
  - Add integration test: mid-stream truncation from any provider triggers ban

- [x] 15. TypeScript compilation check
  - Run `npx tsc --noEmit` in the `server/` directory
  - Ensure no type errors from the new `consecutiveFailures` field or new functions
  - Ensure no errors from removed function (`addLongcatModelsToSkipModels`)
  - Ensure no errors from retained function (`isTruncatedResponse`)

- [x] 16. Run all tests
  - Run `npm test` in the `server/` directory
  - Verify no regressions in router tests, proxy tests, or sticky session behavior
  - Verify all new provider ban tests pass
  - Verify truncation detection tests pass for any provider
