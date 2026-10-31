import { AsyncLocalStorage } from 'node:async_hooks';
import { cache } from 'react';
import { EMPTY_STORE, type LocaleStore } from './types.js';

/**
 * Server build (`react-server` export condition: server components, metadata and route handlers).
 *
 * The active locale lives in a request scope and nowhere else, so concurrent requests in different
 * languages never see each other's messages:
 * - while React renders server components, `cache` memoises one scope per request; layouts and pages
 *   render in parallel, so every page primes the scope itself (`primeLocale()` in apps/web);
 * - route handlers have no React request scope, so they run inside `runWithLocaleScope()`, an
 *   AsyncLocalStorage scope that follows the handler's asynchronous work.
 * Outside both (build tooling) reads get the engine default and writes are ignored: there is no
 * process-wide store a request could leave behind for the next one.
 */
type Scope = { store: LocaleStore | null };

const reactScope = cache((): Scope => ({ store: null }));
const asyncScope = new AsyncLocalStorage<Scope>();
const DEFAULT_STORE: LocaleStore = { ...EMPTY_STORE, layers: [] };

function requestScope(): Scope | null {
  try {
    const first = reactScope();
    if (first === reactScope()) return first;
  } catch {
    // no React request scope (route handler, tooling)
  }
  return asyncScope.getStore() ?? null;
}

export function getLocaleStore(): LocaleStore {
  return requestScope()?.store ?? DEFAULT_STORE;
}

export function setLocaleStore(next: LocaleStore): void {
  const scope = requestScope();
  if (scope) scope.store = { ...next };
}

/** Runs a route handler (or any server work outside React rendering) with its own locale scope. */
export function runWithLocaleScope<T>(fn: () => T): T {
  return asyncScope.run({ store: null }, fn);
}

/** Client components only: never rendered by the server-component build. */
export function LocaleScope(): never {
  throw new Error('LocaleScope is a client component; render it from a "use client" module');
}

export const RUNTIME = 'server' as const;
