# Zero-Configuration Deployment Requirements

## Overview

This specification defines the requirements for transforming freellmapi into a true zero-configuration deployment experience. A first-time user with only Wrangler authentication must be able to install and run the entire stack without editing any `.env` files or understanding Cloudflare Workers, domains, topology, routing, or capacity management.

The target user journey is:
1. Install Node.js
2. Run `wrangler login`
3. Run `install.sh` or `install.ps1`
4. Start freellmapi (`pnpm dev` or `pnpm start`)

Everything between `wrangler login` and `pnpm dev` must be fully automated.

---

## REQ-Z1: Zero-Interactive Installation

The installation process must require zero interactive prompts beyond the initial `wrangler login` (which is a Cloudflare prerequisite).

### Requirements

- **REQ-Z1.1**: The `install.sh` and `install.ps1` scripts must complete the entire installation without prompting the user for any configuration values.
- **REQ-Z1.2**: The `setup.ts` script must operate in fully non-interactive mode by default. All values must be auto-generated or auto-detected.
- **REQ-Z1.3**: The `--non-interactive` flag (or absence of `--interactive`) must be the default mode for `setup.ts`.
- **REQ-Z1.4**: If a required value cannot be auto-generated or auto-detected, the script must fail with a clear error message and non-zero exit code rather than prompting.
- **REQ-Z1.5**: The `setup.ts` script must support an optional `--interactive` flag for advanced users who want manual control.

---

## REQ-Z2: Auto-Deploy llm-proxy

The installer must automatically deploy llm-proxy to Cloudflare Workers as part of the installation process.

### Requirements

- **REQ-Z2.1**: After `setup.ts` completes, `install.sh` / `install.ps1` must automatically invoke the llm-proxy deployment process.
- **REQ-Z2.2**: The deployment must use `wrangler deploy` to deploy all proxy workers and the router worker.
- **REQ-Z2.3**: The deployment must handle Wrangler authentication failures gracefully with a clear error message.
- **REQ-Z2.4**: The deployment must verify that all workers were deployed successfully before proceeding.
- **REQ-Z2.5**: If deployment fails, the script must report the failure clearly and provide manual recovery instructions.
- **REQ-Z2.6**: The deployment step must be idempotent — re-running install must not create duplicate workers.

---

## REQ-Z3: Auto-Detect workers.dev URL

When no custom domain is configured, the system must automatically use Cloudflare's free `*.workers.dev` subdomain.

### Requirements

- **REQ-Z3.1**: The llm-proxy deploy process must default to deploying the router to `*.workers.dev` when no `ROUTER_DOMAIN` is configured.
- **REQ-Z3.2**: The deploy script must capture the deployed router URL from `wrangler deploy` output.
- **REQ-Z3.3**: The captured URL must be written to both `llm-proxy/.env` as `ROUTER_DOMAIN` and to the freellmapi `.env` as `LLM_PROXY_URL`.
- **REQ-Z3.4**: If a custom `ROUTER_DOMAIN` is already configured in `llm-proxy/.env`, it must be preserved (not overwritten with `*.workers.dev`).
- **REQ-Z3.5**: The `ROUTER_DOMAIN` value must not include the `https://` prefix — it must be a bare domain (e.g., `llm-proxy-router.<subdomain>.workers.dev`).

---

## REQ-Z4: Auto-Configure LLM_PROXY_URL

The freellmapi server's `LLM_PROXY_URL` must be automatically set to the deployed router's URL.

### Requirements

- **REQ-Z4.1**: After llm-proxy deployment, the deploy process must write `LLM_PROXY_URL` to the freellmapi `.env` file.
- **REQ-Z4.2**: `LLM_PROXY_URL` must be in the format `https://{ROUTER_DOMAIN}`.
- **REQ-Z4.3**: If `LLM_PROXY_URL` is already set in `.env`, it must be preserved unless `--regenerate` is specified.
- **REQ-Z4.4**: The value must be validated as a valid HTTPS URL before writing.

---

## REQ-Z5: Auto-Generate All Secrets

All secrets must be auto-generated with no user input required.

### Requirements

