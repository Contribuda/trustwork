import type { NextConfig } from 'next';

/**
 * `@trustwork/ui` ships TypeScript sources and CSS Modules and `@trustwork/contracts` ships TypeScript with
 * NodeNext `.js` specifiers, so Next compiles both (transpilePackages + extension alias).
 * Every page is rendered per request (each document carries its CSP nonce); public pages live under
 * app/(public)/[lang] with one address per language (WEB-005).
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

/**
 * Public pages by language (WEB-005, ADR 012 decision 27): the proxy decides at request time which internal page of
 * `app/(public)/[lang]` serves an address (the default language for an unprefixed one, the filtered twin for a list with
 * a query) and hands it over in this header (`PUBLIC_ROUTE_HEADER` in app/_lib/public-paths.ts); these rewrites apply it.
 * The sources exclude exactly what the proxy's matcher excludes, so every request they match had the header set or
 * removed by the proxy; the value must start with a language segment, so it can only ever name a public page. `'/'` is
 * listed on its own for the base path's bare home page (see the proxy's matcher).
 */
const PUBLIC_ROUTE_HEADER = 'x-trustwork-public-route';
const publicRoute = { type: 'header' as const, key: PUBLIC_ROUTE_HEADER, value: '(?<route>[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*(?:/.*)?)' };
const publicRouteRewrites = [
  { source: '/', has: [publicRoute], destination: '/:route*' },
  { source: '/:path((?!_next/static/|icons/|media/|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest).+)', has: [publicRoute], destination: '/:route*' },
];


const config: NextConfig = {
  // Served under a prefix behind the hosting site's reverse proxy; empty on the local stand.
  ...(basePath ? { basePath } : {}),
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  experimental: {
    // Server actions arrive with the public host in Origin while the proxy rewrites Host to the upstream.
    ...(allowedOrigins.length ? { serverActions: { allowedOrigins } } : {}),
    // Every document imports the global stylesheets first, then its route stylesheets (WEB-005: four documents and
    // per-route public stylesheets instead of one root layout and one public stylesheet). The default chunking merges
    // stylesheets shared by several routes in any order; 'strict' keeps the import order, so tokens stay before the
    // stylesheets that override them.
    cssChunking: false,
  },
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ['@trustwork/ui', '@trustwork/contracts'],
  images: { formats: ['image/avif', 'image/webp'] },
  rewrites: async () => ({ beforeFiles: [...(apiOrigin ? [{ source: '/v1/:path*', destination: `${apiOrigin}/v1/:path*` }] : []), ...publicRouteRewrites] }),
  webpack: (webpackConfig, { isServer }) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.extensionAlias = { ...(webpackConfig.resolve.extensionAlias ?? {}), '.js': ['.ts', '.tsx', '.js'] };
    const splitChunks = webpackConfig.optimization?.splitChunks;
    if (!isServer && splitChunks && typeof splitChunks === 'object') {
      // Every document (public, workspace, sign-in, onboarding) renders the same client providers and locale controls
      // (components/RootDocument.tsx, WEB-005). Together they stay under Next's 20 kB minimum for a shared chunk, so
      // each document's layout chunk would carry its own copy: one named chunk holds them once. JavaScript only, so
      // stylesheet order and grouping stay as Next builds them.
      splitChunks.cacheGroups = {
        ...(splitChunks.cacheGroups || {}),
        document: {
          test: /[\\/]apps[\\/]web[\\/](?:components[\\/](?:AppRouterProvider|DemoBanner|locale[\\/])|app[\\/]_lib[\\/](?:localize|public-paths|base-path|persona|locale-names)\.)/,
          type: /javascript/,
          name: 'document',
          chunks: 'all',
          minChunks: 2,
          minSize: 0,
          priority: 10,
          enforce: true,
        },
      };
    }
    return webpackConfig;
  },
};

export default config;
