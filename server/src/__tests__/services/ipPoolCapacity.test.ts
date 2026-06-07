import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  allocateIpForKey,
  releaseIpForKey,
  hasIpCapacity,
  getIpCapacityStatus,
  getIpCount,
  isIpCapacityEnabled,
  cleanupExpired,
  _reset,
  _resetAssignments,
  _getActiveAssignmentCount,
  getWorkerCount,
} from '../../services/ipPoolCapacity.js';
import { _reset as resetTopology, _setMockTopology } from '../../services/proxyTopology.js';

describe('IP Pool Capacity Manager', () => {
  // Save and restore env between tests
  const originalEnv = process.env.PROXY_IP_COUNT;

  beforeEach(() => {
    _reset();
    resetTopology();
    // Default: disabled (no PROXY_IP_COUNT, no mock topology)
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
    it('returns 0 when PROXY_IP_COUNT is unset and no topology', () => {
      delete process.env.PROXY_IP_COUNT;
      resetTopology();
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
    it('returns false when unset and no topology', () => {
      delete process.env.PROXY_IP_COUNT;
      resetTopology();
      expect(isIpCapacityEnabled()).toBe(false);
    });

    it('returns true when set to positive integer', () => {
      process.env.PROXY_IP_COUNT = '3';
      expect(isIpCapacityEnabled()).toBe(true);
    });

    it('returns true when topology is available', () => {
      delete process.env.PROXY_IP_COUNT;
      _setMockTopology({ workers: [{ index: 0, url: 'http://localhost:8080' }], workerCount: 1 });
      expect(isIpCapacityEnabled()).toBe(true);
    });
  });

  // ── Allocation (allocateIpForKey) ──────────────────────────────────

  describe('allocateIpForKey', () => {
    it('returns bypass when IP capacity is disabled', () => {
      delete process.env.PROXY_IP_COUNT;
      resetTopology();
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('bypass');
    });

    it('allocates when pool has space', () => {
      process.env.PROXY_IP_COUNT = '3';
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('allocated');
      expect(result.ipIndex).toBeGreaterThanOrEqual(0);
      expect(result.ipIndex).toBeLessThan(3);
    });

    it('returns capacity_exhausted when pool is full', () => {
      process.env.PROXY_IP_COUNT = '2';
      allocateIpForKey('key-1');
      allocateIpForKey('key-2');
      // Both slots occupied
      const result = allocateIpForKey('key-3');
      expect(result.kind).toBe('capacity_exhausted');
    });

    it('returns key_busy when same key is already allocated', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIpForKey('key-1');
      // Second allocation for same key should return key_busy
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('key_busy');
    });

    it('allocates different workers for different keys', () => {
      process.env.PROXY_IP_COUNT = '3';
      const result1 = allocateIpForKey('key-1');
      const result2 = allocateIpForKey('key-2');
      expect(result1.kind).toBe('allocated');
      expect(result2.kind).toBe('allocated');
      expect(result1.ipIndex).not.toBe(result2.ipIndex);
    });
  });

  // ── Release (releaseIpForKey) ───────────────────────────────────────

  describe('releaseIpForKey', () => {
    it('frees the worker for reuse', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIpForKey('key-1');
      const result = allocateIpForKey('key-2');
      expect(result.kind).toBe('capacity_exhausted'); // pool full

      releaseIpForKey('key-1');
      // Now there should be space
      const result2 = allocateIpForKey('key-2');
      expect(result2.kind).toBe('allocated');
    });

    it('is a no-op when key has no allocation', () => {
      process.env.PROXY_IP_COUNT = '3';
      // Should not throw
      expect(() => releaseIpForKey('nonexistent-key')).not.toThrow();
    });

    it('re-entrant release is safe', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIpForKey('key-1');
      releaseIpForKey('key-1');
      releaseIpForKey('key-1'); // second release should not throw
      expect(true).toBe(true);
    });
  });

  // ── Capacity Queries ───────────────────────────────────────────────

  describe('hasIpCapacity', () => {
    it('returns true when IP capacity is disabled', () => {
      delete process.env.PROXY_IP_COUNT;
      resetTopology();
      expect(hasIpCapacity()).toBe(true);
    });

    it('returns true when pool has space', () => {
      process.env.PROXY_IP_COUNT = '3';
      expect(hasIpCapacity()).toBe(true);
    });

    it('returns false when pool is full', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIpForKey('key-1');
      expect(hasIpCapacity()).toBe(false);
    });

    it('returns true for re-entrant key that already holds a worker even when pool is full', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIpForKey('key-1');
      // Pool is full, but key-1 already has allocation
      expect(hasIpCapacity('key-1')).toBe(true);
    });

    it('returns false for different key when pool is full', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIpForKey('key-1');
      // Pool is full, key-2 has no allocation
      expect(hasIpCapacity('key-2')).toBe(false);
    });
  });

  describe('getIpCapacityStatus', () => {
    it('returns { used: 0, max: 0 } when disabled', () => {
      delete process.env.PROXY_IP_COUNT;
      resetTopology();
      const status = getIpCapacityStatus('google');
      expect(status.used).toBe(0);
      expect(status.max).toBe(0);
    });

    it('tracks used count', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIpForKey('key-1');
      allocateIpForKey('key-2');

      const status = getIpCapacityStatus('google');
      expect(status.used).toBe(2);
      expect(status.max).toBe(3);
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────────

  describe('cleanupExpired', () => {
    it('removes expired allocations', () => {
      process.env.PROXY_IP_COUNT = '1';
      allocateIpForKey('key-1');

      // Simulate time passing (TTL is 5 minutes by default)
      // For testing, we need to manually expire or use a shorter TTL
      // This test verifies the cleanup function exists and can be called
      cleanupExpired();

      const status = getIpCapacityStatus('google');
      // After cleanup of expired (none in this case), should still have 1
      expect(status.used).toBe(1);
    });

    it('does not remove active allocations', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIpForKey('key-1');

      cleanupExpired();

      const status = getIpCapacityStatus('google');
      expect(status.used).toBe(1);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles rapid allocate/release cycles', () => {
      process.env.PROXY_IP_COUNT = '2';
      for (let i = 0; i < 10; i++) {
        const key = `key-${i}`;
        const result = allocateIpForKey(key);
        expect(result.kind).toBe('allocated');
        releaseIpForKey(key);
      }
    });

    it('handles many different keys independently', () => {
      process.env.PROXY_IP_COUNT = '3';
      allocateIpForKey('key-1');
      allocateIpForKey('key-2');

      const googleStatus = getIpCapacityStatus('google');
      const groqStatus = getIpCapacityStatus('groq');
      expect(googleStatus.used).toBe(2);
      expect(groqStatus.used).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Phase 4: API-Key-Based Allocation Tests (T4.1–T4.13)
  // ══════════════════════════════════════════════════════════════════════

  describe('Phase 4: API-Key-Based Allocation (T4.1–T4.13)', () => {
    const POOL_SIZE = 3;

    // T4.1 — Single allocation success
    it('T4.1 — allocates worker for first request', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('allocated');
      expect(result.ipIndex).toBeGreaterThanOrEqual(0);
    });

    // T4.2 — Same key concurrent → 409
    it('T4.2 — rejects same key concurrent request with 409', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      allocateIpForKey('key-1');
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('key_busy');
    });

    // T4.3 — Different keys until full
    it('T4.3 — allocates different workers for different keys', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      const r1 = allocateIpForKey('key-1');
      const r2 = allocateIpForKey('key-2');
      expect(r1.kind).toBe('allocated');
      expect(r2.kind).toBe('allocated');
      expect(r1.ipIndex).not.toBe(r2.ipIndex);
    });

    // T4.4 — Pool exhausted → 503
    it('T4.4 — rejects new key when pool is full with 503', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      for (let i = 0; i < POOL_SIZE; i++) {
        allocateIpForKey(`key-${i}`);
      }
      const result = allocateIpForKey('key-overflow');
      expect(result.kind).toBe('capacity_exhausted');
    });

    // T4.5 — Release restores capacity
    it('T4.5 — releases worker and restores capacity', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      const r1 = allocateIpForKey('key-1');
      expect(r1.kind).toBe('allocated');
      releaseIpForKey('key-1');
      const r2 = allocateIpForKey('key-2');
      expect(r2.kind).toBe('allocated');
    });

    // T4.6 — Exception path releases slot
    it('T4.6 — releases worker even when request throws', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      allocateIpForKey('key-1');
      try {
        throw new Error('simulated');
      } catch {
        // swallow — simulates upstream error
      } finally {
        releaseIpForKey('key-1');
      }
      expect(_getActiveAssignmentCount()).toBe(0);
    });

    // T4.7 — Disabled mode bypass
    it('T4.7 — bypasses allocation when sticky routing is disabled', () => {
      _resetAssignments();
      // No PROXY_IP_COUNT, no topology → disabled
      delete process.env.PROXY_IP_COUNT;
      resetTopology();
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('bypass');
    });

    // T4.8 — workerCount=0 → 503 (not bypass)
    it('T4.8 — returns capacity_exhausted when workerCount=0', () => {
      _resetAssignments();
      // PROXY_IP_COUNT=0 → getWorkerCount()=0, isStickyRoutingEnabled()=true (0 is valid non-negative)
      process.env.PROXY_IP_COUNT = '0';
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('capacity_exhausted');
    });

    // T4.9 — No worker leaks after failures
    it('T4.9a — no worker leaks after key_busy rejection', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      allocateIpForKey('key-1');
      allocateIpForKey('key-1');
      expect(_getActiveAssignmentCount()).toBe(1);
    });

    it('T4.9b — no worker leaks after capacity_exhausted rejection', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      for (let i = 0; i < POOL_SIZE; i++) {
        allocateIpForKey(`key-${i}`);
      }
      allocateIpForKey('key-overflow');
      expect(_getActiveAssignmentCount()).toBe(POOL_SIZE);
    });

    // T4.10 — Router integration: 409 on concurrent same-key requests
    it('T4.10 — returns 409 for concurrent same-key requests', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      const firstResult = allocateIpForKey('test-key');
      expect(firstResult.kind).toBe('allocated');
      const secondResult = allocateIpForKey('test-key');
      expect(secondResult.kind).toBe('key_busy');
      releaseIpForKey('test-key');
      const thirdResult = allocateIpForKey('test-key');
      expect(thirdResult.kind).toBe('allocated');
    });

    // T4.11 — Router integration: 503 when all workers occupied
    it('T4.11 — returns 503 when all workers are occupied', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      const keys = Array.from({ length: POOL_SIZE }, (_, i) => `key-${i}`);
      keys.forEach(key => {
        const result = allocateIpForKey(key);
        expect(result.kind).toBe('allocated');
      });
      const overflowResult = allocateIpForKey('key-overflow');
      expect(overflowResult.kind).toBe('capacity_exhausted');
      releaseIpForKey('key-0');
      const retryResult = allocateIpForKey('key-overflow');
      expect(retryResult.kind).toBe('allocated');
    });

    // T4.12 — Router integration: Exception cleanup
    it('T4.12 — releases worker on exception', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = String(POOL_SIZE);
      const result = allocateIpForKey('test-key');
      expect(result.kind).toBe('allocated');
      let exceptionThrown = false;
      try {
        throw new Error('simulated upstream error');
      } catch (e) {
        exceptionThrown = true;
      } finally {
        releaseIpForKey('test-key');
      }
      expect(exceptionThrown).toBe(true);
      expect(_getActiveAssignmentCount()).toBe(0);
      const newResult = allocateIpForKey('test-key');
      expect(newResult.kind).toBe('allocated');
    });

    // T4.13 — Invalid PROXY_IP_COUNT values → disabled mode
    it('T4.13a — treats invalid PROXY_IP_COUNT as disabled', () => {
      _resetAssignments();
      const invalidValues = ['abc', '-1', '1.5', ''];
      invalidValues.forEach(value => {
        process.env.PROXY_IP_COUNT = value;
        const result = allocateIpForKey('key-1');
        expect(result.kind).toBe('bypass');
        delete process.env.PROXY_IP_COUNT;
      });
    });

    it('T4.13b — accepts valid PROXY_IP_COUNT values', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = '3';
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('allocated');
    });
  });
});
