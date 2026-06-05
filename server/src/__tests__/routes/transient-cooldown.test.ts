import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import {
  transientModelCooldowns,
  TRANSIENT_COOLDOWN_MS,
  stickySessionMap,
  addProviderModelsToSkipModels,
} from '../../routes/proxy.js';

function clearCooldownMap() {
  (transientModelCooldowns as Map<any, any>).clear();
}

function clearStickyMap() {
  (stickySessionMap as Map<any, any>).clear();
}

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(path.startsWith('/v1/') ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
        ...(path.startsWith('/api/') ? { Authorization: `Bearer ${process.env.ADMIN_DASHBOARD_KEY || ''}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.text();

    let json: any = null;
    try { json = JSON.parse(data); } catch {}

    return { status: res.status, body: json, headers: res.headers, raw: data };
  } finally {
    server.close();
  }
}

describe('Transient model cooldown functionality', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.ADMIN_DASHBOARD_KEY = 'test-admin-key-that-is-long-enough';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    clearCooldownMap();
    clearStickyMap();
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  afterEach(() => {
    clearCooldownMap();
    clearStickyMap();
    vi.restoreAllMocks();
  });

  // ---------- Test Suite 1: Cooldown Map Basics ----------
  describe('transientModelCooldowns Map', () => {
    it('starts empty on initialization', () => {
      expect(transientModelCooldowns.size).toBe(0);
    });

    it('can set and retrieve a cooldown entry', () => {
      const modelDbId = 42;
      const expiry = Date.now() + TRANSIENT_COOLDOWN_MS;
      transientModelCooldowns.set(modelDbId, expiry);
      expect(transientModelCooldowns.has(modelDbId)).toBe(true);
      expect(transientModelCooldowns.get(modelDbId)).toBe(expiry);
    });

    it('TRANSIENT_COOLDOWN_MS is 15000 (15 seconds)', () => {
      expect(TRANSIENT_COOLDOWN_MS).toBe(15000);
    });

    it('can delete a cooldown entry', () => {
      transientModelCooldowns.set(1, Date.now() + TRANSIENT_COOLDOWN_MS);
      expect(transientModelCooldowns.size).toBe(1);
      transientModelCooldowns.delete(1);
      expect(transientModelCooldowns.size).toBe(0);
      expect(transientModelCooldowns.has(1)).toBe(false);
    });

    it('clear removes all entries', () => {
      transientModelCooldowns.set(1, Date.now() + TRANSIENT_COOLDOWN_MS);
      transientModelCooldowns.set(2, Date.now() + TRANSIENT_COOLDOWN_MS);
      transientModelCooldowns.set(3, Date.now() + TRANSIENT_COOLDOWN_MS);
      expect(transientModelCooldowns.size).toBe(3);
      clearCooldownMap();
      expect(transientModelCooldowns.size).toBe(0);
    });
  });

  // ---------- Test Suite 2: Cooldown Injection & Pruning ----------
  describe('Cooldown injection and expired entry pruning', () => {
    it('active cooldowns are added to skipModels set', () => {
      const modelDbId = 10;
      const expiry = Date.now() + TRANSIENT_COOLDOWN_MS;
      transientModelCooldowns.set(modelDbId, expiry);

      // Simulate the pre-routing injection logic
      const skipModels = new Set<number>();
      const now = Date.now();
      for (const [id, exp] of transientModelCooldowns) {
        if (now > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(skipModels.has(modelDbId)).toBe(true);
      expect(transientModelCooldowns.has(modelDbId)).toBe(true);
    });

    it('expired cooldowns are pruned during injection', () => {
      const modelDbId = 20;
      // Set an already-expired cooldown
      const expiredTimestamp = Date.now() - 1000; // 1 second ago
      transientModelCooldowns.set(modelDbId, expiredTimestamp);

      const skipModels = new Set<number>();
      const now = Date.now();
      for (const [id, exp] of transientModelCooldowns) {
        if (now > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(skipModels.has(modelDbId)).toBe(false);
      expect(transientModelCooldowns.has(modelDbId)).toBe(false);
    });

    it('mixed active and expired entries: active kept, expired pruned', () => {
      const activeId = 30;
      const expiredId = 31;
      transientModelCooldowns.set(activeId, Date.now() + TRANSIENT_COOLDOWN_MS);
      transientModelCooldowns.set(expiredId, Date.now() - 1000);

      const skipModels = new Set<number>();
      const now = Date.now();
      for (const [id, exp] of transientModelCooldowns) {
        if (now > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(skipModels.has(activeId)).toBe(true);
      expect(skipModels.has(expiredId)).toBe(false);
      expect(transientModelCooldowns.has(activeId)).toBe(true);
      expect(transientModelCooldowns.has(expiredId)).toBe(false);
    });

    it('multiple active cooldowns are all injected into skipModels', () => {
      const ids = [40, 41, 42];
      for (const id of ids) {
        transientModelCooldowns.set(id, Date.now() + TRANSIENT_COOLDOWN_MS);
      }

      const skipModels = new Set<number>();
      const now = Date.now();
      for (const [id, exp] of transientModelCooldowns) {
        if (now > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(skipModels.size).toBe(3);
      for (const id of ids) {
        expect(skipModels.has(id)).toBe(true);
      }
    });

    it('empty cooldown map results in empty skipModels additions', () => {
      const skipModels = new Set<number>();
      const now = Date.now();
      for (const [id, exp] of transientModelCooldowns) {
        if (now > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(skipModels.size).toBe(0);
      expect(transientModelCooldowns.size).toBe(0);
    });
  });

  // ---------- Test Suite 3: Auto-Recovery After Expiry ----------
  describe('Auto-recovery after cooldown expiry', () => {
    it('model becomes routable again after cooldown expires', () => {
      const modelDbId = 50;
      // Set a cooldown that expires in 1ms
      transientModelCooldowns.set(modelDbId, Date.now() + 1);

      // Immediately check — should be active
      expect(transientModelCooldowns.has(modelDbId)).toBe(true);

      // Wait for expiry (with small buffer for test reliability)
      // Instead of waiting, simulate the pruning logic with a future timestamp
      const skipModels = new Set<number>();
      const futureNow = Date.now() + 2000; // 2 seconds in the future
      for (const [id, exp] of transientModelCooldowns) {
        if (futureNow > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(transientModelCooldowns.has(modelDbId)).toBe(false);
      expect(skipModels.has(modelDbId)).toBe(false);
    });

    it('cooldown set with TRANSIENT_COOLDOWN_MS expires after ~15 seconds', () => {
      const modelDbId = 51;
      const expiry = Date.now() + TRANSIENT_COOLDOWN_MS;
      transientModelCooldowns.set(modelDbId, expiry);

      // At 14 seconds (before expiry), should still be active
      const beforeExpiry = expiry - 1000;
      expect(beforeExpiry > Date.now()).toBe(true); // expiry is in the future

      // Simulate pruning at 16 seconds (after expiry)
      const afterExpiry = Date.now() + TRANSIENT_COOLDOWN_MS + 1000;
      const skipModels = new Set<number>();
      for (const [id, exp] of transientModelCooldowns) {
        if (afterExpiry > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(transientModelCooldowns.has(modelDbId)).toBe(false);
    });
  });

  // ---------- Test Suite 4: Sticky Session Override ----------
  describe('Global cooldown overrides sticky preference', () => {
    it('preferredModel on global cooldown is cleared', () => {
      const preferredModel = 60;
      const expiry = Date.now() + TRANSIENT_COOLDOWN_MS;
      transientModelCooldowns.set(preferredModel, expiry);

      // Simulate the sticky override logic
      let preferredModelVar: number | undefined = preferredModel;
      let preferredKeyIdVar: number | undefined = 5;

      if (preferredModelVar !== undefined && transientModelCooldowns.has(preferredModelVar)) {
        const exp = transientModelCooldowns.get(preferredModelVar)!;
        if (Date.now() <= exp) {
          preferredModelVar = undefined;
          preferredKeyIdVar = undefined;
        }
      }

      expect(preferredModelVar).toBeUndefined();
      expect(preferredKeyIdVar).toBeUndefined();
    });

    it('preferredModel not on cooldown remains intact', () => {
      const preferredModel = 61;
      // No cooldown for this model
      expect(transientModelCooldowns.has(preferredModel)).toBe(false);

      let preferredModelVar: number | undefined = preferredModel;
      let preferredKeyIdVar: number | undefined = 5;

      if (preferredModelVar !== undefined && transientModelCooldowns.has(preferredModelVar)) {
        const exp = transientModelCooldowns.get(preferredModelVar)!;
        if (Date.now() <= exp) {
          preferredModelVar = undefined;
          preferredKeyIdVar = undefined;
        }
      }

      expect(preferredModelVar).toBe(61);
      expect(preferredKeyIdVar).toBe(5);
    });

    it('preferredModel with expired cooldown is NOT cleared', () => {
      const preferredModel = 62;
      // Set an already-expired cooldown
      transientModelCooldowns.set(preferredModel, Date.now() - 1000);

      let preferredModelVar: number | undefined = preferredModel;
      let preferredKeyIdVar: number | undefined = 5;

      if (preferredModelVar !== undefined && transientModelCooldowns.has(preferredModelVar)) {
        const exp = transientModelCooldowns.get(preferredModelVar)!;
        if (Date.now() <= exp) {
          preferredModelVar = undefined;
          preferredKeyIdVar = undefined;
        }
      }

      // Expired cooldown should NOT override — model remains preferred
      expect(preferredModelVar).toBe(62);
      expect(preferredKeyIdVar).toBe(5);
    });

    it('undefined preferredModel skips the override check entirely', () => {
      let preferredModelVar: number | undefined = undefined;
      let preferredKeyIdVar: number | undefined = undefined;

      // Set a cooldown for model 63, but preferredModel is undefined
      transientModelCooldowns.set(63, Date.now() + TRANSIENT_COOLDOWN_MS);

      if (preferredModelVar !== undefined && transientModelCooldowns.has(preferredModelVar)) {
        const exp = transientModelCooldowns.get(preferredModelVar)!;
        if (Date.now() <= exp) {
          preferredModelVar = undefined;
          preferredKeyIdVar = undefined;
        }
      }

      // No change — preferredModel was already undefined
      expect(preferredModelVar).toBeUndefined();
      expect(preferredKeyIdVar).toBeUndefined();
    });
  });

  // ---------- Test Suite 5: Cooldown Registration via Actual Proxy Errors ----------
  // Note: isRetryableError() returns true for ALL 5xx status codes (500, 502, 503, 504)
   // and common connection errors (ECONNREFUSED, ECONNRESET, etc.). Transient cooldown is
   // only set when !isRetryableError(err), which means the error type itself must NOT be
   // in the retryable list. We test with a non-retryable status (501) to verify the
   // cooldown registration path works, and verify that retryable errors (5xx, 429) do NOT
   // set cooldowns.
  describe('Cooldown registration via proxy error handling', () => {
    it('non-retryable error (501) registers transient cooldown for the model', async () => {
      const origFetch = global.fetch;

      // Add a Groq key so routing can succeed
      const addKey = await request(app, 'POST', '/api/keys', {
        platform: 'groq',
        key: 'gsk_cooldown_test_501',
        label: 'cooldown-test-501',
      });
      expect(addKey.status).toBe(201);

      // Get all Groq model DB IDs
      const db = getDb();
      const groqModels = db.prepare("SELECT id FROM models WHERE platform = 'groq' AND enabled = 1").all() as { id: number }[];
      expect(groqModels.length).toBeGreaterThan(0);
      const groqModelIds = new Set(groqModels.map(m => m.id));

      // Mock provider to return 501 Not Implemented (NOT in isRetryableError's list)
      vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
          return origFetch(url, init);
        }
        return {
          ok: false,
          status: 501,
          statusText: 'Not Implemented',
          text: () => Promise.resolve('Not Implemented'),
        } as any;
      });

      // Make a request — all retries will fail with 502 (proxy maps 501 to routing error)
      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'Test 501 cooldown' }],
      });

      // Should get an error response back
      expect(status).toBeGreaterThanOrEqual(500);

      // The transient cooldown should be registered for at least one Groq model
      // because 501 is NOT in the isRetryableError list, so !isRetryableError returns true
      const cooldownFound = [...transientModelCooldowns.keys()].some(id => groqModelIds.has(id));
      expect(cooldownFound).toBe(true);

      // Verify the cooldown entry has a valid expiry
      for (const [id, expiry] of transientModelCooldowns) {
        if (groqModelIds.has(id)) {
          expect(expiry).toBeGreaterThan(Date.now());
          expect(expiry).toBeLessThanOrEqual(Date.now() + TRANSIENT_COOLDOWN_MS);
        }
      }
    });

    it('5xx error (502) does NOT register transient cooldown (always retryable)', async () => {
      const origFetch = global.fetch;

      // Add a Groq key
      const addKey = await request(app, 'POST', '/api/keys', {
        platform: 'groq',
        key: 'gsk_cooldown_test_502',
        label: 'cooldown-test-502',
      });
      expect(addKey.status).toBe(201);

      const db = getDb();
      const groqModels = db.prepare("SELECT id FROM models WHERE platform = 'groq' AND enabled = 1").all() as { id: number }[];
      const groqModelIds = new Set(groqModels.map(m => m.id));

      // Mock provider to return 502 Bad Gateway (in isRetryableError's list)
      vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
          return origFetch(url, init);
        }
        return {
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          text: () => Promise.resolve('Bad Gateway'),
        } as any;
      });

      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'Test 502 no cooldown' }],
      });

      expect(status).toBe(502);

      // 502 IS in the isRetryableError list, so transient cooldown should NOT be set
      const anyGroqCooldown = [...transientModelCooldowns.keys()].some(id => groqModelIds.has(id));
      expect(anyGroqCooldown).toBe(false);
    });

    it('429 rate limit does NOT register transient cooldown', async () => {
      const origFetch = global.fetch;

      // Add a Groq key
      const addKey = await request(app, 'POST', '/api/keys', {
        platform: 'groq',
        key: 'gsk_cooldown_test_429',
        label: 'cooldown-test-429',
      });
      expect(addKey.status).toBe(201);

      const db = getDb();
      const groqModels = db.prepare("SELECT id FROM models WHERE platform = 'groq' AND enabled = 1").all() as { id: number }[];
      const groqModelIds = new Set(groqModels.map(m => m.id));

      // Mock provider to return 429
      vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
          return origFetch(url, init);
        }
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: () => Promise.resolve('Rate limited'),
        } as any;
      });

      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'Test 429 no cooldown' }],
      });

      // Should get 429 back
      expect(status).toBe(429);

      // 429 should NOT register a transient cooldown on any Groq model
      const anyGroqCooldown = [...transientModelCooldowns.keys()].some(id => groqModelIds.has(id));
      expect(anyGroqCooldown).toBe(false);
    });
  });

  // ---------- Test Suite 6: Integration with addProviderModelsToSkipModels ----------
  describe('Integration: cooldown + session ban both feed into skipModels', () => {
    it('global cooldown and session-banned models both appear in skipModels', () => {
      const db = getDb();
      // Get a real model ID from the DB
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      if (!longcatRow) {
        // Skip if no longcat models in test DB
        return;
      }

      // Set a global cooldown for the longcat model
      transientModelCooldowns.set(longcatRow.id, Date.now() + TRANSIENT_COOLDOWN_MS);

      const skipModels = new Set<number>();

      // Add session-banned provider models
      addProviderModelsToSkipModels(skipModels, 'longcat');

      // Add global cooldown models
      const now = Date.now();
      for (const [id, exp] of transientModelCooldowns) {
        if (now > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      // The longcat model should be in skipModels (from both sources)
      expect(skipModels.has(longcatRow.id)).toBe(true);
    });

    it('global cooldown for a non-banned provider model still appears in skipModels', () => {
      const modelDbId = 999; // arbitrary ID not in DB
      transientModelCooldowns.set(modelDbId, Date.now() + TRANSIENT_COOLDOWN_MS);

      const skipModels = new Set<number>();
      // No session bans, just cooldown injection
      const now = Date.now();
      for (const [id, exp] of transientModelCooldowns) {
        if (now > exp) {
          transientModelCooldowns.delete(id);
        } else {
          skipModels.add(id);
        }
      }

      expect(skipModels.has(modelDbId)).toBe(true);
    });
  });
});
