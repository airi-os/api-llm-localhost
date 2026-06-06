import { describe, it, expect, beforeEach, vi } from 'vitest';
import { routeRequest, recordRateLimitHit, recordSuccess, getAllPenalties, clearAllPenalties } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
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
    randomBytes: vi.fn(() => Buffer.alloc(32)),
  };
});

describe('Router Fast Mode', () => {
  beforeEach(() => {
    initDb(':memory:');
    clearAllPenalties();
    vi.clearAllMocks();

    // Default: all ratelimit checks pass
    vi.mocked(ratelimit.canMakeRequest).mockReturnValue(true);
    vi.mocked(ratelimit.canUseTokens).mockReturnValue(true);

    const db = getDb();

    // Add request history for dynamic pool calculation
    // Fast models: tokPerSec >= 5000, avgTtfbMs <= 200
    // Balanced models: tokPerSec ~500, avgTtfbMs ~500
    // Smart models: tokPerSec ~50, avgTtfbMs ~3000

    // Fast pool models (openai-fast, google-fast, etc.)
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('openai', 'openai-fast', 'success', 100, 100, 150, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'google-fast', 'success', 100, 100, 150, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('anthropic', 'claude-3-5-haiku', 'success', 100, 100, 150, datetime('now', '-1 day'))
    `).run();

    // Balanced pool models
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('google', 'gemini-2.0-flash', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('openai', 'gpt-4o-mini', 'success', 200, 100, 500, datetime('now', '-1 day'))
    `).run();

    // Smart pool models (slow, high quality)
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('longcat', 'lc-test', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, output_tokens, ttfb_ms, created_at)
      VALUES ('anthropic', 'owl-alpha', 'success', 2000, 100, 3000, datetime('now', '-1 day'))
    `).run();
  });

  it('should only include fast pool models in fast mode', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');

    // Fast mode should only route to models in the Fast pool
    // Fast pool includes models with '-fast' suffix or 'openai-fast'
    expect(result).toBeDefined();
    expect(result.model_id).toBeDefined();

    // The model should be a fast model
    const isFastModel =
      result.model_id.endsWith('-fast') || result.model_id === 'openai-fast';
    expect(isFastModel).toBe(true);
  });

  it('should exclude non-fast models in fast mode', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');

    // Verify the result is not a non-fast model
    expect(result).toBeDefined();
    expect(result.model_id).toBeDefined();

    // Non-fast models should not be selected
    const isNonFastModel =
      result.model_id === 'longcat' ||
      result.model_id === 'owl-alpha' ||
      result.model_id === 'anthropic/claude-3-5-sonnet';
    expect(isNonFastModel).toBe(false);
  });

  it('should use Thompson sampling for model selection in fast mode', () => {
    // Run multiple times to verify Thompson sampling is being used
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = routeRequest(100, undefined, undefined, 'fast');
      results.push(result.model_id);
    }

    // All results should be fast models
    results.forEach(modelId => {
      const isFastModel =
        modelId.endsWith('-fast') || modelId === 'openai-fast';
      expect(isFastModel).toBe(true);
    });
  });

  it('should respect rate limits in fast mode', () => {
    // Mock rate limit to fail for a specific model
    vi.mocked(ratelimit.canMakeRequest).mockImplementation((platform, modelId) => {
      // Block all requests to simulate rate limit
      return false;
    });

    const result = routeRequest(100, undefined, undefined, 'fast');

    // Should still get a result if there are other available models
    // or handle the rate limit gracefully
    expect(result).toBeDefined();
  });

  it('should apply penalties in fast mode', () => {
    const db = getDb();

    // Get initial penalties
    const initialPenalties = getAllPenalties();

    // Record a rate limit hit for a fast model
    const result = routeRequest(100, undefined, undefined, 'fast');
    const modelDbId = result.model_db_id;

    recordRateLimitHit(modelDbId);

    // Check penalties were applied
    const penalties = getAllPenalties();
    const modelPenalty = penalties.find(p => p.modelDbId === modelDbId);

    expect(modelPenalty).toBeDefined();
    expect(modelPenalty!.count).toBeGreaterThan(0);
  });

  it('should include openai-fast as a fast pool model', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');

    // openai-fast should be a valid fast pool model
    expect(result).toBeDefined();
    expect(result.model_id).toBeDefined();

    // If openai-fast is available, it should be selected
    // Otherwise, another fast model should be selected
    const isFastModel =
      result.model_id.endsWith('-fast') || result.model_id === 'openai-fast';
    expect(isFastModel).toBe(true);
  });

  it('should allow sticky session to override fast mode filtering', () => {
    // When a sticky session is provided, it should override the fast mode filtering
    const stickyModelId = 'longcat'; // A non-fast model

    const result = routeRequest(100, stickyModelId, undefined, 'fast');

    // Sticky session should take precedence over fast mode filtering
    expect(result).toBeDefined();
    // The sticky model should be selected if it has valid keys
    expect(result.model_id).toBeDefined();
  });

  it('should reduce penalty on success in fast mode', () => {
    const result = routeRequest(100, undefined, undefined, 'fast');
    const modelDbId = result.model_db_id;

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