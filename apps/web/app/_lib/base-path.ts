/**
 * Public base path the app is served under: empty at the root (local stand), `/trustwork` behind the
 * hosting site's reverse proxy. Next prefixes its own links, routes and assets from `basePath`; this helper
 * covers what it does not: plain form actions, anchors, manifest entries and browser fetches.
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');

/** Prefixes an app-absolute path with the base path; external and already prefixed URLs pass through. */
export function withBase(path: string): string {
  if (!BASE_PATH || !path.startsWith('/') || path.startsWith('//')) return path;
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`) || path.startsWith(`${BASE_PATH}?`)) return path;
  return `${BASE_PATH}${path}`;
}
