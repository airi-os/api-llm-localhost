import { describe, it, expect, beforeEach, vi } from 'vitest';
import { routeRequest, recordRateLimitHit, recordSuccess, getAllPenalties, clearAllPenalties } from '../../services/router.js';
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

describe('Router Penalties', () => {
  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();

    // Disable all fallback entries by default
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    // Clear penalties between tests
    clearAllPenalties();

    vi.clearAllMocks();
  });

  it('should apply penalty when all keys are exhausted', () => {
    const db = getDb();

    // Insert a model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'test-model', 'Test Model', 1, 1, 1, 1000, 100000)").run();
    const modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;

    // Enable in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(modelId);

    // Insert API key
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Test Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Mock ratelimit to deny all requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(false);

    // Call routeRequest and expect it to throw
    expect(() => routeRequest(100)).toThrow(/exhausted/i);
  });

  it('should not apply penalty when only some keys are exhausted', () => {
    const db = getDb();

    // Insert a model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'test-model', 'Test Model', 1, 1, 1, 1000, 100000)").run();
    const modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;

    // Enable in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(modelId);

    // Insert two API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key B', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Mock ratelimit to allow at least one key
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest
    const result = routeRequest(100);

    // Assert it succeeded
    expect(result).toBeDefined();
    expect(result.modelId).toBe('test-model');
  });

  it('should record rate limit hit and increase penalty', () => {
    const db = getDb();

    // Insert a model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'test-model', 'Test Model', 1, 1, 1, 1000, 100000)").run();
    const modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;

    // Enable in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(modelId);

    // Insert API key
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Test Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Record rate limit hits
    recordRateLimitHit(modelId);
    recordRateLimitHit(modelId);

    // Check penalties
    const penalties = getAllPenalties();
    const modelPenalty = penalties.find(p => p.modelDbId === modelId);

    expect(modelPenalty).toBeDefined();
    expect(modelPenalty!.count).toBe(2);
    expect(modelPenalty!.penalty).toBe(6); // PENALTY_PER_429 = 3, so 2 hits = 6
  });

  it('should cap penalty at MAX_PENALTY (10)', () => {
    const db = getDb();

    // Insert a model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'test-model', 'Test Model', 1, 1, 1, 1000, 100000)").run();
    const modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;

    // Record many rate limit hits to exceed max penalty
    for (let i = 0; i < 10; i++) {
      recordRateLimitHit(modelId);
    }

    // Check penalties - should be capped at 10
    const penalties = getAllPenalties();
    const modelPenalty = penalties.find(p => p.modelDbId === modelId);

    expect(modelPenalty).toBeDefined();
    expect(modelPenalty!.penalty).toBe(10); // MAX_PENALTY
  });

  it('should reduce penalty on success', () => {
    const db = getDb();

    // Insert a model
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'test-model', 'Test Model', 1, 1, 1, 1000, 100000)").run();
    const modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-model'").get() as { id: number }).id;

    // Record rate limit hits
    recordRateLimitHit(modelId);
    recordRateLimitHit(modelId);

    // Record success
    recordSuccess(modelId);

    // Check penalties - should be reduced by 1
    const penalties = getAllPenalties();
    const modelPenalty = penalties.find(p => p.modelDbId === modelId);

    expect(modelPenalty).toBeDefined();
    expect(modelPenalty!.penalty).toBe(5); // 6 - 1 = 5
  });

  it('should prefer key with lower penalty', () => {
    const db = getDb();

    // Insert two models with different priorities
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'model-high', 'High Priority', 1, 1, 1, 1000, 100000)").run();
    const highId = (db.prepare("SELECT id FROM models WHERE model_id = 'model-high'").get() as { id: number }).id;

    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'model-low', 'Low Priority', 2, 2, 1, 1000, 100000)").run();
    const lowId = (db.prepare("SELECT id FROM models WHERE model_id = 'model-low'").get() as { id: number }).id;

    // Enable both in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(highId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(lowId);

    // Insert API keys
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key High', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key Low', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Apply penalty to high priority model
    recordRateLimitHit(highId);
    recordRateLimitHit(highId);
    recordRateLimitHit(highId);
    recordRateLimitHit(highId); // penalty = 12, capped at 10

    // Mock ratelimit to allow requests
    (ratelimit.canMakeRequest as jest.Mock).mockReturnValue(true);
    (ratelimit.canUseTokens as jest.Mock).mockReturnValue(true);

    // Call routeRequest
    const result = routeRequest(100);

    // Assert low priority model was selected due to penalty on high
    expect(result.modelId).toBe('model-low');
  });
});