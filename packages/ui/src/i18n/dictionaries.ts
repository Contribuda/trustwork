import type { Messages } from '@trustwork/i18n-runtime/types';
import es from '../../locales/es.json' with { type: 'json' };
import ru from '../../locales/ru.json' with { type: 'json' };
import uzLatn from '../../locales/uz-Latn.json' with { type: 'json' };
import ka from '../../locales/ka.json' with { type: 'json' };
import hy from '../../locales/hy.json' with { type: 'json' };
import azLatn from '../../locales/az-Latn.json' with { type: 'json' };
import { FALLBACK_LOCALE, registerUiLocale, uiDictionary } from './index';

/**
 * Every design-system dictionary besides the built-in English reference. Import it only where all
 * languages are needed at once: the server that resolves a request's layers, tests and tools. Client
 * components never import it, so a browser receives the active locale's dictionary as a store layer
 * instead of all of them.
 */
const ENGINE_DICTIONARIES: Record<string, Messages> = { es, ru, 'uz-Latn': uzLatn, ka, hy, 'az-Latn': azLatn };

for (const [tag, messages] of Object.entries(ENGINE_DICTIONARIES)) registerUiLocale(tag, messages);

/**
 * The design-system layer for a locale's store: its own dictionary, or nothing for English and for
 * languages without one (the English reference is built into every bundle as the last fallback).
 */
export function uiLayers(tag: string): Messages[] {
  if (tag === FALLBACK_LOCALE) return [];
  const own = uiDictionary(tag);
  return own ? [own] : [];
}