- **REQ-Z5.1**: `ENCRYPTION_KEY` — auto-generate using `crypto.randomBytes(32).toString('hex')` (64 hex chars).
- **REQ-Z5.2**: `ADMIN_DASHBOARD_KEY` — auto-generate using `'freellmapi-admin-' + crypto.randomBytes(32).toString('hex')`.
- **REQ-Z5.3**: `INTERNAL_AUTH_SECRET` — auto-generate using `crypto.randomBytes(32).toString('hex')` and synchronize to both `.env` files.
- **REQ-Z5.4**: `AUTH_KEY` — auto-generate using a secure random string (minimum 16 characters). No user prompt.
- **REQ-Z5.5**: All secrets must be preserved on re-run (never overwrite existing values unless `--regenerate` is specified).
- **REQ-Z5.6**: Generated secrets must be printed to stdout with a warning to back them up.

---

## REQ-Z6: Dynamic Topology (Eliminate Static topology.ts)

The router must generate topology responses dynamically from environment variables, eliminating the static `src/generated/topology.ts` module.

### Requirements

- **REQ-Z6.1**: The `/internal/v1/topology` endpoint on the router must generate its response dynamically from `env.PROXY_COUNT` and the service bindings available on the router.
- **REQ-Z6.2**: The response schema must remain backwards-compatible with the existing `TopologySnapshot` interface (same `schemaVersion`, `topologyId`, `topologyGeneratedAt`, `workerCount`, `proxies` fields).
- **REQ-Z6.3**: The `topologyId` must be computed as a deterministic hash of the topology-defining fields (same algorithm as current `deploy.ts`).
- **REQ-Z6.4**: The `proxies` array must be generated by iterating from `1` to `env.PROXY_COUNT`, creating entries with `id: i-1`, `name: llm-proxy-{i}`, `status: "active"`.
- **REQ-Z6.5**: The static `src/generated/topology.ts` file must no longer be imported by the router.
- **REQ-Z6.6**: The `import { TOPOLOGY } from "./generated/topology"` statement must be removed from `router.ts`.
- **REQ-Z6.7**: The `generateTopologyModule()` function in `deploy.ts` must be removed (no longer needed).

---

## REQ-Z7: Worker Count from Provider Keys

The system must automatically determine the required worker count from the number of enabled API keys per provider platform.

### Requirements

- **REQ-Z7.1**: On startup, freellmapi must query the database for the maximum count of enabled API keys across all platforms:
  ```sql
  SELECT MAX(key_count) FROM (
    SELECT COUNT(*) as key_count FROM api_keys WHERE enabled = 1 GROUP BY platform
  )
  ```
- **REQ-Z7.2**: If no API keys exist, the default worker count must be `1` (minimum viable pool).
- **REQ-Z7.3**: The computed worker count must be compared against the topology's `workerCount` to detect drift.
- **REQ-Z7.4**: The worker count must be configurable via `PROXY_COUNT` in `llm-proxy/.env` for manual override.
- **REQ-Z7.5**: The initial deployment must default to `PROXY_COUNT=1` (single proxy) to minimize resource usage for new installations.

---

## REQ-Z8: Startup Drift Detection

The freellmapi server must detect topology drift on every startup.

### Requirements

- **REQ-Z8.1**: During startup, after fetching topology, the server must compare `topology.workerCount` against the computed expected worker count from REQ-Z7.
- **REQ-Z8.2**: If `topology.workerCount < expectedCount`, drift is detected and reconciliation must be triggered.
- **REQ-Z8.3**: If `topology.workerCount >= expectedCount`, no action is needed (over-provisioning is acceptable).
- **REQ-Z8.4**: Drift detection must be logged with clear messages indicating current vs expected worker count.
- **REQ-Z8.5**: Drift detection must not block server startup — reconciliation runs asynchronously.

---

## REQ-Z9: Automatic Reconciliation

When drift is detected, the system must automatically reconcile the topology.

### Requirements

- **REQ-Z9.1**: A `scripts/reconcile-topology.ts` script must exist that performs topology reconciliation.
- **REQ-Z9.2**: The reconciliation script must:
  1. Read the expected worker count from the database
  2. Generate new TOML configs for all proxy workers and the router
  3. Run `wrangler deploy` for each worker
  4. Verify the deployment by fetching the topology endpoint
