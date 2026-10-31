import { createContext, createElement, use, useMemo, type ReactNode } from 'react';
import { EMPTY_STORE, type LocaleStore, type Messages } from './types.js';

/**
 * Client-component build (browser bundle and the server-side rendering pass of client components).
 *
 * Server-side rendering interleaves many requests in one process, so the active locale of a render is a
 * React context value set by `LocaleScope` at the top of the tree: React restores the right value for
 * every component it renders, whichever request it belongs to. Message lookups read it through `use()`.
 *
 * In the browser a document has exactly one locale, so the scope also writes a module-level store that
 * lookups read; this keeps `t()` usable outside rendering (event handlers, effects) and avoids reading
 * context from inside hooks. On the server the module store is never written by a render, so nothing a
 * request does can leak into another; it only serves code outside any render (unit tests, tooling).
 */
const LocaleContext = createContext<LocaleStore | null>(null);
LocaleContext.displayName = 'LocaleScope';

const store: LocaleStore = { ...EMPTY_STORE, layers: [] };
const IN_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

/** Set once a scope has rendered on the server: before that no render can be inside a scope, so `use()` is not attempted. */
let serverScopeSeen = false;

function scopedStore(): LocaleStore | null {
  if (IN_BROWSER || !serverScopeSeen) return null;
  try {
    // Outside rendering React has no dispatcher and throws; that path falls back to the module store.
    return use(LocaleContext);
  } catch {
    return null;
  }
}

export function getLocaleStore(): LocaleStore {
  return scopedStore() ?? store;
}

/** Replaces the module-level store (browser documents, unit tests and tools that render nothing). */
export function setLocaleStore(next: LocaleStore): void {
  Object.assign(store, next);
}

export type LocaleScopeProps = { locale: string; country: string; layers: Messages[]; children?: ReactNode };

/**
 * Makes `{ locale, country, layers }` the active locale for every client component below it. Render it
 * once at the top of the client tree with the layers the server resolved for this request.
 */
export function LocaleScope({ locale, country, layers, children }: LocaleScopeProps): ReactNode {
  const value = useMemo<LocaleStore>(() => ({ locale, country, layers }), [locale, country, layers]);
  if (IN_BROWSER) setLocaleStore(value);
  else serverScopeSeen = true;
  return createElement(LocaleContext.Provider, { value }, children);
}

/** Route handlers only exist on the server build; here the callback simply runs. */
export function runWithLocaleScope<T>(fn: () => T): T {
  return fn();
}

export const RUNTIME = 'client' as const;
