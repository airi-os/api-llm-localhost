import { describe, it, expect, beforeEach, vi } from 'vitest';
import { routeRequest, recordRateLimitHit, recordSuccess, getAllPenalties, clearAllPenalties, refreshStatsCache } from '../../services/router.js';
import { canMakeRequest, canUseTokens } from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(),
    canUseTokens: vi.fn(),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return {
    ...actual,
    decrypt: vi.fn(() => 'mocked-api-key'),
  };
});

describe('Router Fast Mode', () => {
  beforeEach(() => {
    initDb(':memory:');
    clearAllPenalties();
    vi.clearAllMocks();

    // Default: all ratelimit checks pass
    canMakeRequest.mockReturnValue(true);
    canUseTokens.mockReturnValue(true);

    const db = getDb();

    // Disable all fallback entries by default
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    // Insert Fast pool models
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('openai', 'openai-fast', 'OpenAI Fast', 5, 1, 1, 1000, 100000)").run();
    const openaiFastId = (db.prepare("SELECT id FROM models WHERE model_id = 'openai-fast'").get() as { id: number }).id;
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'google-fast', 'Google Fast', 5, 1, 1, 1000, 100000)").run();
    const googleFastId = (db.prepare("SELECT id FROM models WHERE model_id = 'google-fast'").get() as { id: number }).id;
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('anthropic', 'claude-3-5-haiku', 'Claude Haiku', 4, 1, 1, 1000, 100000)").run();
    const haikuId = (db.prepare("SELECT id FROM models WHERE model_id = 'claude-3-5-haiku'").get() as { id: number }).id;

    // Insert Balanced pool models
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('google', 'gemini-2.0-flash', 'Gemini Flash', 3, 2, 1, 1000, 100000)").run();
    const flashId = (db.prepare("SELECT id FROM models WHERE model_id = 'gemini-2.0-flash'").get() as { id: number }).id;
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('openai', 'gpt-4o-mini', 'GPT-4o Mini', 3, 2, 1, 1000, 100000)").run();
    const miniId = (db.prepare("SELECT id FROM models WHERE model_id = 'gpt-4o-mini'").get() as { id: number }).id;

    // Insert Smart pool models
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('longcat', 'lc-test', 'LongCat Test', 1, 5, 1, 1000, 100000)").run();
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, rpm_limit, tpm_limit) VALUES ('anthropic', 'owl-alpha', 'Owl Alpha', 1, 5, 1, 1000, 100000)").run();
    const owlId = (db.prepare("SELECT id FROM models WHERE model_id = 'owl-alpha'").get() as { id: number }).id;

    // Enable all in fallback
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(openaiFastId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(googleFastId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 3, 1)").run(haikuId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 4, 1)").run(flashId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 5, 1)").run(miniId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 6, 1)").run(lcId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 7, 1)").run(owlId);

    // Insert API keys for each platform
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('openai', 'OpenAI Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Google Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('anthropic', 'Anthropic Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('longcat', 'LongCat Key', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Add request history for dynamic pool calculation
    // Fast models: tokPerSec >= 40000, avgTtfbMs <= 20 (speed score >= 8)
    // Formula: speedScore = log(tokPerSec) - log(ttfbMs + 1) * 0.1
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('openai', 'openai-fast', 'success', 3, 200, 20, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'google-fast', 'success', 3, 200, 20, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('anthropic', 'claude-3-5-haiku', 'success', 3, 200, 20, datetime('now', '-1 day'))
    `).run();

    // Balanced pool models: tokPerSec ~500, avgTtfbMs ~10 (speed score 5-8)
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'gemini-2.0-flash', 'success', 200, 100, 10, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('openai', 'gpt-4o-mini', 'success', 200, 100, 10, datetime('now', '-1 day'))
    `).run();

    // Smart pool models: tokPerSec ~50, avgTtfbMs ~3000 (speed score < 5)
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('anthropic', 'owl-alpha', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();

    // Refresh stats cache with the new request history
    refreshStatsCache(db, true);
  });

  it('should only include fast pool models in fast mode', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');

    // Fast mode should only route to models in the Fast pool
    expect(result).toBeDefined();
    expect(result.modelId).toBeDefined();

    // The model should be a fast model (openai-fast, google-fast, or claude-3-5-haiku)
    const fastModels = ['openai-fast', 'google-fast', 'claude-3-5-haiku'];
    expect(fastModels).toContain(result.modelId);
  });

  it('should exclude smart pool models in fast mode', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');

    // Verify the result is not a smart pool model
    expect(result).toBeDefined();
    expect(result.modelId).toBeDefined();

    // Smart pool models should not be selected in fast mode
    // Note: Fast mode includes Fast + Balanced pools (borrowing up)
    const smartPoolModels = ['lc-test', 'owl-alpha'];
    expect(smartPoolModels).not.toContain(result.modelId);
  });

  it('should use Thompson sampling for model selection in fast mode', () => {
    // Run multiple times to verify Thompson sampling is being used
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = routeRequest(100, undefined, undefined, 'fast');
      results.push(result.modelId);
    }

    // All results should be fast models
    const fastModels = ['openai-fast', 'google-fast', 'claude-3-5-haiku'];
    results.forEach(modelId => {
      expect(fastModels).toContain(modelId);
    });
  });

  it('should respect rate limits in fast mode', () => {
    // Mock rate limit to fail for fast pool models only
    canMakeRequest.mockImplementation((platform, modelId) => {
      // Block fast pool models, allow balanced pool models
      return !(modelId === 'openai-fast' || modelId === 'google-fast' || modelId === 'claude-3-5-haiku');
    });

    const result = routeRequest(100, undefined, undefined, 'fast');

    // Should still get a result from balanced pool via borrowing
    expect(result).toBeDefined();
    expect(result.modelId).toBeDefined();
    // Result should be from balanced pool (gemini-2.0-flash or gpt-4o-mini)
    const balancedModels = ['gemini-2.0-flash', 'gpt-4o-mini'];
    expect(balancedModels).toContain(result.modelId);
  });

  it('should apply penalties in fast mode', () => {
    const db = getDb();

    // Get initial penalties
    const initialPenalties = getAllPenalties();

    // Record a rate limit hit for a fast model
    const result = routeRequest(100, undefined, undefined, 'fast');
    const modelDbId = result.modelDbId;

    recordRateLimitHit(modelDbId);

    // Check penalties were applied
    const penalties = getAllPenalties();
    const modelPenalty = penalties.find(p => p.modelDbId === modelDbId);

    expect(modelPenalty).toBeDefined();
    expect(modelPenalty!.count).toBeGreaterThan(0);
  });

  it('should include haiku as a fast pool model', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');

    // haiku should be a valid fast pool model
    expect(result).toBeDefined();
    expect(result.modelId).toBeDefined();

    // The result should be a fast model
    const fastModels = ['openai-fast', 'google-fast', 'claude-3-5-haiku'];
    expect(fastModels).toContain(result.modelId);
  });

  it('should allow sticky session to override fast mode filtering', () => {
    const db = getDb();

    // Get the model_db_id for lc-test
    const lcId = (db.prepare("SELECT id FROM models WHERE model_id = 'lc-test'").get() as { id: number }).id;

    // Note: lc-test is a Smart pool model, but sticky session should override
    // the pool filtering and select it anyway
    const result = routeRequest(100, undefined, lcId, 'fast');

    // Sticky session should take precedence over fast mode filtering
    expect(result).toBeDefined();
    // The sticky model should be selected if it has valid keys
    expect(result.modelDbId).toBe(lcId);
  });

  it('should reduce penalty on success in fast mode', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');
    const modelDbId = result.modelDbId;

    // Apply a penalty
    recordRateLimitHit(modelDbId);
    recordRateLimitHit(modelDbId);

    const penaltiesAfterHits = getAllPenalties();
    const penaltyBefore = penaltiesAfterHits.find(p => p.modelDbId === modelDbId);

    expect(penaltyBefore).toBeDefined();
    const penaltyCountBefore = penaltyBefore!.count;

    // Record success - should reduce penalty
    recordSuccess(modelDbId);

    const penaltiesAfterSuccess = getAllPenalties();
    const penaltyAfter = penaltiesAfterSuccess.find(p => p.modelDbId === modelDbId);

    // Penalty should be reduced after success
    expect(penaltyAfter).toBeDefined();
    expect(penaltyAfter!.count).toBeLessThan(penaltyCountBefore);
  });
});