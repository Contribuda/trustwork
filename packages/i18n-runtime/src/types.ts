/** One dictionary: nested objects whose leaves are ICU-subset message strings. */
export type Messages = { readonly [key: string]: string | Messages | readonly string[] };

/**
 * The active locale for one render plus the message layers that resolve a key, in order: the app's
 * dictionary for the locale, the app's English fallback, the design system's dictionary for the locale,
 * the design system's English fallback. `country` is the active country-pack code.
 */
export type LocaleStore = { locale: string; country: string; layers: Messages[] };

export const EMPTY_STORE: LocaleStore = { locale: 'en', country: 'UZ', layers: [] };
