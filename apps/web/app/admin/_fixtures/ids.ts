/** Stable identifiers and the fixture clock of the console demo (ADM-002). Synthetic: nothing here names a real node or hub. */
export const NODE_ID = 'node-demo-1';
export const HUB_US_ID = 'hub-us-demo';
export const HUB_SAMARKAND_ID = 'hub-samarkand-example';

/**
 * The fixture clock. Fixture states that depend on time (expired approvals, elevated sessions, gate age) are computed
 * against this instant, so the demo renders the same on every day; the live adapter uses the server clock.
 */
export const FIXTURE_NOW = '2026-10-31T12:00:00Z';
