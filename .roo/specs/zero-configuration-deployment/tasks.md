# Zero-Configuration Deployment — Tasks

## Overview

This document defines the implementation tasks for transforming freellmapi into a zero-configuration deployment experience. Tasks are organized by phase, with dependencies tracked between phases.

**Key principles**:
- Each task is independently verifiable
- Phases must be completed in order
- Idempotency is required for all scripts
- Backward compatibility is maintained at every step

---

## Phase 1: Make setup.ts Non-Interactive

**Goal**: Eliminate all blocking prompts from `setup.ts`. All secrets auto-generated.

### T1.1 — Add `--non-interactive` mode to setup.ts

Modify `scripts/setup.ts`:
- Default mode is non-interactive (no prompts)
- Add `--interactive` flag to enable old prompt-based behavior
- When non-interactive:
  - AUTH_KEY: auto-generate via `generateAuthKey()` (no prompt)
  - ROUTER_DOMAIN: skip entirely (handled by deploy-proxy later)
  - LLM_PROXY_URL: skip (set by deploy-proxy after deployment)
- When `--interactive`:
  - Preserve existing prompt behavior for AUTH_KEY and ROUTER_DOMAIN
- Add `--non-interactive` flag detection alongside existing `--dry-run` and `--regenerate`

### T1.2 — Auto-generate AUTH_KEY without prompt

In `scripts/setup.ts`, replace the interactive AUTH_KEY prompt (lines 168-177):
```typescript
// Before:
const authKey = await prompt('Enter AUTH_KEY (or press Enter for random):', suggested);

// After (non-interactive):
const authKey = generateAuthKey();
logAction('generate', 'AUTH_KEY', 'llm-proxy/.env');
llmProxyUpdates.set('AUTH_KEY', authKey);
```

### T1.3 — Remove ROUTER_DOMAIN prompt from setup.ts

In `scripts/setup.ts`, remove the ROUTER_DOMAIN prompt block (lines 183-189):
```typescript
// Remove:
const existingRouterDomain = llmProxyEnv.get('ROUTER_DOMAIN') || 'router.example.com';
const routerDomain = await prompt('Enter router domain:', existingRouterDomain);
```

Also remove the LLM_PROXY_URL derivation from ROUTER_DOMAIN (lines 191-197). LLM_PROXY_URL will be set by `deploy-proxy.ts` after deployment.

### T1.4 — Add deploy-proxy invocation to setup.ts

At the end of `setup.ts` `main()`, after writing configuration:
```typescript
// After writing .env files, trigger deploy-proxy
if (!isDryRun) {
  console.log('\n── Deploying llm-proxy ──');
  // Import and run deploy-proxy
  const { deployProxy } = await import('./deploy-proxy.js');
  await deployProxy();
} else {
  console.log('  [dry-run] Would run: pnpm run deploy-proxy');
}
```

### T1.5 — Add `deploy-proxy` script to root package.json

In root `package.json`, add:
```json
"deploy-proxy": "tsx scripts/deploy-proxy.ts"
```

### T1.6 — Verify setup.ts backward compatibility

- Run `pnpm run setup -- --interactive` on an existing installation → should prompt as before
- Run `pnpm run setup` (no flags) on a clean installation → should complete without prompts
- Run `pnpm run setup -- --dry-run` → should report all actions without writing

---

## Phase 2: Create deploy-proxy.ts

**Goal**: New script that deploys llm-proxy, captures the workers.dev URL, and writes LLM_PROXY_URL.

### T2.1 — Create `scripts/deploy-proxy.ts` skeleton

Create the file with:
- CLI args: `--dry-run`
- Read `AUTH_KEY`, `INTERNAL_AUTH_SECRET`, `PROXY_COUNT` from `llm-proxy/.env`
- Default `PROXY_COUNT` to `1` if not set
- Validate all required values are present

### T2.2 — Implement TOML generation in deploy-proxy.ts

Implement two functions:
- `generateProxyToml(index, internalSecret)` — same as `llm-proxy/scripts/deploy.ts:generateProxyToml()`
- `generateRouterToml(proxyCount, internalSecret, authKey)` — modified version:
  - **No `routes` field** (uses workers.dev subdomain)
  - **No `ROUTER_DOMAIN` in vars**
  - Same `services` bindings as before

### T2.3 — Implement wrangler deploy execution in deploy-proxy.ts

