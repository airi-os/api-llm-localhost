// Topology Client Service
//
// Fetches and caches the proxy topology from llm-proxy's /internal/v1/topology
// endpoint at startup. Provides the worker count to ipPoolCapacity.
//
// Fallback chain: dynamic topology → PROXY_IP_COUNT env → 0

export interface TopologyProxy {
  id: number;
  name: string;
  status: 'active' | 'unknown';
}

export interface TopologySnapshot {
  schemaVersion: number;
  topologyId: string;
  topologyGeneratedAt: number;
  workerCount: number;
  proxies: TopologyProxy[];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let cachedSnapshot: TopologySnapshot | null = null;
let dynamicAvailable = false;

const TOPOLOGY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidTopology(data: unknown): data is TopologySnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.schemaVersion === 1 &&
    typeof d.topologyId === 'string' &&
    typeof d.topologyGeneratedAt === 'number' &&
    typeof d.workerCount === 'number' &&
    Number.isInteger(d.workerCount) &&
    d.workerCount >= 0 &&
    Array.isArray(d.proxies)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initialize(): Promise<void> {
  const proxyUrl = process.env.LLM_PROXY_URL;
  const internalAuth = process.env.INTERNAL_AUTH_SECRET;

  if (!proxyUrl) {
    console.log('[topology] LLM_PROXY_URL not set, skipping topology discovery');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOPOLOGY_TIMEOUT_MS);

    const res = await fetch(`${proxyUrl}/internal/v1/topology`, {
      method: 'GET',
      headers: internalAuth ? { 'X-Internal-Auth': internalAuth } : {},
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[topology] fetch failed with status ${res.status}, falling back to static config`);
      return;
    }

    const data: unknown = await res.json();

    if (!isValidTopology(data)) {
      console.warn('[topology] invalid topology response, falling back to static config');
      return;
    }

    cachedSnapshot = data;
    dynamicAvailable = true;
    console.log(`[topology] discovered ${data.workerCount} workers`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[topology] unavailable (${message}), falling back to static config`);
  }
}

/** Return the worker count from dynamic topology, or 0 if unavailable. */
export function getWorkerCount(): number {
  if (!dynamicAvailable || !cachedSnapshot) return 0;
  return cachedSnapshot.workerCount;
}

/** Return the full topology snapshot, or null if unavailable. */
export function getTopology(): TopologySnapshot | null {
  return cachedSnapshot;
}

/** Whether dynamic topology was successfully fetched at startup. */
export function isDynamicTopologyAvailable(): boolean {
  return dynamicAvailable;
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

export function _reset(): void {
  cachedSnapshot = null;
  dynamicAvailable = false;
}

export function _setMockTopology(topology: TopologySnapshot | null): void {
  cachedSnapshot = topology;
  dynamicAvailable = topology !== null;
}
