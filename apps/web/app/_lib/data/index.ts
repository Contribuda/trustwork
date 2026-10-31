import { fixtureDataPort } from './fixture-adapter';
import type { DataPort, DataSource } from './port';

/**
 * The single data boundary of apps/web. Pages, layouts and route handlers import `data` (typed as the
 * `DataPort` in `./port`) and the view-model types from here, never an adapter module. Every method is
 * asynchronous; public entities are addressed by handle and workspace objects by id.
 *
 * Today the only adapter reads synthetic fixtures (`./fixture-adapter`). WEB-004 adds the HTTP adapter for
 * the implemented `/v1/*` endpoints under `./http` and selects it here; no page changes are needed for that.
 */
export const data: DataPort = fixtureDataPort;

/** `fixtures` shows the demo banner; the API adapter reports `api`. */
export const DATA_SOURCE: DataSource = data.source;

export type * from './types';
export type * from './port';
