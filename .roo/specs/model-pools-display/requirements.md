# Requirements: Model Pools Display

## Overview

The application already classifies models into three pools (Fast, Balanced, Smart) in the backend routing logic, but the frontend displays all models in a single flat list. This feature will update the frontend to display models organized by their pool classification across all relevant pages.

## User Stories

### US-1: View Models Grouped by Pool on Fallback Page
**As a** user managing the routing chain  
**I want to** see models grouped by their pool classification (Fast, Balanced, Smart)  
**So that** I can quickly understand which models are optimized for different use cases

**Acceptance Criteria**:
- [ ] Fallback page displays three distinct sections for Fast, Balanced, and Smart pools
- [ ] Each section shows the pool name, icon, and model count
- [ ] Models within each section maintain existing sort functionality
- [ ] Sections are collapsible to save space when needed
- [ ] Empty pools are hidden or shown with a "no models" message

### US-2: Select Models by Pool in Playground
**As a** user testing models in the playground  
**I want to** see models organized by pool in the model selector dropdown  
**So that** I can easily choose a model based on my speed vs. intelligence needs

**Acceptance Criteria**:
- [ ] Model selector shows optgroups for each pool (Fast, Balanced, Smart)
- [ ] Auto options remain at the top level outside pool groups
- [ ] Pool groups are clearly labeled with icons
- [ ] Models within each group show platform name

### US-3: Filter Analytics by Pool
**As a** user analyzing model performance  
**I want to** see pool classification in the analytics table and filter by pool  
**So that** I can compare performance across different model categories

**Acceptance Criteria**:
- [ ] Per-model breakdown table includes a "Pool" column
- [ ] Pool badges are color-coded (Fast=green, Balanced=gray, Smart=purple)
- [ ] Filter buttons allow showing All, Fast only, Balanced only, or Smart only
- [ ] Pool filter persists when changing time range

### US-4: Consistent Pool Display Across Pages
**As a** user navigating between pages  
**I want to** see consistent pool indicators and colors  
**So that** I can quickly identify model pools regardless of which page I'm on

**Acceptance Criteria**:
- [ ] PoolBadge component is reused across all pages
- [ ] Pool colors are consistent (Fast=emerald, Balanced=slate, Smart=purple)
- [ ] Pool icons are consistent (⚡ Fast, ⚖️ Balanced, 🧠 Smart)

## Functional Requirements

### Backend Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Add `pool` field to fallback route response | Must |
| FR-2 | Add `pool` field to analytics by-model response | Must |
| FR-3 | Use existing `classifyModel()` function for pool calculation | Must |

### Frontend Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4 | Create reusable PoolBadge component | Must |
| FR-5 | Create reusable PoolSection component | Must |
| FR-6 | Update FallbackPage to group models by pool | Must |
| FR-7 | Update PlaygroundPage model selector with pool groups | Must |
| FR-8 | Update AnalyticsPage with pool column and filter | Must |
| FR-9 | Add pool field to TypeScript interfaces | Must |

## Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-1 | Pool classification should not add noticeable latency | Must |
| NFR-2 | UI should be responsive on mobile devices | Must |
| NFR-3 | Pool sections should be accessible (ARIA labels, keyboard nav) | Should |
| NFR-4 | Pool colors should meet WCAG contrast requirements | Must |

## Constraints

- Must use existing `ModelPool` enum from `shared/types.ts`
- Must use existing `classifyModel()` function from router service
- Pool classification logic should match backend routing logic exactly
- No changes to the pool classification algorithm (only display changes)

## Out of