Implement:
- `runWranglerDeploy(configPath)` — same pattern as `llm-proxy/scripts/deploy.ts:runWranglerDeploy()`
- `deployWithRetry(worker)` — same retry logic (3 attempts, exponential backoff)
- `deployParallel(workers)` — deploy proxies in parallel with stagger

### T2.4 — Implement URL capture from wrangler output

In the router deploy step:
- Capture stdout from `wrangler deploy`
- Extract URL using regex: `/https:\/\/llm-proxy-router\.[a-zA-Z0-9-]+\.workers\.dev/`
- If no match, fail with error: "Could not detect router URL from wrangler output. Check wrangler deploy output manually."
- Return the captured URL

### T2.5 — Write LLM_PROXY_URL to .env

After successful deployment:
- Use `updateEnvKey()` from `scripts/lib/env.ts` to write `LLM_PROXY_URL` to `freellmapi-alpha/.env`
- Format: `https://llm-proxy-router.<subdomain>.workers.dev`
- Validate it's a valid HTTPS URL before writing

### T2.6 — Implement dry-run mode in deploy-proxy.ts

In dry-run mode:
- Report all actions: TOML generation, wrangler deploy commands, URL capture, .env update
- No files written, no network calls
- Exit 0

### T2.7 — Implement error handling in deploy-proxy.ts

- If `llm-proxy/.env` is missing required values → fail with clear message
- If wrangler deploy fails after retries → fail with error + manual recovery instructions
- If URL capture fails → fail with error + suggest manual LLM_PROXY_URL configuration
- Print summary of deployed workers (success/failure count)

---

## Phase 3: Dynamic Topology Endpoint

**Goal**: Replace static `topology.ts` import with dynamic generation in the router.

### T3.1 — Remove static topology import from router.ts

In `llm-proxy/src/router.ts`:
- Remove `import { TOPOLOGY } from "./generated/topology"` (line 4)
- Remove `TOPOLOGY` from the env type (if referenced)

### T3.2 — Add dynamic topology generation to router.ts

In the `/internal/v1/topology` handler (lines 18-24):
```typescript
import crypto from "crypto";

// Replace: return jsonResponse(TOPOLOGY);
const proxyCount = Number(env.PROXY_COUNT);
const proxies = Array.from({ length: proxyCount }, (_, i) => ({
  id: i,
  name: `llm-proxy-${String(i + 1).padStart(2, "0")}`,
  status: "active" as const,
}));
const topologyGeneratedAt = Math.floor(Date.now() / 1000);
const hashInput = JSON.stringify({ schemaVersion: 1, workerCount: proxyCount, proxies });
const topologyId = `sha256:${crypto.createHash("sha256").update(hashInput).digest("hex")}`;
return jsonResponse({
  schemaVersion: 1,
  topologyId,
  topologyGeneratedAt,
  workerCount: proxyCount,
  proxies,
});
```

### T3.3 — Remove ROUTER_DOMAIN from router.ts

In `llm-proxy/src/router.ts`:
- Remove `ROUTER_DOMAIN` from the env type declaration
- Replace `env.ROUTER_DOMAIN || url.hostname` with `url.hostname` (line 34)

### T3.4 — Remove generateTopologyModule from deploy.ts

In `llm-proxy/scripts/deploy.ts`:
- Remove the `generateTopologyModule()` function (lines 248-273)
- Remove the call to `generateTopologyModule()` in `main()` (lines 327-332)
- Remove the `topologyDir` and `topologyModule` variables

### T3.5 — Remove ROUTER_DOMAIN from deploy.ts

In `llm-proxy/scripts/deploy.ts`:
- Remove `requireEnv("ROUTER_DOMAIN", 1)` (line 282)
- Remove `routerDomain` parameter from `generateRouterToml()`
- Remove `routes: [{ pattern: routerDomain, custom_domain: true }]` from router TOML
- Remove `ROUTER_DOMAIN: routerDomain` from router TOML vars
- Update `main()` to not pass `routerDomain` to `generateRouterToml()`

### T3.6 — Verify topology response schema

Deploy the updated router and verify:
- `GET /internal/v1/topology` returns HTTP 200 with `X-Internal-Auth` header
- Response matches the `TopologySnapshot` interface exactly
- `topologyId` format is `sha256:<hex>`
- `proxies` array length equals `PROXY_COUNT`

---

