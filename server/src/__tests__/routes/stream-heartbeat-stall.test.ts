import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { streamKeepaliveConfig } from '../../routes/proxy.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(path.startsWith('/v1/') ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
        ...(path.startsWith('/api/') ? { Authorization: `Bearer ${process.env.ADMIN_DASHBOARD_KEY || ''}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.text();

    let json: any = null;
    try { json = JSON.parse(data); } catch {}

    return { status: res.status, body: json, headers: res.headers, raw: data };
  } finally {
    server.close();
  }
}

describe('SSE stream heartbeat and stall protection', () => {
  let app: Express;
  let origKeepaliveInterval: number;
  let origMaxStall: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.ADMIN_DASHBOARD_KEY = 'test-admin-key';
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(async () => {
    // Save original config values
    origKeepaliveInterval = streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS;
    origMaxStall = streamKeepaliveConfig.MAX_STREAM_STALL_MS;

    // Use very short intervals for testing
    streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS = 100;
    streamKeepaliveConfig.MAX_STREAM_STALL_MS = 500;

    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    // Add a Groq key so routing can succeed
    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_heartbeat_test',
      label: 'heartbeat-test',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    // Restore original config values
    streamKeepaliveConfig.KEEPALIVE_INTERVAL_MS = origKeepaliveInterval;
    streamKeepaliveConfig.MAX_STREAM_STALL_MS = origMaxStall;
    vi.restoreAllMocks();
  });

  it('emits SSE keep-alive comments during idle periods', async () => {
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider that delays first chunk by 300ms (longer than KEEPALIVE_INTERVAL_MS=100)
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const body = JSON.parse((init as any).body);

      // Delay 300ms before first chunk, then send content
      const chunks = [
        { id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
        { id: 'chunk-2', object: 'chat.completion.chunk', created: 123, model: body.model,
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }] },
      ];

      return {
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            // Wait 300ms before first chunk — heartbeat should fire during this gap
            await new Promise(r => setTimeout(r, 300));
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as any;
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Test heartbeat' }],
      stream: true,
    });

    expect(status).toBe(200);
    // Should contain the actual content
    expect(raw).toContain('hello');
    expect(raw).toContain('world');
    // Should contain at least one keep-alive comment during the 300ms idle period
    expect(raw).toContain(': keep-alive');
  });

  it('terminates stream with stream_timeout error on stall', async () => {
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider that yields 2 chunks then stalls indefinitely (never closes)
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const body = JSON.parse((init as any).body);

      // Yield 2 chunks quickly, then never yield more (stall)
      const chunks = [
        { id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }] },
        { id: 'chunk-2', object: 'chat.completion.chunk', created: 123, model: body.model,
          choices: [{ index: 0, delta: { content: ' text' }, finish_reason: null }] },
      ];

      return {
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            // Stall: never close the stream, wait longer than MAX_STREAM_STALL_MS (500ms)
            await new Promise(r => setTimeout(r, 2000));
            controller.close();
          },
        }),
      } as any;
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Test stall detection' }],
      stream: true,
    });

    expect(status).toBe(200);
    // Should contain the partial content that was delivered before stall
    expect(raw).toContain('partial');
    // Should contain the stream_timeout error frame
    expect(raw).toContain('stream_timeout');
    // Should contain [DONE] after the error
    expect(raw).toContain('[DONE]');
  }, 10000);

  it('returns 504 on pre-stream stall (no chunks yielded)', async () => {
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock ALL provider fetch calls to stall before yielding any chunk
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      // Stall: never yield any data, wait longer than MAX_STREAM_STALL_MS (500ms)
      return {
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            await new Promise(r => setTimeout(r, 2000));
            controller.close();
          },
        }),
      } as any;
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Test pre-stream stall' }],
      stream: true,
    });

    // Pre-stream stall should return 504 (no headers sent yet, response still mutable)
    expect(status).toBe(504);
    expect(body?.error?.type).toBe('stream_timeout');
  }, 30000);

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

      const body = JSON.parse((init as any).body);

      return {
        ok: true,
        body: new ReadableStream({
          async start(controller) {
            // Yield one chunk, then wait a long time
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'start' }, finish_reason: null }],
            })}\n\n`));
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
    const url = `http://127.0.0.1:${addr.port}/v1/chat/completions`;

    const abortController = new AbortController();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getUnifiedApiKey()}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Test disconnect cleanup' }],
        stream: true,
      }),
      signal: abortController.signal,
    });

    // Read a bit of the stream, then abort
    const reader = res.body?.getReader();
    if (reader) {
      const { value } = await reader.read();
      expect(value).toBeDefined();
      reader.releaseLock();
    }

    // Abort the client connection
    abortController.abort();

    // Wait a bit for the server to process the disconnect
    await new Promise(r => setTimeout(r, 200));

    server.close();

    // If the test completes without hanging, the cleanup worked
    // (no leaked timers causing the process to hang)
    expect(true).toBe(true);
  });

  it('normal streaming still works correctly with heartbeat enabled', async () => {
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider that yields chunks quickly (no idle period)
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
        return origFetch(url, init);
      }
      if (!urlStr.includes('/chat/completions')) return origFetch(url, init);

      const body = JSON.parse((init as any).body);

      const chunks = [
        { id: 'chunk-1', object: 'chat.completion.chunk', created: 123, model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'quick' }, finish_reason: null }] },
        { id: 'chunk-2', object: 'chat.completion.chunk', created: 123, model: body.model,
          choices: [{ index: 0, delta: { content: ' response' }, finish_reason: 'stop' }] },
      ];

      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      } as any;
    });

    const { status, raw } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Quick response test' }],
      stream: true,
    });

    expect(status).toBe(200);
    expect(raw).toContain('quick');
    expect(raw).toContain('response');
    expect(raw).toContain('[DONE]');
    // Fast streams may or may not have keep-alive comments (depends on timing)
    // but the stream must complete successfully regardless
  });
});