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

describe('Router Balanced Mode', () => {
  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();

    // Disable all fallback entries by default
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    vi.clearAllMocks();
  });

  it('should exclude LongCat platform from balanced mode', () => {
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

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in balanced mode (default)
    const result = routeRequest(100);

    // Assert LongCat was NOT selected - should be google
    expect(result.platform).toBe('google');
    expect(result.modelId).toBe('balanced-test');
  });

  it('should exclude Owl Alpha model from balanced mode', () => {
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

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in balanced mode (default)
    const result = routeRequest(100);

    // Assert Owl Alpha was NOT selected - should be google
    expect(result.platform).toBe('google');
    expect(result.modelId).toBe('balanced-test');
  });

  it('should include other models in balanced mode', () => {
    const db = getDb();

    // Insert a balanced model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'balanced-test', 'Balanced Test', 1, 1, 1, 1000, 100000)").run();
    const balancedId = (db.prepare("SELECT id FROM models WHERE model_id = 'balanced-test'").get() as { id: number }).id;

    // Enable in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(balancedId);

    // Insert API key
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in balanced mode (default)
    const result = routeRequest(100);

    // Assert balanced model was selected
    expect(result.platform).toBe('google');
    expect(result.modelId).toBe('balanced-test');
  });

  it('should allow sticky session to override LongCat exclusion in balanced mode', () => {
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

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest in balanced mode with sticky session for LongCat
    const result = routeRequest(100, undefined, lcId, 'balanced');

    // Assert LongCat WAS selected because of sticky session
    expect(result.platform).toBe('longcat');
    expect(result.modelId).toBe('lc-test');
  });
});