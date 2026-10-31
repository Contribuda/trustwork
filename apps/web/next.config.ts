import type { NextConfig } from 'next';

/**
 * `@trustwork/ui` ships TypeScript sources and CSS Modules and `@trustwork/contracts` ships TypeScript with
 * NodeNext `.js` specifiers, so Next compiles both (transpilePackages + extension alias).
 * Public pages are server-rendered; the whole app opts out of shared caching in the root layout.
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');
const allowedOrigins = (process.env.TRUSTWORK_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Same-origin API routing (WEB-004, ADR 002 amendment): the browser calls `/v1/*` on the web origin and Next proxies
 * it to the API process, forwarding cookies, the CSRF header, fetch metadata and `Idempotency-Key` unchanged, so the
 * session cookie and the API's same-origin checks see the visitor's own request. Read when the build or the dev server
 * starts: `TRUSTWORK_API_ORIGIN`, or the local API (`http://127.0.0.1:3001`) outside production. A production build
 * without it adds no rewrite (the reverse proxy routes `/v1/*`, OPS-002); demo deployments never call the API.
 * Behind this rewrite the API sees the web server as its peer: set `API_TRUSTED_PROXY_HOPS=1` there so rate limits
 * and lockout use the visitor's address from `X-Forwarded-For`.
 */
function apiRewriteOrigin(): string | null {
  if (['1', 'true', 'on', 'yes'].includes((process.env.TRUSTWORK_DEMO_MODE ?? '').trim().toLowerCase())) return null;
  const configured = process.env.TRUSTWORK_API_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;
  return process.env.NODE_ENV === 'production' ? null : 'http://127.0.0.1:3001';
}
const apiOrigin = apiRewriteOrigin();

const config: NextConfig = {
  // Served under a prefix behind the hosting site's reverse proxy; empty on the local stand.
  ...(basePath ? { basePath } : {}),
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Server actions arrive with the public host in Origin while the proxy rewrites Host to the upstream.
  ...(allowedOrigins.length ? { experimental: { serverActions: { allowedOrigins } } } : {}),
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ['@trustwork/ui', '@trustwork/contracts'],
  images: { formats: ['image/avif', 'image/webp'] },
  ...(apiOrigin ? { rewrites: async () => ({ beforeFiles: [{ source: '/v1/:path*', destination: `${apiOrigin}/v1/:path*` }] }) } : {}),
  webpack: (webpackConfig) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.extensionAlias = { ...(webpackConfig.resolve.extensionAlias ?? {}), '.js': ['.ts', '.tsx', '.js'] };
    return webpackConfig;
  },
};

export default config;
