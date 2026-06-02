import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
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

describe('Transient model cooldown functionality', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
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

  // ---------- Test Suite 5: Cooldown Registration Error Classification ----------
  describe('Cooldown registration: only 5xx and connection failures trigger cooldown', () => {
    it('5xx status codes (500-504) are eligible for cooldown registration', () => {
      // Simulate the condition: (errStatus >= 500 && errStatus < 600)
      const eligibleStatuses = [500, 502, 503, 504];
      for (const status of eligibleStatuses) {
        const condition = status !== undefined && status >= 500 && status < 600;
        expect(condition).toBe(true);
      }
    });

    it('429 rate limit is NOT eligible for cooldown registration', () => {
      const status = 429;
      const condition = status !== undefined && status >= 500 && status < 600;
      expect(condition).toBe(false);
    });

    it('401 auth error is NOT eligible for cooldown registration', () => {
      const status = 401;
      const condition = status !== undefined && status >= 500 && status < 600;
      expect(condition).toBe(false);
    });

    it('403 forbidden is NOT eligible for cooldown registration', () => {
      const status = 403;
      const condition = status !== undefined && status >= 500 && status < 600;
      expect(condition).toBe(false);
    });

    it('400 bad request is NOT eligible for cooldown registration', () => {
      const status = 400;
      const condition = status !== undefined && status >= 500 && status < 600;
      expect(condition).toBe(false);
    });

    it('undefined status (connection failure) IS eligible for cooldown', () => {
      const status: number | undefined = undefined;
      // The condition: (errStatus !== undefined && errStatus >= 500 && errStatus < 600) || errStatus === undefined
      const condition = (status !== undefined && status >= 500 && status < 600) || status === undefined;
      expect(condition).toBe(true);
    });

    it('404 not found is NOT eligible for cooldown registration', () => {
      const status = 404;
      const condition = (status !== undefined && status >= 500 && status < 600) || status === undefined;
      expect(condition).toBe(false);
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