## Phase 4: Topology Reconciliation

**Goal**: Detect and fix topology drift on startup.

### T4.1 — Create `scripts/reconcile-topology.ts`

Create the script with:
- Read `LLM_PROXY_URL` and `INTERNAL_AUTH_SECRET` from freellmapi `.env`
- Read `AUTH_KEY`, `INTERNAL_AUTH_SECRET`, `PROXY_COUNT` from `llm-proxy/.env`
- `--dry-run` flag support

### T4.2 — Implement expected worker count query

Implement `getExpectedWorkerCount()`:
```typescript
import { getDb } from '../server/src/db/index.js';

function getExpectedWorkerCount(): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(key_count) as max_count FROM (
      SELECT COUNT(*) as key_count FROM api_keys WHERE enabled = 1 GROUP BY platform
    )
  `).get() as { max_count: number | null };
  return row?.max_count && row.max_count > 0 ? row.max_count : 1;
}
```

### T4.3 — Implement drift detection

Implement `detectDrift()`:
- Fetch current topology from `${LLM_PROXY_URL}/internal/v1/topology`
- Compare `topology.workerCount` vs `getExpectedWorkerCount()`
- Return `{ drifted: boolean, actual: number, expected: number }`

### T4.4 — Implement reconciliation

Implement `reconcile()`:
- If no drift: log "No drift detected ({actual} workers)", return success
- If drift detected:
  1. Log: "Topology drift detected: {actual} workers, expected {expected}"
  2. Update `PROXY_COUNT` in `llm-proxy/.env` to the expected count
  3. Generate new TOML configs (reuse functions from `deploy-proxy.ts`)
  4. Deploy all workers via wrangler deploy
  5. Verify new topology returns updated `workerCount`
  6. Log result

### T4.5 — Create `server/src/services/topologyReconciliation.ts`

Create an importable module that wraps the reconciliation logic:
```typescript
export async function reconcileTopology(): Promise<void> {
  try {
    // Same logic as reconcile-topology.ts but importable
    // Runs asynchronously, doesn't block startup
  } catch (err) {
    console.error('[reconciliation] failed:', err);
    // Continue operating with current topology
  }
}
```

### T4.6 — Add reconciliation call to server startup

In `server/src/index.ts`:
```typescript
import { reconcileTopology } from './services/topologyReconciliation.js';

async function main() {
  assertAdminAuthConfigured();
  initDb();
  await initTopology();
  await reconcileTopology();  // NEW
  const app = createApp();
  // ...
}
```

### T4.7 — Add `reconcile-topology` script to package.json

In root `package.json`:
```json
"reconcile-topology": "tsx scripts/reconcile-topology.ts"
```

---

## Phase 5: Eliminate Deprecated Env Vars

**Goal**: Remove PROXY_IP_COUNT, ROUTER_DOMAIN, and PROXY_COUNT from manual configuration.

### T5.1 — Update `.env.example`

In `freellmapi-alpha/.env.example`:
- Remove the `PROXY_IP_COUNT` entry (lines 15-17)
- Add `LLM_PROXY_URL=https://llm-proxy-router.<subdomain>.workers.dev`

### T5.2 — Update `llm-proxy/.env.example`

In `llm-proxy/.env.example`:
- Remove `ROUTER_DOMAIN=router.example.com` (line 12)
- Change `PROXY_COUNT=3` to `# PROXY_COUNT=1  (managed by freellmapi, set to 1 for new installations)`

### T5.3 — Remove PROXY_IP_COUNT from ipPoolCapacity.ts

In `server/src/services/ipPoolCapacity.ts`:
- In `getWorkerCount()`: remove the `PROXY_IP_COUNT` fallback (lines 68-70)
- New `getWorkerCount()`:
  ```typescript
  export function getWorkerCount(): number {
    if (isDynamicTopologyAvailable()) {
      return getTopologyWorkerCount();
    }
    return 0;
  }
  ```
- In `isStickyRoutingEnabled()`: remove the `PROXY_IP_COUNT` check (lines 91-100)
- New `isStickyRoutingEnabled()`:
  ```typescript
  export function isStickyRoutingEnabled(): boolean {
    return isDynamicTopologyAvailable();
  }
  ```
- Add deprecation warning at module load:
  ```typescript
  if (process.env.PROXY_IP_COUNT !== undefined) {
    console.warn('[deprecation] PROXY_IP_COUNT is deprecated and ignored. Worker count is now derived from provider API keys.');
  }
  ```

