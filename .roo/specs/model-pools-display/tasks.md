# Tasks: Model Pools Display

## Backend Tasks

### Task 1: Add pool field to fallback route response
**File**: `server/src/routes/fallback.ts`

- [ ] Import `classifyModel` and `ModelPool` from router service
- [ ] Calculate min/max speed_rank and intelligence_rank across all models
- [ ] Add `pool` field to each entry in the response using `classifyModel()`
- [ ] Verify pool values match backend routing logic

### Task 2: Add pool field to analytics by-model response
**File**: `server/src/routes/analytics.ts`

- [ ] Import `classifyModel` and `ModelPool` from router service
- [ ] Add pool classification logic to the by-model query/response
- [ ] Add `pool` field to each model in the response

## Frontend Tasks

### Task 3: Create PoolBadge component
**File**: `client/src/components/pool-badge.tsx` (new)

- [ ] Create component with `pool` prop accepting 'fast' | 'balanced' | 'smart'
- [ ] Apply color coding: Fast=emerald, Balanced=slate, Smart=purple
- [ ] Add appropriate icons: ⚡ Fast, ⚖️ Balanced, 🧠 Smart
- [ ] Ensure WCAG contrast compliance

### Task 4: Create PoolSection component
**File**: `client/src/components/pool-section.tsx` (new)

- [ ] Create collapsible section component
- [ ] Accept `pool`, `models`, and `children` props
- [ ] Display pool name, icon, and model count in header
- [ ] Implement collapse/expand functionality
- [ ] Add ARIA labels for accessibility

### Task 5: Update FallbackPage
**File**: `client/src/pages/FallbackPage.tsx`

- [ ] Add `pool` field to FallbackEntry interface
- [ ] Group models by pool (Fast, Balanced, Smart)
- [ ] Use PoolSection component for each pool group
- [ ] Maintain existing sort functionality within each pool
- [ ] Hide empty pools or show "no models" message
- [ ] Update token usage bar to show pool colors

### Task 6: Update PlaygroundPage
**File**: `client/src/pages/PlaygroundPage.tsx`

- [ ] Add `pool` field to FallbackEntry interface
- [ ] Group availableModels by pool
- [ ] Update Select component to use optgroups for pools
- [ ] Keep Auto options at top level
- [ ] Add pool labels with icons to optgroups

### Task 7: Update AnalyticsPage
**File**: `client/src/pages/AnalyticsPage.tsx`

- [ ] Add `pool` field to model data interface
- [ ] Add "Pool" column to per-model breakdown table
- [ ] Use PoolBadge component in the Pool column
- [ ] Add pool filter buttons (All, Fast, Balanced, Smart)
- [ ] Implement filter state and logic
- [ ] Ensure filter persists across time range changes

## Testing Tasks

### Task 8: Verify pool classification consistency
- [ ] Compare pool values in API response with backend routing logic
- [ ] Test with models at boundaries (min/max ranks)
- [ ] Verify empty pool handling

### Task 9: Test UI responsiveness
- [ ] Test FallbackPage on mobile devices
- [ ] Test PlaygroundPage dropdown on mobile
- [ ] Test AnalyticsPage table with pool column on mobile

### Task 10: Accessibility testing
- [ ] Verify keyboard navigation for collapsible sections
- [ ] Check ARIA labels on pool sections
- [ ] Test screen reader announcements
- [ ] Verify color contrast ratios
