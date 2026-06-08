# Zero-Configuration Deployment — Design

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Operator's Machine                           │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  freellmapi-alpha (monorepo)                                  │  │
│  │                                                               │  │
│  │  .env ←── scripts/setup.ts (non-interactive, auto-generates)  │  │
│  │  │                                                            │  │
│  │  ├── server/          (Express API + dashboard)               │  │
│  │  │   └── src/index.ts ← topology reconciliation at startup    │  │
│  │  ├── client/          (React dashboard UI)                    │  │
│  │  ├── shared/          (shared types)                          │  │
│  │  ├── scripts/                                                 │  │
│  │  │   ├── setup.ts            (non-interactive setup)          │  │
│  │  │   ├── deploy-proxy.ts     (auto-deploy llm-proxy)          │  │
│  │  │   ├── reconcile-topology.ts (drift detection + reconcile)  │  │
│  │  │   ├── verify-deploy.ts    (post-deploy verification)      │  │
│  │  │   ├── sync-secrets.ts     (secret sync — unchanged)        │  │
│  │  │   └── rotate-secrets.ts   (secret rotation — unchanged)    │  │
│  │  ├── install.sh       (Linux/macOS bootstrap)                 │  │
│  │  ├── install.ps1      (Windows bootstrap)                     │  │
│  │  └── llm-proxy/       (git submodule)                         │  │
│  │       │                                                       │  │
│  │       └── .env ←── same INTERNAL_AUTH_SECRET, no ROUTER_DOMAIN│  │
│  └───────────────────────────────────────────────────────────────┘  │
│                           │                                         │
│                           │ deploy-proxy.ts                         │
│                           ▼                                         │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Cloudflare Workers                                           │  │
│  │                                                               │  │
│  │  llm-proxy-router.<subdomain>.workers.dev                    │  │
│  │       │                                                       │  │
│  │       ├── /internal/v1/topology (dynamic, from env.PROXY_COUNT)│  │
│  │       └── PROXY_1, PROXY_2, ... PROXY_N                      │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                           ▲                                         │
│                           │ topology discovery + reconciliation     │
│  freellmapi server ───────┘                                         │
└─────────────────────────────────────────────────────────────────────┘
```

## End-to-End Flow

### Installation Flow (Zero-Interactive)

```
install.sh / install.ps1
  │
  ├── 1. Git submodules (git submodule update --init)
  ├── 2. Install dependencies (pnpm install, cd llm-proxy && npm install)
  ├── 3. Validate prerequisites (node, pnpm, wrangler, wrangler whoami)
  └── 4. Invoke: pnpm run setup -- --non-interactive
        │
        ├── 4a. Generate all secrets (auto, no prompts)
        │     ├── ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
        │     ├── ADMIN_DASHBOARD_KEY = 'freellmapi-admin-' + crypto.randomBytes(32).toString('hex')
        │     ├── INTERNAL_AUTH_SECRET = crypto.randomBytes(32).toString('hex')
        │     └── AUTH_KEY = crypto.randomBytes(12).toString('base64url')
        │
        ├── 4b. Write .env files
        │     ├── freellmapi-alpha/.env: ENCRYPTION_KEY, ADMIN_DASHBOARD_KEY,
        │     │     INTERNAL_AUTH_SECRET, LLM_PROXY_URL (placeholder)
        │     └── llm-proxy/.env: AUTH_KEY, INTERNAL_AUTH_SECRET, PROXY_COUNT=1
        │
        └── 4c. Invoke: pnpm run deploy-proxy
              │
              ├── 4c-i.   Read AUTH_KEY, INTERNAL_AUTH_SECRET, PROXY_COUNT from llm-proxy/.env
              ├── 4c-ii.  Generate TOML configs (no custom domain, workers.dev only)
              ├── 4c-iii. Deploy proxy workers via wrangler deploy
              ├── 4c-iv.  Deploy router worker via wrangler deploy
              ├── 4c-v.   Capture router URL from wrangler output
              │           (regex: https://llm-proxy-router\.[^.]+\.workers\.dev)
              ├── 4c-vi.  Write LLM_PROXY_URL to freellmapi-alpha/.env
              └── 4c-vii. Print summary with router URL
```

### Startup Flow (Self-Healing)

```
server/src/index.ts → main()
  │
  ├── 1. assertAdminAuthConfigured()
  ├── 2. initDb()
  ├── 3. await initTopology()          ← existing: fetches /internal/v1/topology
  ├── 4. await reconcileTopology()    ← NEW: detect drift, auto-reconcile
  │     │
  │     ├── 4a. Query DB for expected worker count:
  │     │     SELECT MAX(key_count) FROM (
  │     │       SELECT COUNT(*) as key_count FROM api_keys WHERE enabled = 1 GROUP BY platform
  │     │     )
  │     │     Default: 1 if no keys exist
  │     │
  │     ├── 4b. Read actual worker count from topology.workerCount
  │     │
  │     ├── 4c. Compare:
  │     │     ├── actual >= expected → no action (over-provisioning OK)
  │     │     └── actual < expected → drift detected
  │     │
  │     └── 4d. If drift detected:
  │           ├── Log: "Topology drift: {actual} workers, expected {expected}"
  │           ├── Read current AUTH_KEY, INTERNAL_AUTH_SECRET from llm-proxy/.env
  │           ├── Generate new TOML configs with updated PROXY_COUNT
  │           ├── Deploy all workers via wrangler deploy
  │           ├── Verify new topology endpoint returns updated workerCount
  │           └── Log result (success/failure)
  │
  ├── 5. createApp()
  └── 6. startHealthChecker()
```

## Component Designs

### 1. Non-Interactive Setup (`scripts/setup.ts`)

**Change**: Remove all `await prompt()` calls. All values are auto-generated or auto-detected.

**Current blocking prompts**:
- Line 168-177: `await prompt('Enter AUTH_KEY ...')` → auto-generate via `generateAuthKey()`
- Line 183-189: `await prompt('Enter router domain ...')` → removed entirely (no ROUTER_DOMAIN)

**New behavior**:
- `--non-interactive` is the default mode (no flag needed)
- `--interactive` flag enables the old prompt-based flow for advanced users
- AUTH_KEY: always auto-generated using `crypto.randomBytes(12).toString('base64url')` (16 chars, URL-safe)
- ROUTER_DOMAIN: removed from setup.ts entirely (handled by deploy-proxy.ts)
- LLM_PROXY_URL: set to placeholder `https://llm-proxy-router.<subdomain>.workers.dev` after deploy-proxy completes

**Backward compatibility**: The `--interactive` flag preserves the old behavior for users who want manual control.

### 2. Auto-Deploy Script (`scripts/deploy-proxy.ts`)

**New file**: `scripts/deploy-proxy.ts` — orchestrates llm-proxy deployment from freellmapi.

**Responsibilities**:
1. Read `AUTH_KEY`, `INTERNAL_AUTH_SECRET`, `PROXY_COUNT` from `llm-proxy/.env`
2. Generate TOML configs for all proxy workers and the router
3. Deploy all workers via `wrangler deploy`
4. Capture the router URL from wrangler output
5. Write `LLM_PROXY_URL` to `freellmapi-alpha/.env`

**TOML generation changes** (vs existing `llm-proxy/scripts/deploy.ts`):
- Router TOML: **no `routes` field** (uses `*.workers.dev` subdomain automatically)
- Router TOML: **no `ROUTER_DOMAIN` env var** (removed)
- Proxy TOML: unchanged (still uses `WORKER_ROLE=proxy`, `PROXY_INDEX`, `INTERNAL_AUTH_SECRET`)
- Worker names: `llm-proxy-01`, `llm-proxy-02`, etc. (unchanged)

**URL capture from wrangler output**:
Wrangler deploy output includes lines like:
```
Uploaded llm-proxy-router (2.34 sec)
Published llm-proxy-router (0.45 sec): https://llm-proxy-router.<subdomain>.workers.dev
```
Regex to extract: `https://llm-proxy-router\.[a-zA-Z0-9-]+\.workers\.dev`

**Idempotency**: `wrangler deploy` updates existing workers by name. No duplicate workers are created on re-run.

### 3. Dynamic Topology Endpoint (`llm-proxy/src/router.ts`)

**Change**: Replace static `TOPOLOGY` import with dynamic generation from `env.PROXY_COUNT`.

**Current code** (line 4, 23):
```typescript
import { TOPOLOGY } from "./generated/topology";
// ...
return jsonResponse(TOPOLOGY);
```

**New code**:
```typescript
// Remove: import { TOPOLOGY } from "./generated/topology";
// ...
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

**Schema compatibility**: The response shape is identical to the current static `TOPOLOGY` object — same field names, types, and structure. The `topologyId` uses the same hash algorithm as `deploy.ts:generateTopologyModule()`.

**Note**: The `crypto` import needs to be added to `router.ts` for the `topologyId` hash.

### 4. Topology Reconciliation (`scripts/reconcile-topology.ts`)

**New file**: `scripts/reconcile-topology.ts` — detects and fixes topology drift.

**Algorithm**:
1. Read `LLM_PROXY_URL` and `INTERNAL_AUTH_SECRET` from freellmapi `.env`
2. Fetch current topology from `${LLM_PROXY_URL}/internal/v1/topology`
3. Query DB for expected worker count:
   ```sql
   SELECT MAX(key_count) FROM (
     SELECT COUNT(*) as key_count FROM api_keys WHERE enabled = 1 GROUP BY platform
   )
   ```
   Default to `1` if result is `null` or `0`.
4. Compare `topology.workerCount` vs expected count
5. If `topology.workerCount >= expected`: log "No drift detected", exit 0
6. If `topology.workerCount < expected`:
   - Log drift detection with current vs expected counts
   - Read `AUTH_KEY`, `INTERNAL_AUTH_SECRET` from `llm-proxy/.env`
   - Set `PROXY_COUNT` in `llm-proxy/.env` to the expected count
   - Generate new TOML configs with updated worker count
   - Deploy all workers via `wrangler deploy`
   - Verify new topology returns updated `workerCount`
   - Log result

**Invocation**:
- Automatic: called from `server/src/index.ts` during startup (async, non-blocking)
- Manual: `pnpm run reconcile-topology`
- Dry-run: `pnpm run reconcile-topology -- --dry-run`

**Failure handling**: If reconciliation fails (e.g., wrangler not authenticated, network error), log a clear error and continue. The server operates with the current (under-provisioned) topology.

### 5. Worker Count from Provider Keys

**Source of truth**: `api_keys` table in SQLite.

**Query**:
```sql
SELECT MAX(key_count) FROM (
  SELECT COUNT(*) as key_count FROM api_keys WHERE enabled = 1 GROUP BY platform
)
```

**Interpretation**:
- Result `null` (no keys): default to `1` (minimum viable pool)
- Result `0` (all keys disabled): default to `1`
- Result `N`: use `N` as the expected worker count

**Rationale**: The maximum key count across platforms represents the peak concurrent load the system needs to handle. Each key gets one worker slot (REQ-KS1: one key = one worker).

### 6. Eliminate PROXY_IP_COUNT

**Changes**:
- Remove `PROXY_IP_COUNT` from `.env.example`
- Remove `PROXY_IP_COUNT` from `ipPoolCapacity.ts` fallback chain
- `getWorkerCount()` in `ipPoolCapacity.ts`: only uses dynamic topology (no env fallback)
- `isStickyRoutingEnabled()`: only checks `isDynamicTopologyAvailable()` (no env check)
- Deprecation warning: if `PROXY_IP_COUNT` is set in `.env`, log a warning on startup:
  ```
  [deprecation] PROXY_IP_COUNT is deprecated and ignored. Worker count is now derived from provider API keys.
  ```

### 7. Eliminate ROUTER_DOMAIN

**Changes**:
- Remove `ROUTER_DOMAIN` from `llm-proxy/.env.example`
- Remove `ROUTER_DOMAIN` from `llm-proxy/scripts/deploy.ts` (no longer needed)
- Remove `ROUTER_DOMAIN` env var from router TOML generation
- Router TOML: no `routes` field (workers.dev subdomain is automatic)
- `llm-proxy/src/router.ts`: remove `ROUTER_DOMAIN` from env type and usage
  - The encoder page (line 34) uses `env.ROUTER_DOMAIN || url.hostname` → change to `url.hostname`

### 8. Eliminate PROXY_COUNT (as a static config)

**Changes**:
- `PROXY_COUNT` is still written to `llm-proxy/.env` but is now managed by freellmapi
- Initial value: `1` (single proxy for new installations)
- Updated by `reconcile-topology.ts` when drift is detected
- Removed from interactive setup (no prompt)
- The `llm-proxy/scripts/deploy.ts` script still reads `PROXY_COUNT` from env for manual deployments

### 9. Updated `install.sh` / `install.ps1`

**Changes**:
- After `pnpm run setup` completes, the setup script itself triggers `pnpm run deploy-proxy`
- No change to the install script's own flow — it already invokes `pnpm run setup`
- The setup script's `--non-interactive` mode triggers deploy-proxy automatically

### 10. Updated `server/src/index.ts`

**Change**: Add topology reconciliation call after `initTopology()`.

```typescript
import { reconcileTopology } from './services/topologyReconciliation.js';

async function main() {
  assertAdminAuthConfigured();
  initDb();
  await initTopology();
  await reconcileTopology();  // NEW: non-blocking drift detection + reconciliation
  const app = createApp();
  // ...
}
```

**New file**: `server/src/services/topologyReconciliation.ts` — wraps `scripts/reconcile-topology.ts` logic as an importable module.

## File Changes

| File | Change |
|---|---|
| `scripts/setup.ts` | Remove `await prompt()` for AUTH_KEY (auto-generate). Remove ROUTER_DOMAIN prompt entirely. Add `--non-interactive` as default. |
| `scripts/deploy-proxy.ts` | **NEW**. Orchestrates llm-proxy deployment, captures workers.dev URL, writes LLM_PROXY_URL. |
| `scripts/reconcile-topology.ts` | **NEW**. Drift detection + automatic reconciliation script. |
| `server/src/services/topologyReconciliation.ts` | **NEW**. Importable module wrapping reconcile logic for startup call. |
| `server/src/index.ts` | Add `await reconcileTopology()` after `initTopology()`. |
| `llm-proxy/src/router.ts` | Remove `import { TOPOLOGY } from "./generated/topology"`. Generate topology dynamically from `env.PROXY_COUNT`. Remove `ROUTER_DOMAIN` usage. |
| `llm-proxy/scripts/deploy.ts` | Remove `requireEnv("ROUTER_DOMAIN")`. Remove `routes` from router TOML. Remove `ROUTER_DOMAIN` from router TOML vars. Remove `generateTopologyModule()` call. |
| `llm-proxy/.env.example` | Remove `ROUTER_DOMAIN`. Remove `PROXY_COUNT` (commented out with note: managed by freellmapi). |
| `.env.example` | Remove `PROXY_IP_COUNT` entry. Add `LLM_PROXY_URL` entry. |
| `server/src/services/ipPoolCapacity.ts` | Remove `PROXY_IP_COUNT` fallback from `getWorkerCount()`. Remove `PROXY_IP_COUNT` check from `isStickyRoutingEnabled()`. Add deprecation warning if `PROXY_IP_COUNT` is set. |
| `server/src/services/proxyTopology.ts` | No changes needed (already fetches from endpoint). |
| `install.sh` | No changes needed (already invokes `pnpm run setup` which triggers deploy-proxy). |
| `install.ps1` | No changes needed (same as above). |

## Data Flow Diagrams

### Secret Generation and Flow

```
scripts/setup.ts (non-interactive)
  │
  ├── generateHexSecret() → ENCRYPTION_KEY → freellmapi-alpha/.env
  ├── generateAdminKey() → ADMIN_DASHBOARD_KEY → freellmapi-alpha/.env
  ├── generateHexSecret() → INTERNAL_AUTH_SECRET → freellmapi-alpha/.env + llm-proxy/.env
  └── generateAuthKey() → AUTH_KEY → llm-proxy/.env

scripts/deploy-proxy.ts
  │
  ├── Reads from llm-proxy/.env: AUTH_KEY, INTERNAL_AUTH_SECRET, PROXY_COUNT
  ├── Generates TOML configs with these values
  ├── Deploys workers
  ├── Captures workers.dev URL
  └── Writes LLM_PROXY_URL → freellmapi-alpha/.env

At runtime:
  │
  ├── llm-proxy router: reads INTERNAL_AUTH_SECRET, AUTH_KEY, PROXY_COUNT from env (TOML vars)
  └── freellmapi server: reads INTERNAL_AUTH_SECRET, LLM_PROXY_URL from .env
```

### Topology Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    Topology Lifecycle                             │
│                                                                  │
│  Deploy Time                    Runtime                         │
│  ───────────                    ───────                         │
│  deploy-proxy.ts                index.ts → initTopology()       │
│  ├── Generate TOML (PROXY_COUNT) ├── Fetch /internal/v1/topology│
│  ├── wrangler deploy            ├── Cache snapshot              │
│  └── Capture URL                └── Log worker count            │
│                                                                  │
│  Reconcile Time                 Capacity Service                │
│  ───────────────                ────────────────                │
│  reconcile-topology.ts          ipPoolCapacity.ts               │
│  ├── Query DB for key counts    ├── getWorkerCount()            │
│  ├── Compare vs topology        │   └── topology.getWorkerCount()│
│  ├── If drift: redeploy         ├── allocateIpForKey()          │
│  └── Verify new topology        └── releaseIpForKey()           │
└─────────────────────────────────────────────────────────────────┘
```

## Error Handling

| Condition | Component | Behavior |
|---|---|---|
| AUTH_KEY not set | `setup.ts` | Auto-generate (no prompt) |
| ROUTER_DOMAIN not set | `deploy-proxy.ts` | Use workers.dev (no custom domain needed) |
| wrangler not authenticated | `deploy-proxy.ts` | Fail with clear error + instructions |
| Deploy fails | `deploy-proxy.ts` | Retry up to 3x, then fail with manual recovery instructions |
| Topology fetch fails | `reconcile-topology.ts` | Log warning, skip reconciliation, continue startup |
| Reconciliation fails | `reconcile-topology.ts` | Log error, continue with current topology |
| PROXY_IP_COUNT set in .env | `ipPoolCapacity.ts` | Log deprecation warning, ignore value |
| DB query returns null | `reconcile-topology.ts` | Default to 1 worker |
| wrangler output doesn't match URL regex | `deploy-proxy.ts` | Fail with error: "Could not detect router URL from wrangler output" |

## Backward Compatibility

| Scenario | Behavior |
|---|---|
| Existing deployment with ROUTER_DOMAIN set | Preserved. `setup.ts --interactive` can still set it. `deploy-proxy.ts` uses it if present. |
| Existing deployment with PROXY_COUNT set | Preserved. `reconcile-topology.ts` updates it when drift detected. |
| Existing deployment with PROXY_IP_COUNT set | Deprecated. Logged as warning. Ignored by capacity service. |
| Manual `cd llm-proxy && npm run deploy` | Still works. `deploy.ts` still reads PROXY_COUNT from env. |
| Existing topology response schema | Unchanged. Dynamic endpoint returns identical shape. |
| Existing `.env` files | Never overwritten by `setup.ts`. Missing keys are appended. |

## Security Considerations

- `.env` files are created with restrictive permissions (`chmod 600`) where supported
- Secrets are never logged to stdout (only key names and confirmation)
- `INTERNAL_AUTH_SECRET` is synchronized between both `.env` files automatically
- Generated AUTH_KEY is 16 characters (12 bytes base64url), sufficient for URL path segment security
- No secrets are embedded in committed source code or TOML files
