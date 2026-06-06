import { describe, it, expect, beforeEach, vi } from 'vitest';
import { routeRequest, refreshStatsCache } from '../../services/router.js';
import { canMakeRequest, canUseTokens } from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';

// Mock ratelimit to control quota availability
vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(),
    canUseTokens: vi.fn(),
    isOnCooldown: vi.fn(() => false),
  };
});

// Mock crypto to avoid IV errors
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return {
    ...actual,
    decrypt: vi.fn(() => 'mocked-api-key'),
  };
});

describe('Router Sticky Sessions', () => {
  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();

    // Disable all fallback entries by default
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    // Add request history for dynamic pool calculation
    // Fast models: tokPerSec >= 5000, avgTtfbMs <= 200 (speed score >= 8)
    // Balanced models: tokPerSec ~500, avgTtfbMs ~500 (speed score 5-8)
    // Smart models: tokPerSec ~50, avgTtfbMs ~3000 (speed score < 5)

    // Fast pool models: high tokPerSec, low TTFB
    // tokPerSec = output_tokens * 1000 / latency_ms
    // For ~3000 tok/s: output_tokens=300, latency_ms=100
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('openai', 'gpt-4o-mini', 'success', 100, 300, 150, datetime('now', '-1 day'))
    `).run();

    // Balanced pool models: moderate tokPerSec
    // For ~150 tok/s: output_tokens=150, latency_ms=1000
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'gemini-2.0-flash', 'success', 1000, 150, 500, datetime('now', '-1 day'))
    `).run();

    // Smart pool models (slow, high quality): low tokPerSec, high TTFB
    // For ~15 tok/s: output_tokens=30, latency_ms=2000
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 30, 3000, datetime('now', '-1 day'))
    `).run();

    // Refresh stats cache with the new request history
    refreshStatsCache(db, true);

    vi.clearAllMocks();
  });

  it('should use sticky session to override exclusions', () => {
    const db = getDb();

    // Insert LongCat model (normally excluded from balanced mode)
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LC Test', 1, 1, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Insert a balanced model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Add request history for dynamic pool calculation
    // lc-test: Smart pool (slow, high quality) - tokPerSec ~15, avgTtfbMs ~3000
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 30, 3000, datetime('now', '-1 day'))
    `).run();
    // balanced-test: Balanced pool - tokPerSec ~150, avgTtfbMs ~500
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 1000, 150, 500, datetime('now', '-1 day'))
    `).run();

    // Refresh stats cache with the new request history
    refreshStatsCache(db, true);

    // Enable both in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LC Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Mock ratelimit to allow requests
    canMakeRequest.mockReturnValue(true);
    canUseTokens.mockReturnValue(true);

    // Call routeRequest in balanced mode with sticky session for LongCat
    const result = routeRequest(100, undefined, lcId, 'balanced');

    // Assert LongCat WAS selected because of sticky session
    expect(result.platform).toBe('longcat');
    expect(result.modelId).toBe('lc-test');
  });

  it('should maintain sticky session across multiple requests', () => {
    const db = getDb();

    // Insert a model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'test-model', 'Test Model', 1, 1, 1, 1000, 100000)").run();
    const modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;

    // Add request history for dynamic pool calculation
    // test-model: Balanced pool - tokPerSec ~150, avgTtfbMs ~500
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'test-model', 'success', 1000, 150, 500, datetime('now', '-1 day'))
    `).run();

    // Refresh stats cache with the new request history
    refreshStatsCache(db, true);

    // Enable in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(modelId);

    // Insert API key
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Test Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Mock ratelimit to allow requests
    canMakeRequest.mockReturnValue(true);
         canUseTokens.mockReturnValue(true);
    // Call routeRequest multiple times with sticky session
    const result1 = routeRequest(100, undefined, modelId, 'balanced');
    const result2 = routeRequest(100, undefined, modelId, 'balanced');

    // Assert same model is used
    expect(result1.modelDbId).toBe(modelId);
    expect(result2.modelDbId).toBe(modelId);
  });

  it('should fall back to non-excluded model when sticky session is not set', () => {
    const db = getDb();

    // Insert LongCat model (normally excluded from balanced mode)
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LC Test', 1, 1, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Insert a balanced model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Add request history for dynamic pool calculation
    // lc-test: Smart pool (slow, high quality) - tokPerSec ~15, avgTtfbMs ~3000
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 30, 3000, datetime('now', '-1 day'))
    `).run();
    // balanced-test: Balanced pool - tokPerSec ~150, avgTtfbMs ~500
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 1000, 150, 500, datetime('now', '-1 day'))
    `).run();

    // Refresh stats cache with the new request history
    refreshStatsCache(db, true);

    // Enable both in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LC Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Mock ratelimit to allow requests
    canMakeRequest.mockReturnValue(true);
         canUseTokens.mockReturnValue(true);

    // Call routeRequest in balanced mode WITHOUT sticky session
    const result = routeRequest(100, undefined, undefined, 'balanced');

    // Assert LongCat was NOT selected - should be google
    expect(result.platform).toBe('google');
    expect(result.modelId).toBe('balanced-test');
  });

  it('should use preferred key when sticky key is set', () => {
    const db = getDb();

    // Insert a model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'test-model', 'Test Model', 1, 1, 1, 1000, 100000)").run();
    const modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;

    // Add request history for dynamic pool calculation
    // test-model: Balanced pool - tokPerSec ~150, avgTtfbMs ~500
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'test-model', 'success', 1000, 150, 500, datetime('now', '-1 day'))
    `).run();

    // Refresh stats cache with the new request history
    refreshStatsCache(db, true);

    // Enable in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(modelId);

    // Insert two API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    const keyAId = (db.prepare("SELECT id FROM api_keys WHERE label = 'Key A'").get() as { id: number }).id;
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key B', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Mock ratelimit to allow requests
    canMakeRequest.mockReturnValue(true);
         canUseTokens.mockReturnValue(true);

    // Call routeRequest with sticky key
    const result = routeRequest(100, undefined, modelId, 'balanced', undefined, keyAId);

    // Assert the preferred key was used
    expect(result.keyId).toBe(keyAId);
  });
});