### T5.4 — Remove ROUTER_DOMAIN from router.ts env type

In `llm-proxy/src/router.ts`:
- Remove `ROUTER_DOMAIN` from the env type in `handleRouterRequest` parameter

---

## Phase 6: Update install.sh / install.ps1

**Goal**: Ensure install scripts trigger the full zero-config flow.

### T6.1 — Verify install.sh triggers deploy-proxy via setup.ts

The existing `install.sh` already invokes `pnpm run setup`. Since `setup.ts` now triggers `deploy-proxy` automatically in non-interactive mode, no changes to `install.sh` are needed.

Verify:
- `install.sh` → `pnpm run setup` → `setup.ts` (non-interactive) → `deploy-proxy.ts`
- The full chain completes without user input

### T6.2 — Verify install.ps1 triggers deploy-proxy via setup.ts

Same as T6.1 for PowerShell. Verify the chain works on Windows.

### T6.3 — Update install.sh final instructions

Update the "Next steps" message in `install.sh`:
```bash
echo "Next steps:"
echo "  pnpm dev                        Start local development"
echo "  pnpm run verify                 Verify deployment"
# Remove: "cd llm-proxy && npm run deploy  Deploy proxy to Cloudflare"
```

### T6.4 — Update install.ps1 final instructions

Same as T6.3 for `install.ps1`.

---

## Phase 7: Update verify-deploy.ts

**Goal**: Update verification script for the new architecture.

### T7.1 — Update verify-deploy.ts for workers.dev URL

In `scripts/verify-deploy.ts`:
- The existing checks still work (topology endpoint, schema validation)
- Update check 6 (fallback mode) to reflect PROXY_IP_COUNT deprecation:
  - If `PROXY_IP_COUNT` is set, report it as deprecated
  - Report dynamic topology availability as the primary status

### T7.2 — Add LLM_PROXY_URL validation

In `scripts/verify-deploy.ts`:
- Add a check that `LLM_PROXY_URL` matches the expected workers.dev pattern
- If `LLM_PROXY_URL` contains `workers.dev`, note that zero-config deployment is active

---

## Phase 8: Update README.md

**Goal**: Document the new zero-config installation flow.

### T8.1 — Update freellmapi-alpha README.md Quick Start

Replace the Quick Start section:
```markdown
## Quick Start

1. Install Node.js
2. Run `wrangler login`
3. Run `./install.sh` (Linux/macOS) or `.\install.ps1` (Windows)
4. Run `pnpm dev`

That's it. The installer handles everything:
- Deploys llm-proxy to Cloudflare Workers
- Configures all secrets automatically
- Sets up the database
- Verifies the deployment
```

### T8.2 — Update README.md Advanced Configuration

Add a section documenting:
- `--interactive` flag for manual control
- `--regenerate` flag for secret rotation
- `--dry-run` flag for previewing changes
- Manual `pnpm run reconcile-topology` for topology reconciliation
- Manual `pnpm run deploy-proxy` for re-deploying llm-proxy

### T8.3 — Update README.md Environment Variables

Update the environment variable documentation:
- Remove `PROXY_IP_COUNT` from the table
- Remove `ROUTER_DOMAIN` from the table
- Add `LLM_PROXY_URL` to the table
- Note that `PROXY_COUNT` in `llm-proxy/.env` is managed by freellmapi

---

## Phase 9: Tests

**Goal**: Verify all new behavior works correctly.

### T9.1 — Test setup.ts non-interactive mode

```bash
# Clean environment (no .env files)
rm -f .env llm-proxy/.env
pnpm run setup -- --dry-run
# Verify: reports all actions, writes nothing

pnpm run setup
# Verify: completes without prompts, creates .env files, deploys llm-proxy
```

### T9.2 — Test setup.ts interactive mode

```bash
pnpm run setup -- --interactive
# Verify: prompts for AUTH_KEY and ROUTER_DOMAIN (backward compat)
```

### T9.3 — Test setup.ts idempotency

```bash
# Run setup twice
pnpm run setup
pnpm run setup
# Verify: second run preserves all values, reports "preserved"
```

### T9.4 — Test deploy-proxy.ts

```bash
pnpm run deploy-proxy -- --dry-run
# Verify: reports TOML generation, wrangler commands, URL capture

pnpm run deploy-proxy
# Verify: deploys workers, captures URL, writes LLM_PROXY_URL
```

