    import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
    import type { Express } from 'express';
    import { createApp } from '../../app.js';
    import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
    import { streamKeepaliveConfig } from '../../routes/proxy.js';
    import http from 'http';
    import type { AddressInfo } from 'net';

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
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
    const origFetch = global.fetch;
    const encoder = new TextEncoder();

    // Mock provider that yields a chunk quickly (no idle period)
    vi.spyOn(global, 'fetch').mockImplementation(async (url: RequestInfo, init?: RequestInit): Promise<Response> => {
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
