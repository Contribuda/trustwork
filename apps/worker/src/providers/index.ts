import type { DataPool } from '@trustwork/data';
import { providerSweeps } from '../../../../packages/data/src/repositories/providers.js';
import type { Metrics } from '../metrics.js';
import type { ScheduledTask } from '../scheduler.js';

/**
 * Providers in the worker (KEYS-001): rotated secret versions whose grace period ended are destroyed (their ciphertext
 * deleted; the reference stays as `destroyed` with a change-log row). The worker never decrypts anything and holds no
 * key-encryption key; it only calls `providers_destroy_expired_secrets`.
 */
export const PROVIDERS_SECRET_SWEEP_TASK = 'providers.secrets_destroy';
export const PROVIDERS_METRICS = {
  destroyed: ['trustwork_provider_secrets_destroyed_total', 'Rotated provider secret versions destroyed after their grace period.'],
} as const;

export interface ProvidersRuntime { pool: DataPool; metrics: Metrics }

export function providersSecretSweepTask(runtime: ProvidersRuntime, intervalSeconds = 600): ScheduledTask {
  return {
    name: PROVIDERS_SECRET_SWEEP_TASK,
    intervalSeconds,
    run: async () => {
      const destroyed = await providerSweeps.destroyExpiredSecrets(runtime.pool, 200);
      if (destroyed > 0) runtime.metrics.inc(...PROVIDERS_METRICS.destroyed, {}, destroyed);
      return { destroyed };
    },
  };
}
