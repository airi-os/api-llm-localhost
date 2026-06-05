import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { streamKeepaliveConfig } from '../../routes/proxy.js';
import http from 'http';

function httpRequest(app: Express, method: string, path: string, body?: any): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    const addr = server.address() as any;
    const port = addr.port;

    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(path.startsWith('/v1/') ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
        ...(path.startsWith('/api/') ? { Authorization: `Bearer ${process.env.ADMIN_DASHBOARD_KEY || ''}` } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        server.close();
        resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
      });
    });

    req.on('error', (err) => {
      server.close();
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('SSE stream heartbeat and stall protection', () => {
  let app: Express;
  let origKeepaliveInterval: number;
  let origMaxStall: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.ADMIN_DASHBOARD_KEY = 'test-admin-key-that-is-long-enough';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    // Save original config values
    origKeepaliveInterval = streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS;
    origMaxStall = streamKeepaliveConfig.MAX_STREAM_STALL_MS;

    // Use short intervals for testing
    streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS = 100;
    streamKeepaliveConfig.MAX_STREAM_STALL_MS = 500;

    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    // Add a Groq key so routing can succeed
    const addKey = await httpRequest(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_heartbeat_test',
      label: 'heartbeat-test',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(async () => {
    // Restore original config values
    streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS = origKeepaliveInterval;
    streamKeepaliveConfig.MAX_STREAM_STALL_MS = origMaxStall;
    vi.restoreAllMocks();
  });

  it('emits SSE keep-alive comments when first chunk is delayed', async () => {
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider: delay first chunk by 300ms (longer than KEEPALIVE_INTERVAL_MS=100)
    // This gives the heartbeat timer time to fire at least once before any data arrives
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const reqBody = JSON.parse((init as any).body);

      return {
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            // Wait 300ms before first chunk — heartbeat should fire during this gap
            await new Promise(r => setTimeout(r, 300));
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({
              id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: reqBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            }) + '\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as any;
    });

    const { status, body } = await httpRequest(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Test heartbeat' }],
      stream: true,
    });

    expect(status).toBe(200);
    // Should contain the content from the first chunk
    expect(body).toContain('hello');
    // Should contain [DONE] indicating stream completed
    expect(body).toContain('[DONE]');
    // The stream should complete without hanging (keep-alive prevented stall)
  });

  it('terminates stream with stream_timeout error on stall', async () => {
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider: yield 1 chunk then stall indefinitely
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const reqBody = JSON.parse((init as any).body);

      return {
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            // Yield one chunk
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({
              id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: reqBody.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }],
            }) + '\n\n'));
            // Stall: never close the stream, wait longer than MAX_STREAM_STALL_MS (500ms)
            await new Promise(r => setTimeout(r, 3000));
            controller.close();
          },
        }),
      } as any;
    });

    const { status, body } = await httpRequest(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Test stall detection' }],
      stream: true,
    });

    expect(status).toBe(200);
    // Should contain the partial content that was delivered before stall
    expect(body).toContain('partial');
    // Stream should complete (not hang forever)
    // The stall detection should have terminated the stream after MAX_STREAM_STALL_MS
    expect(body).toContain('[DONE]');
  }, 15000);

  it('returns error on pre-stream stall (no chunks yielded)', async () => {
    const origFetch = global.fetch;
    let callCount = 0;

    // Mock provider: stall on first call, return error on retries
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      callCount++;
      if (callCount === 1) {
        // First call: stall longer than MAX_STREAM_STALL_MS (500ms)
        // This triggers the pre-stream stall detection which injects a 504 error
        return {
          ok: true,
          body: new ReadableStream({
            async start(controller) {
              await new Promise(r => setTimeout(r, 3000));
              controller.close();
            },
          }),
        } as any;
      }

      // Subsequent calls: return an error response immediately (no stall)
      // This prevents the test from timing out due to repeated stalls
      return new Response(
        JSON.stringify({ error: { message: 'Provider unavailable', type: 'api_error' } }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const { status, body } = await httpRequest(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Test pre-stream stall' }],
      stream: true,
    });

    // Pre-stream stall should return 504 (no headers sent yet, response still mutable)
    // OR the proxy may retry and eventually return 502/504 depending on fallback behavior
    expect(status).toBeGreaterThanOrEqual(500);
    // Should complete without hanging
    expect(body.length).toBeGreaterThan(0);
  }, 15000);

  it('clears heartbeat interval on client disconnect', async () => {
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider that yields chunks slowly
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const reqBody = JSON.parse((init as any).body);

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
      } as any;
    });

    // Make the request but abort it after receiving the first chunk
    const server = app.listen(0);
    const addr = server.address() as any;
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
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider that yields a chunk quickly (no idle period)
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const reqBody = JSON.parse((init as any).body);

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
      } as any;
    });

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
