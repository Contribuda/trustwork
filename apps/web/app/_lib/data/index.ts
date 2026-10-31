import * as adapter from './fixture-adapter';
import { DATA_SOURCE } from './fixtures';

/**
 * The single data boundary of apps/web. Pages import `data` and `DATA_SOURCE` from here only.
 * Today every function is synchronous and reads synthetic fixtures; pages address entities by slug. The live API
 * cannot be swapped in without touching pages: WEB-006 makes the boundary asynchronous and keyed by handle, and
 * WEB-004 adds the HTTP adapter against `/v1/*` (BE-001 implemented the API, not this swap).
 */
export const data = adapter;
export { DATA_SOURCE };
export type * from './types';
