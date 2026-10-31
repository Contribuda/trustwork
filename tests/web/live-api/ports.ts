/**
 * Loopback ports of the live API browser suite (WEB-004). Fixed defaults so the Playwright main process and its
 * workers agree (the config is evaluated in each), overridable when they are taken. The web build must be made with
 * `TRUSTWORK_API_ORIGIN=http://127.0.0.1:<api port>` so its same-origin `/v1/*` rewrite reaches this API.
 */
export const WEB_PORT = Number(process.env.TRUSTWORK_LIVE_WEB_PORT ?? 3470);
export const API_PORT = Number(process.env.TRUSTWORK_LIVE_API_PORT ?? 3471);
export const CONTROL_PORT = Number(process.env.TRUSTWORK_LIVE_CONTROL_PORT ?? 4472);
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
export const CONTROL_ORIGIN = `http://127.0.0.1:${CONTROL_PORT}`;
