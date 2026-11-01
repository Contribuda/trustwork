import { screeningNoticeDictionaries, validateScreeningNotice } from './templates/screening/index.js';
import type { MailTemplateName } from '@trustwork/data';
import { escapeHtml, formatMessage, type MessageParams } from './format.js';
import en from './locales/en/mail.json' with { type: 'json' };
import ru from './locales/ru/mail.json' with { type: 'json' };
import uzLatn from './locales/uz-Latn/mail.json' with { type: 'json' };
import ka from './locales/ka/mail.json' with { type: 'json' };
import hy from './locales/hy/mail.json' with { type: 'json' };
import azLatn from './locales/az-Latn/mail.json' with { type: 'json' };
import es from './locales/es/mail.json' with { type: 'json' };
import stroyreputationRu from './brand/stroyreputation-ru.json' with { type: 'json' };

/**
 * Mail templates rendered from the `mail` locale namespace (`locales/<tag>/mail.json`, the INTL-004 layout
 * `<tag>/<namespace>.json`). English is the reference; every engine language defines every key, which the tests
 * enforce. A missing key is never replaced by English at runtime: rendering throws (MSG-S5: a missing translation
 * blocks sending instead of mailing a reader in a language they did not choose).
 */
export type MailDictionary = { readonly [key: string]: string | MailDictionary };

export const REFERENCE_LOCALE = 'en';
/** Every language with a mail dictionary; tests compare it with the engine languages and the directory listing. */
export const MAIL_DICTIONARIES: Readonly<Record<string, MailDictionary>> = Object.fromEntries(Object.entries({ en, ru, 'uz-Latn': uzLatn, ka, hy, 'az-Latn': azLatn, es }).map(([locale, dictionary]) => [locale, { ...dictionary, screeningNotice: screeningNoticeDictionaries[locale as keyof typeof screeningNoticeDictionaries] }]));
export const MAIL_LOCALES: readonly string[] = Object.keys(MAIL_DICTIONARIES);

/** Brand overlays (docs/oss/BRAND.md): per-locale names that replace the hub brand in those locales only. */
export const BRAND_OVERLAYS: Readonly<Record<string, Readonly<Record<string, { name: string }>>>> = {
  'stroyreputation-ru': { ru: stroyreputationRu.ru },
};

export class MissingTranslationError extends Error {
  constructor(readonly locale: string, readonly key: string) {
    super(`mail dictionary ${locale} has no message ${key}`);
    this.name = 'MissingTranslationError';
  }
}
export class TemplateParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateParameterError';
  }
}

export type LinkKind = 'verifyEmail' | 'emailChange' | 'recovery' | 'invitation' | 'signIn' | 'recover' | 'compliance';
export const SECURITY_EVENTS = [
  'login_throttled', 'password_reset', 'password_changed', 'email_change_requested', 'provider_linked', 'provider_unlinked',
  // BE-004: second factor, recovery codes and support resets (SECOND_FACTOR_NOTICE_EVENTS in the contracts).
  'second_factor_enabled', 'second_factor_removed', 'recovery_codes_regenerated', 'recovery_code_used', 'second_factor_throttled',
  'second_factor_reset_requested', 'second_factor_reset_approved', 'second_factor_reset_cancelled', 'second_factor_reset_completed',
  // SUP-001: account servicing by support (recovery e-mail rebind with its cooling-off, sessions, password, lockout, guided tasks).
  'recovery_email_rebind_requested', 'recovery_email_rebind_approved', 'recovery_email_rebind_cancelled', 'recovery_email_rebind_completed',
  'sessions_revoked_by_support', 'password_reset_required', 'account_unlocked', 'support_guided_task',
] as const;
export type SecurityEvent = (typeof SECURITY_EVENTS)[number];
const PROVIDER_NAMES: Readonly<Record<string, string>> = { google: 'Google', apple: 'Apple' };

type Block =
  | { kind: 'paragraph'; key: string }
  /** Pre-rendered text from a delivery parameter (COMMS-001 notification texts), escaped like every value. */
  | { kind: 'text'; param: string }
  /** A link to a workspace path carried by the delivery (validated `/app/...`), labelled from the dictionary. */
  | { kind: 'pathAction'; key: string; param: string }
  | { kind: 'action'; key: string; link: LinkKind }
  | { kind: 'secondary'; hintKey: string; actionKey: string; link: LinkKind };

