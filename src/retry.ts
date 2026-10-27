export interface RetryPolicy {
  /** Total attempts including the first one. `1` means no retries. */
  readonly maxAttempts: number;
  /** Delay before the first retry; doubles after each failed attempt. */
  readonly baseDelayMs: number;
  /** Upper bound for the delay. */
  readonly maxDelayMs: number;
  /**
   * `'full'`: wait a random time between 0 and the exponential delay
   * ("full jitter"), so many tasks failing together do not retry in lockstep.
   * `'none'`: wait exactly the exponential delay.
   */
  readonly jitter: 'full' | 'none';
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitter: 'full',
};

export function resolveRetry(input: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy = { ...DEFAULT_RETRY, ...input };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('retry.maxAttempts must be an integer >= 1');
  }
  if (!(policy.baseDelayMs >= 0) || !(policy.maxDelayMs >= policy.baseDelayMs)) {
    throw new RangeError('retry delays must satisfy 0 <= baseDelayMs <= maxDelayMs');
  }
  return policy;
}

/**
 * Delay before the retry that follows failed attempt number `attempt` (1-based):
 * `min(maxDelayMs, baseDelayMs * 2^(attempt - 1))`, optionally jittered.
 */
export function backoffDelay(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return policy.jitter === 'full' ? Math.floor(random() * exponential) : exponential;
}
