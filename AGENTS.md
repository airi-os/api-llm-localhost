## Commands

```bash
pnpm dev                                        # dev server + client concurrently
pnpm build                                      # build everything
pnpm build:server                               # server only
pnpm test                                       # all tests
pnpm --filter server test                       # server tests
pnpm --filter server test:watch                 # server tests (watch)
pnpm --filter server vitest run src/__tests__/<path>   # single test file
pnpm --filter client lint
pnpm --filter server start                      # start from compiled dist
```

## Features

**Auto routing modes** (use as the model name in API requests):
- `freellmapi/auto` — default; balanced routing optimizing for speed, reliability, and intelligence
- `freellmapi/auto-smart` — prioritizes model capability (60% intelligence weight) for complex reasoning tasks
- `freellmapi/auto-fast` — routes to lowest latency models (models with `-fast` suffix)

## Non-obvious invariants

- **Migrations**: always increment the migration version number — never reuse one.
- **Two-key auth**: the admin key gates `/api/*`; the unified API key gates `/v1/*`. They must never overlap — using one against the wrong route returns 401.
- **Adding a provider**: touch shared types, provider registry, DB catalog migration, and the keys route allowlist.
- **429 penalty**: model-level bandit penalty fires only when *all* keys for that model are exhausted — a single key failing does not penalise the model.

## Environment

Copy `.env.example` to `.env`.

| Variable | Required | Description |
|---|---|---|
| `ENCRYPTION_KEY` | Yes | 64-char hex. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_DASHBOARD_KEY` | Yes (prod) | Bearer token for `/api/*`. `node -e "console.log('freellmapi-admin-' + require('crypto').randomBytes(32).toString('hex'))"`. Safe to omit in `NODE_ENV=development/test`. |
| `ADMIN_CORS_ORIGINS` | No | Comma-separated origins for cross-origin `/api/*` access. |
| `DISABLE_HSTS` | No | `true` to skip HSTS (e.g. behind HTTP-only reverse proxy). |
| `LOG_SENSITIVE_DATA` | No | `true` to log full request/response bodies. Keep off in production. |
| `PORT` | No | Server port (default 3001). |

Database: `server/data/freeapi.db` — auto-created on first boot.
