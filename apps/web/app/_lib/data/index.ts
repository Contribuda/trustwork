import * as adapter from './fixture-adapter';
import { DATA_SOURCE } from './fixtures';

/**
 * The single data boundary of apps/web. Pages import `data` and `DATA_SOURCE` from here only.
 * BE-001 swaps `./fixture-adapter` for an HTTP adapter against `/v1/*` without touching pages.
 */
export const data = adapter;
export { DATA_SOURCE };
export type * from './types';
