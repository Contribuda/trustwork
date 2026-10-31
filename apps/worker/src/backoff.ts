import type { RetryPolicy } from './config.js';

/**
 * Delay before the next attempt after `attempt` failed (1-based): fixed `baseSeconds`, or `baseSeconds * 2^(attempt-1)`
 * capped at `maxDelaySeconds`, plus up to `jitter` of the delay at random. The database adds it to its own clock.
 */
export function retryDelaySeconds(policy: RetryPolicy, attempt: number, jitter = 0, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = policy.backoff === 'fixed' ? policy.baseSeconds : policy.baseSeconds * 2 ** Math.min(n - 1, 30);
  const capped = Math.min(raw, policy.maxDelaySeconds);
  const extra = jitter > 0 ? capped * Math.min(jitter, 1) * Math.min(Math.max(random(), 0), 1) : 0;
  return Math.min(capped + extra, policy.maxDelaySeconds);
}
