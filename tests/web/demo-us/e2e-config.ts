/**
 * The default country of the main browser-test server (apps/web/playwright.config.ts): the hosted preview's `US` unless
 * `TRUSTWORK_E2E_DEFAULT_COUNTRY` names another one. DEMO-US acceptance runs the suite with `US` and with `UZ`.
 */
export const E2E_DEFAULT_COUNTRY = (process.env.TRUSTWORK_E2E_DEFAULT_COUNTRY ?? 'US').trim().toUpperCase();
