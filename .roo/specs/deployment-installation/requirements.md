# Deployment & Installation Requirements

## Overview

This specification defines the requirements for deploying and installing the freellmapi platform, which consists of two components:

- **freellmapi-alpha** — the main API server + admin dashboard (Node.js/Express monorepo)
- **llm-proxy** — the Cloudflare Workers proxy pool (separate repo, included as a submodule)

The two components remain in separate repositories. llm-proxy is included in freellmapi-alpha as a git submodule. This is a permanent and supported deployment model.

Today, deployment requires manual `.env` editing, manual secret generation, and operational knowledge that lives only in README files. This spec aims to make the system deployable by a new operator with zero prior knowledge beyond running an install script.

The only operator-provided deployment prerequisites are:
- Node.js installed
- Wrangler installed
- Wrangler authenticated

Everything else is automated.

---

## REQ-D1: Secret Generation

The system uses multiple secrets that must be generated before first deploy. The setup process must generate them automatically when missing.

### Secrets inventory

| Secret | Used by | Min length | Generation method |
|---|---|---|---|
| `ENCRYPTION_KEY` | freellmapi server | 64 hex chars (32 bytes) | `crypto.randomBytes(32).toString('hex')` |
| `ADMIN_DASHBOARD_KEY` | freellmapi server | 32+ chars | `'freellmapi-admin-' + crypto.randomBytes(32).toString('hex')` |
| `AUTH_KEY` | llm-proxy router | 8+ chars | User-provided or auto-generated |
| `INTERNAL_AUTH_SECRET` | llm-proxy router + freellmapi server | 32+ chars (64 hex) | `crypto.randomBytes(32).toString('hex')` |

### Requirements

- **REQ-D1.1**: A setup script (`scripts/setup.ts`) must exist in freellmapi-alpha that generates all required secrets and writes them to `.env` if not already present.
- **REQ-D1.2**: The setup script must never overwrite an existing `.env` file. If `.env` exists, it must be preserved and only missing keys must be appended.
- **REQ-D1.3**: The setup script must generate `ENCRYPTION_KEY` and `ADMIN_DASHBOARD_KEY` for the freellmapi server.
- **REQ-D1.4**: The setup script must generate `INTERNAL_AUTH_SECRET` and write it to **both** the freellmapi `.env` and the llm-proxy `.env` (so both systems share the same secret).
- **REQ-D1.5**: The setup script must prompt the user for `AUTH_KEY` (with a secure random default offered).
- **REQ-D1.6**: Generated secrets must be printed to stdout with a warning to back them up.

---

## REQ-D2: Secret Synchronization

The `INTERNAL_AUTH_SECRET` is used by both llm-proxy (router) and freellmapi-alpha (server) for topology discovery. Both systems must share the same value.

### Requirements

- **REQ-D2.1**: The setup script must write `INTERNAL_AUTH_SECRET` to both `.env` files (freellmapi-alpha root and llm-proxy submodule root).
- **REQ-D2.2**: A `scripts/sync-secrets.ts` script must exist to re-synchronize `INTERNAL_AUTH_SECRET` between both repos after initial setup (e.g., after regenerating secrets).
- **REQ-D2.3**: The sync script must validate that both `.env` files contain the same `INTERNAL_AUTH_SECRET` value and report mismatches.
- **REQ-D2.4**: Neither system must embed `INTERNAL_AUTH_SECRET` in source code or committed config files.

---

## REQ-D3: Router URL Discovery

The freellmapi server needs `LLM_PROXY_URL` to discover the proxy topology. This URL depends on the Cloudflare domain configured in llm-proxy's `ROUTER_DOMAIN`.

### Requirements

