import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, backoffDelay, resolveRetry } from '../src/retry.js';

describe('retry policy', () => {
  it('defaults to a single attempt', () => {
    expect(resolveRetry()).toEqual(DEFAULT_RETRY);
    expect(resolveRetry().maxAttempts).toBe(1);
  });

  it('doubles the delay and caps it', () => {
    const policy = resolveRetry({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 'none' });
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(policy, n))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });

  it('full jitter scales the delay by a random factor', () => {
    const policy = resolveRetry({ baseDelayMs: 1000 });
    expect(backoffDelay(policy, 1, () => 0)).toBe(0);
    expect(backoffDelay(policy, 2, () => 0.25)).toBe(500);
  });

  it('rejects invalid policies', () => {
    expect(() => resolveRetry({ maxAttempts: 0 })).toThrow('maxAttempts');
    expect(() => resolveRetry({ maxAttempts: 1.5 })).toThrow('maxAttempts');
    expect(() => resolveRetry({ baseDelayMs: -1 })).toThrow('delays');
    expect(() => resolveRetry({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow('delays');
  });

  it('property: delay is always within [0, maxDelayMs]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        fc.constantFrom('full' as const, 'none' as const),
        (base, extra, attempt, r, jitter) => {
          const policy = resolveRetry({ baseDelayMs: base, maxDelayMs: base + extra, jitter });
          const delay = backoffDelay(policy, attempt, () => r);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(policy.maxDelayMs);
        },
      ),
    );
  });
});