export interface TemplateSpec {
  template: MailTemplateName;
  /** Top-level key of the template in the mail namespace. */
  namespace: string;
  /** Parameters the delivery must carry (strings); `numeric` ones must parse as positive integers. */
  required: readonly string[];
  numeric: readonly string[];
  /** Whether the delivery carries a sealed one-time token (the action link embeds it). */
  secret: boolean;
  /** Subject and heading come from this parameter instead of the dictionary (pre-rendered notification texts). */
  subjectParam?: string;
  blocks(params: Readonly<Record<string, string>>): Block[];
}

const p = (key: string): Block => ({ kind: 'paragraph', key });
export const TEMPLATE_SPECS: Readonly<Record<MailTemplateName, TemplateSpec>> = {
  verify_email: { template: 'verify_email', namespace: 'verifyEmail', required: ['hours'], numeric: ['hours'], secret: true,
    blocks: () => [p('intro'), { kind: 'action', key: 'action', link: 'verifyEmail' }, p('expiry'), p('ignore')] },
  already_registered: { template: 'already_registered', namespace: 'alreadyRegistered', required: [], numeric: [], secret: false,
    blocks: () => [p('intro'), { kind: 'action', key: 'action', link: 'signIn' }, { kind: 'secondary', hintKey: 'recoverHint', actionKey: 'recoverAction', link: 'recover' }, p('ignore')] },
  recovery: { template: 'recovery', namespace: 'recovery', required: ['minutes'], numeric: ['minutes'], secret: true,
    blocks: () => [p('intro'), { kind: 'action', key: 'action', link: 'recovery' }, p('expiry'), p('ignore')] },
  email_change: { template: 'email_change', namespace: 'emailChange', required: ['hours'], numeric: ['hours'], secret: true,
    blocks: () => [p('intro'), { kind: 'action', key: 'action', link: 'emailChange' }, p('expiry'), p('ignore')] },
  membership_invitation: { template: 'membership_invitation', namespace: 'membershipInvitation', required: ['company', 'membershipId', 'days'], numeric: ['days'], secret: true,
    blocks: () => [p('intro'), { kind: 'action', key: 'action', link: 'invitation' }, p('expiry'), p('ignore')] },
  screening_notice: { template: 'screening_notice', namespace: 'screeningNotice', required: ['kind'], numeric: [], secret: false,
    blocks: () => [p('intro'), { kind: 'action', key: 'action', link: 'compliance' }] },
  security_notice: { template: 'security_notice', namespace: 'securityNotice', required: ['event'], numeric: [], secret: false,
    blocks: (params) => [p(`events.${params.event}`), p('notYou'), { kind: 'action', key: 'action', link: 'recover' }] },
  // COMMS-001: a notification rendered from the hub's active template version in the recipient's language.
  notification: { template: 'notification', namespace: 'notification', required: ['subject', 'body', 'path'], numeric: [], secret: false, subjectParam: 'subject',
    blocks: () => [{ kind: 'text', param: 'body' }, { kind: 'pathAction', key: 'action', param: 'path' }, p('footer')] },
};
/** Workspace paths a notification may link to (the same rule as `comms_enqueue_mail`). */
export const NOTIFICATION_PATH = /^\/app\/[A-Za-z0-9/_.?=&-]{0,255}$/;

export interface LinkConfig {
  /** Public origin of the web application, for example `https://hub.example`. */
  origin: string;
  /** Path templates with `{token}` and `{membershipId}` placeholders. */
  paths: Readonly<Record<Exclude<LinkKind, 'compliance'>, string> & { compliance?: string }>;
}
export const DEFAULT_LINK_PATHS: Readonly<Record<LinkKind, string>> = {
  compliance: '/app/settings/account/compliance',
  verifyEmail: '/verify-email/{token}',
  emailChange: '/verify-email/{token}',
  recovery: '/recover/{token}',
  invitation: '/invitations/{membershipId}/{token}',
  signIn: '/login',
  recover: '/recover',
};

export interface RenderConfig {
  /** Hub default language: used when no preference matches; links in it carry no `lang` parameter. */
  defaultLocale: string;
  /** Languages the hub serves (a subset of MAIL_LOCALES). */
  locales: readonly string[];
  /** Explicit hub brand name for every language (overrides the dictionary's `brand.name`). */
  brandName: string | null;
  /** Brand overlay id (`TRUSTWORK_BRAND`), or null for none. */
  brandOverlay: string | null;
  links: LinkConfig;
}

