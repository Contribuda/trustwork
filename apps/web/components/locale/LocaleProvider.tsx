'use client';

import { useEffect, type ReactNode } from 'react';
import { setLocaleStore } from '@trustwork/i18n-runtime';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { registerBrandOverlay } from '@trustwork/ui/brand';
import { brandOverlay } from '@/brand';

// The client bundle registers the deployment brand once so <Brand /> letters it in every locale.
registerBrandOverlay(brandOverlay);

/**
 * Hands the active locale and its message layers to the client bundle. The store is set during render (so
 * every child reads the right messages on the first pass) and `<html lang>` follows on the client.
 */
export function LocaleProvider({ locale, country, layers, children }: { locale: string; country: string; layers: Messages[]; children: ReactNode }) {
  setLocaleStore({ locale, country, layers });
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return children;
}
