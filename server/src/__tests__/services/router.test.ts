import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, refreshStatsCache, getAnalyticsScores } from '../../services/router.js';

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
    it('T10: analytics scores prioritize recent models', () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      // Insert two models with minimal required columns
      db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label) VALUES (?,?,?,?,?,?)')
        .run('test', 'old-model', 'Old Model', 1, 1, '');
      db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label) VALUES (?,?,?,?,?,?)')
        .run('test', 'new-model', 'New Model', 2, 1, '');
      // Insert requests with timestamps affecting recency weighting
      db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('test', 'old-model', 'success', 0, 0, 0, null, now - 14 * 24 * 60 * 60);
      db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('test', 'new-model', 'success', 0, 0, 0, null, now - 1 * 24 * 60 * 60);
      refreshStatsCache(getDb());
      const scores = getAnalyticsScores();
      const newScore = scores.find(s => s.modelName === 'new-model');
      const oldScore = scores.find(s => s.modelName === 'old-model');
      expect(newScore).toBeDefined();
      expect(oldScore).toBeDefined();
      expect(newScore!.total).toBeGreaterThan(oldScore!.total);
    });

    it('T11: thompson sampling prefers higher weighted total', () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label) VALUES (?,?,?,?,?,?)')
        .run('test', 'model-a', 'Model A', 1, 1, '');
      db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label) VALUES (?,?,?,?,?,?)')
        .run('test', 'model-b', 'Model B', 1, 1, '');
      db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('test', 'model-a', 'success', 0, 0, 0, null, now);
      db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('test', 'model-b', 'success', 0, 0, 0, null, now - 10 * 24 * 60 * 60);
      refreshStatsCache(getDb());
      const scores = getAnalyticsScores();
      const selections: Record<string, number> = {};
      for (let i = 0; i < 200; i++) {
        const chosen = scores.reduce((best, cur) => (cur.thompsonScore > best.thompsonScore ? cur : best)).modelName;
        selections[chosen] = (selections[chosen] || 0) + 1;
      }
      expect(selections['model-a']).toBeGreaterThan(selections['model-b'] ?? 0);
    });

    it('T12: getAnalyticsScores returns raw total count', () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label) VALUES (?,?,?,?,?,?)')
        .run('test', 'raw-model', 'Raw Model', 1, 1, '');
      db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('test', 'raw-model', 'success', 0, 0, 0, null, now);
      db.prepare('INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('test', 'raw-model', 'error', 0, 0, 0, null, now);
      refreshStatsCache(getDb());
      const scores = getAnalyticsScores();
      const raw = scores.find(s => s.modelName === 'raw-model');
      expect(raw).toBeDefined();
      expect(raw!.total).toBe(2);
    });
  });
});
