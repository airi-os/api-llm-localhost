# Model Pool-Based Routing Test Tasks

## Task List

- [x] Create test file for `getModelPool` function (`server/src/__tests__/routes/fallback-pool.test.ts`)
- [x] Create test file for smart mode routing (`server/src/__tests__/services/router-smart-mode.test.ts`)
- [x] Create test file for balanced mode exclusions (`server/src/__tests__/services/router-balanced-mode.test.ts`)
- [x] Create test file for rate limit penalties (`server/src/__tests__/services/router-penalties.test.ts`)
- [x] Create test file for sticky session behavior (`server/src/__tests__/services/router-sticky.test.ts`)
- [x] Create integration test file for pool-based routing (`server/src/__tests__/services/router-pools.test.ts`)
- [x] Add tests for LongCat preference in smart mode
- [x] Add tests for Owl Alpha preference in smart mode
- [x] Add tests for LongCat/Owl Alpha combined preference
- [x] Add tests for LongCat/Owl Alpha exclusion in balanced mode
- [x] Add tests for sticky session override of exclusions
- [x] Add tests for penalty application when all keys exhausted
- [x] Add tests for penalty decay over time
- [x] Add tests for penalty cap enforcement
- [x] Add tests for success reducing penalty
- [x] Add tests for preferred key selection
- [x] Add tests for preferred model pinning
- [x] Add tests for mixed pool scenarios
- [x] Add tests for cross-pool fallback
- [x] Run all tests to verify they pass
- [x] Verify test coverage meets requirements

## Implementation Notes

### Task 1: getModelPool Tests
- Test each pool classification rule
- Use direct function call (no HTTP needed)
- Verify all edge cases for model naming

### Task 2: Smart Mode Routing Tests
- Mock ratelimit to control key availability
- Test LongCat preference logic
- Test Owl Alpha preference logic
- Verify sorting order after preference application

### Task 3: Balanced Mode Exclusion Tests
- Test exclusion sets in router.ts
- Verify LongCat is filtered out
- Verify Owl Alpha is filtered out
- Test sticky session override

### Task 4: Rate Limit Penalty Tests
- Test recordRateLimitHit function
- Test recordSuccess function
- Test getPenalty function with time decay
- Test MAX_PENALTY cap

### Task 5: Sticky Session Tests
- Test preferredModelDbId parameter
- Test preferredKeyId parameter
- Test interaction with exclusions

### Task 6: Integration Tests
- Combine multiple scenarios
- Test full request flow
- Verify pool assignments in responses