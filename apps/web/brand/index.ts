import type { BrandOverlay } from '@trustwork/ui/brand';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { deploymentWordmarks } from './wordmarks';
import ru from './messages/ru.json';

/**
 * Brand overlays (owner decision 2026-10-31, ADR 010 decision 14): **Trustwork everywhere**. The only
 * exception is the Russian interface, which shows «Строй Репутация» (name, stacked lettering and the copy
 * that embeds the name). Every other language falls back to the Trustwork lockup and strings.
 *
 * A deployment that wants Trustwork in Russian too builds with NEXT_PUBLIC_TRUSTWORK_BRAND=none. The name
 * and lettering «Строй Репутация» are marks of their owner; the licence grants no trademark rights to them
 * (NOTICE, AGPL-3.0 section 7(e)). See docs/oss/BRAND.md to add another overlay.
 */
const OVERLAYS: Record<string, BrandOverlay> = {
  'stroyreputation-ru': {
    wordmarks: { ru: deploymentWordmarks.ru! },
    messages: { ru: ru as Messages },
  },
};

export const BRAND_ID = process.env.NEXT_PUBLIC_TRUSTWORK_BRAND || 'stroyreputation-ru';
export const brandOverlay: BrandOverlay | null = OVERLAYS[BRAND_ID] ?? null;
