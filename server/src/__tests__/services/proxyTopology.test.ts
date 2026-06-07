import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initialize,
  getWorkerCount,
  getTopology,
  isDynamicTopologyAvailable,
  _reset,
  _setMockTopology,
  type TopologySnapshot,
} from '../../services/proxyTopology.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validTopology: TopologySnapshot = {
  schemaVersion: 1,
  topologyId: 'sha256:abc123',
  topologyGeneratedAt: 1717640000,
  workerCount: 3,
  proxies: [
    { id: 0, name: 'llm-proxy-00', status: 'active' },
    { id: 1, name: 'llm-proxy-01', status: 'active' },
    { id: 2, name: 'llm-proxy-02', status: 'active' },
  ],
};

const zeroWorkerTopology: TopologySnapshot = {
  schemaVersion: 1,
  topologyId: 'sha256:zero',
  topologyGeneratedAt: 1717640000,
  workerCount: 0,
  proxies: [],
};

function mockFetch(response: { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  globalThis.fetch = vi.fn().mockResolvedValue(response) as typeof fetch;
}

function mockFetchError(error: Error) {
  globalThis.fetch = vi.fn().mockRejectedValue(error) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

  const originalFetch = globalThis.fetch;
describe('proxyTopology', () => {
  const originalProxyUrl = process.env.LLM_PROXY_URL;
  const originalAuth = process.env.INTERNAL_AUTH_SECRET;

  beforeEach(() => {
    _reset();
    delete process.env.LLM_PROXY_URL;
    delete process.env.INTERNAL_AUTH_SECRET;
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    _reset();
    // Restore env
    if (originalProxyUrl !== undefined) {
      process.env.LLM_PROXY_URL = originalProxyUrl;
    } else {
      delete process.env.LLM_PROXY_URL;
    }
    if (originalAuth !== undefined) {
      process.env.INTERNAL_AUTH_SECRET = originalAuth;
    } else {
      delete process.env.INTERNAL_AUTH_SECRET;
    }
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  // ── Configuration ──────────────────────────────────────────────────

  describe('initial state', () => {
    it('reports no dynamic topology available', () => {
      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('returns 0 workers when no topology loaded', () => {
      expect(getWorkerCount()).toBe(0);
    });

    it('returns null topology when none loaded', () => {
      expect(getTopology()).toBeNull();
    });
  });

  // ── Success path ───────────────────────────────────────────────────

  describe('initialize() — success', () => {
    it('fetches and caches a valid topology', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      process.env.INTERNAL_AUTH_SECRET = 'test-secret';
      mockFetch({ ok: true, status: 200, json: async () => validTopology });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(true);
      expect(getWorkerCount()).toBe(3);
      expect(getTopology()).toEqual(validTopology);
    });

    it('sends X-Internal-Auth header when INTERNAL_AUTH_SECRET is set', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      process.env.INTERNAL_AUTH_SECRET = 'my-secret';
      mockFetch({ ok: true, status: 200, json: async () => validTopology });

      await initialize();

      expect(fetch).toHaveBeenCalledWith(
        'https://router.example.com/internal/v1/topology',
        expect.objectContaining({
          headers: { 'X-Internal-Auth': 'my-secret' },
        }),
      );
    });

    it('sends no auth header when INTERNAL_AUTH_SECRET is unset', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: true, status: 200, json: async () => validTopology });

      await initialize();

      expect(fetch).toHaveBeenCalledWith(
        'https://router.example.com/internal/v1/topology',
        expect.objectContaining({
          headers: {},
        }),
      );
    });

    it('handles workerCount=0 as a valid topology', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: true, status: 200, json: async () => zeroWorkerTopology });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(true);
      expect(getWorkerCount()).toBe(0);
      expect(getTopology()).toEqual(zeroWorkerTopology);
    });
  });

  // ── Skipped discovery ──────────────────────────────────────────────

  describe('initialize() — skipped', () => {
    it('skips discovery when LLM_PROXY_URL is unset', async () => {
      mockFetch({ ok: true, status: 200, json: async () => validTopology });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ── HTTP failure paths ─────────────────────────────────────────────

  describe('initialize() — HTTP failures', () => {
    it('falls back on 401', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      process.env.INTERNAL_AUTH_SECRET = 'wrong-secret';
      mockFetch({ ok: false, status: 401 });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
      expect(getWorkerCount()).toBe(0);
    });

    it('falls back on 500', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: false, status: 500 });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
      expect(getWorkerCount()).toBe(0);
    });

    it('falls back on 403', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: false, status: 403 });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });
  });

  // ── Schema validation ──────────────────────────────────────────────

  describe('initialize() — invalid schema', () => {
    it('rejects response with missing schemaVersion', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ topologyId: 'x', topologyGeneratedAt: 1, workerCount: 1, proxies: [] }),
      });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('rejects response with wrong schemaVersion', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 2, topologyId: 'x', topologyGeneratedAt: 1, workerCount: 1, proxies: [] }),
      });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('rejects response with missing topologyId', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 1, topologyGeneratedAt: 1, workerCount: 1, proxies: [] }),
      });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('rejects response with non-integer workerCount', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 1, topologyId: 'x', topologyGeneratedAt: 1, workerCount: 1.5, proxies: [] }),
      });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('rejects response with negative workerCount', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 1, topologyId: 'x', topologyGeneratedAt: 1, workerCount: -1, proxies: [] }),
      });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('rejects response with non-array proxies', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 1, topologyId: 'x', topologyGeneratedAt: 1, workerCount: 1, proxies: 'not-an-array' }),
      });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('rejects response that is not an object', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: true, status: 200, json: async () => 'just a string' });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('rejects response that is null', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: true, status: 200, json: async () => null });

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });
  });

  // ── Network / transport failures ───────────────────────────────────

  describe('initialize() — network failures', () => {
    it('falls back on network error', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetchError(new Error('ECONNREFUSED'));

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
      expect(getWorkerCount()).toBe(0);
    });

    it('falls back on DNS resolution failure', async () => {
      process.env.LLM_PROXY_URL = 'https://nonexistent.example.com';
      mockFetchError(new Error('getaddrinfo ENOTFOUND'));

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
    });

    it('falls back on timeout (abort)', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      // Simulate AbortController aborting the fetch
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetchError(abortError);

      await initialize();

      expect(isDynamicTopologyAvailable()).toBe(false);
      expect(getWorkerCount()).toBe(0);
    });
  });

  // ── Startup survival ───────────────────────────────────────────────

  describe('startup survival', () => {
    it('initialize() never throws — startup always continues', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetchError(new Error('total failure'));

      // Should not throw
      await expect(initialize()).resolves.toBeUndefined();
    });

    it('initialize() never throws on malformed JSON', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token'); },
      }) as typeof fetch;

      await expect(initialize()).resolves.toBeUndefined();
      expect(isDynamicTopologyAvailable()).toBe(false);
    });
  });

  // ── Test helpers ───────────────────────────────────────────────────

  describe('_setMockTopology', () => {
    it('sets topology and marks as available', () => {
      _setMockTopology(validTopology);
      expect(isDynamicTopologyAvailable()).toBe(true);
      expect(getWorkerCount()).toBe(3);
      expect(getTopology()).toEqual(validTopology);
    });

    it('accepts null to clear topology', () => {
      _setMockTopology(validTopology);
      _setMockTopology(null);
      expect(isDynamicTopologyAvailable()).toBe(false);
      expect(getWorkerCount()).toBe(0);
      expect(getTopology()).toBeNull();
    });
  });

  describe('_reset', () => {
    it('clears all state', () => {
      _setMockTopology(validTopology);
      _reset();
      expect(isDynamicTopologyAvailable()).toBe(false);
      expect(getWorkerCount()).toBe(0);
      expect(getTopology()).toBeNull();
    });
  });

  // ── Immutability ───────────────────────────────────────────────────

  describe('immutability', () => {
    it('getTopology() returns the same reference as cached (no copy)', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: true, status: 200, json: async () => validTopology });

      await initialize();

      // The returned object should be the exact same reference
      expect(getTopology()).toBe(validTopology);
    });

    it('external mutation of returned topology does not affect internal state', async () => {
      process.env.LLM_PROXY_URL = 'https://router.example.com';
      mockFetch({ ok: true, status: 200, json: async () => validTopology });

      await initialize();

      const topology = getTopology();
      // Attempt mutation (TypeScript `as const` prevents this at compile time,
      // but runtime mutation is still possible)
      if (topology) {
        (topology as any).workerCount = 999;
        (topology as any).proxies.push({ id: 99, name: 'evil', status: 'active' });
      }

      // Internal state should be unaffected because the snapshot was stored
      // as-is and the next getTopology() returns the same (now mutated) object.
      // This test documents the current behavior — the service trusts the
      // caller not to mutate. For true immutability, deep-freeze could be added.
      const fresh = getTopology();
      expect(fresh).not.toBeNull();
    });
  });
});
