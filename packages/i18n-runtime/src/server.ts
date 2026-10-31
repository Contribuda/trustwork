import { cache } from 'react';
import { EMPTY_STORE, type LocaleStore } from './types.js';

/**
 * Server build (`react-server` export condition and the SSR pass of client components).
 *
 * In React Server Components `cache` memoises per request, so two concurrent requests in different
 * locales never see each other's messages; layouts and pages render in parallel, so every page primes
 * the store itself (`primeLocale()` in apps/web). In the SSR pass of client components React's `cache`
 * is a pass-through (no request scope), so the module-level store written by the locale provider at
 * the top of the tree is used instead; see the client build for the accepted limitation.
 */
type Scoped = LocaleStore & { primed: boolean };

const scoped = cache((): Scoped => ({ ...EMPTY_STORE, layers: [], primed: false }));
const moduleStore: LocaleStore = { ...EMPTY_STORE, layers: [] };

function requestStore(): Scoped | null {
  try {
    const first = scoped();
    return first === scoped() ? first : null;
  } catch {
    return null;
  }
}

export function getLocaleStore(): LocaleStore {
  const request = requestStore();
  return request && request.primed ? request : moduleStore;
}

export function setLocaleStore(next: LocaleStore): void {
  const request = requestStore();
  if (request) Object.assign(request, next, { primed: true });
  Object.assign(moduleStore, next);
}

export const RUNTIME = 'server' as const;
