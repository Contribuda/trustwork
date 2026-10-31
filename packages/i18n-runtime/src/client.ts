import { EMPTY_STORE, type LocaleStore } from './types.js';

/**
 * Browser and SSR build of client components: one module-level store. In the browser a document has one
 * locale, so this is exact. During server-side rendering of client components the module is shared by the
 * process; the provider sets the store at the top of every render and the pages are small, so a mismatch
 * would need two renders in different locales to interleave inside one streaming boundary — accepted and
 * documented in ADR-009 until a request-scoped SSR context exists.
 */
const store: LocaleStore = { ...EMPTY_STORE, layers: [] };

export function getLocaleStore(): LocaleStore {
  return store;
}

export function setLocaleStore(next: LocaleStore): void {
  Object.assign(store, next);
}

export const RUNTIME = 'client' as const;
