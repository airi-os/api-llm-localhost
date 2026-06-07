// Cryptographic utility functions for secret generation

import crypto from 'node:crypto';

/** Generate a 64-character hex string (32 bytes) for ENCRYPTION_KEY and INTERNAL_AUTH_SECRET */
export function generateHexSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Generate ADMIN_DASHBOARD_KEY with the standard prefix */
export function generateAdminKey(): string {
  return 'freellmapi-admin-' + crypto.randomBytes(32).toString('hex');
}

/** Generate a random AUTH_KEY (URL-safe, 16 chars) */
export function generateAuthKey(): string {
  return crypto.randomBytes(12).toString('base64url');
}
