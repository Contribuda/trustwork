import { checkFuzzyThreshold, FuzzyThresholdError } from '../../../../packages/compliance/src/matching/index.js';

/**
 * Worker settings of the screening engine (SANC-003). Hub settings inside engine bounds; until the hub configuration
 * store carries them (HUB-001), they come from the environment.
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `SCREENING_FUZZY_THRESHOLD` | off | Jaro-Winkler threshold of the fuzzy layer, 0.85 to 0.99; only adds possible matches. The owner has not chosen one (ADR 014 open question 3), so the engine ships with it off |
 * | `SCREENING_VESSELS_AND_AIRCRAFT` | off (`0`) | `1` also compares companies with vessel and aircraft entries |
 * | `SCREENING_SWEEP_BATCH` | 500 | Subjects enqueued per run of the nightly names-digest sweep |
 */
export interface ScreeningConfig {
  readonly fuzzyThreshold: number | null;
  readonly vesselsAndAircraft: boolean;
  readonly sweepBatch: number;
}

export class ScreeningConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreeningConfigError';
  }
}

export const DEFAULT_SCREENING_CONFIG: ScreeningConfig = { fuzzyThreshold: null, vesselsAndAircraft: false, sweepBatch: 500 };

export function screeningConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ScreeningConfig {
  const rawFuzzy = env.SCREENING_FUZZY_THRESHOLD?.trim();
  let fuzzyThreshold: number | null = null;
  if (rawFuzzy && rawFuzzy !== 'off') {
    try {
      fuzzyThreshold = checkFuzzyThreshold(Number(rawFuzzy));
    } catch (error) {
      if (error instanceof FuzzyThresholdError) throw new ScreeningConfigError(`SCREENING_FUZZY_THRESHOLD: ${error.message}`);
      throw error;
    }
  }
  const rawVessels = env.SCREENING_VESSELS_AND_AIRCRAFT?.trim() ?? '0';
  if (rawVessels !== '0' && rawVessels !== '1') throw new ScreeningConfigError('SCREENING_VESSELS_AND_AIRCRAFT must be 0 or 1');
  const rawBatch = env.SCREENING_SWEEP_BATCH?.trim();
  const sweepBatch = rawBatch ? Number(rawBatch) : DEFAULT_SCREENING_CONFIG.sweepBatch;
  if (!Number.isInteger(sweepBatch) || sweepBatch < 1 || sweepBatch > 1000) throw new ScreeningConfigError('SCREENING_SWEEP_BATCH must be an integer between 1 and 1000');
  return { fuzzyThreshold, vesselsAndAircraft: rawVessels === '1', sweepBatch };
}
