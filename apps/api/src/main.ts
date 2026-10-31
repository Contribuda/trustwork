import { createApp } from './app.js';

/**
 * Process entry: `GET /health` always; `/v1/auth/*`, `/v1/me/*`, `/v1/people/:id`, `/v1/companies/*` and
 * `/v1/projects/*` when `API_DATABASE_URL` (or `DATABASE_URL`) points at a restricted runtime role.
 * Nothing is read from `.env` implicitly; see apps/api/src/modules/identity/README.md for the variables.
 */
const created = await createApp();
if (!created.ctx) console.warn('[trustwork-api] no API_DATABASE_URL/DATABASE_URL: serving /health only');
await created.app.listen(created.config.port, created.config.host);
