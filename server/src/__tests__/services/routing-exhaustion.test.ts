import { describe, it, expect, beforeEach, vi } from 'vitest';
import { routeRequest } from '../../services/router.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from '../../services/ratelimit.js';
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

describe('Routing Key Exhaustion', () => {
  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();
    
    db.prepare('UPDATE fallback_config SET enabled = 0').run();

    // Setup: 2 isolated test models (Pro and Flash)
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'test-pro', 'Pro', 1, 1, 1)").run();
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'test-flash', 'Flash', 2, 2, 1)").run();
    
    const proId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-pro'").get() as { id: number }).id;
    const flashId = (db.prepare("SELECT id FROM models WHERE model_id = 'test-flash'").get() as { id: number }).id;
    
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(proId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(flashId);
    
    // Setup: 2 keys for Google
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key B', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    vi.clearAllMocks();
  });

  it('should skip exhausted Key B and use functional Key A for the same high-priority model', () => {
    const db = getDb();
    const keys = db.prepare("SELECT id, label FROM api_keys").all();
    const keyA = keys.find(key => key.label === 'Key A');
    const keyB = keys.find(key => key.label === 'Key B');

    // Mock behavior:
    // Key B is exhausted (returns false for canMakeRequest)
    // Key A is functional (returns true)
    const isKeyA = (_platform: unknown, _modelId: unknown, keyId: number) => keyId === keyA.id;
    (canMakeRequest as jest.Mock).mockImplementation(isKeyA);
    (canUseTokens as jest.Mock).mockReturnValue(true);

    db.prepare("UPDATE fallback_config SET enabled = 0 WHERE model_db_id = (SELECT id FROM models WHERE model_id = 'test-flash')").run();

    // Act: Route request
    const result = routeRequest(100);

    // Assert: It should have picked the Pro model despite Key B being exhausted
    expect(result.modelId).toBe('test-pro');
    expect(result.keyId).toBe(keyA.id);
    expect(canMakeRequest).toHaveBeenCalled();
  });

  it('should throw 429 when every key on every model is exhausted', () => {
    (canMakeRequest as jest.Mock).mockReturnValue(false);
    expect(() => routeRequest(100)).toThrow(/All models exhausted/);
  });

  it('should fall back to Flash when Pro is exhausted but Flash has quota', () => {
    const isNotPro = (_platform: string, modelId: string) => modelId !== 'test-pro';
    (canMakeRequest as jest.MockedFunction<typeof canMakeRequest>).mockImplementation(isNotPro);
    (canUseTokens as jest.MockedFunction<typeof canUseTokens>).mockReturnValue(true);

    const result = routeRequest(100);
    expect(result.modelId).toBe('test-flash');
  });
});
