# Deployment & Installation Design

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Operator's Machine                       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  freellmapi-alpha (monorepo)                          │  │
│  │                                                       │  │
│  │  .env ←── scripts/setup.ts generates secrets          │  │
│  │  │                                                    │  │
│  │  ├── server/          (Express API + dashboard)       │  │
│  │  ├── client/          (React dashboard UI)            │  │
│  │  ├── shared/          (shared types)                  │  │
│  │  ├── scripts/         (setup, sync, verify, rotate)   │  │
│  │  ├── install.sh       (Linux/macOS bootstrap)         │  │
│  │  ├── install.ps1      (Windows bootstrap)             │  │
│  │  └── llm-proxy/       (git submodule)                 │  │
│  │       │                                               │  │
│  │       └── .env ←── same INTERNAL_AUTH_SECRET          │  │
│  └───────────────────────────────────────────────────────┘  │
│                           │                                  │
│                           │ npm run deploy                   │
│                           ▼                                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Cloudflare Workers                                   │  │
│  │                                                       │  │
│  │  llm-proxy-router ──→ PROXY_1, PROXY_2, ... PROXY_N  │  │
│  │       │                                               │  │
│  │       └── /internal/v1/topology (X-Internal-Auth)     │  │
│  └───────────────────────────────────────────────────────┘  │
│                           ▲                                  │
│                           │ topology discovery at startup    │
│  freellmapi server ───────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

## Installation Flow

### Bootstrap Phase (install scripts)

The install scripts are the entry point for new operators. They own all repository bootstrapping and invoke setup automatically.

```
install.sh (Linux/macOS) / install.ps1 (Windows)
  │
  ├── 1. Clone repository (if not already in target directory)
  ├── 2. Initialize git submodules
  │       git submodule update --init
  ├── 3. Install dependencies
  │       pnpm install          (freellmapi-alpha root)
  │       cd llm-proxy && npm install
  ├── 4. Validate prerequisites
  │       Node.js version check
  │       pnpm availability
  │       wrangler availability
  ├── 5. Guide Wrangler authentication
  │       wrangler whoami → if not authenticated, prompt wrangler login
  └── 6. Invoke pnpm run setup automatically
```

The install scripts are idempotent. Re-running them updates submodules, installs missing dependencies, and validates prerequisites without deleting repositories, overwriting `.env` files, or regenerating secrets. The setup script (invoked in step 6) handles its own idempotency for configuration generation.

The operator should never need to manually run `git submodule update --init --recursive`. The install scripts own this workflow. Manual intervention is only required if the operation fails.

### Configuration Phase (setup script)

The setup script is invoked automatically by the install scripts. It owns first-time project configuration.

```
scripts/setup.ts
  │
  ├── 1. Read existing .env files (if any)
  │       Parse into key-value map
  │       Preserve all existing values (REQ-D8)
  ├── 2. Generate missing secrets (REQ-D1)
  │       ENCRYPTION_KEY (if missing)
  │       ADMIN_DASHBOARD_KEY (if missing)
  │       INTERNAL_AUTH_SECRET (if missing)
  │       Prompt for AUTH_KEY (with random default)
  ├── 3. Prompt for ROUTER_DOMAIN
  │       Default from llm-proxy/.env or router.example.com
  ├── 4. Write LLM_PROXY_URL to freellmapi .env
  ├── 5. Write INTERNAL_AUTH_SECRET to llm-proxy .env
  ├── 6. Print summary of what was created/updated
  │       Existing values: shown as "preserved"
  │       New values: shown as "generated"
  └── 7. Print next steps
          pnpm dev (local development)
          cd llm-proxy && npm run deploy (production)
```

### Responsibility Separation

| Concern | Install scripts | Setup script |
|---|---|---|
| Clone repository | Yes | No |
| Init submodules | Yes | No |
| Install dependencies | Yes | No |
| Validate tooling (node, pnpm, wrangler) | Yes | No |
| Wrangler auth guidance | Yes | No |
| Invoke setup automatically | Yes | — |
| Generate secrets | No | Yes |
| Create .env files | No | Yes |
| Sync shared secrets | No | Yes |
| Configure LLM_PROXY_URL | No | Yes |
| Modify existing .env files | No | No (REQ-D8) |

## Exit Code Contracts

All scripts follow a consistent exit code convention:

| Script | Success | Failure |
|---|---|---|
| `install.sh` / `install.ps1` | 0 | non-zero |
| `scripts/setup.ts` | 0 | non-zero |
| `scripts/sync-secrets.ts` | 0 | non-zero |
| `scripts/verify-deploy.ts` | 0 (all checks pass) | non-zero (any check fails) |
| `scripts/rotate-secrets.ts` | 0 | non-zero |

Dry-run mode returns exit code 0 unless argument validation fails.

## Secret Flow

### Generation Phase (first time)

