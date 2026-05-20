import './services/logBuffer.js';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { logsRouter } from './routes/logs.js';
import { errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_BODY_CHARS = 2000;

function stringifyForLog(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return '';
    return serialized.length > MAX_LOG_BODY_CHARS
      ? `${serialized.slice(0, MAX_LOG_BODY_CHARS)}...`
      : serialized;
  } catch {
    return '[unserializable body]';
  }
}

export function createApp(): Express {
  const app = express();

  app.use((req, res, next) => {
    const start = Date.now();
    const requestUrl = req.originalUrl;
    let responseBody: unknown;
    const originalJson = res.json.bind(res);

    res.json = (body: unknown) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      console.log(`[HTTP] ${req.method} ${requestUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
      if (res.statusCode >= 400 && requestUrl.startsWith('/v1/')) {
        console.warn(`[HTTP] ${req.method} ${requestUrl} request body: ${stringifyForLog(req.body)}`);
        console.warn(`[HTTP] ${req.method} ${requestUrl} response body: ${stringifyForLog(responseBody)}`);
      }
    });
    next();
  });

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP on localhost. Both should
  // stay disabled unless someone serves the proxy over HTTPS publicly
  // (which is also not a supported deployment — see README).
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // API routes
  app.use('/api/keys', keysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/logs', logsRouter);

  // OpenAI-compatible proxy
  app.use('/v1', proxyRouter);

  // Health check
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler)
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
