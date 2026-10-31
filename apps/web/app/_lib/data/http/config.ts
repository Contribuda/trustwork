/**
 * Server-side configuration of the live API adapter (WEB-004). Read at request time from the server environment;
 * nothing here reaches a browser bundle.
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `TRUSTWORK_DEMO_MODE` | off | `1` serves synthetic fixtures and the persona switch instead of the API (demo deployments only). |
 * | `TRUSTWORK_API_ORIGIN` | `http://127.0.0.1:3001` outside production; required in production | Origin of the API process for server rendering (`GET /v1/*` with the visitor's session cookie) and, at build or dev-server start, the destination of the same-origin `/v1/*` rewrite. |
 */
const DEVELOPMENT_ORIGIN = 'http://127.0.0.1:3001';

export class ApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigurationError';
  }
}

/** The API origin without a trailing slash; throws when it is missing in production or is not an http(s) origin. */
export function apiOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = env.TRUSTWORK_API_ORIGIN?.trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') throw new ApiConfigurationError('TRUSTWORK_API_ORIGIN is required when TRUSTWORK_DEMO_MODE is off');
    return DEVELOPMENT_ORIGIN;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiConfigurationError('TRUSTWORK_API_ORIGIN must be an absolute http(s) origin');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new ApiConfigurationError('TRUSTWORK_API_ORIGIN must be an http(s) origin without path, query, fragment or credentials');
  }
  return url.origin;
}