```
scripts/setup.ts
  │
  ├── Read existing .env files (if any)
  ├── Generate ENCRYPTION_KEY (64 hex chars) — if missing
  ├── Generate ADMIN_DASHBOARD_KEY (freellmapi-admin-<random>) — if missing
  ├── Prompt for AUTH_KEY (or generate random)
  ├── Generate INTERNAL_AUTH_SECRET (64 hex chars) — if missing
  │
  ├── Write to freellmapi-alpha/.env:
  │     ENCRYPTION_KEY=...
  │     ADMIN_DASHBOARD_KEY=...
  │     INTERNAL_AUTH_SECRET=...
  │     LLM_PROXY_URL=https://router.example.com
  │
  └── Write to llm-proxy/.env:
        AUTH_KEY=...
        INTERNAL_AUTH_SECRET=...   ← same value
        ROUTER_DOMAIN=router.example.com
        PROXY_COUNT=3
```

### Runtime Phase

```
llm-proxy router worker:
  - Reads INTERNAL_AUTH_SECRET from env (set in TOML by deploy.ts)
  - Validates X-Internal-Auth header on /internal/v1/topology

freellmapi server (startup):
  - Reads INTERNAL_AUTH_SECRET from .env
  - Reads LLM_PROXY_URL from .env
  - Fetches /internal/v1/topology with X-Internal-Auth header
  - On success: caches topology, enables dynamic worker count
  - On failure: falls back to PROXY_IP_COUNT env → 0
```

### Synchronization Invariant

`INTERNAL_AUTH_SECRET` must be identical in three places:

| Location | How set |
|---|---|
| `llm-proxy/.env` | `scripts/setup.ts` or `scripts/sync-secrets.ts` |
| `freellmapi-alpha/.env` | `scripts/setup.ts` or `scripts/sync-secrets.ts` |
| Cloudflare Worker env | `llm-proxy/scripts/deploy.ts` reads from `.env` and embeds in TOML |

After rotating `INTERNAL_AUTH_SECRET`, both `.env` files must be updated, llm-proxy must be redeployed, and freellmapi must be restarted.

## Script Design

### `install.sh` / `install.ps1`

```
Entry point: ./install.sh  or  .\install.ps1

Steps:
  1. Detect current directory / offer to clone
  2. git submodule update --init
  3. pnpm install (root)
  4. cd llm-proxy && npm install
  5. Validate: node --version, pnpm --version, wrangler --version
  6. Check: wrangler whoami
     - If not authenticated: prompt to run wrangler login
  7. Invoke: pnpm run setup
  8. Print: "Installation complete. Run 'pnpm dev' to start locally."

Idempotency:
  - Safe to re-run
  - Updates submodules to committed revision
  - Installs only missing dependencies
  - Does not modify existing .env files
  - Does not delete repositories
  - Setup script (step 7) handles its own idempotency

Exit codes:
  0 = success (bootstrapping + setup completed)
  non-zero = failure (with descriptive error message)
```

### `scripts/setup.ts`

```
Entry point: pnpm run setup
Options: --dry-run, --regenerate

Steps:
  1. Check if .env exists
     - If yes: read existing values, only generate missing keys (REQ-D8)
     - If no: create .env from .env.example template
  2. Generate missing secrets (REQ-D1)
  3. Prompt for ROUTER_DOMAIN (default from llm-proxy/.env or example.com)
  4. Write LLM_PROXY_URL to freellmapi .env
  5. Write INTERNAL_AUTH_SECRET to llm-proxy .env
  6. Print summary of what was created/updated
  7. Print next steps (pnpm dev, deploy llm-proxy)

Dry-run behavior (REQ-D9):
  - Report all actions that would be taken
  - No files written or modified
  - Exit 0 unless validation fails

Preservation behavior (REQ-D8):
  - Existing keys in .env are never overwritten
  - --regenerate flag required to overwrite existing values
  - Never delete or truncate .env files
  - Protects all .env values: secrets, URLs, counts, future keys

Exit codes:
  0 = success (configuration complete or already valid)
  non-zero = failure (validation error, file write error)
```

### `scripts/sync-secrets.ts`

```
Entry point: pnpm run sync-secrets
Options: --dry-run

Steps:
  1. Read INTERNAL_AUTH_SECRET from freellmapi .env
  2. Read INTERNAL_AUTH_SECRET from llm-proxy .env
  3. If mismatch: update llm-proxy .env to match freellmapi .env
  4. Print status (synced / updated / error)

Dry-run behavior: report what would change, make no changes

Exit codes:
  0 = success (synced or already in sync)
  non-zero = failure (file read/write error)
```

### `scripts/verify-deploy.ts`

