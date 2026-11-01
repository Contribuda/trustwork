import type { ActivationPreview } from './schemas.js';

/** Helpers shared by the HUBC-005 fixtures: a deterministic placeholder digest and a stored preview with its fixture time. */
export const digest = (seed: string) => ({ algorithm: 'trustwork-digest-1' as const, value: seed.repeat(64 / seed.length) });

export function preview(id: string, seed: string, rest: Omit<ActivationPreview, 'id' | 'digest' | 'computedAt' | 'synthetic'>, computedAt = '2026-10-30T15:00:00Z'): ActivationPreview {
  return { id, digest: digest(seed), computedAt, synthetic: true, ...rest };
}
