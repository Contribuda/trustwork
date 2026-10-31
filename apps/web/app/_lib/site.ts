import type { Metadata } from 'next';
import { currentDeployment } from '@trustwork/config/server';
import { BASE_PATH } from './base-path';
import { DATA_SOURCE } from './data';
import { offeredLanguages } from './locale-negotiation';
import { localizePath } from './public-paths';

/**
 * The deployment's public address (origin and base path, no trailing slash): `site.url` of the runtime configuration
 * or `TRUSTWORK_SITE_URL` (CFG-001), read when a page renders, so one image serves any host. `NEXT_PUBLIC_SITE_URL`
 * (a build argument of older images) is still honoured when nothing is configured; the loopback stand is the last
 * resort.
 */
export function siteUrl(): string {
  const configured = currentDeployment().site.url ?? process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? '';
  return (configured || `http://127.0.0.1:3000${BASE_PATH}`).replace(/\/+$/, '');
}

/** Absolute URL of an app-absolute path (without the base path; the site URL carries it). */
export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path === '/' ? '' : path}` || '/';
}

/**
 * Canonical URL and `hreflang` alternates of a public page (ADR 012 decision 27): one URL per offered language, the
 * default language unprefixed and also the `x-default`. `path` is the page's unprefixed path without query.
 */
export function languageAlternates(path: string, lang: string): NonNullable<Metadata['alternates']> {
  const deployment = currentDeployment();
  const fallback = deployment.languages.default;
  const languages: Record<string, string> = {};
  for (const tag of offeredLanguages(deployment)) languages[tag] = absoluteUrl(localizePath(path, tag, fallback));
  languages['x-default'] = absoluteUrl(path);
  return { canonical: absoluteUrl(localizePath(path, lang, fallback)), languages };
}

/**
 * Whether search engines may index public pages: only with live data. The demo's synthetic companies, people and
 * reviews must never be indexed as if they were real (AGENTS.md: no fake users, companies or traffic).
 */
export function publicRobots(): { index: boolean; follow: boolean } {
  return DATA_SOURCE === 'fixtures' ? { index: false, follow: false } : { index: true, follow: true };
}
