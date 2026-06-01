# Tasks: LongCat Sticky Key Implementation

## Implementation Steps

- [x] 1. Extend `stickySessionMap` value type in `proxy.ts`
  - Edit line 16: change `{ modelDbId: number; lastUsed: number }` to `{ modelDbId: number; keyId?: number; lastUsed: number }`
  - This is the foundational type change everything else depends on

- [x] 2. Add `getStickyKey()` function in `proxy.ts`
  - Add after `getStickyModel()` (after line 52)
  - Follow the same pattern: lookup by session key, check TTL, return `entry.keyId`
  - Add logging for hit/miss/expired (mirrors `getStickyModel()`)

- [x] 3. Update `setStickyModel()` to accept and store `keyId`
  - Edit line 62: add `keyId?: number` parameter
  - Include `keyId` in the `stickySessionMap.set()` call
  - Update log message to include key ID when present

- [x] 4. Add `preferredKeyId` parameter to `routeRequest()` in `router.ts`
  - Edit line 457: add `preferredKeyId?: number` as the last parameter
  - Update the JSDoc comment to document the new parameter

- [x] 5. Implement preferred key selection in router key loop
  - In the key selection loop (around line 528), add a pre-check before round-robin:
    - If `preferredKeyId` is defined, find the matching key in the `keys` array
    - Check if it's eligible (not skipped, not on cooldown, within limits)
    - If eligible, use it immediately and return the `RouteResult`
  - If preferred key is unavailable, fall through to existing round-robin logic unchanged

- [x] 6. Update proxy retry loop to pass `preferredKeyId` for LongCat
  - In `handleChatCompletion()` (around line 998-1016):
    - After getting `preferredModel`, check if it's a LongCat model via DB lookup
    - If LongCat, call `getStickyKey()` to get the stored key ID
    - Pass `preferredKeyId` to `routeRequest()`
  - Add the DB lookup: `SELECT platform FROM models WHERE id = ?`

- [x] 7. Pass `keyId` to `setStickyModel()` on success
  - In the non-streaming success path (line ~1174): pass `route.keyId`
  - In the streaming success path (line ~1127): pass `route.keyId`
  - Both paths already call `setStickyModel()` — just add the `keyId` argument

- [x] 8. Add logging for sticky key behavior
  - In `getStickyKey()`: log hit/miss/expired with key ID
  - In router: log when preferred key is used or when falling back to round-robin
  - In `setStickyModel()`: include key ID in existing log message

- [x] 9. Verify TypeScript compilation
  - Run `npx tsc --noEmit` in the `server/` directory
  - Ensure no type errors from the new optional `keyId` field or new parameter

- [x] 10. Run existing tests
  - Run `npm test` in the `server/` directory
  - Verify no regressions in router tests, proxy tests, or sticky session behavior

- [x] 11. Manual testing
   - Add a LongCat API key via the Keys page
   - Send a chat completion request and verify it routes through LongCat
   - Send a second request with the same first user message and verify the same key is used
   - Check logs for sticky key hit messages
   - Disable the LongCat key and verify fallback to round-robin with a new key

## Code Review Fixes (2025-07-18)

- [x] 12. Fix truthiness checks for keyId (use `!== undefined`)
   - `getStickyKey()`: `if (entry.keyId)` → `if (entry.keyId !== undefined)`
   - `setStickyModel()`: `keyId ? ...` → `keyId !== undefined ? ...`
   - Sticky key determination: `if (stickyKeyId)` → `if (stickyKeyId !== undefined)`

- [x] 13. Add `clearStickyKey()` and clear on 401/403 errors
   - Added `clearStickyKey()` function (mirrors `clearStickyModel()`)
   - In retry loop, detect 401/403 and call `clearStickyKey()` + unset `preferredKeyId`

- [x] 14. Add diagnostic logs for sticky key miss/expired/unset cases
   - `getStickyKey()` now logs miss (no session key, no entry), expired (TTL), and unset (entry exists but no keyId)

- [x] 15. Verify round-robin for new sessions
   - Confirmed: `getStickyKey()` returns `undefined` for new sessions → router falls through to round-robin
   - Sticky key only stored after successful response via `setStickyModel()`

- [x] 16. Update design.md
   - Removed conflicting alternatives (always-pass, simpler approach, no-gating)
   - Kept only the DB-gated approach for passing `preferredKeyId`
   - Updated error handling flow and edge cases
