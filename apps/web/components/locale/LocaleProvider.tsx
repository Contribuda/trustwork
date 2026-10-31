'use client';

import { useEffect, type ReactNode } from 'react';
import { LocaleScope } from '@trustwork/i18n-runtime';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { registerBrandOverlay } from '@trustwork/ui/brand';
import { brandOverlay } from '@/brand';

// The client bundle registers the deployment brand once so <Brand /> letters it in every locale.
registerBrandOverlay(brandOverlay);

/**
 * Hands the active locale and its message layers (this request's language only) to the client
 * components below. `LocaleScope` keeps them request-scoped during server rendering, so concurrent
 * visitors in different languages never mix; `<html lang>` follows on the client.
 */
export function LocaleProvider({ locale, country, layers, children }: { locale: string; country: string; layers: Messages[]; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <LocaleScope locale={locale} country={country} layers={layers}>
      {children}
    </LocaleScope>
  );
}