export interface RenderInput {
  template: MailTemplateName;
  localePreferences: readonly string[];
  params: Readonly<Record<string, string>>;
  /** Opened one-time token (only for templates with `secret: true`). */
  secret: string | null;
}
export interface RenderedMail {
  locale: string;
  subject: string;
  text: string;
  html: string;
  /** Display name for the From header (the brand in the message's language). */
  fromName: string;
}

function lookup(locale: string, key: string): string {
  let node: string | MailDictionary | undefined = MAIL_DICTIONARIES[locale];
  for (const part of key.split('.')) node = node && typeof node === 'object' ? node[part] : undefined;
  if (typeof node !== 'string' || node.trim() === '') throw new MissingTranslationError(locale, key);
  return node;
}

/** First preference the hub serves (exact tag, then same language), else the hub default. */
export function resolveLocale(preferences: readonly string[], served: readonly string[], fallback: string): string {
  const exact = new Map(served.map((tag) => [tag.toLowerCase(), tag]));
  for (const preference of preferences) {
    const hit = exact.get(preference.toLowerCase());
    if (hit) return hit;
    const language = preference.split('-')[0]!.toLowerCase();
    const sameLanguage = served.find((tag) => tag.split('-')[0]!.toLowerCase() === language);
    if (sameLanguage) return sameLanguage;
  }
  return fallback;
}

export function brandFor(config: Pick<RenderConfig, 'brandName' | 'brandOverlay'>, locale: string): string {
  const overlay = config.brandOverlay ? BRAND_OVERLAYS[config.brandOverlay]?.[locale]?.name : undefined;
  return overlay ?? config.brandName ?? lookup(locale, 'brand.name');
}

export function buildLink(config: RenderConfig, kind: LinkKind, locale: string, values: Readonly<Record<string, string>>): string {
  const path = (config.links.paths[kind] ?? DEFAULT_LINK_PATHS[kind]).replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') throw new TemplateParameterError(`link ${kind} needs {${name}}`);
    return encodeURIComponent(value);
  });
  const url = new URL(path, config.links.origin);
  if (locale !== config.defaultLocale) url.searchParams.set('lang', locale);
  return url.toString();
}

function validate(spec: TemplateSpec, input: RenderInput): MessageParams {
  if (spec.template === 'screening_notice') validateScreeningNotice(input.params);
  const values: Record<string, string | number> = {};
  for (const name of spec.required) {
    const raw = input.params[name];
    if (typeof raw !== 'string' || raw === '') throw new TemplateParameterError(`template ${spec.template} needs parameter ${name}`);
    if (spec.numeric.includes(name)) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new TemplateParameterError(`parameter ${name} must be a positive integer`);
      values[name] = n;
    } else values[name] = raw;
  }
  if (spec.template === 'security_notice') {
    if (!(SECURITY_EVENTS as readonly string[]).includes(String(input.params.event))) throw new TemplateParameterError(`unknown security event ${String(input.params.event)}`);
    const provider = input.params.provider;
    if (input.params.event === 'provider_linked' || input.params.event === 'provider_unlinked') {
      if (!provider || !PROVIDER_NAMES[provider]) throw new TemplateParameterError('provider events need a known provider');
      values.provider = PROVIDER_NAMES[provider];
    }
  }
  if (spec.template === 'notification') {
    if (!NOTIFICATION_PATH.test(String(input.params.path))) throw new TemplateParameterError('notification links stay inside the workspace');
    if (/[\r\n]/.test(String(input.params.subject)) || String(input.params.subject).length > 200) throw new TemplateParameterError('notification subject is one short line');
    if (String(input.params.body).length > 4000) throw new TemplateParameterError('notification body is too long');
  }
  if (spec.secret && !input.secret) throw new TemplateParameterError(`template ${spec.template} needs its one-time token`);
  if (!spec.secret && input.secret) throw new TemplateParameterError(`template ${spec.template} must not carry a token`);
  return values;
}

/**
 * Renders subject, plain text and HTML in the best language for the delivery. Every interpolated value is escaped in
 * the HTML part; links are built from the configured origin only (never from delivery data).
 */
