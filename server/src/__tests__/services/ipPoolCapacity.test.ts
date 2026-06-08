import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  allocateIpForKey,
  releaseIpForKey,
  hasIpCapacity,
  getIpCapacityStatus,
  isIpCapacityEnabled,
  cleanupExpired,
  _reset,
  _resetAssignments,
  _getActiveAssignmentCount,
  getWorkerCount,
} from '../../services/ipPoolCapacity.js';
import { _reset as resetTopology, _setMockTopology } from '../../services/proxyTopology.js';

describe('IP Pool Capacity Manager', () => {
  beforeEach(() => {
    _reset();
    resetTopology();
  });

  // ── Configuration ──────────────────────────────────────────────────

  describe('getWorkerCount', () => {
    it('returns 0 when no topology is available', () => {
      resetTopology();
      expect(getWorkerCount()).toBe(0);
    });

    it('returns the topology worker count when available', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 5,
        proxies: [],
      });
      expect(getWorkerCount()).toBe(5);
    });

    it('returns 0 when topology has 0 workers', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 0,
        proxies: [],
      });
      expect(getWorkerCount()).toBe(0);
    });
  });

  describe('isIpCapacityEnabled', () => {
    it('returns false when no topology is available', () => {
      resetTopology();
      expect(isIpCapacityEnabled()).toBe(false);
    });

    it('returns true when topology reports workers', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      expect(isIpCapacityEnabled()).toBe(true);
    });

    it('returns false when topology has 0 workers', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 0,
        proxies: [],
      });
      expect(isIpCapacityEnabled()).toBe(false);
    });
  });

  // ── Allocation (allocateIpForKey) ──────────────────────────────────

  describe('allocateIpForKey', () => {
    it('returns bypass when topology is unavailable', () => {
      resetTopology();
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('bypass');
    });

    it('allocates when pool has space', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('allocated');
      if (result.kind === 'allocated') {
        expect(result.ipIndex).toBeGreaterThanOrEqual(0);
        expect(result.ipIndex).toBeLessThan(3);
      }
    });

    it('returns capacity_exhausted when pool is full', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 2,
        proxies: [],
      });
      allocateIpForKey('key-1');
      allocateIpForKey('key-2');
      // Both slots occupied
      const result = allocateIpForKey('key-3');
      expect(result.kind).toBe('capacity_exhausted');
    });

    it('returns key_busy when same key is already allocated', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      allocateIpForKey('key-1');
      // Second allocation for same key should return key_busy
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('key_busy');
    });

    it('allocates different workers for different keys', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      const result1 = allocateIpForKey('key-1');
      const result2 = allocateIpForKey('key-2');
      expect(result1.kind).toBe('allocated');
      expect(result2.kind).toBe('allocated');
      if (result1.kind === 'allocated' && result2.kind === 'allocated') {
        expect(result1.ipIndex).not.toBe(result2.ipIndex);
      }
    });
  });

  // ── Release (releaseIpForKey) ───────────────────────────────────────

  describe('releaseIpForKey', () => {
    it('frees the worker for reuse', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 1,
        proxies: [],
      });
      allocateIpForKey('key-1');
      const result = allocateIpForKey('key-2');
      expect(result.kind).toBe('capacity_exhausted'); // pool full

      releaseIpForKey('key-1');
      // Now there should be space
      const result2 = allocateIpForKey('key-2');
      expect(result2.kind).toBe('allocated');
    });

    it('is a no-op when key has no allocation', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      // Should not throw
      expect(() => releaseIpForKey('nonexistent-key')).not.toThrow();
    });

    it('re-entrant release is safe', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      allocateIpForKey('key-1');
      releaseIpForKey('key-1');
      releaseIpForKey('key-1'); // second release should not throw
      expect(true).toBe(true);
    });
  });

  // ── Capacity Queries ───────────────────────────────────────────────

  describe('hasIpCapacity', () => {
    it('returns true when topology is unavailable', () => {
      resetTopology();
      expect(hasIpCapacity()).toBe(true);
    });

    it('returns true when pool has space', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      expect(hasIpCapacity()).toBe(true);
    });

    it('returns false when pool is full', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 1,
        proxies: [],
      });
      allocateIpForKey('key-1');
      expect(hasIpCapacity()).toBe(false);
    });

    it('returns true for re-entrant key that already holds a worker even when pool is full', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 1,
        proxies: [],
      });
      allocateIpForKey('key-1');
      // Pool is full, but key-1 already has allocation
      expect(hasIpCapacity('key-1')).toBe(true);
    });

    it('returns false for different key when pool is full', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 1,
        proxies: [],
      });
      allocateIpForKey('key-1');
      // Pool is full, key-2 has no allocation
      expect(hasIpCapacity('key-2')).toBe(false);
    });
  });

  describe('getIpCapacityStatus', () => {
    it('returns { used: 0, max: 0 } when no topology', () => {
      resetTopology();
      const status = getIpCapacityStatus('google');
      expect(status.used).toBe(0);
      expect(status.max).toBe(0);
    });

    it('tracks used count', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      allocateIpForKey('key-1');
      allocateIpForKey('key-2');

      const status = getIpCapacityStatus('google');
      expect(status.used).toBe(2);
      expect(status.max).toBe(3);
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────────

  describe('cleanupExpired', () => {
    it('is a no-op (expiration handled by releaseIpForKey)', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 1,
        proxies: [],
      });
      allocateIpForKey('key-1');

      cleanupExpired();

      const status = getIpCapacityStatus('google');
      // After cleanup of expired (none in this case), should still have 1
      expect(status.used).toBe(1);
    });

    it('does not remove active allocations', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      allocateIpForKey('key-1');

      cleanupExpired();

      const status = getIpCapacityStatus('google');
      expect(status.used).toBe(1);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles rapid allocate/release cycles', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 2,
        proxies: [],
      });
      for (let i = 0; i < 10; i++) {
        const key = `key-${i}`;
        const result = allocateIpForKey(key);
        expect(result.kind).toBe('allocated');
        releaseIpForKey(key);
      }
    });

    it('handles many different keys independently', () => {
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 3,
        proxies: [],
      });
      allocateIpForKey('key-1');
      allocateIpForKey('key-2');

      const googleStatus = getIpCapacityStatus('google');
      const groqStatus = getIpCapacityStatus('groq');
      expect(googleStatus.used).toBe(2);
      expect(groqStatus.used).toBe(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Phase 4+5: Topology-Only Worker Count Tests
  // ══════════════════════════════════════════════════════════════════════

  describe('Phase 4+5: Topology-only worker count', () => {
    const POOL_SIZE = 3;

    // Single allocation success
    it('allocates worker for first request', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('allocated');
      if (result.kind === 'allocated') {
        expect(result.ipIndex).toBeGreaterThanOrEqual(0);
      }
    });

    // Same key concurrent → key_busy
    it('rejects same key concurrent request with key_busy', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      allocateIpForKey('key-1');
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('key_busy');
    });

    // Different keys until full
    it('allocates different workers for different keys', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      const r1 = allocateIpForKey('key-1');
      const r2 = allocateIpForKey('key-2');
      expect(r1.kind).toBe('allocated');
      expect(r2.kind).toBe('allocated');
      if (r1.kind === 'allocated' && r2.kind === 'allocated') {
        expect(r1.ipIndex).not.toBe(r2.ipIndex);
      }
    });

    // Pool exhausted → capacity_exhausted
    it('rejects new key when pool is full with capacity_exhausted', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      for (let i = 0; i < POOL_SIZE; i++) {
        allocateIpForKey(`key-${i}`);
      }
      const result = allocateIpForKey('key-overflow');
      expect(result.kind).toBe('capacity_exhausted');
    });

    // Release restores capacity
    it('releases worker and restores capacity', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      const r1 = allocateIpForKey('key-1');
      expect(r1.kind).toBe('allocated');
      releaseIpForKey('key-1');
      const r2 = allocateIpForKey('key-2');
      expect(r2.kind).toBe('allocated');
    });

    // Exception path releases slot
    it('releases worker even when request throws', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
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

    // Disabled mode bypass (no topology)
    it('bypasses allocation when topology is unavailable', () => {
      _resetAssignments();
      resetTopology();
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('bypass');
    });

    // workerCount=0 → capacity_exhausted (not bypass)
    it('returns capacity_exhausted when workerCount=0', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 0,
        proxies: [],
      });
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('capacity_exhausted');
    });

    // No worker leaks after failures
    it('no worker leaks after key_busy rejection', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      allocateIpForKey('key-1');
      allocateIpForKey('key-1');
      expect(_getActiveAssignmentCount()).toBe(1);
    });

    it('no worker leaks after capacity_exhausted rejection', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      for (let i = 0; i < POOL_SIZE; i++) {
        allocateIpForKey(`key-${i}`);
      }
      allocateIpForKey('key-overflow');
      expect(_getActiveAssignmentCount()).toBe(POOL_SIZE);
    });

    // Router integration: key_busy on concurrent same-key requests
    it('returns key_busy for concurrent same-key requests', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
      const firstResult = allocateIpForKey('test-key');
      expect(firstResult.kind).toBe('allocated');
      const secondResult = allocateIpForKey('test-key');
      expect(secondResult.kind).toBe('key_busy');
      releaseIpForKey('test-key');
      const thirdResult = allocateIpForKey('test-key');
      expect(thirdResult.kind).toBe('allocated');
    });

    // Router integration: capacity_exhausted when all workers occupied
    it('returns capacity_exhausted when all workers are occupied', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
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

    // Router integration: Exception cleanup
    it('releases worker on exception', () => {
      _resetAssignments();
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: POOL_SIZE,
        proxies: [],
      });
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

    // Topology-only: no PROXY_IP_COUNT fallback
    it('ignores PROXY_IP_COUNT env var — uses topology only', () => {
      _resetAssignments();
      // Set PROXY_IP_COUNT but no topology → should bypass (not use PROXY_IP_COUNT)
      process.env.PROXY_IP_COUNT = '5';
      resetTopology();
      const result = allocateIpForKey('key-1');
      expect(result.kind).toBe('bypass');
      delete process.env.PROXY_IP_COUNT;
    });

    it('uses topology worker count even when PROXY_IP_COUNT is set', () => {
      _resetAssignments();
      process.env.PROXY_IP_COUNT = '10';
      _setMockTopology({
        schemaVersion: 1,
        topologyId: 'test',
        topologyGeneratedAt: Date.now(),
        workerCount: 2,
        proxies: [],
      });
      // Should use topology count (2), not PROXY_IP_COUNT (10)
      expect(getWorkerCount()).toBe(2);
      // Fill 2 slots
      allocateIpForKey('key-1');
      allocateIpForKey('key-2');
      // Third should be exhausted (not have 10 slots)
      const result = allocateIpForKey('key-3');
      expect(result.kind).toBe('capacity_exhausted');
      delete process.env.PROXY_IP_COUNT;
    });
  });
});
