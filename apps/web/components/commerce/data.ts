import { demoModeEnabled } from '@/app/_lib/persona';
import { demoCommercePort } from './demo';
import { httpCommercePort } from './http';
import type { CommercePort } from './port';

/**
 * The commerce data boundary of the workspace pages (WEB-002), chosen once per server process like the app's `data`:
 * `TRUSTWORK_DEMO_MODE=1` serves the synthetic demo projections, otherwise the live `/v1/*` API. Pages import
 * `commerce` from here and never an adapter. Server only.
 */
export const commerce: CommercePort = demoModeEnabled() ? demoCommercePort : httpCommercePort;
export const COMMERCE_DEMO = commerce.source === 'fixtures';
export type * from './port';
