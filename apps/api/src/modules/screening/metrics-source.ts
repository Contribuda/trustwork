import type { z } from 'zod';
import type { ScreeningMetricsSchema } from '../../../../../packages/contracts/src/sanctions.js';

type HubMetrics = z.infer<typeof ScreeningMetricsSchema>['metrics'];

/**
 * Typed unavailable adapter until owning sanctions records bind the affected subject to
 * actual immutable operation provenance. AGT-003/PR #385 is an engineering dependency;
 * a selected staff hub, membership or anonymous counter cannot provide that authority.
 * This adapter has no authority input, source enumeration, persistence or fallback value.
 */
export function unavailableScreeningHubMetrics(): HubMetrics {
  const keys: HubMetrics[number]['key'][] = ['refusals', 'openHolds', 'clearedHolds', 'medianClearSeconds', 'openedMatches', 'decidedMatches', 'lateMatches', 'notSamePersonShare', 'gateRefusals'];
  return keys.map((key) => ({
    key, state: 'unknown', value: null,
    reason: key === 'refusals' ? 'distinct_principals_missing' : key === 'gateRefusals' ? 'gate_counter_missing' : 'hub_attribution_missing',
  }));
}
