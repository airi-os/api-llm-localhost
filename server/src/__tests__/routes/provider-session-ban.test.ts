import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import {
  isSessionBannedFromPlatform,
  banPlatformFromSession,
  addProviderModelsToSkipModels,
  recordConsecutiveFailure,
  resetConsecutiveFailures,
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

  // ---------- Test Suite 4: recordConsecutiveFailure ----------
  describe('recordConsecutiveFailure', () => {
    it('does not create entry if no sticky session and no modelDbId', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      recordConsecutiveFailure(messages, 'balanced', 'longcat', new Set());
      expect(stickySessionMap.has(key)).toBe(false);
    });

    it('creates entry and increments counter on first 5xx when modelDbId provided', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const skipModels = new Set<number>();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      expect(stickySessionMap.has(key)).toBe(true);
      const entry = stickySessionMap.get(key);
      expect(entry.consecutiveFailures.get('longcat')).toBe(1);
      expect(entry.modelDbId).toBe(42);
    });

    it('increments counter to 2 and bans provider on second consecutive 5xx', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const skipModels = new Set<number>();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      const entry = stickySessionMap.get(key);
      expect(entry.bannedPlatforms.has('longcat')).toBe(true);
    });

    it('adds provider models to skipModels on ban', () => {
      const messages = makeMessages('Hello');
      const skipModels = new Set<number>();
      const db = getDb();
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      expect(longcatRow).toBeDefined();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, longcatRow.id);
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, longcatRow.id);
      expect(skipModels.has(longcatRow.id)).toBe(true);
    });

    it('tracks different providers independently', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const skipModels = new Set<number>();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      recordConsecutiveFailure(messages, 'balanced', 'groq', skipModels, 43);
      const entry = stickySessionMap.get(key);
      expect(entry.consecutiveFailures.get('longcat')).toBe(1);
      expect(entry.consecutiveFailures.get('groq')).toBe(1);
    });
  });

  // ---------- Test Suite 5: resetConsecutiveFailures ----------
  describe('resetConsecutiveFailures', () => {
    it('resets counter for specific provider', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const skipModels = new Set<number>();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      recordConsecutiveFailure(messages, 'balanced', 'groq', skipModels, 43);
      resetConsecutiveFailures(messages, 'balanced', 'longcat');
      const entry = stickySessionMap.get(key);
      expect(entry.consecutiveFailures.has('longcat')).toBe(false);
      expect(entry.consecutiveFailures.get('groq')).toBe(1);
    });

    it('no-op if no sticky session', () => {
      const messages = makeMessages('Hello');
      expect(() => resetConsecutiveFailures(messages, 'balanced', 'longcat')).not.toThrow();
    });

    it('no-op if provider has no counter', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, { modelDbId: 1, lastUsed: Date.now() });
      expect(() => resetConsecutiveFailures(messages, 'balanced', 'longcat')).not.toThrow();
    });
  });

  // ---------- Test Suite 6: resetAllConsecutiveFailures ----------
  describe('resetAllConsecutiveFailures', () => {
    it('clears all counters', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const skipModels = new Set<number>();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      recordConsecutiveFailure(messages, 'balanced', 'groq', skipModels, 43);
      resetAllConsecutiveFailures(messages, 'balanced');
      const entry = stickySessionMap.get(key);
      expect(entry.consecutiveFailures.size).toBe(0);
    });

    it('no-op if no sticky session', () => {
      const messages = makeMessages('Hello');
      expect(() => resetAllConsecutiveFailures(messages, 'balanced')).not.toThrow();
    });

    it('no-op if no consecutive failures', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      (stickySessionMap as Map<any, any>).set(key, { modelDbId: 1, lastUsed: Date.now() });
      expect(() => resetAllConsecutiveFailures(messages, 'balanced')).not.toThrow();
    });
  });

  // ---------- Test Suite 7: isTruncatedResponse ----------
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

    it('two consecutive 5xx failures from same provider triggers ban', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const db = getDb();
      const longcatRow = db.prepare("SELECT id FROM models WHERE platform = 'longcat' AND enabled = 1").get() as any;
      expect(longcatRow).toBeDefined();
      const skipModels = new Set<number>();
      // First 5xx
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, longcatRow.id);
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(false);
      // Second consecutive 5xx → ban
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, longcatRow.id);
      expect(isSessionBannedFromPlatform(messages, 'balanced', 'longcat')).toBe(true);
    });

    it('success resets consecutive failure counter', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const skipModels = new Set<number>();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      const entry = stickySessionMap.get(key);
      expect(entry.consecutiveFailures.get('longcat')).toBe(1);
      // Simulate success
      resetAllConsecutiveFailures(messages, 'balanced');
      expect(entry.consecutiveFailures.size).toBe(0);
    });

    it('5xx from provider A then success from provider B resets A counter', () => {
      const messages = makeMessages('Hello');
      const key = getSessionKey(messages, 'balanced');
      const skipModels = new Set<number>();
      recordConsecutiveFailure(messages, 'balanced', 'longcat', skipModels, 42);
      // Success from any provider resets all counters
      resetAllConsecutiveFailures(messages, 'balanced');
      const entry = stickySessionMap.get(key);
      expect(entry.consecutiveFailures.has('longcat')).toBe(false);
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
