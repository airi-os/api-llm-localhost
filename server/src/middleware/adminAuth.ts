import type { NextFunction, Request, Response } from 'express';
import { extractBearerToken, timingSafeStringEqual } from '../lib/secrets.js';

const MIN_ADMIN_KEY_LENGTH = 24;

function isTestOrDev(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
}

export function getAdminApiKey(): string | null {
  const key = process.env.ADMIN_DASHBOARD_KEY?.trim();
  if (!key) return null;
  return key;
}

export function assertAdminAuthConfigured(): void {
  const key = getAdminApiKey();
  if (key && key.length >= MIN_ADMIN_KEY_LENGTH) return;
  if (isTestOrDev()) return;

  throw new Error(
    `ADMIN_DASHBOARD_KEY must be set to at least ${MIN_ADMIN_KEY_LENGTH} characters before exposing the admin API.`,
  );
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKey = getAdminApiKey();
  if (!adminKey && isTestOrDev()) {
    next();
    return;
  }

  if (!adminKey || adminKey.length < MIN_ADMIN_KEY_LENGTH) {
    res.status(503).json({
      error: {
        message: 'Admin API authentication is not configured',
        type: 'configuration_error',
      },
    });
    return;
  }

  const token = extractBearerToken(req.headers.authorization);
  if (!token || !timingSafeStringEqual(token, adminKey)) {
    res.status(401).json({
      error: {
        message: 'Invalid admin API key',
        type: 'authentication_error',
      },
    });
    return;
  }

  next();
}
