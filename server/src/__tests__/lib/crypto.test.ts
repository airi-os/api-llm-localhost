import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../../db/index.js';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';

describe('Crypto', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('should encrypt and decrypt a key round-trip', () => {
    const original = 'gsk_test1234567890abcdef';
    const { encrypted, iv, authTag } = encrypt(original);
    const decrypted = decrypt(encrypted, iv, authTag);
    expect(decrypted).toBe(original);
  });

  it('should produce different ciphertext for same input (random IV)', () => {
    const original = 'same-key';
    const encrypted1 = encrypt(original);
    const encrypted2 = encrypt(original);
    expect(encrypted1.encrypted).not.toBe(encrypted2.encrypted);
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
  });

  it('should fail to decrypt with wrong auth tag', () => {
    const { encrypted, iv } = encrypt('test-key');
    expect(() => decrypt(encrypted, iv, 'a'.repeat(32))).toThrow();
  });

  describe('maskKey', () => {
    it('should mask long keys', () => {
      expect(maskKey('gsk_test1234567890abcdef')).toBe('gsk_...cdef');
    });

    it('should mask short keys', () => {
      expect(maskKey('abcd')).toBe('****abcd');
    });
  });
});
