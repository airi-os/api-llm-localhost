import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import {
  isSessionBannedFromPlatform,
  banPlatformFromSession,
  addProviderModelsToSkipModels,
  resetAllConsecutiveFailures,
  isTruncatedResponse,
  getSessionKey,
  getStickyModel,
  setStickyModel,
  stickySessionMap,
} from '../../routes/proxy.js';

function clearStickyMap() {
  (stickySessionMap as Map<any, any>).clear();
}

describe('Provider session ban functionality', () => {
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
    it('does not create entry if none exists and no modelDbId provided', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      expect(stickySessionMap.has(key)).toBe(false);
      banPlatformFromSession(messages, 'balanced', 'longcat');
      expect(stickySessionMap.has(key)).toBe(false);
    });

    it('creates entry if none exists and modelDbId is provided', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      expect(stickySessionMap.has(key)).toBe(false);
      banPlatformFromSession(messages, 'balanced', 'longcat', 99);
      expect(stickySessionMap.has(key)).toBe(true);
      const entry = stickySessionMap.get(key);
      expect(entry.modelDbId).toBe(99);
      expect(entry.bannedPlatforms.has('longcat')).toBe(true);
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

  // ---------- Test Suite 3: addProviderModelsToSkipModels ----------
  describe('addProviderModelsToSkipModels', () => {
    it('adds all model IDs of the given provider to the skipModels set', () => {
      const skipModels = new Set<number>();
      addProviderModelsToSkipModels(skipModels, 'longcat');
      const db = getDb();
      const longcatRows = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").all() as any[];
      expect(longcatRows.length).toBeGreaterThan(0);
      const ids = longcatRows.map(r => r.id);
      ids.forEach(id => expect(skipModels.has(id)).toBe(true));
    });

    it('does not add models of other providers', () => {
      const skipModels = new Set<number>();
      addProviderModelsToSkipModels(skipModels, 'longcat');
      const db = getDb();
      const otherRows = db.prepare("SELECT id FROM models WHERE platform != 'longcat' AND enabled = 1").all() as any[];
      otherRows.forEach(r => expect(skipModels.has(r.id)).toBe(false));
    });

    it('handles empty provider model list gracefully', () => {
      const db = getDb();
      db.prepare('PRAGMA foreign_keys = OFF').run();
      db.prepare('BEGIN').run();
      db.prepare("DELETE FROM api_keys WHERE platform = 'longcat'").run();
      db.prepare("DELETE FROM models WHERE platform = 'longcat'").run();
      const skipModels = new Set<number>();
      expect(() => addProviderModelsToSkipModels(skipModels, 'longcat')).not.toThrow();
      expect(skipModels.size).toBe(0);
      db.prepare('ROLLBACK').run();
      db.prepare('PRAGMA foreign_keys = ON').run();
    });
  });

  // ---------- Test Suite 4: resetAllConsecutiveFailures ----------
  describe('resetAllConsecutiveFailures', () => {
    it('runs without error when sticky session exists', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, { modelDbId: 1, lastUsed: Date.now() });
      expect(() => resetAllConsecutiveFailures(messages, 'balanced')).not.toThrow();
    });

    it('no-op if no sticky session', () => {
      const messages = makeMessages('Hello');
      expect(() => resetAllConsecutiveFailures(messages, 'balanced')).not.toThrow();
    });

    it('preserves sticky entry when called', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 1,
        lastUsed: Date.now(),
        bannedPlatforms: new Set(['groq']),
      });
      resetAllConsecutiveFailures(messages, 'balanced');
      const entry = stickySessionMap.get(key);
      expect(entry).toBeDefined();
      expect(entry.modelDbId).toBe(1);
      expect(entry.bannedPlatforms.has('groq')).toBe(true);
    });
  });

  // ---------- Test Suite 5: isTruncatedResponse ----------
  describe('isTruncatedResponse', () => {
    const truncationSamples = [
      'Response was truncated due to length',
      'Truncation error occurred',
      'This response was truncated',
      'truncation detected',
      'context_length_exceeded',
      'token_limit exceeded',
      'maximum length reached',
      'response_length_limit hit',
      'conflict in response',
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
      // Objects with truncation keywords are now detected via JSON.stringify
      expect(isTruncatedResponse({ message: 'truncated' })).toBe(true);
      expect(isTruncatedResponse({ error: 'context_length_exceeded' })).toBe(true);
      expect(isTruncatedResponse({ foo: 'bar' })).toBe(false);
      expect(isTruncatedResponse(null)).toBe(false);
      expect(isTruncatedResponse(undefined)).toBe(false);
      expect(isTruncatedResponse(123)).toBe(false);
    });
  });

  // ---------- Integration Tests ----------
  describe('Integration: ban lifecycle', () => {
    it('ban persists across model changes and expires after TTL', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const db = getDb();
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      expect(longcatRow).toBeDefined();
      setStickyModel(messages, longcatRow.id, 'balanced');
      // Ban longcat for this session
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
      expect(longcatRow).toBeDefined();
      // Set sticky model to a longcat model
      setStickyModel(messages, longcatRow.id, 'balanced');
      // Verify sticky model is set
      expect(getStickyModel(messages, 'balanced')).toBe(longcatRow.id);
      // Ban longcat for this session
      banPlatformFromSession(messages, 'balanced', 'longcat');
      // Verify ban is registered
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
      // Verify addProviderModelsToSkipModels includes the banned model
      const skipModels = new Set<number>();
      addProviderModelsToSkipModels(skipModels, 'longcat');
      expect(skipModels.has(longcatRow.id)).toBe(true);
    });

    it('ban via banPlatformFromSession makes isSessionBannedFromPlatform return true', () => {
      const messages = makeMessages('Hello');
      const db = getDb();
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      expect(longcatRow).toBeDefined();
      // Initially not banned
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(false);
      // Ban via banPlatformFromSession (simulating what production code now does directly)
      banPlatformFromSession(messages, 'balanced', 'longcat', longcatRow.id);
      // Now should be banned
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
    });

    it('success via resetAllConsecutiveFailures runs without error', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      // Create a sticky entry
      (stickySessionMap as Map<any, any>).set(key, { modelDbId: 1, lastUsed: Date.now() });
      // Simulate success path calling resetAllConsecutiveFailures
      expect(() => resetAllConsecutiveFailures(messages, 'balanced')).not.toThrow();
      // Entry should still exist (resetAllConsecutiveFailures is a no-op)
      expect(stickySessionMap.has(key)).toBe(true);
    });

    it('ban from provider A does not affect provider B', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, {
        modelDbId: 1,
        lastUsed: Date.now(),
      });
      // Ban longcat
      banPlatformFromSession(messages, 'balanced', 'longcat');
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
      // groq should not be banned
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'groq')).toBe(false);
    });
  });

  // ---------- Integration: Truncation from any provider ----------
  describe('Integration: truncation detection for any provider', () => {
    it('truncated response from any provider triggers ban via banPlatformFromSession', () => {
      const messages = makeMessages('Hello');
      const db = getDb();
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      expect(longcatRow).toBeDefined();
      // Simulate truncation detection calling banPlatformFromSession
      banPlatformFromSession(messages, 'balanced', 'longcat', longcatRow.id);
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
    });

    it('isTruncatedResponse detects truncation patterns in error messages', () => {
      expect(isTruncatedResponse('The response was truncated')).toBe(true);
      expect(isTruncatedResponse('context_length_exceeded error')).toBe(true);
      expect(isTruncatedResponse('some other error')).toBe(false);
    });
  });
});