export function renderMail(config: RenderConfig, input: RenderInput): RenderedMail {
  const spec = TEMPLATE_SPECS[input.template];
  if (!spec) throw new TemplateParameterError(`unknown template ${String(input.template)}`);
  const locale = resolveLocale(input.localePreferences, config.locales, config.defaultLocale);
  const brand = brandFor(config, locale);
  const params: MessageParams = { ...validate(spec, input), brand };
  const linkValues = { ...input.params, ...(input.secret ? { token: input.secret } : {}) };
  const t = (key: string) => formatMessage(lookup(locale, key), params, locale);
  const ns = (key: string) => t(`${spec.namespace}.${key}`);
  const subject = (spec.subjectParam ? String(input.params[spec.subjectParam]) : ns('subject')).replace(/[\r\n]+/g, ' ');
  const heading = spec.subjectParam ? subject : ns('heading');
  const dir = /^(ar|fa|he|ur|ps|yi|dv|ku-Arab)(-|$)/.test(locale) ? 'rtl' : 'ltr';

  const text: string[] = [t('layout.greeting'), '', heading, ''];
  const html: string[] = [`<p style="margin:0 0 16px">${escapeHtml(t('layout.greeting'))}</p>`, `<h1 style="font-size:20px;line-height:28px;margin:0 0 16px">${escapeHtml(heading)}</h1>`];
  for (const block of spec.blocks(input.params)) {
    if (block.kind === 'paragraph') {
      const body = ns(block.key);
      text.push(body, '');
      html.push(`<p style="margin:0 0 16px">${escapeHtml(body)}</p>`);
    } else if (block.kind === 'text') {
      for (const paragraph of String(input.params[block.param]).split(/\n{2,}/)) {
        text.push(paragraph, '');
        html.push(`<p style="margin:0 0 16px;white-space:pre-line">${escapeHtml(paragraph)}</p>`);
      }
    } else if (block.kind === 'pathAction') {
      const label = ns(block.key);
      const url = new URL(String(input.params[block.param]), config.links.origin);
      if (locale !== config.defaultLocale) url.searchParams.set('lang', locale);
      text.push(`${label}:`, url.toString(), '');
      html.push(`<p style="margin:24px 0"><a href="${escapeHtml(url.toString())}" style="background:#1d4ed8;border-radius:6px;color:#ffffff;display:inline-block;font-weight:600;padding:12px 20px;text-decoration:none">${escapeHtml(label)}</a></p>`);
    } else if (block.kind === 'action') {
      const label = ns(block.key);
      const url = buildLink(config, block.link, locale, linkValues);
      text.push(`${label}:`, url, '');
      html.push(
        `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#1d4ed8;border-radius:6px;color:#ffffff;display:inline-block;font-weight:600;padding:12px 20px;text-decoration:none">${escapeHtml(label)}</a></p>`,
        `<p style="color:#4b5563;font-size:13px;margin:0 0 16px">${escapeHtml(t('layout.linkFallback'))}<br><a href="${escapeHtml(url)}" style="color:#1d4ed8;word-break:break-all">${escapeHtml(url)}</a></p>`,
      );
    } else {
      const hint = ns(block.hintKey);
      const label = ns(block.actionKey);
      const url = buildLink(config, block.link, locale, linkValues);
      text.push(hint, `${label}: ${url}`, '');
      html.push(`<p style="margin:0 0 16px">${escapeHtml(hint)} <a href="${escapeHtml(url)}" style="color:#1d4ed8">${escapeHtml(label)}</a></p>`);
    }
  }
  const signature = t('layout.signature');
  const automated = t('layout.automated');
  text.push('-- ', signature, automated);
  html.push(`<p style="margin:24px 0 8px">${escapeHtml(signature)}</p>`, `<p style="color:#6b7280;font-size:12px;margin:0">${escapeHtml(automated)}</p>`);
  const document = [
    '<!doctype html>',
    `<html lang="${escapeHtml(locale)}" dir="${dir}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="background:#f3f4f6;margin:0;padding:24px 12px">',
    `<main style="background:#ffffff;border-radius:8px;color:#111827;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:24px;margin:0 auto;max-width:560px;padding:32px 24px">`,
    ...html,
    '</main></body></html>',
  ].join('\n');
  return { locale, subject, text: `${text.join('\n')}\n`, html: `${document}\n`, fromName: brand };
}

/** Keys of the reference dictionary (dot paths), for completeness checks. */
export function dictionaryKeys(dictionary: MailDictionary, prefix = ''): string[] {
  return Object.entries(dictionary).flatMap(([key, value]) => {
    if (key === '$comment') return [];
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : dictionaryKeys(value, path);
  });
}

/** Refuses a hub language without a complete mail dictionary (checked at worker start). */
export function assertDictionariesComplete(locales: readonly string[]): void {
  const reference = dictionaryKeys(MAIL_DICTIONARIES[REFERENCE_LOCALE]!);
  for (const locale of locales) {
    if (!MAIL_DICTIONARIES[locale]) throw new MissingTranslationError(locale, '*');
    for (const key of reference) lookup(locale, key);
  }
}
