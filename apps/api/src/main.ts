import { createApp } from './app.js';
import { ConfigError } from './config.js';
import { createLogger } from './observability/logger.js';

/**
 * Process entry: `GET /health`, `/health/live` and `/health/ready` always; `/v1/auth/*`, `/v1/me/*`,
 * `/v1/people/:id`, `/v1/companies/*` and `/v1/projects/*` when `API_DATABASE_URL` (or `DATABASE_URL`) points at a
 * restricted runtime role. Nothing is read from `.env` implicitly; see `.env.example` and
 * apps/api/src/modules/identity/README.md for the variables. Every line on stdout is one JSON object; an invalid
 * configuration (for example production without AUTH_FLOW_SECRET, an http PUBLIC_ORIGIN or insecure cookies) is
 * reported as one `config.invalid` line naming the variables (never their values) and the process exits with 78.
 */
const boot = createLogger({ level: 'info' });
try {
  const created = await createApp();
  if (!created.ctx) created.logger.warn('server.no_database', { message: 'no API_DATABASE_URL/DATABASE_URL: serving health routes only' });
  await created.app.listen(created.config.port, created.config.host);
  created.logger.info('server.listening', {
    port: created.config.port,
    production: created.config.production,
    providers: created.config.providers.mode,
    telemetry: created.telemetry.enabled ? 'otlp' : 'off',
  });
} catch (error) {
  if (error instanceof ConfigError) {
    boot.error('config.invalid', { issues: error.issues });
    process.exit(78); // EX_CONFIG
  }
  boot.error('server.start_failed', { err: error });
  process.exit(1);
}
