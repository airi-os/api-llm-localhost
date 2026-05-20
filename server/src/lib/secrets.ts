import crypto from 'crypto';

export function timingSafeStringEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  const compareBuffer = providedBuffer.length === expectedBuffer.length
    ? providedBuffer
    : Buffer.alloc(expectedBuffer.length);

  return crypto.timingSafeEqual(compareBuffer, expectedBuffer)
    && providedBuffer.length === expectedBuffer.length;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}
