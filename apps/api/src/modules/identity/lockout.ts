import type { ApiConfig } from '../../config.js';

/**
 * H03 lockout without a permanent disable (architecture audit B7). Failed password proofs are counted per account
 * and per client IP inside the window (database clock). From `accountThreshold` failures on, every further attempt
 * on the account waits a delay that doubles with each failure, capped at the window; throttled attempts are not
 * counted, so an attacker can never push an account into a disabled state, only slow attempts down. The owner is
 * notified when the threshold is first reached, and a successful sign-in, step-up or recovery clears the counter.
 * The IP limit stays a plain threshold for the window. The base delay is the integrator default until the owner
 * decides H03.
 */
export const BASE_DELAY_SECONDS = 30;

export interface LockoutPolicy {
  windowSeconds: number;
  accountThreshold: number;
  ipThreshold: number;
  retentionSeconds: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
}

export function lockoutPolicy(config: ApiConfig['lockout']): LockoutPolicy {
  return {
    windowSeconds: config.windowSeconds,
    accountThreshold: config.accountThreshold,
    ipThreshold: config.ipThreshold,
    retentionSeconds: config.retentionSeconds,
    baseDelaySeconds: BASE_DELAY_SECONDS,
    maxDelaySeconds: config.windowSeconds,
  };
}

/** Required delay after `failures` failures inside the window (0 below the threshold). */
export function accountDelaySeconds(failures: number, policy: LockoutPolicy): number {
  if (failures < policy.accountThreshold) return 0;
  const exponent = Math.min(failures - policy.accountThreshold, 30);
  return Math.min(policy.maxDelaySeconds, policy.baseDelaySeconds * 2 ** exponent);
}

/** Seconds the caller still has to wait (0: an attempt may be verified now). */
export function remainingWaitSeconds(account: { failures: number; secondsSinceLast: number }, ip: { failures: number }, policy: LockoutPolicy): number {
  const accountWait = Math.max(0, Math.ceil(accountDelaySeconds(account.failures, policy) - account.secondsSinceLast));
  const ipWait = ip.failures >= policy.ipThreshold ? policy.windowSeconds : 0;
  return Math.max(accountWait, ipWait);
}
