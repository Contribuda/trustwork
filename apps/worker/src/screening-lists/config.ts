import { join } from 'node:path';

/**
 * Worker settings of the screening lists module (SANC-002):
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `SCREENING_LISTS_DIR` | `<TRUSTWORK_DATA_DIR>/screening-lists` | Where `file` mode reads official exports (`<code>.xml`; a hub's list under `<hub id>/`) |
 * | `SCREENING_LIST_MAX_BYTES` | 268435456 (256 MiB) | Larger exports are refused before parsing |
 * | `NODE_ENV` | | `production` refuses the `fake` mode |
 */
export interface ScreeningListsConfig {
  readonly listsDir: string | null;
  readonly maxExportBytes: number;
  readonly production: boolean;
}

export class ScreeningListsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreeningListsConfigError';
  }
}

export function screeningListsConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ScreeningListsConfig {
  const dataDir = env.TRUSTWORK_DATA_DIR?.trim();
  const listsDir = env.SCREENING_LISTS_DIR?.trim() || (dataDir ? join(dataDir, 'screening-lists') : null);
  const rawMax = env.SCREENING_LIST_MAX_BYTES?.trim();
  const maxExportBytes = rawMax ? Number(rawMax) : 256 * 1024 * 1024;
  if (!Number.isInteger(maxExportBytes) || maxExportBytes < 1024 * 1024 || maxExportBytes > 1024 * 1024 * 1024) throw new ScreeningListsConfigError('SCREENING_LIST_MAX_BYTES must be an integer between 1 MiB and 1 GiB');
  return { listsDir, maxExportBytes, production: env.NODE_ENV === 'production' };
}
