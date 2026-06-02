import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, refreshStatsCache, getAnalyticsScores, classifyModel } from '../../services/router.js';
import { ModelPool } from '@freellmapi/shared/types.js';

describe('Router', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all();
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  it('should throw when no keys are configured', () => {
    expect(() => routeRequest()).toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', encrypted, iv, authTag, 'healthy', 1);
    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should route to an available model when keys exist for multiple platforms', () => {
    const db = getDb();
    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1);
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);
    const result = routeRequest();
    expect(['google', 'groq']).toContain(result.platform);
  });

  it('should skip disabled keys', () => {
    const db = getDb();
    const googleKey = encrypt('test-google-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0);
    const groqKey = encrypt('test-groq-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1);
    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  // Recency‑biased Thompson sampling tests (T10‑T12)
  describe('Recency‑biased Thompson sampling', () => {
    beforeEach(() => {
      const db = getDb();
      db.prepare('DELETE FROM requests').run();
    });

    it('T10: Outage sensitivity under high baseline volume', () => {
      const db = getDb();
      const insertRequest = db.prepare(`
        INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Seed 1,000 successful requests spread over days 1-5 of the 7-day window
      // Use days 3-7 to give lower average recency weight
      for (let i = 0; i < 1000; i++) {
        const daysAgo = 3 + (i / 1000) * 4; // spreads from 3 days ago to 7 days ago
        const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
        insertRequest.run('google', 'gemini-2.5-flash', 'success', 10, 100, 1000, 500, timestamp);
      }

      // Seed 15 failed requests within the last 10 minutes (full recency weight)
      for (let i = 0; i < 15; i++) {
        const timestamp = new Date(Date.now() - i * 60 * 1000).toISOString();
        insertRequest.run('google', 'gemini-2.5-flash', 'error', 10, 0, 0, null, timestamp);
      }

      refreshStatsCache(db, true);
      const scores = getAnalyticsScores();
      const entry = scores.find(s => s.modelName === 'gemini-2.5-flash');

      expect(entry).toBeDefined();
      // With 15 errors at weight 1.0 and ~2000 weighted successes (avg weight ~2.0),
      // successRate should be significantly lower than flat rate
      expect(entry!.successRate).toBeLessThan(0.96);
      expect(entry!.total).toBe(1015);
    });

    it('T11: Safe fractional evaluation', () => {
      const db = getDb();
      const insertRequest = db.prepare(`
        INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Insert 1 successful request ~5.6 days ago (recency_weight ≈ 0.2)
      const daysAgo = 5.6;
      const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      insertRequest.run('google', 'gemini-2.5-flash', 'success', 10, 100, 1000, 500, timestamp);

      refreshStatsCache(db, true);
      const scores = getAnalyticsScores();
      const entry = scores.find(s => s.modelName === 'gemini-2.5-flash');

      expect(entry).toBeDefined();
      expect(entry!.successRate).toBe(1.0);
      expect(entry!.score).toBeGreaterThanOrEqual(0.0);
      expect(entry!.score).toBeLessThanOrEqual(2.0);
      expect(entry!.total).toBe(1);
    });

    it('T12: Clock drift safety', () => {
      const db = getDb();
      const insertRequest = db.prepare(`
        INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Insert 1 successful request with future timestamp (1 hour from now)
      const futureTimestamp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      insertRequest.run('google', 'gemini-2.5-flash', 'success', 10, 100, 1000, 500, futureTimestamp);

      refreshStatsCache(db, true);
      const scores = getAnalyticsScores();
      const entry = scores.find(s => s.modelName === 'gemini-2.5-flash');

      expect(entry).toBeDefined();
      expect(entry!.successRate).toBe(1.0);
      expect(entry!.total).toBe(1);
      expect(Number.isNaN(entry!.score)).toBe(false);
      expect(Number.isFinite(entry!.score)).toBe(true);
    });
  });

  // Fast routing pool tests (T13-T16)
  describe('Fast routing pool classification', () => {
    it('T13: classifyModel returns Fast for top-speed models', () => {
      // speed_rank 1 out of 1-10 → normalized = 0 → Fast pool
      expect(classifyModel(1, 10, 1, 10, 1, 10)).toBe(ModelPool.Fast);
      // speed_rank 4 out of 1-10 → normalized = 0.333 → Fast pool (≤ 0.4)
      expect(classifyModel(4, 10, 1, 10, 1, 10)).toBe(ModelPool.Fast);
    });

    it('T14: classifyModel returns Smart for top-intelligence models', () => {
      // intelligence_rank 1 out of 1-10 → normalized = 0 → Smart pool
      expect(classifyModel(10, 1, 1, 10, 1, 10)).toBe(ModelPool.Smart);
      // intelligence_rank 4 out of 1-10 → normalized = 0.333 → Smart pool (≤ 0.4)
      expect(classifyModel(10, 4, 1, 10, 1, 10)).toBe(ModelPool.Smart);
    });

    it('T15: classifyModel returns Balanced for mid-range models', () => {
      // speed_rank 6, intelligence_rank 6 out of 1-10 → both normalized > 0.4
      expect(classifyModel(6, 6, 1, 10, 1, 10)).toBe(ModelPool.Balanced);
    });

    it('T16: classifyModel defaults to Balanced when no variation', () => {
      expect(classifyModel(5, 5, 5, 5, 5, 5)).toBe(ModelPool.Balanced);
    });
  });

  describe('Fast routing mode', () => {
    beforeEach(() => {
      const db = getDb();
      db.prepare('DELETE FROM api_keys').run();
      db.prepare('DELETE FROM requests').run();
    });

    it('T17: routeRequest with fast mode returns a valid result from fast pool', () => {
      const db = getDb();
      const models = db.prepare('SELECT id, platform, model_id, speed_rank FROM models WHERE enabled = 1 ORDER BY speed_rank ASC').all() as any[];
      expect(models.length).toBeGreaterThan(1);

      // Add a key for a fast pool model (use a unique platform to avoid key sharing)
      // Pick the fastest model that has a unique platform not shared by other fast pool models
      const fastPoolModels = models.slice(0, Math.max(1, Math.floor(models.length * 0.4)));
      const uniquePlatformModel = fastPoolModels.find(m =>
        !models.slice(fastPoolModels.length).some(other => other.platform === m.platform)
      ) || fastPoolModels[0];

      const { encrypted, iv, authTag } = encrypt('fastest-key');
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uniquePlatformModel.platform, 'fast-test', encrypted, iv, authTag, 'healthy', 1);

      // Route in fast mode - should return a result from the fast pool
      const result = routeRequest(1000, undefined, undefined, 'fast');
      expect(result).toBeDefined();
      expect(result.apiKey).toBe('fastest-key');
      // The result should be from the fast pool (one of the top 40% speed_rank models)
      const resultModel = models.find(m => m.model_id === result.modelId);
      expect(resultModel).toBeDefined();
      expect(resultModel!.speed_rank).toBeLessThanOrEqual(fastPoolModels[fastPoolModels.length - 1].speed_rank);
    });

    it('T18: routeRequest with fast mode falls back when fast pool has no keys', () => {
      const db = getDb();
      const models = db.prepare('SELECT id, platform, model_id, speed_rank FROM models WHERE enabled = 1 ORDER BY speed_rank ASC').all() as any[];
      expect(models.length).toBeGreaterThan(1);

      // Add key only for a slower (balanced pool) model on a unique platform
      const balancedPoolModels = models.slice(Math.floor(models.length * 0.4));
      const uniqueBalancedModel = balancedPoolModels.find(m =>
        !models.slice(0, Math.floor(models.length * 0.4)).some(other => other.platform === m.platform)
      ) || balancedPoolModels[0];

      const { encrypted, iv, authTag } = encrypt('balanced-key');
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uniqueBalancedModel.platform, 'balanced-test', encrypted, iv, authTag, 'healthy', 1);

      // Route in fast mode - should fall back to balanced pool
      const result = routeRequest(1000, undefined, undefined, 'fast');
      expect(result).toBeDefined();
      expect(result.apiKey).toBe('balanced-key');
      // The result should be from the balanced pool
      const resultModel = models.find(m => m.model_id === result.modelId);
      expect(resultModel).toBeDefined();
      expect(resultModel!.speed_rank).toBeGreaterThan(models[Math.floor(models.length * 0.4) - 1].speed_rank);
    });
  });
});
