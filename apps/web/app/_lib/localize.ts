import { localeTag } from '@trustwork/ui/i18n';
import { withBase } from './base-path';
import { localizePath } from './public-paths';

/**
 * Links to public pages in the language being rendered (ADR 012 decision 27). Shared by server and client code: the
 * active language comes from the request-scoped locale store, the deployment's default language (the unprefixed one)
 * is registered once per process by the server (`locale.ts`) and once per document by `LocaleProvider`.
 */
let defaultLanguage: string | (() => string) = 'en';

/** Registers the unprefixed language: a value (the browser, from the document) or a reader (the server configuration). */
export function setDefaultLanguage(tag: string | (() => string)): void {
  if (tag) defaultLanguage = tag;
}

export function unprefixedLanguage(): string {
  return typeof defaultLanguage === 'function' ? defaultLanguage() : defaultLanguage;
}

/** An app-absolute public path in the active language (`/news` stays `/news` in English, becomes `/es/news` in Spanish). */
export function localPath(path: string, lang: string = localeTag()): string {
  return localizePath(path, lang, unprefixedLanguage());
}

/** `localPath` with the base path, for plain anchors, form actions and redirects that Next does not prefix itself. */
export function localHref(path: string, lang?: string): string {
  return withBase(localPath(path, lang));
}