```
Entry point: pnpm run verify
Options: --dry-run

Steps:
  1. Read LLM_PROXY_URL and INTERNAL_AUTH_SECRET from .env
  2. Check 1: llm-proxy deployment reachable (TCP/connectivity)
  3. Check 2: GET /internal/v1/topology returns HTTP 200
  4. Check 3: Response validates against topology schema
     - schemaVersion: number === 1
     - topologyId: string, non-empty
     - topologyGeneratedAt: number
     - workerCount: number, integer, >= 0
     - proxies: array of { id: number, name: string, status: string }
  5. Check 4: freellmapi can retrieve topology (if server running)
  6. Check 5: workerCount >= 0
  7. Check 6: fallback mode reported correctly when dynamic topology unavailable
  8. Print pass/fail for each check
  9. Exit 0 if all pass, exit 1 if any fail

Dry-run behavior: report what checks would run, make no network calls

Exit codes:
  0 = success (all checks passed)
  non-zero = failure (one or more checks failed)
```

### `scripts/rotate-secrets.ts`

```
Entry point: pnpm run rotate-secrets
Options: --dry-run

Steps:
  1. Generate new INTERNAL_AUTH_SECRET
  2. Require explicit confirmation before writing
  3. Update freellmapi .env
  4. Update llm-proxy .env
  5. Print required follow-up actions:
     - cd llm-proxy && npm run deploy
     - restart freellmapi server

Dry-run behavior: show what the new secret would be, make no changes

Exit codes:
  0 = success (rotation complete or user declined)
  non-zero = failure (file write error)
```

## Repository Topology

```
freellmapi-alpha/           ← main repo (monorepo)
  .env                      ← ENCRYPTION_KEY, ADMIN_DASHBOARD_KEY,
                               INTERNAL_AUTH_SECRET, LLM_PROXY_URL
  .env.example              ← template (committed)
  .gitmodules               ← llm-proxy submodule pointer
  install.sh                ← Linux/macOS bootstrap script
  install.ps1               ← Windows bootstrap script
  scripts/
    setup.ts                ← first-time configuration
    sync-secrets.ts         ← re-sync shared secrets
    verify-deploy.ts        ← post-deploy verification
    rotate-secrets.ts       ← secret rotation
  server/
  client/
  shared/
  llm-proxy/                ← git submodule (separate repo)
    .env                    ← AUTH_KEY, INTERNAL_AUTH_SECRET,
                               ROUTER_DOMAIN, PROXY_COUNT
    .env.example            ← template (committed)
    scripts/
      deploy.ts             ← deploy to Cloudflare Workers
    src/
      worker.ts
      router.ts
      proxy.ts
      generated/
        topology.ts         ← generated at deploy time
```

## File Ownership

| File | Owned by | Committed? |
|---|---|---|
| `freellmapi-alpha/.env` | `scripts/setup.ts` | No (gitignored) |
| `llm-proxy/.env` | `scripts/setup.ts` | No (gitignored) |
| `freellmapi-alpha/.env.example` | Developers | Yes |
| `llm-proxy/.env.example` | Developers | Yes |
| `freellmapi-alpha/install.sh` | Developers | Yes |
| `freellmapi-alpha/install.ps1` | Developers | Yes |
| `freellmapi-alpha/scripts/setup.ts` | Developers | Yes |
| `freellmapi-alpha/scripts/sync-secrets.ts` | Developers | Yes |
| `freellmapi-alpha/scripts/verify-deploy.ts` | Developers | Yes |
| `freellmapi-alpha/scripts/rotate-secrets.ts` | Developers | Yes |
| `llm-proxy/scripts/deploy.ts` | Developers | Yes |

## Error Handling

| Condition | Script | Behavior |
|---|---|---|
| `.env` already exists | `setup.ts` | Preserve, append missing keys only (REQ-D8) |
| Submodule not initialized | `install.sh`/`install.ps1` | Auto-initialize; fail with error message if it fails |
| `wrangler` not authenticated | `install.sh`/`install.ps1` | Warning + prompt to run `wrangler login` |
| `INTERNAL_AUTH_SECRET` mismatch | `sync-secrets.ts` | Auto-fix, report change |
| Topology endpoint unreachable | `verify-deploy.ts` | Fail check 1, continue remaining checks, exit non-zero |
| Invalid URL entered | `setup.ts` | Re-prompt |
| `--dry-run` with invalid args | Any script | Validation error, exit non-zero |
| Confirmation refused | `rotate-secrets.ts` | Abort, no changes, exit 0 |

## Security Considerations

- Generated `.env` files must have restrictive permissions (`chmod 600`) where the OS supports it.
- Secrets are never logged to stdout (only key names and confirmation that they were set).
- The setup script must not commit `.env` files (verify `.gitignore` includes `.env`).
- `INTERNAL_AUTH_SECRET` is a shared symmetric secret — it is not asymmetric key material.
- The authentication model (INTERNAL_AUTH_SECRET shared between router and server) is retained without change.
