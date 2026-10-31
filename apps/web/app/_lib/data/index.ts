import { demoModeEnabled } from '../persona';
import { fixtureDataPort } from './fixture-adapter';
import { httpDataPort } from './http';
import type { DataPort, DataSource } from './port';

/**
 * The single data boundary of apps/web. Pages, layouts and route handlers import `data` (typed as the
 * `DataPort` in `./port`) and the view-model types from here, never an adapter module. Every method is
 * asynchronous; public entities are addressed by handle and workspace objects by id.
 *
 * The adapter is chosen once per server process (WEB-004): `TRUSTWORK_DEMO_MODE=1` serves the synthetic fixtures
 * (`./fixture-adapter`, demo deployments such as the hosted preview); otherwise the live `/v1/*` API (`./http`).
 */
export const data: DataPort = demoModeEnabled() ? fixtureDataPort : httpDataPort;

/** `fixtures` shows the demo banner; the API adapter reports `api`. */
export const DATA_SOURCE: DataSource = data.source;

export type * from './types';
export type * from './port';
