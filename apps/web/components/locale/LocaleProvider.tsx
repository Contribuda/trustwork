'use client';

import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';
import { LocaleScope } from '@trustwork/i18n-runtime';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { brandOverlay, registerBrandOverlay, type BrandOverlay } from '@trustwork/ui/brand';
import { installPacks, type CountryPack } from '@trustwork/country-packs';

type WordmarkLines = BrandOverlay['wordmarks'][string];

/**
 * The deployment's brand overlay is runtime configuration (CFG-001), so the browser learns it from the server: the
 * root layout hands over the overlay's wordmark for this document's language, and it is added here (never removed:
 * one deployment has one overlay, so concurrent server renders in different languages only ever add entries).
 */
function registerWordmark(locale: string, wordmark: WordmarkLines | null | undefined): void {
  if (!wordmark) return;
  const current = brandOverlay();
  if (current?.wordmarks[locale] === wordmark) return;
  registerBrandOverlay({ wordmarks: { ...current?.wordmarks, [locale]: wordmark }, messages: current?.messages ?? {} });
}

/**
 * The messages a document has received, grouped so that nested route groups can add theirs (INTL-004):
 * the brand overlay first, then the application layers of each provider (keyed by its namespaces; the
 * namespaces of different providers never share a key), then the design system's dictionary.
 */
type Received = { locale: string; country: string; brand: Messages[]; app: Map<string, Messages[]>; ui: Messages[] };

const ReceivedContext = createContext<Received | null>(null);
ReceivedContext.displayName = 'LocaleNamespaces';

const IN_BROWSER = typeof window !== 'undefined';

/**
 * In the browser one document has one locale, and lookups outside rendering (event handlers) read the
 * module store that the innermost scope wrote last. Everything a document received for its locale is
 * therefore kept here and every scope hands the union on, so moving between route groups never leaves a
 * lookup without its namespace. Never used on the server, where each render has its own context.
 */
let documentReceived: Received | null = null;

function inDocument(next: Received): Received {
  if (!IN_BROWSER) return next;
  if (!documentReceived || documentReceived.locale !== next.locale || documentReceived.country !== next.country) {
    documentReceived = { ...next, app: new Map(next.app) };
  } else {
    for (const [key, layers] of next.app) documentReceived.app.set(key, layers);
    if (next.brand.length) documentReceived.brand = next.brand;
    if (next.ui.length) documentReceived.ui = next.ui;
  }
  return documentReceived;
}

const layersOf = (received: Received): Messages[] => [...received.brand, ...[...received.app.values()].flat(), ...received.ui];

function Scope({ received, children }: { received: Received; children: ReactNode }) {
  const merged = inDocument(received);
  const layers = layersOf(merged);
  return (
    <ReceivedContext.Provider value={received}>
      <LocaleScope locale={merged.locale} country={merged.country} layers={layers}>
        {children}
      </LocaleScope>
    </ReceivedContext.Provider>
  );
}

/**
 * Hands the active locale and the root layout's message layers (this request's language only: brand
 * overlay, the root namespaces, the design system's dictionary) to the client components below.
 * `LocaleScope` keeps them request-scoped during server rendering, so concurrent visitors in different
 * languages never mix; `<html lang>` follows on the client.
 */
/**
 * Country packs from the deployment's data directory, for region labels and currency in client components. They are
 * only ever added (the deployment's packs do not change while it runs), so concurrent renders never remove one.
 */
const deploymentPacks = new Map<string, CountryPack>();
function registerPack(pack: CountryPack | null | undefined): void {
  if (!pack || deploymentPacks.has(pack.code)) return;
  deploymentPacks.set(pack.code, pack);
  installPacks([...deploymentPacks.values()]);
}

export function LocaleProvider({ locale, country, brand, wordmark, pack, namespaces, layers, ui, children }: { locale: string; country: string; brand: Messages[]; wordmark?: WordmarkLines | null; pack?: CountryPack | null; namespaces: string[]; layers: Messages[]; ui: Messages[]; children: ReactNode }) {
  registerWordmark(locale, wordmark);
  registerPack(pack);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const received = useMemo<Received>(() => ({ locale, country, brand, app: new Map([[namespaces.join(','), layers]]), ui }), [locale, country, brand, namespaces, layers, ui]);
  return <Scope received={received}>{children}</Scope>;
}

/**
 * Adds a route group's namespaces (from `clientLayers()` in its layout) to the locale above, for the
 * client components of that group only.
 */
export function LocaleNamespaces({ namespaces, layers, children }: { namespaces: string[]; layers: Messages[]; children: ReactNode }) {
  const parent = use(ReceivedContext);
  if (!parent) throw new Error('LocaleNamespaces must be rendered inside LocaleProvider');
  const received = useMemo<Received>(() => ({ ...parent, app: new Map([...parent.app, [namespaces.join(','), layers]]) }), [parent, namespaces, layers]);
  return <Scope received={received}>{children}</Scope>;
}
