# Fast Routing Mode Requirements

## Overview

Add a new `fast` routing mode that routes to fast pool models only, and expose it via a `freellmapi/auto-fast` endpoint.

## Current State

- **RoutingMode**: `'balanced' | 'smart'` (line 162 in router.ts)
- **ModelPool**: `'fast' | 'balanced' | 'smart'` (defined in shared/types.ts)
- **getModelPool()**: Classifies models into pools based on naming conventions (line 12-22 in fallback.ts)
  - Fast pool: models ending with `-fast` or `openai-fast`
  - Smart pool: LongCat platform, Owl Alpha model
  - Balanced pool: all other models

## Requirements

### 1. Routing Mode Extension

- [ ] Update `RoutingMode` type to include `'fast'`
- [ ] Add fast pool filtering logic in `routeRequest()` function
- [ ] Fast mode should only include models with `pool = 'fast'`

### 2. API Endpoint

- [ ] Add `AUTO_FAST_MODEL_ID = 'freellmapi/auto-fast'` constant
- [ ] Add `/models` entry for auto-fast endpoint
- [ ] Add `/models/:id` handler for auto-fast
- [ ] Route requests with model `freellmapi/auto-fast` to fast pool

### 3. UI Updates

- [ ] Update FallbackPage to show fast pool routing mode indicator
- [ ] Add auto-fast to the models list

### 4. Testing

- [ ] Add tests for fast mode routing
- [ ] Test that only fast pool models are selected in fast mode
- [ ] Test that non-fast models are excluded in fast mode
- [ ] Test auto-fast endpoint response

## User-Facing Behavior

When a user specifies `freellmapi/auto-fast` as the model:
1. The router filters to only fast pool models (those with `-fast` suffix)
2. Uses Thompson sampling to select the best fast model based on performance
3. Falls back through fast models if the first one is unavailable

## Technical Notes

- Fast mode should NOT exclude any pools (unlike balanced mode which excludes smart pool)
- Fast mode should use the same Thompson sampling as balanced mode
- Fast mode should respect rate limits and penalties like other modes