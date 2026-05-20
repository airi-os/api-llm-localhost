# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs both server and client concurrently)
pnpm dev

# Build everything
pnpm build

# Build server only
pnpm build:server

# Run all tests
pnpm test

# Server tests only (with watch mode)
pnpm --filter server test
pnpm --filter server test:watch

# Run a single test file
pnpm --filter server vitest run src/__tests__/services/router.test.ts

# Lint client
pnpm --filter client lint

# Start server from compiled dist
pnpm --filter server start
```

## Architecture

This is a **pnpm monorepo** with three workspaces: `server`, `client`, and `shared`.

### Request flow

```
Client (browser) → /v1/chat/completions or /v1/responses
    → server/src/routes/proxy.ts  (auth, validation, retry loop)
        → services/router.ts      (Thompson Sampling bandit routing)
            → providers/index.ts  (selects BaseProvider for platform)
                → provider.chatCompletion() or .streamChatCompletion()
```

The server serves the built client SPA as static files — in production there is one process on port 3001.

### Key architectural concepts

**Thompson Sampling router** (`services/router.ts`): Routes requests across models using a Bayesian bandit. Each model maintains a Beta posterior over success rates; stochastic sampling ensures exploration. Scores also incorporate a normalized tok/s speed signal. Models receive a dynamic penalty for 429s that decays over time. The penalty is applied inside `routeRequest` only when **all** keys for a model are exhausted by 429s — a single key failing does not penalise the model if other keys remain. Per-key 429s are handled by `skipKeys` and `setCooldown` in `proxy.ts`; the model-level bandit penalty fires once the key-loop sets `exhaustedBy429 = true`.

**Sticky sessions**: Multi-turn conversations are pinned to the same model (keyed on a SHA-1 hash of the first user message) to prevent hallucination from mid-conversation model switches. TTL is 30 minutes.

**Fallback chain**: The `fallback_config` table defines which models participate in routing. On retryable errors (429, 5xx, timeout, 404), the router skips that model+key combination and tries the next one, up to 20 attempts.

**Provider abstraction** (`providers/base.ts`): `BaseProvider` is an abstract class with `chatCompletion`, `streamChatCompletion`, and `validateKey`. Most providers use `OpenAICompatProvider` (a concrete subclass). `GoogleProvider`, `CohereProvider`, and `CloudflareProvider` have custom implementations for API format differences.

**Database** (`db/index.ts`): SQLite via `better-sqlite3`. Schema is created inline in `createTables()`. All schema evolution uses numbered `migrateModelsVN()` functions called at startup — they are idempotent (`INSERT OR IGNORE`, guarded `UPDATE`). Never add a new migration without incrementing the version number.

**API key encryption**: Keys are stored AES-256-GCM encrypted. The `ENCRYPTION_KEY` env var (64-char hex) is the master secret; it is itself stored in the `settings` table on first boot if not provided (development convenience only — set it explicitly in production).

**Two-key auth model**: Two separate bearer tokens with no overlap.
- `ADMIN_DASHBOARD_KEY` (env var) gates all `/api/*` routes — the management dashboard (keys, models, analytics, logs, fallback config). Enforced by `middleware/adminAuth.ts` using timing-safe comparison. `/api/ping` is the only public exception.
- Unified API key (stored in the `settings` table, shown on the Keys page) gates all `/v1/*` routes — the LLM proxy. Enforced inside `routes/proxy.ts`. Using the admin key against `/v1/*` or vice versa returns 401.

**Security middleware** (`middleware/adminAuth.ts`, `lib/secrets.ts`): `adminAuth` reads `ADMIN_DASHBOARD_KEY` from env, validates minimum length (24 chars), and performs timing-safe bearer comparison. `extractBearerToken` and `timingSafeStringEqual` in `lib/secrets.ts` are shared by both auth layers. In `NODE_ENV=development/test`, admin auth is skipped when the key is absent (dev convenience only).

**CORS & Helmet**: CORS is restricted to origins listed in `ADMIN_CORS_ORIGINS` (same-origin by default). Helmet CSP/HSTS headers are enabled in production; `DISABLE_HSTS=true` skips HSTS (useful behind HTTP-only reverse proxies). Production 500 errors return a generic message — stack traces never reach the client.

**OpenAI Responses API compatibility** (`routes/proxy.ts`): The `/v1/responses` endpoint translates the Responses API shape (stateful sessions, `previous_response_id`) into standard chat completions internally. Session state is held in memory with a 30-minute TTL.

### Shared types

`shared/types.ts` is the single source of truth for the `Platform` type and all OpenAI-compatible message/response interfaces. When adding a new provider: add it to `Platform` here, register it in `providers/index.ts`, add catalog rows in `db/index.ts` via a new `migrateModelsVN()`, and add it to the `PLATFORMS` allowlist in `routes/keys.ts`.

### Client

React 19 SPA with React Router v7, TanStack Query, Tailwind CSS v4, and shadcn/ui components (via `@base-ui/react`). Pages: Playground, Keys, Fallback (chain config + drag-and-drop reordering), Analytics (Recharts), Logs (SSE streaming). The client talks to the server at `/api/` and `/v1/`.

## Environment

Copy `.env.example` to `.env`.

| Variable | Required | Description |
|---|---|---|
| `ENCRYPTION_KEY` | Yes | 64-char hex. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_DASHBOARD_KEY` | Yes (prod) | Bearer token for `/api/*` dashboard routes. Generate: `node -e "console.log('freellmapi-admin-' + require('crypto').randomBytes(32).toString('hex'))"`. Omitting it is only safe in `NODE_ENV=development/test`. |
| `ADMIN_CORS_ORIGINS` | No | Comma-separated browser origins allowed to call `/api/*` cross-origin. Same-origin deployments don't need this. |
| `DISABLE_HSTS` | No | Set to `true` to skip HSTS headers (e.g. behind an HTTP-only reverse proxy in dev). |
| `LOG_SENSITIVE_DATA` | No | Set to `true` to log full request/response bodies. Off by default — keep off in production. |
| `PORT` | No | Server port (default 3001). |

The database lives at `server/data/freeapi.db` and is auto-created on first boot.