### T9.5 — Test deploy-proxy.ts idempotency

```bash
pnpm run deploy-proxy
pnpm run deploy-proxy
# Verify: second run updates existing workers (no duplicates)
```

### T9.6 — Test dynamic topology endpoint

```bash
# Deploy router with PROXY_COUNT=2
curl -H "X-Internal-Auth: $INTERNAL_AUTH_SECRET" $LLM_PROXY_URL/internal/v1/topology
# Verify: workerCount=2, proxies array has 2 entries

# Update PROXY_COUNT to 4, redeploy
curl -H "X-Internal-Auth: $INTERNAL_AUTH_SECRET" $LLM_PROXY_URL/internal/v1/topology
# Verify: workerCount=4, proxies array has 4 entries
```

### T9.7 — Test topology reconciliation

```bash
# Add API keys to DB (simulate 5 keys for one platform)
pnpm run reconcile-topology -- --dry-run
# Verify: reports drift detection, would redeploy with PROXY_COUNT=5

pnpm run reconcile-topology
# Verify: redeploys with updated worker count, new topology reflects change
```

### T9.8 — Test PROXY_IP_COUNT deprecation

```bash
# Set PROXY_IP_COUNT in .env
echo "PROXY_IP_COUNT=3" >> .env
pnpm dev
# Verify: deprecation warning logged, value ignored
```

### T9.9 — Test verify-deploy.ts

```bash
pnpm run verify
# Verify: all checks pass, reports workers.dev URL
```

### T9.10 — Test end-to-end flow

```bash
# Clean environment
rm -f .env llm-proxy/.env server/data/freeapi.db

# Full install
./install.sh
# Verify: completes without prompts

# Start server
pnpm dev
# Verify: server starts, topology fetched, reconciliation runs

# Verify deployment
pnpm run verify
# Verify: all checks pass
```

---

## Dependencies

```
Phase 1 (T1.1-T1.6) → Phase 2 (T2.1-T2.7)     [setup.ts must trigger deploy-proxy]
Phase 1 (T1.1-T1.6) → Phase 3 (T3.1-T3.6)     [setup.ts no longer needs ROUTER_DOMAIN]
Phase 2 (T2.1-T2.7) → Phase 4 (T4.1-T4.7)     [deploy-proxy.ts TOML functions reusable]
Phase 3 (T3.1-T3.6) → Phase 4 (T4.1-T4.7)     [dynamic topology needed for reconciliation]
Phase 4 (T4.1-T4.7) → Phase 5 (T5.1-T5.4)     [reconciliation must work before removing fallbacks]
Phase 5 (T5.1-T5.4) → Phase 6 (T6.1-T6.4)     [env vars cleaned before install scripts]
Phase 6 (T6.1-T6.4) → Phase 7 (T7.1-T7.2)     [install flow stable before verify updates]
Phase 7 (T7.1-T7.2) → Phase 8 (T8.1-T8.3)     [verify works before documenting]
Phase 8 (T8.1-T8.3) → Phase 9 (T9.1-T9.10)     [all code complete before testing]
```

## Verification Checklist

After all phases complete:

- [ ] `./install.sh` completes without any prompts on a clean environment
- [ ] `pnpm run setup` (no flags) completes without prompts
- [ ] `pnpm run setup -- --interactive` prompts for AUTH_KEY and ROUTER_DOMAIN
- [ ] `pnpm run setup -- --dry-run` reports actions without writing
- [ ] `pnpm run deploy-proxy` deploys llm-proxy and writes LLM_PROXY_URL
- [ ] `pnpm run deploy-proxy -- --dry-run` reports actions without deploying
- [ ] `/internal/v1/topology` returns dynamic response (not static)
- [ ] Topology response schema matches `TopologySnapshot` interface
- [ ] `pnpm run reconcile-topology` detects drift and redeploys
- [ ] `pnpm run reconcile-topology -- --dry-run` reports without changes
- [ ] Server startup triggers reconciliation automatically
- [ ] `PROXY_IP_COUNT` in .env logs deprecation warning
- [ ] `pnpm run verify` passes all checks
- [ ] README.md documents the new Quick Start flow
- [ ] Existing installations with manual config continue to work
- [ ] No TypeScript compilation errors
- [ ] All existing tests pass
