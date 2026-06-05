import { describe, it, expect, beforeAll } from 'vitest';
import { ModelPool } from '@freellmapi/shared/types.js';
import type { Express } from 'express';
import type { AddressInfo } from 'net';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0);
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data: unknown = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Fallback Pool Classification', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('GET /api/fallback pool values include smart for LongCat platform', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const entries = body as Array<{ platform: string; pool: string }>;
    const longcatEntries = entries.filter(e => e.platform === 'longcat');
    // If LongCat models exist in the seed data, they should have smart pool
    for (const entry of longcatEntries) {
      expect(entry.pool).toBe(ModelPool.Smart);
    }
  });

  it('GET /api/fallback pool values include fast for -fast suffix models', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const entries = body as Array<{ modelId: string; pool: string }>;
    const fastEntries = entries.filter(e => e.modelId.endsWith('-fast'));
    for (const entry of fastEntries) {
      expect(entry.pool).toBe(ModelPool.Fast);
    }
  });

  it('GET /api/fallback pool values are valid ModelPool enum values', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const validPools = [ModelPool.Fast, ModelPool.Balanced, ModelPool.Smart];
    const entries = body as Array<{ pool: string }>;
    for (const entry of entries) {
      expect(validPools).toContain(entry.pool);
    }
  });

  it('GET /api/fallback pool values include balanced for non-smart non-fast models', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const entries = body as Array<{ platform: string; modelId: string; pool: string }>;
    const balancedEntries = entries.filter(
      e => e.pool === ModelPool.Balanced
    );
    // Balanced entries should not be LongCat platform or -fast suffix
    for (const entry of balancedEntries) {
      expect(entry.platform).not.toBe('longcat');
      expect(entry.modelId).not.toMatch(/-fast$/);
    }
  });
});
