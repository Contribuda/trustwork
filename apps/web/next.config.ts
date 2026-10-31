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
  webpack: (webpackConfig) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.extensionAlias = { ...(webpackConfig.resolve.extensionAlias ?? {}), '.js': ['.ts', '.tsx', '.js'] };
    return webpackConfig;
  },
};

export default config;
