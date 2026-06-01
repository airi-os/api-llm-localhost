# Tasks: LongCat Smart-Auto Preference

## Implementation

- [x] 1. Add LongCat preference logic to routeRequest in server/src/services/router.ts
  - After score computation and sorting, before sticky session pinning
  - Only active when routingMode is "smart"
  - Check if any LongCat key has remaining rate-limit capacity
  - Move all LongCat entries to front of sorted array if capacity exists
  - Sticky session pinning (applied after) takes precedence for position 0

- [ ] 2. Verify existing tests pass
  - Run: cd server && npx vitest run src/__tests__/services/router.test.ts

- [ ] 3. Commit and push changes
