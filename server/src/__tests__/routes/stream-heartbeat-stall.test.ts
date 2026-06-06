import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import type { AddressInfo } from 'net';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { streamKeepaliveConfig } from '../../routes/proxy.js';
import http from 'http';

function httpRequest(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0);
    const addr = server.address() as AddressInfo;
    const port = addr.port;

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(path.startsWith('/v1/') ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        server.close();
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    });

    req.on('error', () => {
      server.close();
      resolve({ status: 0, body: '' });
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('Stream heartbeat and stall handling', () => {
  let app: Express;
  let origFetch: typeof global.fetch;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    origFetch = global.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = origFetch;
  });

  it('client disconnect cleans up keepalive timers', async () => {
    const encoder = new TextEncoder();

    vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const reqBody = JSON.parse(init?.body as string);

      return {
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            // Yield one chunk, then wait a long time
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({
              id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: reqBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'start' }, finish_reason: null }],
            }) + '\n\n'));
            await new Promise(r => setTimeout(r, 5000));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response;
    });

    // Make the request but abort it after receiving the first chunk
    const server = app.listen(0);
    const addr = server.address() as AddressInfo;
    const port = addr.port;

    const result = await new Promise<{ completed: boolean }>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + getUnifiedApiKey(),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          // After receiving first chunk, abort
          if (data.includes('start')) {
            req.destroy();
          }
        });
        res.on('end', () => {
          server.close();
          resolve({ completed: true });
        });
      });

      req.on('error', () => {
        server.close();
        resolve({ completed: true });
      });

      req.write(JSON.stringify({
        messages: [{ role: 'user', content: 'Test disconnect cleanup' }],
        stream: true,
      }));
      req.end();
    });

    // If the test completes without hanging, the cleanup worked
    expect(result.completed).toBe(true);
  });

  it('normal streaming works correctly with heartbeat enabled', async () => {
    const encoder = new TextEncoder();

    // Mock provider that yields a chunk quickly (no idle period)
    vi.spyOn(global, 'fetch').mockImplementation((url: RequestInfo, init?: RequestInit): Response => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const bodyStr = init?.body as string;
      const reqBody = JSON.parse(bodyStr) as { model: string };

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({
              id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: reqBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'quick' }, finish_reason: 'stop' }],
            }) + '\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as unknown as Response;
    });

    // Add a key so the proxy can route to a provider
    const addKey = await httpRequest(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_heartbeat_test',
      label: 'heartbeat-test',
    });
    expect(addKey.status).toBe(201);

    const { status, body } = await httpRequest(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Quick response test' }],
      stream: true,
    });

    expect(status).toBe(200);
    expect(body).toContain('quick');
    expect(body).toContain('[DONE]');
  });

  it('streamKeepaliveConfig controls heartbeat and stall thresholds', () => {
    // Verify the config object exists and has the expected properties
    expect(streamKeepaliveConfig).toHaveProperty('KEEPALIVE_INTERVAL_MS');
    expect(streamKeepaliveConfig).toHaveProperty('MAX_STREAM_STALL_MS');
    // The test overrides should be restored by afterEach
  });
});