- **REQ-Z9.3**: The reconciliation must be triggered automatically by the server on startup when drift is detected.
- **REQ-Z9.4**: The reconciliation must be manually triggerable via `pnpm run reconcile-topology`.
- **REQ-Z9.5**: If reconciliation fails, the server must log a clear error and continue operating with the current topology (degraded but functional).
- **REQ-Z9.6**: The reconciliation script must support `--dry-run` mode.

---

## REQ-Z10: Eliminate PROXY_IP_COUNT

The `PROXY_IP_COUNT` environment variable must be removed from freellmapi's configuration.

### Requirements

- **REQ-Z10.1**: The `PROXY_IP_COUNT` entry must be removed from `.env.example`.
- **REQ-Z10.2**: The `ipPoolCapacity.ts` service must obtain worker count exclusively from the dynamic topology client.
- **REQ-Z10.3**: The fallback chain in `ipPoolCapacity.ts` must be: dynamic topology → 0 (disabled).
- **REQ-Z10.4**: The `isStickyRoutingEnabled()` function must check only `isDynamicTopologyAvailable()`, not `PROXY_IP_COUNT`.
- **REQ-Z10.5**: All references to `PROXY_IP_COUNT` in code and documentation must be removed.
- **REQ-Z10.6**: Existing installations with `PROXY_IP_COUNT` set must log a deprecation warning on startup but continue to function.

---

## REQ-Z11: Idempotent Re-Installation

Re-running the install process must be safe and must not disrupt a working system.

### Requirements

- **REQ-Z11.1**: Re-running `install.sh` / `install.ps1` must not overwrite existing `.env` files.
- **REQ-Z11.2**: Re-running `setup.ts` must not regenerate existing secrets.
- **REQ-Z11.3**: Re-running the llm-proxy deployment must update existing workers (not create duplicates).
- **REQ-Z11.4**: Re-running must not reset the database or lose any data.
- **REQ-Z11.5**: Each step must report what it checked and whether changes were made.

---

## REQ-Z12: Backwards Compatibility

Changes must not break existing deployments that use the current configuration model.

### Requirements

- **REQ-Z12.1**: The `/internal/v1/topology` endpoint response schema must remain identical (same field names, types, and structure).
- **REQ-Z12.2**: Existing `PROXY_IP_COUNT` configurations must continue to work during a transition period (deprecated but functional).
- **REQ-Z12.3**: The `ROUTER_DOMAIN` configuration in `llm-proxy/.env` must continue to work for users with custom domains.
- **REQ-Z12.4**: The `LLM_PROXY_URL` configuration in freellmapi's `.env` must continue to work.
- **REQ-Z12.5**: The `llm-proxy/scripts/deploy.ts` script must continue to function for manual deployments.
- **REQ-Z12.6**: Existing `wrangler.toml` configurations must continue to work.

---

## Out of Scope

- Automated Cloudflare DNS provisioning
- Automated domain registration
- Custom domain configuration (users who want custom domains can still configure them manually)
- CI/CD pipeline configuration
- Docker / containerization
- Multi-environment management (staging, production)
- `ENCRYPTION_KEY` rotation automation
- Secret storage in a vault
- Monorepo migration
- Uninstall / cleanup scripts
- Changes to the llm-proxy proxy worker logic (only router and deployment changes)

---

## Traceability

| Requirement | Current Pain Point |
|---|---|
| REQ-Z1 | `setup.ts` prompts for AUTH_KEY and ROUTER_DOMAIN |
| REQ-Z2 | llm-proxy deployment is a separate manual step |
| REQ-Z3 | No `*.workers.dev` fallback — requires custom domain |
| REQ-Z4 | `LLM_PROXY_URL` must be manually configured |
| REQ-Z5 | AUTH_KEY requires user input |
| REQ-Z6 | Static `topology.ts` requires code change + redeploy to update worker count |
| REQ-Z7 | Worker count is static, not derived from actual key count |
| REQ-Z8 | No drift detection exists |
| REQ-Z9 | No automatic reconciliation exists |
| REQ-Z10 | `PROXY_IP_COUNT` is a configuration drift source |
| REQ-Z11 | Re-running setup can overwrite values |
| REQ-Z12 | N/A (new requirement for this spec) |
