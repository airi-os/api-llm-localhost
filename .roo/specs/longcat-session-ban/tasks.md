# Tasks: LongCat Session Ban & Fallback

## Implementation Steps

- [x] 1. Extend `stickySessionMap` value type in `proxy.ts`
  - Edit line 16: add `bannedPlatforms?: Set<string>` to the map value type
  - This is the foundational type change — all other changes depend on it

- [x] 2. Add `isSessionBannedFromPlatform()` function in `proxy.ts`
  - Add after `getStickyKey()` (after line 79)
  - Parameters: `messages`, `routingMode`, `platform`
  - Returns `boolean` — checks if the session's `bannedPlatforms` set contains the given platform
  - Includes TTL check (expired sessions have no bans)
  - Add diagnostic logging

- [x] 3. Add `banPlatformFromSession()` function in `proxy.ts`
  - Add after `isSessionBannedFromPlatform()`
  - Parameters: `messages`, `routingMode`, `platform`
  - Creates or adds to `bannedPlatforms` set in the sticky session entry
  - Refreshes `lastUsed` TTL so the ban persists
  - Add diagnostic logging with banned platforms list

- [x] 4. Add `addLongcatModelsToSkipModels()` helper in `proxy.ts`
  - Add after `banPlatformFromSession()`
  - Queries DB for all enabled LongCat model IDs: `SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1`
  - Adds each to the `skipModels` set
  - Add diagnostic logging with count and IDs

- [x] 5. Add `isTruncatedResponse()` function in `proxy.ts`
  - Add after `addLongcatModelsToSkipModels()`
  - Parameters: `errOrContent: any`
  - Returns `boolean` — checks for truncation keywords in stringified input
  - Keywords: 'truncated', 'truncation'
  - Case-insensitive matching

- [x] 6. Update `getStickyKey()` to check session bans
  - In `getStickyKey()` (lines 54-79), after TTL check, add:
    - Look up the sticky model's platform via DB query
    - If the model's platform is in `entry.bannedPlatforms`, return `undefined`
    - Add diagnostic logging for skipped sticky keys due to bans

- [x] 7. Update `setStickyModel()` to preserve `bannedPlatforms`
  - In `setStickyModel()` (lines 100-112), before setting the new entry:
    - Get existing entry from `stickySessionMap`
    - Preserve `bannedPlatforms` from existing entry (if any)
    - Include `bannedPlatforms` in the new map entry
  - Update log message to include banned platforms count when present

- [x] 8. Update pre-routing logic in `handleChatCompletion()`
  - After determining `preferredModel` and `preferredKeyId` (around lines 1035-1053):
    - Check `isSessionBannedFromPlatform(normalizedMessages, routingMode, 'longcat')`
    - If banned:
      - Call `addLongcatModelsToSkipModels(skipModels)`
      - If `preferredModel` points to a LongCat model, set `preferredModel = undefined` and `preferredKeyId = undefined`
      - Add diagnostic logging
  - Move `skipModels` initialization earlier (before the ban check) or create it at the ban check point
  - Note: `skipModels` is currently initialized at line 1058 — need to ensure it exists before the ban check

- [x] 9. Update error handling in retry loop for LongCat-specific bans
  - In the `catch (err)` block (around lines 1245-1282):
    - After logging the request error, check if `route.platform === 'longcat'`
    - If LongCat + auth error: call `banPlatformFromSession()`, `addLongcatModelsToSkipModels()`, clear `preferredKeyId`
    - If LongCat + rate-limit error: call `banPlatformFromSession()`, `addLongcatModelsToSkipModels()`, clear `preferredKeyId`
    - If LongCat + truncated response: call `banPlatformFromSession()`, `addLongcatModelsToSkipModels()`, clear `preferredKeyId`
    - Keep existing auth error handling for non-LongCat (`clearStickyKey()` + `preferredKeyId = undefined`)
    - Keep existing `isRetryableError()` and `shouldSkipModelOnRetry()` logic
    - Keep existing non-retryable error handling (`clearStickyModel()`)

- [x] 10. Add truncated response detection after stream completes
  - After the streaming `for await` loop completes (around line 1133-1147):
    - Check `route.platform === 'longcat'` and `isTruncatedResponse(streamedText)`
    - If detected: call `banPlatformFromSession(normalizedMessages, routingMode, 'longcat')`
    - Add diagnostic logging
    - Note: the stream has already been sent to the client — no retry within the same request
    - Future requests in this session will route to non-LongCat models
  - For Responses API streaming: check `responseStreamContext.outputText` instead of `streamedText`

- [x] 11. Add truncation detection in mid-stream error handling
  - In the `catch (streamErr)` block for mid-stream errors (around lines 1185-1214):
    - Check `route.platform === 'longcat'` and `isTruncatedResponse(streamErr.message)`
    - If detected:
      - Call `banPlatformFromSession(normalizedMessages, routingMode, 'longcat')`
      - End the stream gracefully (send completion event, not error event)
      - Return — client receives truncated response as-is
    - If not truncation: keep existing mid-stream error behavior (send error SSE event + return)

    - Add diagnostic logging for both paths

- [x] 12. Verify TypeScript compilation
  - Run `npx tsc --noEmit` in the `server/` directory
  - Ensure no type errors from the new `bannedPlatforms` field or new functions

- [ ] 13. Run existing tests
  - Run `npm test` in the `server/` directory
  - Verify no regressions in router tests, proxy tests, or sticky session behavior

- [ ] 14. Add new unit tests for ban functionality
  - Test `isSessionBannedFromPlatform()` — no session, expired session, banned session, non-banned session
  - Test `banPlatformFromSession()` — adds platform to banned set, preserves existing bans
  - Test `isTruncatedResponse()` — various truncation keywords, non-truncation strings
  - Test `addLongcatModelsToSkipModels()` — adds LongCat model IDs to skip set
  - Test `setStickyModel()` preserves `bannedPlatforms` when updating sticky model
  - Test `getStickyKey()` returns `undefined` when session is banned from model's platform

- [ ] 15. Manual integration testing
  - Add a LongCat API key via the Keys page
  - Send a chat completion request and verify it routes through LongCat
  - Send a second request with same first user message — verify sticky key is used
  - Simulate auth error (disable key mid-session) — verify LongCat is banned and fallback occurs
  - Send a third request — verify it routes to non-LongCat model ( LongCat is still banned)
  - Wait for session TTL to expire (30 min) — verify LongCat is no longer banned