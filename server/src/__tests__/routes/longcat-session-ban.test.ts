import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import {
  isSessionBannedFromPlatform,
  banPlatformFromSession,
  addLongcatModelsToSkipModels,
  isTruncatedResponse,
  getSessionKey,
  getStickyModel,
  setStickyModel,
  stickySessionMap,
} from '../../routes/proxy.js';

function clearStickyMap() {
  (stickySessionMap as Map<any, any>).clear();
}

describe('LongCat session ban functionality', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    clearStickyMap();
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    // Insert a dummy LongCat API key so routing can succeed if needed
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('longcat', 'test', 'enc', 'iv', 'tag', 'healthy', 1)`).run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to create a simple user message array
  const makeMessages = (content: string) => [{ role: 'user' as const, content }];

  // ---------- Test Suite 1: isSessionBannedFromPlatform ----------
  describe('isSessionBannedFromPlatform', () => {
    it('returns false when no sticky session exists', () => {
      const messages = makeMessages('Hello');
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(false);
    });

    it('returns false when sticky session exists but no bannedPlatforms', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, { modelDbId: 1, lastUsed: Date.now() });
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(false);
    });

    it('returns true when the platform is in bannedPlatforms', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 1,
        lastUsed: Date.now(),
        bannedPlatforms: new Set(['longcat']),
      });
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
    });

    it('returns false when a different platform is banned', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 1,
        lastUsed: Date.now(),
        bannedPlatforms: new Set(['groq']),
      });
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(false);
    });

    it('returns false when the sticky session has expired (past TTL)', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 1,
        lastUsed: Date.now() - (31 * 60 * 1000), // 31 minutes ago
        bannedPlatforms: new Set(['longcat']),
      });
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(false);
    });
  });

  // ---------- Test Suite 2: banPlatformFromSession ----------
  describe('banPlatformFromSession', () => {
    it('does not create entry if none exists (only modifies existing)', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      expect(stickySessionMap.has(key)).toBe(false);
      banPlatformFromSession(messages, 'balanced', 'longcat');
      expect(stickySessionMap.has(key)).toBe(false);
    });

    it('adds to existing bannedPlatforms if entry already exists', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 2,
        lastUsed: Date.now(),
        bannedPlatforms: new Set(['groq']),
      });
      banPlatformFromSession(messages, 'balanced', 'longcat');
      const entry = stickySessionMap.get(key);
      expect(entry.bannedPlatforms.has('groq')).toBe(true);
      expect(entry.bannedPlatforms.has('longcat')).toBe(true);
    });

    it('does not duplicate platforms already banned', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 3,
        lastUsed: Date.now(),
        bannedPlatforms: new Set(['longcat']),
      });
      const beforeSize = stickySessionMap.get(key).bannedPlatforms.size;
      banPlatformFromSession(messages, 'balanced', 'longcat');
      const afterSize = stickySessionMap.get(key).bannedPlatforms.size;
      expect(afterSize).toBe(beforeSize);
    });

    it('preserves existing modelDbId and keyId when banning', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 42,
        keyId: 7,
        lastUsed: Date.now(),
      });
      banPlatformFromSession(messages, 'balanced', 'longcat');
      const entry = stickySessionMap.get(key);
      expect(entry.modelDbId).toBe(42);
      expect(entry.keyId).toBe(7);
    });

    it('refreshes lastUsed TTL when banning', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const oldTime = Date.now() - (20 * 60 * 1000); // 20 minutes ago
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 1,
        lastUsed: oldTime,
      });
      banPlatformFromSession(messages, 'balanced', 'longcat');
      const entry = stickySessionMap.get(key);
      expect(entry.lastUsed).toBeGreaterThan(oldTime);
    });
  });

  // ---------- Test Suite 3: addLongcatModelsToSkipModels ----------
  describe('addLongcatModelsToSkipModels', () => {
    it('adds all LongCat model IDs to the skipModels set', () => {
      const skipModels = new Set<number>();
      addLongcatModelsToSkipModels(skipModels);
      const db = getDb();
      const longcatRows = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").all() as any[];
      const ids = longcatRows.map(r => r.id);
      ids.forEach(id => expect(skipModels.has(id)).toBe(true));
    });

    it('does not add non-LongCat model IDs', () => {
      const skipModels = new Set<number>();
      addLongcatModelsToSkipModels(skipModels);
      const db = getDb();
      const otherRows = db.prepare("SELECT id FROM models WHERE platform != 'longcat' AND enabled = 1").all() as any[];
      otherRows.forEach(r => expect(skipModels.has(r.id)).toBe(false));
    });

    it('handles empty LongCat model list gracefully', () => {
      const db = getDb();
      db.prepare('PRAGMA foreign_keys = OFF').run();
      try {
        db.prepare("DELETE FROM models WHERE platform = 'longcat'").run();
        const skipModels = new Set<number>();
        expect(() => addLongcatModelsToSkipModels(skipModels)).not.toThrow();
        expect(skipModels.size).toBe(0);
      } finally {
        db.prepare('PRAGMA foreign_keys = ON').run();
      }
      // Restore by re-initializing DB for subsequent tests
      initDb(':memory:');
    });
  });

  // ---------- Test Suite 4: isTruncatedResponse ----------
  describe('isTruncatedResponse', () => {
    const truncationSamples = [
      'Response was truncated due to length',
      'Truncation error occurred',
      'This response was truncated',
      'truncation detected',
    ];

    truncationSamples.forEach(sample => {
      it(`returns true for string containing '${sample}'`, () => {
        expect(isTruncatedResponse(sample)).toBe(true);
      });
    });

    it('returns false for normal error messages', () => {
      expect(isTruncatedResponse('Invalid API key')).toBe(false);
    });

    it('returns false for empty strings', () => {
      expect(isTruncatedResponse('')).toBe(false);
    });

    it('handles non-string input gracefully', () => {
      // isTruncatedResponse converts to string via String(), so objects become "[object Object]"
      expect(isTruncatedResponse({ message: 'truncated' })).toBe(false);
      expect(isTruncatedResponse(null)).toBe(false);
      expect(isTruncatedResponse(undefined)).toBe(false);
    });
  });

  // ---------- Integration Tests ----------
  describe('Integration: ban lifecycle', () => {
    it('ban persists across model changes and expires after TTL', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const db = getDb();
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      setStickyModel(messages, longcatRow.id, 'balanced');
      // Ban LongCat for this session
      banPlatformFromSession(messages, 'balanced', 'longcat');
      // getStickyModel still returns the model (ban check is in routing logic, not getStickyModel)
      expect(getStickyModel(messages, 'balanced')).toBe(longcatRow.id);
      // But isSessionBannedFromPlatform should return true
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
      // Simulate TTL expiration by adjusting lastUsed
      const entry = stickySessionMap.get(key);
      entry.lastUsed = Date.now() - (31 * 60 * 1000); // 31 minutes
      // After expiration, ban should be considered cleared
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(false);
    });

    it('ban check and skipModels work together to prevent banned platform selection', () => {
      const messages = makeMessages('Hello');
      const db = getDb();
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      // Set sticky model to a LongCat model
      setStickyModel(messages, longcatRow.id, 'balanced');
      // Verify sticky model is set
      expect(getStickyModel(messages, 'balanced')).toBe(longcatRow.id);
      // Ban LongCat for this session
      banPlatformFromSession(messages, 'balanced', 'longcat');
      // Verify ban is registered
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
      // Verify addLongcatModelsToSkipModels includes the banned model
      const skipModels = new Set<number>();
      addLongcatModelsToSkipModels(skipModels);
      expect(skipModels.has(longcatRow.id)).toBe(true);
    });
  });
});
