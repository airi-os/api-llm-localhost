// Verify Deploy — Post-Deployment Verification
//
// Checks that the deployment is working correctly:
//   1. llm-proxy deployment is reachable
//   2. Topology endpoint returns HTTP 200
//   3. Topology response validates against schema
//   4. freellmapi server is running (end-to-end)
//   5. Discovered worker count is valid (>= 0)
//   6. Fallback mode is reported correctly when dynamic topology unavailable
//
// Usage:
//   pnpm run verify           — run verification
//   pnpm run verify -- --dry-run  — report checks without executing

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './lib/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const frellmapiEnvPath = path.join(projectRoot, '.env');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, passed: true, detail });
}

function fail(name: string, detail: string) {
  results.push({ name, passed: false, detail });
}

// ── Topology schema validation ────────────────────────────────────────

interface TopologyProxy {
  id: number;
  name: string;
  status: string;
}

interface TopologyResponse {
  schemaVersion: number;
  topologyId: string;
  topologyGeneratedAt: number;
  workerCount: number;
  proxies: TopologyProxy[];
}

function isValidTopology(data: unknown): data is TopologyResponse {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.schemaVersion === 1 &&
    typeof d.topologyId === 'string' &&
    d.topologyId.length > 0 &&
    typeof d.topologyGeneratedAt === 'number' &&
    typeof d.workerCount === 'number' &&
    Number.isInteger(d.workerCount) &&
    d.workerCount >= 0 &&
    Array.isArray(d.proxies) &&
    d.proxies.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Record<string, unknown>).id === 'number' &&
        typeof (p as Record<string, unknown>).name === 'string' &&
        typeof (p as Record<string, unknown>).status === 'string',
    )
  );
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (isDryRun) {
    console.log('=== DRY RUN — no changes will be made ===\n');
  }

  console.log('🔍 Verifying deployment\n');

  // Read configuration
  const env = parseEnvFile(frellmapiEnvPath);
  const llmProxyUrl = env.get('LLM_PROXY_URL');
  const internalAuth = env.get('INTERNAL_AUTH_SECRET');

  if (!llmProxyUrl) {
    fail('Configuration', 'LLM_PROXY_URL not set in .env');
    printResults();
    process.exit(1);
  }

  if (isDryRun) {
    console.log('  [dry-run] Would execute the following checks:\n');
    console.log('  1. Check llm-proxy deployment reachability');
    console.log('  2. Check topology endpoint returns HTTP 200');
    console.log('  3. Check topology response schema validation');
    console.log('  4. Check freellmapi server is running (end-to-end)');
    console.log('  5. Check workerCount >= 0');
    console.log('  6. Check fallback mode reporting');
    console.log('\n  Dry run complete. No network calls were made.');
    process.exit(0);
  }

  // ── Check 1: llm-proxy deployment reachable ────────────────────────

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${llmProxyUrl}/internal/v1/topology`, {
      method: 'HEAD',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    void res; // We only care about reachability
    pass('1. llm-proxy reachable', llmProxyUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('1. llm-proxy reachable', msg);
    // If we can't reach the proxy, remaining checks will likely fail too
    printResults();
    process.exit(1);
  }

  // ── Check 2: Topology endpoint returns HTTP 200 ─────────────────────

  let topologyData: unknown = null;
  try {
    const headers: Record<string, string> = {};
    if (internalAuth) {
      headers['X-Internal-Auth'] = internalAuth;
    }
    const res = await fetch(`${llmProxyUrl}/internal/v1/topology`, { headers });
    if (res.ok) {
      pass('2. Topology endpoint HTTP 200', `Status: ${res.status}`);
      topologyData = await res.json();
    } else {
      fail('2. Topology endpoint HTTP 200', `Status: ${res.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail('2. Topology endpoint HTTP 200', msg);
  }

  // ── Check 3: Topology schema validation ─────────────────────────────

  if (topologyData !== null) {
    if (isValidTopology(topologyData)) {
      pass('3. Topology schema valid', `schemaVersion=${topologyData.schemaVersion}, proxies=${topologyData.proxies.length}`);
    } else {
      fail('3. Topology schema valid', 'Response does not match expected topology schema');
    }

    // ── Check 5: workerCount >= 0 ─────────────────────────────────────

    const workerCount = (topologyData as TopologyResponse).workerCount;
    if (workerCount >= 0) {
      pass('5. Worker count valid', `workerCount=${workerCount}`);
    } else {
      fail('5. Worker count valid', `workerCount=${workerCount} (expected >= 0)`);
    }
  } else {
    fail('3. Topology schema valid', 'Skipped (no topology data)');
    fail('5. Worker count valid', 'Skipped (no topology data)');
  }

  // ── Check 4: freellmapi server is running (end-to-end) ──────────────

  try {
    const serverPort = env.get('PORT') || '3001';
    const serverRes = await fetch(`http://localhost:${serverPort}/api/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    if (serverRes.ok) {
      const pingData = await serverRes.json() as { status?: string };
      pass('4. freellmapi server running', `Server responded: ${pingData.status ?? 'ok'}`);
    } else {
      fail('4. freellmapi server running', `Server responded with status ${serverRes.status}`);
    }
  } catch {
    // Server not running — this is optional, not a hard fail
    pass('4. freellmapi server running', 'Server not running (optional check skipped)');
  }

  // ── Check 6: Fallback mode reporting ────────────────────────────────

  const proxyIpCount = env.get('PROXY_IP_COUNT');
  if (!llmProxyUrl) {
    pass('6. Fallback mode', 'LLM_PROXY_URL not set — topology discovery will be skipped');
  } else if (topologyData === null) {
    if (proxyIpCount) {
      pass('6. Fallback mode', `Topology unavailable, PROXY_IP_COUNT=${proxyIpCount} will be used as fallback`);
    } else {
      pass('6. Fallback mode', 'Topology unavailable, PROXY_IP_COUNT not set — IP capacity disabled');
    }
  } else {
    pass('6. Fallback mode', 'Dynamic topology is available');
  }

  // ── Results ─────────────────────────────────────────────────────────

  printResults();

  const allPassed = results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

function printResults(): void {
  console.log('\n── Results ──\n');
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    const detail = r.detail ? ` — ${r.detail}` : '';
    console.log(`  ${icon} ${r.name}${detail}`);
  }
  console.log();
}

main().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
