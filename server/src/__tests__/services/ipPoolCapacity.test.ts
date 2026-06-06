import { describe, it, expect, beforeEach } from 'vitest';
import {
  allocateIp,
  releaseIp,
  hasIpCapacity,
  getIpCapacityStatus,
  getIpCount,
  isIpCapacityEnabled,
  cleanupExpired,
  _reset,
} from '../../services/ipPoolCapacity.js';

describe('IP Pool Capacity Manager', () => {
  // Save and restore env between tests
  const originalEnv = process.env.PROXY_IP_COUNT;

  beforeEach(() => {
    _reset();
    // Default: disabled
    delete process.env.PROXY_IP_COUNT;
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.PROXY_IP_COUNT = originalEnv;
    } else {
      delete process.env.PROXY_IP_COUNT;
    }
  });

  // ── Configuration ──────────────────────────────────────────────────

  describe('getIpCount', () => {
    it('returns 0 when PROXY_IP_COUNT is unset', () => {
      delete process.env.PROXY_IP_COUNT;
      expect(getIpCount()).toBe(0);
    });

    it('returns 0 when PROXY_IP_COUNT is 0', () => {
      process.env.PROXY_IP_COUNT = '0';
      expect(getIpCount()).toBe(0);
    });

    it('returns 0 when PROXY_IP_COUNT is invalid', () => {
      process.env.PROXY_IP_COUNT = 'abc';
      expect(getIpCount()).toBe(0);
    });

    it('returns the configured value', () => {
      process.env.PROXY_IP_COUNT = '5';
      expect(getIpCount()).toBe(5);
    });
  });

  describe('isIpCapacityEnabled', () => {
    it('returns false when unset', () => {
      delete process.env.PROXY_IP_COUNT;
      expect(isIpCapacityEnabled()).toBe(false);
    });

    it('returns true when set to positive integer', () => {
      process.env.PROXY_IP_COUNT = '3';
      expect(isIpCapacityEnabled()).toBe(true);
    });
  });

  // ── Allocation ─────────────────────────────────────────────────────

  describe('allocateIp', () => {
    it('returns -1 when IP capacity is disabled', () => {
      delete process.env.PROXY_IP_COUNT;
      expect(allocateIp('sess-1', 'google', 1)).toBe(-1);
    });

    it('allocates an IP when pool has space', () => {
      process.env.PROXY_IP_COUNT = '3';
      const idx = allocateIp('sess-1', 'google', 1);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    });

    it('returns -1 when pool is full (normal provider)', () => {
      process.env.PROXY_IP_COUNT = '2';
      allocateIp('sess-1', 'google', 1);
      allocateIp('sess-2', 'google', 2);
      // Both IPs occupied
      expect(allocateIp('sess-3', 'google', 3)).toBe(-1);
    });

    it('returns -1 when pool is full (longcat)', () => {
      process.env.PROXY_IP_COUNT = '2';
      allocateIp('sess-1', 'longcat', 1);
      allocateIp('sess-2', 'longcat', 1);
      expect(allocateIp('sess-3', 'longcat', 1)).toBe(-1);
    });

    it('is re-entrant: same session gets same IP on retry', () => {
      process.env.PROXY_IP_COUNT = '3';
      const first = allocateIp('sess-1', 'google', 1);
      const second = allocateIp('sess-1', 'google', 1);
      expect(first).toBe(second);
    });

    it('allocates different IPs for different sessions', () => {
      process.env.PROXY_IP_COUNT = '3';
      const ip1 = allocateIp('sess-1', 'google', 1);
      const ip2 = allocateIp('sess-2', 'google', 2);
      // With 3 IPs and 2 sessions, they should get different IPs
      // (key-based: 1%3=1, 2%3=2)
      expect(ip1).not.toBe(ip2);
    });

    it('uses key-based offset for normal providers', () => {
      process.env.PROXY_IP_COUNT = '3';
      // keyId=4 → 4%3=1, keyId=5 → 5%3=2
      const ip1 = allocateIp('sess-1', 'google', 4);
      const ip2 = allocateIp('sess-2', 'google', 5);
      expect(ip1).toBe(1);
      expect(ip2).toBe(2);
    });
  });

  // ── Release ────────────────────────────────────────────────────────

  describe('releaseIp', () => {
    it('frees the IP for reuse', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIp('sess-1', 'google', 1);
      expect(allocateIp('sess-2', 'google', 2)).toBe(-1); // full

      releaseIp('sess-1');
      // Now there should be space
      const idx = allocateIp('sess-2', 'google', 2);
      expect(idx).toBeGreaterThanOrEqual(0);
    });

    it('is a no-op when session has no allocation', () => {
      process.env.PROXY_IP_COUNT = '3';
      expect(() => releaseIp('nonexistent')).not.toThrow();
    });

    it('re-entrant release is safe', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIp('sess-1', 'google', 1);
      releaseIp('sess-1');
      releaseIp('sess-1'); // second release should not throw
      expect(true).toBe(true);
    });
  });

  // ── Capacity Queries ───────────────────────────────────────────────

  describe('hasIpCapacity', () => {
    it('returns true when IP capacity is disabled', () => {
      delete process.env.PROXY_IP_COUNT;
      expect(hasIpCapacity('google', 1)).toBe(true);
    });

    it('returns true when pool has space', () => {
      process.env.PROXY_IP_COUNT = '3';
      expect(hasIpCapacity('google', 1)).toBe(true);
    });

    it('returns false when pool is full for normal provider', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIp('sess-1', 'google', 1);
      // keyId=2 → 2%1=0, same IP, should be full
      expect(hasIpCapacity('google', 2)).toBe(false);
    });

    it('returns false when pool is full for longcat', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIp('sess-1', 'longcat', 1);
      expect(hasIpCapacity('longcat', 1)).toBe(false);
    });

    it('returns true when pool has space for longcat', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIp('sess-1', 'longcat', 1);
      expect(hasIpCapacity('longcat', 1)).toBe(true);
    });
  });

  describe('getIpCapacityStatus', () => {
    it('returns { used: 0, max: 0 } when disabled', () => {
      delete process.env.PROXY_IP_COUNT;
      expect(getIpCapacityStatus('google')).toEqual({ used: 0, max: 0 });
    });

    it('tracks used count per platform', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIp('sess-1', 'google', 1);
      allocateIp('sess-2', 'google', 2);

      const googleStatus = getIpCapacityStatus('google');
      expect(googleStatus.used).toBe(2);
      expect(googleStatus.max).toBe(3);

      const longcatStatus = getIpCapacityStatus('longcat');
      expect(longcatStatus.used).toBe(0);
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────────

  describe('cleanupExpired', () => {
    it('removes expired allocations', () => {
      process.env.PROXY_IP_COUNT = '2';
      // Allocate with very short TTL
      allocateIp('sess-1', 'google', 1, 1); // 1ms TTL
      allocateIp('sess-2', 'google', 2, 1);

      // Wait for expiry
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          cleanupExpired();

          // Both should be freed now
          expect(hasIpCapacity('google', 1)).toBe(true);
          resolve();
        }, 10);
      });
    });

    it('does not remove active allocations', () => {
      process.env.PROXY_IP_COUNT = '2';
      allocateIp('sess-1', 'google', 1, 60_000); // 60s TTL

      cleanupExpired();
      const status = getIpCapacityStatus('google');
      expect(status.used).toBe(1);
    });
  });

  // ── LongCat special handling ───────────────────────────────────────

  describe('LongCat mode', () => {
    it('enforces 1 session per IP', () => {
      process.env.PROXY_IP_COUNT = '2';
      const ip1 = allocateIp('lc-sess-1', 'longcat', 1);
      const ip2 = allocateIp('lc-sess-2', 'longcat', 1);
      expect(ip1).not.toBe(ip2);
      expect(ip1).toBeGreaterThanOrEqual(0);
      expect(ip2).toBeGreaterThanOrEqual(0);

      // Third session should fail
      expect(allocateIp('lc-sess-3', 'longcat', 1)).toBe(-1);
    });

    it('releases IP on completion allowing reuse', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIp('lc-sess-1', 'longcat', 1);
      expect(allocateIp('lc-sess-2', 'longcat', 1)).toBe(-1);

      releaseIp('lc-sess-1');
      const ip = allocateIp('lc-sess-2', 'longcat', 1);
      expect(ip).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles rapid allocate/release cycles', () => {
      process.env.PROXY_IP_COUNT = '1';
      for (let i = 0; i < 100; i++) {
        allocateIp(`sess-${i}`, 'google', i + 1);
        releaseIp(`sess-${i}`);
      }
      expect(hasIpCapacity('google', 1)).toBe(true);
    });

    it('handles many different platforms independently', () => {
      process.env.PROXY_IP_COUNT = '2';
      allocateIp('sess-g', 'google', 1);
      allocateIp('sess-gr', 'groq', 2);

      // Both platforms share the same IP pool but are tracked separately in status
      const googleStatus = getIpCapacityStatus('google');
      const groqStatus = getIpCapacityStatus('groq');
      expect(googleStatus.used).toBe(1);
      expect(groqStatus.used).toBe(1);
    });
  });
});
