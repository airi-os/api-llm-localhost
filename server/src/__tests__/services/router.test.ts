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
    const models = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as Array<{ id: number; intelligence_rank: number }>;
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

    // Add request history for dynamic pool calculation (Balanced pool: tokPerSec=500, avgTtfbMs=50)
    const groqModel = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' LIMIT 1").get() as { model_id: string } | undefined;
    if (groqModel) {
      db.prepare("INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, created_at) VALUES ('groq', ?, 'success', 200, 100, datetime('now'))").run(groqModel.model_id);
    }
    refreshStatsCache(db, true);

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

    // Add request history for dynamic pool calculation
    const googleModel = db.prepare("SELECT model_id FROM models WHERE platform = 'google' LIMIT 1").get() as { model_id: string } | undefined;
    const groqModel = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' LIMIT 1").get() as { model_id: string } | undefined;
    if (googleModel) {
      db.prepare("INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, created_at) VALUES ('google', ?, 'success', 200, 100, datetime('now'))").run(googleModel.model_id);
    }
    if (groqModel) {
      db.prepare("INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, created_at) VALUES ('groq', ?, 'success', 200, 100, datetime('now'))").run(groqModel.model_id);
    }
    refreshStatsCache(db, true);

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

    // Add request history for dynamic pool calculation
    const groqModel = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' LIMIT 1").get() as { model_id: string } | undefined;
    if (groqModel) {
      db.prepare("INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, created_at) VALUES ('groq', ?, 'success', 200, 100, datetime('now'))").run(groqModel.model_id);
    }
    refreshStatsCache(db, true);

    const result = routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });
});