- **REQ-D3.1**: The setup script must prompt the user for the router domain (default: value from llm-proxy's `.env` `ROUTER_DOMAIN`, or `router.example.com`).
- **REQ-D3.2**: The setup script must construct `LLM_PROXY_URL` as `https://{ROUTER_DOMAIN}` and write it to freellmapi's `.env`.
- **REQ-D3.3**: If `LLM_PROXY_URL` is not set, the server must still start (topology discovery is skipped gracefully — existing behavior).
- **REQ-D3.4**: The setup script must validate that `LLM_PROXY_URL` is a valid HTTPS URL before writing.

---

## REQ-D4: Installation Experience

A new operator must be able to go from nothing to a running system using install scripts. The install scripts own all repository bootstrapping work and invoke setup automatically.

### Requirements

- **REQ-D4.1**: An `install.sh` script must exist at the repository root for Linux/macOS.
- **REQ-D4.2**: An `install.ps1` script must exist at the repository root for Windows.
- **REQ-D4.3**: The install scripts must be idempotent. Re-running them:
  - Updates submodules to the committed revision
  - Installs missing dependencies without reinstalling existing ones
  - Validates prerequisites without modifying configuration
  - Does not delete repositories, overwrite `.env` files, or regenerate secrets
- **REQ-D4.4**: The install scripts must perform all of the following:
  - Clone the repository if not already present (or operate on the current directory)
  - Initialize and update git submodules (`git submodule update --init`)
  - Install dependencies (`pnpm install` for freellmapi, `npm install` for llm-proxy)
  - Validate prerequisites (Node.js, pnpm, wrangler)
  - Guide the user through Wrangler authentication if not already authenticated
  - Invoke `pnpm run setup` automatically after bootstrapping completes
- **REQ-D4.5**: The install scripts must not require the user to manually run `git submodule update --init --recursive`. Manual intervention is only required if the operation fails.
- **REQ-D4.6**: After the install scripts complete (including the automatic setup invocation), the operator must be able to run `pnpm dev` for local development without further configuration.
- **REQ-D4.7**: For production deployment of llm-proxy, the operator must only need to run `cd llm-proxy && npm run deploy` (existing behavior, documented).

---

## REQ-D5: Repository Topology

The two components live in separate repositories. freellmapi-alpha includes llm-proxy as a git submodule. This is a permanent deployment model.

### Requirements

- **REQ-D5.1**: The freellmapi-alpha repository must include llm-proxy as a git submodule at `llm-proxy/`.
- **REQ-D5.2**: The `.gitmodules` file must reference the operator's fork URL (configurable at clone time).
- **REQ-D5.3**: The install scripts must initialize the submodule automatically. The setup script does not handle submodule initialization.
- **REQ-D5.4**: The README must document the install script as the primary entry point.

---

## REQ-D6: Post-Deploy Verification

After deploying llm-proxy and starting freellmapi, the operator must be able to verify that the system is working correctly.

### Requirements

- **REQ-D6.1**: A `scripts/verify-deploy.ts` script must exist that checks all of the following:
  1. llm-proxy deployment is reachable (network connectivity to `LLM_PROXY_URL`)
  2. Topology endpoint returns HTTP 200 (`GET /internal/v1/topology` with `X-Internal-Auth`)
  3. Topology response validates against the expected schema (all required fields present and correctly typed)
  4. freellmapi can retrieve topology successfully (end-to-end check, if server is running)
  5. Discovered worker count is valid (`>= 0`)
  6. Fallback mode is reported correctly when dynamic topology is unavailable
- **REQ-D6.2**: The verification script must be runnable via `pnpm run verify`.
- **REQ-D6.3**: The script must print a clear pass/fail summary for each check. All checks must pass for the overall verification to succeed.
- **REQ-D6.4**: The script must not require any manual configuration beyond what the setup script already wrote to `.env`.
- **REQ-D6.5**: Verification succeeds only when all six checks in REQ-D6.1 pass. Any single check failure results in overall failure with a non-zero exit code.

---

## REQ-D7: Secret Rotation

Secrets must be rotatable without full redeployment where possible.

### Requirements

- **REQ-D7.1**: `INTERNAL_AUTH_SECRET` rotation requires:
  1. Updating the value in both `.env` files
  2. Redeploying llm-proxy (so the router uses the new secret)
  3. Restarting freellmapi-alpha (so it uses the new secret for topology fetch)
- **REQ-D7.2**: The `scripts/rotate-secrets.ts` script must support rotating `INTERNAL_AUTH_SECRET` and printing the required redeploy/restart steps.
- **REQ-D7.3**: `ENCRYPTION_KEY` rotation is out of scope (requires re-encryption of all stored API keys — documented as manual process).
- **REQ-D7.4**: `ADMIN_DASHBOARD_KEY` rotation requires only a server restart (no redeploy).

---

## REQ-D8: Existing Configuration Preservation

All scripts must preserve existing working configuration. Destructive actions require explicit user intent.

### Requirements

- **REQ-D8.1**: The setup script must never overwrite existing `.env` values by default. Already-present values in `.env` files are preserved, including but not limited to: `ENCRYPTION_KEY`, `ADMIN_DASHBOARD_KEY`, `AUTH_KEY`, `INTERNAL_AUTH_SECRET`, `LLM_PROXY_URL`, `PROXY_IP_COUNT`, and any future configuration keys.
- **REQ-D8.2**: The setup script must never regenerate working credentials automatically. Missing keys are filled; existing keys are left untouched.
- **REQ-D8.3**: The setup script may offer explicit regeneration options (e.g., `--regenerate` flag) that allow overwriting existing values, but this must be opt-in.
- **REQ-D8.4**: The rotate-secrets script is the only script that intentionally overwrites secrets, and it must require explicit confirmation before doing so.
- **REQ-D8.5**: No script may delete or truncate an `.env` file.
- **REQ-D8.6**: The install scripts must not modify existing `.env` files. Repository bootstrapping and configuration generation are separate phases.

---

## REQ-D9: Dry Run Mode

All configuration scripts must support a dry-run mode that reports intended actions without making changes.

### Requirements

- **REQ-D9.1**: The following scripts must support `--dry-run`:
  - `scripts/setup.ts`
  - `scripts/sync-secrets.ts`
  - `scripts/rotate-secrets.ts`
  - `scripts/verify-deploy.ts`
- **REQ-D9.2**: In dry-run mode, each script must report all actions it would take (e.g., "Would write ENCRYPTION_KEY to .env", "Would update INTERNAL_AUTH_SECRET in llm-proxy/.env").
- **REQ-D9.3**: In dry-run mode, no files may be written, modified, or deleted.
- **REQ-D9.4**: In dry-run mode, scripts must return exit code 0 (success) unless validation of inputs/arguments fails.
- **REQ-D9.5**: Dry-run output must be clearly labeled as a dry run (e.g., header: "=== DRY RUN — no changes will be made ===").

---

## REQ-D10: Exit Code Contracts

All scripts must follow a consistent exit code convention. This is critical for CI/CD integration and scripting.

### Requirements

- **REQ-D10.1**: All scripts must return exit code 0 on successful completion.
- **REQ-D10.2**: All scripts must return a non-zero exit code on failure (validation error, network failure, missing prerequisites, etc.).
- **REQ-D10.3**: The following table defines the exit code contract for each script:

| Script | Success | Failure |
|---|---|---|
| `install.sh` / `install.ps1` | 0 | non-zero |
| `scripts/setup.ts` | 0 | non-zero |
| `scripts/sync-secrets.ts` | 0 | non-zero |
| `scripts/verify-deploy.ts` | 0 (all checks pass) | non-zero (any check fails) |
| `scripts/rotate-secrets.ts` | 0 | non-zero |

- **REQ-D10.4**: Dry-run mode must return exit code 0 unless argument validation fails.

---

## Out of Scope

- Automated Cloudflare DNS provisioning
- Automated domain registration
- CI/CD pipeline configuration (GitHub Actions, etc.)
- Docker / containerization
- Multi-environment management (staging, production)
- `ENCRYPTION_KEY` rotation automation
- Secret storage in a vault (AWS Secrets Manager, HashiCorp Vault, etc.)
- Monorepo migration or repository consolidation
- Package publishing (npm, etc.)
- Authentication model changes (INTERNAL_AUTH_SECRET shared-secret model is retained)
- Uninstall / cleanup scripts

---

## Traceability

| Requirement | Audit Finding |
|---|---|
| REQ-D1 | No secret generation automation exists today |
| REQ-D2 | `INTERNAL_AUTH_SECRET` must be manually copied between repos |
| REQ-D3 | `LLM_PROXY_URL` must be manually determined and entered |
| REQ-D4 | No install scripts exist; README assumes manual `git clone` + manual submodule init |
| REQ-D5 | Submodule exists but initialization is manual |
| REQ-D6 | No post-deploy verification exists |
| REQ-D7 | No secret rotation tooling exists |
| REQ-D8 | No protection against accidental configuration overwriting |
| REQ-D9 | No dry-run support exists in any script |
| REQ-D10 | No exit code contracts defined for any script |
