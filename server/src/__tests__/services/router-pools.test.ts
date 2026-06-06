import { describe, it, expect, beforeEach, vi } from 'vitest';
import { routeRequest } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
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

describe('Router Pool-Based Routing', () => {
  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();

    // Disable all fallback entries by default
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    vi.clearAllMocks();
  });

  it('should route to smart pool for LongCat platform in smart mode', () => {
    const db = getDb();

    // Insert LongCat model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LC Test', 1, 1, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Insert a balanced model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Enable both in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LC Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Insert request history to establish performance metrics
    // LongCat: slow model (tokPerSec ~50, avgTtfbMs ~3000) -> Smart pool
    // Balanced: fast model (tokPerSec ~500, avgTtfbMs ~500) -> Balanced pool
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in smart mode
    const result = routeRequest(100, undefined, undefined, 'smart');

    // Assert LongCat was selected (smart pool)
    expect(result.platform).toBe('longcat');
    expect(result.modelId).toBe('lc-test');
  });

  it('should route to smart pool for Owl Alpha model in smart mode', () => {
    const db = getDb();

    // Insert Owl Alpha model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('openrouter', 'owl-alpha', 'Owl Alpha', 1, 1, 1, 1000, 100000)").run();
    const owlId = (db.prepare("SELECT id FROM models WHERE model_id = 'owl-alpha'").get() as { id: number }).id;

    // Insert a balanced model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Enable both in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(owlId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('openrouter', 'OR Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Insert request history to establish performance metrics
    // Owl Alpha: slow model (tokPerSec ~50, avgTtfbMs ~3000) -> Smart pool
    // Balanced: fast model (tokPerSec ~500, avgTtfbMs ~500) -> Balanced pool
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('openrouter', 'owl-alpha', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in smart mode
    const result = routeRequest(100, undefined, undefined, 'smart');

    // Assert Owl Alpha was selected (smart pool)
    expect(result.platform).toBe('openrouter');
    expect(result.modelId).toBe('owl-alpha');
  });

  it('should exclude LongCat/Owl Alpha from balanced mode', () => {
    const db = getDb();

    // Insert LongCat model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LC Test', 1, 1, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Insert Owl Alpha model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('openrouter', 'owl-alpha', 'Owl Alpha', 1, 1, 1, 1000, 100000)").run();
    const owlId = (db.prepare("SELECT id FROM models WHERE model_id = 'owl-alpha'").get() as { id: number }).id;

    // Insert a balanced model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Enable all in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(owlId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 3, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LC Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('openrouter', 'OR Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Insert request history to establish performance metrics
    // LongCat: slow model (tokPerSec ~50, avgTtfbMs ~3000) -> Smart pool
    // Owl Alpha: slow model (tokPerSec ~50, avgTtfbMs ~3000) -> Smart pool
    // Balanced: fast model (tokPerSec ~500, avgTtfbMs ~500) -> Balanced pool
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('openrouter', 'owl-alpha', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in balanced mode
    const result = routeRequest(100, undefined, undefined, 'balanced');

    // Assert neither LongCat nor Owl Alpha was selected (smart pool excluded from balanced)
    expect(result.platform).toBe('google');
    expect(result.modelId).toBe('balanced-test');
  });

  it('should handle cross-pool fallback when smart pool is exhausted', () => {
    const db = getDb();

    // Insert LongCat model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LC Test', 1, 1, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Insert a balanced model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Enable both in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LC Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Insert request history to establish performance metrics
    // LongCat: slow model (tokPerSec ~50, avgTtfbMs ~3000) -> Smart pool
    // Balanced: fast model (tokPerSec ~500, avgTtfbMs ~500) -> Balanced pool
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();

    // Mock ratelimit: LongCat exhausted, Google available
    (ratelimit.canMakeRequest as jest.Mock).mockImplementation((platform: string) => {
      if (platform === 'longcat') return false;
      return true;
    });
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in smart mode - should fail since smart mode doesn't borrow
    // Note: Smart mode NEVER borrows, so this should throw
    expect(() => routeRequest(100, undefined, undefined, 'smart')).toThrow('All models exhausted');
  });

  it('should handle mixed pool scenarios', () => {
    const db = getDb();

    // Insert smart pool model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LC Test', 1, 1, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Insert fast pool model (very fast: tokPerSec ~5000, avgTtfbMs ~200)
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'fast-model', 'Fast Model', 3, 1, 1, 1000, 100000)").run();
    const fastId = (db.prepare("SELECT id FROM models WHERE model_id = 'fast-model'").get() as { id: number }).id;

    // Insert balanced pool model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Enable all in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(fastId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 3, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LC Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Insert request history to establish performance metrics
    // LongCat: slow model (tokPerSec ~50, avgTtfbMs ~3000) -> Smart pool
    // Fast: very fast model (tokPerSec ~5000, avgTtfbMs ~200) -> Fast pool
    // Balanced: fast model (tokPerSec ~500, avgTtfbMs ~500) -> Balanced pool
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'fast-model', 'success', 20, 100, 200, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in smart mode
    const result = routeRequest(100, undefined, undefined, 'smart');

    // Assert smart pool model was selected
    expect(result.platform).toBe('longcat');
    expect(result.modelId).toBe('lc-test');
  });

  it('should prefer smart pool models in smart mode', () => {
    const db = getDb();

    // Insert smart pool model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LC Test', 1, 1, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Insert balanced pool model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 2, 2, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Enable all in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(balancedId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LC Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Insert request history to establish performance metrics
    // LongCat: slow model (tokPerSec ~50, avgTtfbMs ~3000) -> Smart pool
    // Balanced: fast model (tokPerSec ~500, avgTtfbMs ~500) -> Balanced pool
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'balanced-test', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in smart mode
    const result = routeRequest(100, undefined, undefined, 'smart');

    // Assert smart pool model was selected
    expect(result.modelId).toBe('lc-test');
  });
});