# Requirements: LongCat LLM Provider Integration

## Overview

Add a new LLM provider called **LongCat** to the freellmapi project. LongCat exposes an OpenAI-compatible API and offers a single free model (LongCat-2.0-Preview) that is architecturally similar to OpenRouter's Owl Alpha. The integration should follow the exact same patterns used by existing OpenAI-compatible providers.

## Provider Specifications

| Property | Value |
|---|---|
| **Provider Name** | LongCat |
| **Platform ID** | `longcat` |
| **Backend Type** | OpenAI-compatible API |
| **Base URL** | `https://api.longcat.chat/openai` |
| **Chat Completions Endpoint** | `https://api.longcat.chat/openai/chat/completions` (auto-appended by `OpenAICompatProvider`) |
| **Extra Headers** | None required |
| **Timeout** | Default (15s) — no override needed |
| **Key Validation** | Default `OpenAICompatProvider.validateKey()` |

## Model Specifications

| Property | Value | Source |
|---|---|---|
| **Model ID** | `longcat/longcat-2.0-preview` | Provider catalog |
| **Display Name** | `LongCat 2.0 Preview (free)` | Mirrors Owl Alpha naming convention |
| **Intelligence Rank** | `6` | Same as Owl Alpha |
| **Speed Rank** | `7` | Same as Owl Alpha |
| **Size Label** | `Frontier` | Same as Owl Alpha |
| **RPM Limit** | `20` | Same as Owl Alpha |
| **RPD Limit** | `200` | Same as Owl Alpha |
| **TPM Limit** | `null` | Same as Owl Alpha |
| **TPD Limit** | `null` | Same as Owl Alpha |
| **Monthly Token Budget** | `~6M` | Same as Owl Alpha |
| **Context Window** | `1048576` | Same as Owl Alpha |

## Functional Requirements

### FR-1: Shared Type System
The `Platform` type in [`shared/types.ts`](shared/types.ts:7-23) must include `'longcat'` as a valid platform literal. This type is the single source of truth used across the entire stack (server routes, client UI, database layer).

### FR-2: Provider Registration
The LongCat provider must be registered in [`server/src/providers/index.ts`](server/src/providers/index.ts:142-145) using the `OpenAICompatProvider` class, following the same pattern as Groq, Cerebras, SambaNova, and other OpenAI-compatible providers. No extra headers or custom timeout are needed.

### FR-3: Key Management Allowlist
The `PLATFORMS` allowlist in [`server/src/routes/keys.ts`](server/src/routes/keys.ts:12-16) must include `'longcat'`. This array controls which platforms accept API key creation via the `/api/keys` POST endpoint.

### FR-4: Database Migration
A new migration function `migrateModelsV16` must be added to [`server/src/db/index.ts`](server/src/db/index.ts:1034-1058) following the exact pattern of `migrateModelsV15`. The migration must:
- Insert the LongCat model into the `models` table using `INSERT OR IGNORE`
- Auto-populate the `fallback_config` table for any models missing a fallback entry
- Be called in `initDb()` after `migrateModelsV15`

### FR-5: Client-Side Key Management UI
The `PLATFORMS` array in [`client/src/pages/KeysPage.tsx`](client/src/pages/KeysPage.tsx:11-28) must include a LongCat entry with:
- `value: 'longcat'`
- `label: 'LongCat'`
- `keyUrl: 'https://longcat.chat'` (or the appropriate key management URL)

### FR-6: Client-Side Fallback UI
The `platformColors` map in [`client/src/pages/FallbackPage.tsx`](client/src/pages/FallbackPage.tsx:91-107) must include a `longcat` entry with a distinct hex color for display in the token usage bar and model badges.

### FR-7: No Changes Required
The following components require **no modifications** because they dynamically read from the database or provider registry:
- [`server/src/routes/models.ts`](server/src/routes/models.ts) — uses `hasProvider()` to list available models
- [`server/src/routes/fallback.ts`](server/src/routes/fallback.ts) — reads from `fallback_config` table
- [`server/src/routes/proxy.ts`](server/src/routes/proxy.ts) — routes via provider registry
- [`server/src/routes/analytics.ts`](server/src/routes/analytics.ts) — aggregates from `requests` table
- [`server/src/services/router.ts`](server/src/services/router.ts) — Thompson Sampling reads from DB
- [`client/src/pages/PlaygroundPage.tsx`](client/src/pages/PlaygroundPage.tsx) — reads fallback entries from API
- [`client/src/lib/api.ts`](client/src/lib/api.ts) — generic API client
- [`server/src/providers/openai-compat.ts`](server/src/providers/openai-compat.ts) — base class handles all OpenAI-compatible providers
- [`server/src/providers/base.ts`](server/src/providers/base.ts) — abstract base class

## Non-Functional Requirements

### NFR-1: Consistency
All changes must follow the exact patterns established by existing OpenAI-compatible providers (Groq, Cerebras, SambaNova, etc.). No new abstractions or architectural changes.

### NFR-2: Idempotency
The database migration must be idempotent — running `initDb()` multiple times must not create duplicate rows. Use `INSERT OR IGNORE` as all previous migrations do.

### NFR-3: Type Safety
The `Platform` type must be updated before any code references `'longcat'`. TypeScript compilation must pass with no errors.

## Files Requiring Modification

| # | File | Change Type | Description |
|---|---|---|---|
| 1 | [`shared/types.ts`](shared/types.ts:23) | Edit | Add `'longcat'` to `Platform` union type |
| 2 | [`server/src/providers/index.ts`](server/src/providers/index.ts:145) | Edit | Register `OpenAICompatProvider` for LongCat |
| 3 | [`server/src/routes/keys.ts`](server/src/routes/keys.ts:15) | Edit | Add `'longcat'` to `PLATFORMS` allowlist |
| 4 | [`server/src/db/index.ts`](server/src/db/index.ts:52,1058) | Edit | Add `migrateModelsV16` function and call it in `initDb()` |
| 5 | [`client/src/pages/KeysPage.tsx`](client/src/pages/KeysPage.tsx:27) | Edit | Add LongCat to `PLATFORMS` array |
| 6 | [`client/src/pages/FallbackPage.tsx`](client/src/pages/FallbackPage.tsx:107) | Edit | Add `longcat` color to `platformColors` map |

## Out of Scope

- Adding multiple LongCat models (only `longcat-2.0-preview`)
- Custom provider implementation (use existing `OpenAICompatProvider`)
- Authentication flow changes
- Rate limiting logic changes
- Router algorithm changes
