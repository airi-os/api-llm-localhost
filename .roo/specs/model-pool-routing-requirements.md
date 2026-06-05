# Model Pool-Based Routing Test Requirements

## Overview

The goal is to fully instrument all paths with tests for the model pool-based routing system. This includes testing the server-side routing logic (smart/balanced/fast pools) and ensuring the UI screen showing the pools (fallback tab) is properly tested.

## Current State Analysis

### Existing Test Coverage
- `server/src/__tests__/services/router.test.ts` - Basic tests covering:
  - No keys configured
  - Single key routing
  - Multiple platform key routing
  - Disabled key skipping

- `server/src/__tests__/services/routing-exhaustion.test.ts` - Key exhaustion tests covering:
  - Skipping exhausted keys
  - All keys exhausted error
  - Fallback to alternative models

- `server/src/__tests__/routes/fallback.test.ts` - API endpoint tests covering:
  - GET /api/fallback returns chain
  - Pool field validation
  - PUT /api/fallback updates
  - Sort endpoints

### Missing Test Coverage

#### 1. Pool-Based Routing Logic (router.ts)
- **Smart Mode**:
  - LongCat platform preference when keys available
  - LongCat platform skipped when no valid keys
  - Owl Alpha model preference when keys available
  - Owl Alpha model skipped when no valid keys
  - LongCat + Owl Alpha combined preference (LongCat first, then Owl Alpha)
  - Smart mode score calculation (intelligence weight 60%)

- **Balanced Mode**:
  - LongCat platform exclusion (unless sticky session)
  - Owl Alpha model exclusion (unless sticky session)
  - Balanced mode score calculation (intelligence weight 10%)

- **Fast Pool**:
  - Models ending with `-fast` suffix
  - `openai-fast` model identifier
  - Fast pool models in routing

#### 2. Rate Limit Penalty System
- Penalty application when ALL keys for a model are exhausted by 429
- Penalty decay over time (2-minute intervals)
- Penalty cap at MAX_PENALTY (10)
- Model recovery after success (penalty reduction)
- Penalty impact on effective score

#### 3. Sticky Session Behavior
- Preferred model pinning in balanced mode
- Preferred model pinning in smart mode
- Preferred key selection within model
- Sticky session with excluded models (LongCat/Owl Alpha)

#### 4. getModelPool Function (fallback.ts)
- LongCat platform → Smart pool
- Owl Alpha model → Smart pool
- `-fast` suffix models → Fast pool
- `openai-fast` model → Fast pool
- All other models → Balanced pool

#### 5. Edge Cases
- Mixed pool scenarios (multiple pools with different key states)
- All keys exhausted in one pool but available in another
- Rate limit penalty across different pools
- Empty pool (no models in a specific pool)
- Single model in a pool with exhausted keys

## Requirements

### Functional Requirements

1. **FR-1**: Test smart mode routing with LongCat preference
   - When LongCat has valid keys, it should be prioritized
   - When LongCat has no valid keys, it should be skipped
   - LongCat should be moved to front of sorted chain

2. **FR-2**: Test smart mode routing with Owl Alpha preference
   - When Owl Alpha has valid keys, it should be prioritized
   - When Owl Alpha has no valid keys, it should be skipped
   - Owl Alpha should be positioned after LongCat (if LongCat is preferred)

3. **FR-3**: Test balanced mode exclusions
   - LongCat platform should be excluded from balanced routing
   - Owl Alpha model should be excluded from balanced routing
   - Sticky session should override exclusions

4. **FR-4**: Test fast pool model identification
   - Models with `-fast` suffix should return Fast pool
   - `openai-fast` model should return Fast pool
   - Other models should return Balanced or Smart pool

5. **FR-5**: Test rate limit penalty system
   - Penalty applied only when ALL keys for a model are exhausted
   - Penalty decays over time
   - Penalty reduces effective score
   - Success reduces penalty

6. **FR-6**: Test sticky key behavior
   - Preferred key is tried first
   - Fallback to round-robin if preferred key unavailable
   - Key exhaustion tracking per model

### Non-Functional Requirements

1. **NFR-1**: Test coverage must include both happy paths and error/failure scenarios
2. **NFR-2**: Tests should be deterministic and not rely on random sampling
3. **NFR-3**: Tests should cover integration between router and fallback endpoints
4. **NFR-4**: Tests should verify pool assignments are correct in API responses

## Test Scenarios to Cover

### Smart Mode Routing Tests
- [ ] LongCat with valid keys is prioritized
- [ ] LongCat without valid keys is skipped
- [ ] Owl Alpha with valid keys is prioritized
- [ ] Owl Alpha without valid keys is skipped
- [ ] LongCat + Owl Alpha both available (LongCat first)
- [ ] LongCat + Owl Alpha both unavailable (fallback to other models)
- [ ] Smart mode score includes intelligence weight

### Balanced Mode Routing Tests
- [ ] LongCat excluded from balanced routing
- [ ] Owl Alpha excluded from balanced routing
- [ ] Sticky session allows LongCat in balanced mode
- [ ] Sticky session allows Owl Alpha in balanced mode
- [ ] Balanced mode score includes low intelligence weight

### Fast Pool Tests
- [ ] `-fast` suffix model returns Fast pool
- [ ] `openai-fast` model returns Fast pool
- [ ] Fast pool models in routing chain

### Rate Limit Penalty Tests
- [ ] Penalty applied when all keys exhausted
- [ ] Penalty decays over time
- [ ] Penalty cap at 10
- [ ] Success reduces penalty
- [ ] Penalty affects routing order

### Sticky Session Tests
- [ ] Preferred model pinning works
- [ ] Preferred key selection works
- [ ] Sticky session with excluded models

### getModelPool Function Tests
- [ ] LongCat platform → Smart
- [ ] Owl Alpha model → Smart
- [ ] `-fast` models → Fast
- [ ] `openai-fast` → Fast
- [ ] Other models → Balanced

### Integration Tests
- [ ] Fallback API returns correct pool values
- [ ] Pool values match routing behavior
- [ ] Mixed pool scenarios in full flow