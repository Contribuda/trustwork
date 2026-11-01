import { hostname } from 'node:os';
import { mailSecretKeyFromEnv } from '@trustwork/data';
import { DEFAULT_LINK_PATHS, MAIL_LOCALES, BRAND_OVERLAYS, type LinkKind, type RenderConfig } from './templates.js';
import { DEFAULT_SMTP_TIMEOUTS, isLoopbackHost, type SmtpConfig } from './smtp.js';

/**
 * Mail configuration of the worker (explicit environment values only). Nothing here registers a provider account:
 * `smtp` points at whatever submission server the operator already has.
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `MAIL_TRANSPORT` | `fake` | `fake` (records, sends nothing), `log` (stdout, development only), `smtp` |
 * | `MAIL_SECRET_KEY` | development key outside production | Hex, at least 32 bytes; the same value as the API's. Opens sealed tokens |
 * | `MAIL_FROM_ADDRESS` | `no-reply@<origin host>` | Envelope and header sender; required for `smtp` |
 * | `MAIL_REPLY_TO` | none | Optional Reply-To address |
 * | `MAIL_PUBLIC_ORIGIN` | `PUBLIC_ORIGIN`, else `http://localhost:3000` | Origin of links in messages; required for `smtp` |
 * | `MAIL_LINK_<KIND>` | see DEFAULT_LINK_PATHS | Path templates (`VERIFY_EMAIL`, `EMAIL_CHANGE`, `RECOVERY`, `INVITATION`, `SIGN_IN`, `RECOVER`) |
 * | `MAIL_DEFAULT_LOCALE` | `en` | Hub default language (no `lang` parameter in its links) |
 * | `MAIL_LOCALES` | every mail language | Comma-separated languages the hub serves |
 * | `MAIL_BRAND_NAME` | dictionary `brand.name` | Hub brand in every language |
 * | `TRUSTWORK_BRAND` | `stroyreputation-ru` | Brand overlay id (same switch as the web build); `none` disables it |
 * | `MAIL_RECIPIENT_LIMIT_PER_HOUR` | 10 | Messages per address per hour; more are dropped as `rate_limited` |
 * | `MAIL_SEND_LIMIT_PER_MINUTE` | 120 | Messages per minute for the whole hub; more wait with backoff |
 * | `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT` | none, 587 | Submission server |
 * | `MAIL_SMTP_SECURITY` | `starttls` | `starttls`, `tls` or `none` (`none` only for loopback or outside production) |
 * | `MAIL_SMTP_USER`, `MAIL_SMTP_PASSWORD` | none | AUTH PLAIN/LOGIN credentials (never sent without TLS to a remote host) |
 * | `MAIL_SMTP_CONNECT_TIMEOUT_MS`, `MAIL_SMTP_COMMAND_TIMEOUT_MS`, `MAIL_SMTP_DATA_TIMEOUT_MS` | 10000, 10000, 30000 | Phase timeouts |
 */
export interface MailEnv {
  NODE_ENV?: string | undefined;
  PUBLIC_ORIGIN?: string | undefined;
  [key: string]: string | undefined;
}

export interface MailConfig {
  transport: 'fake' | 'log' | 'smtp';
  smtp: SmtpConfig | null;
  /** 32+ byte key material (the repository derives the AES key from it). */
  secretKey: Buffer;
  from: string;
  replyTo: string | null;
  render: RenderConfig;
  limits: { recipientPerHour: number; perMinute: number };
  /** Domain of Message-IDs (`<delivery id>@<domain>`). */
  messageIdDomain: string;
}

function integer(env: MailEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}

const LINK_ENV: Record<LinkKind, string> = { compliance: 'MAIL_LINK_COMPLIANCE', verifyEmail: 'MAIL_LINK_VERIFY_EMAIL', emailChange: 'MAIL_LINK_EMAIL_CHANGE', recovery: 'MAIL_LINK_RECOVERY', invitation: 'MAIL_LINK_INVITATION', signIn: 'MAIL_LINK_SIGN_IN', recover: 'MAIL_LINK_RECOVER' };
const SIMPLE_ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

export function mailConfigFromEnv(env: MailEnv): MailConfig {
  const production = env.NODE_ENV === 'production';
  const transport = (env.MAIL_TRANSPORT?.trim() || 'fake') as MailConfig['transport'];
  if (!['fake', 'log', 'smtp'].includes(transport)) throw new Error('MAIL_TRANSPORT must be fake, log or smtp');
  if (transport === 'log' && production) throw new Error('MAIL_TRANSPORT=log prints one-time links and is not allowed with NODE_ENV=production');

  const originRaw = env.MAIL_PUBLIC_ORIGIN?.trim() || env.PUBLIC_ORIGIN?.trim() || (transport === 'smtp' ? '' : 'http://localhost:3000');
  if (!originRaw) throw new Error('MAIL_PUBLIC_ORIGIN (or PUBLIC_ORIGIN) is required for MAIL_TRANSPORT=smtp');
  let origin: URL;
  try {
    origin = new URL(originRaw);
  } catch {
    throw new Error('MAIL_PUBLIC_ORIGIN must be an absolute URL');
  }
  if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error('MAIL_PUBLIC_ORIGIN must be an origin without path, query or fragment');
  if (production && origin.protocol !== 'https:') throw new Error('MAIL_PUBLIC_ORIGIN must use https in production');

  const from = env.MAIL_FROM_ADDRESS?.trim() || (transport === 'smtp' ? '' : `no-reply@${origin.hostname.includes('.') ? origin.hostname : 'localhost.invalid'}`);
  if (!from) throw new Error('MAIL_FROM_ADDRESS is required for MAIL_TRANSPORT=smtp');
  if (!SIMPLE_ADDRESS.test(from)) throw new Error('MAIL_FROM_ADDRESS must be a plain address (the display name is the brand)');
  const replyTo = env.MAIL_REPLY_TO?.trim() || null;
  if (replyTo && !SIMPLE_ADDRESS.test(replyTo)) throw new Error('MAIL_REPLY_TO must be a plain address');

  const locales = env.MAIL_LOCALES?.trim() ? env.MAIL_LOCALES.split(',').map((l) => l.trim()).filter(Boolean) : [...MAIL_LOCALES];
  for (const locale of locales) if (!MAIL_LOCALES.includes(locale)) throw new Error(`MAIL_LOCALES: no mail dictionary for ${locale}`);
  const defaultLocale = env.MAIL_DEFAULT_LOCALE?.trim() || 'en';
  if (!locales.includes(defaultLocale)) throw new Error('MAIL_DEFAULT_LOCALE must be one of MAIL_LOCALES');

  const overlayRaw = env.TRUSTWORK_BRAND?.trim() || 'stroyreputation-ru';
  const brandOverlay = overlayRaw === 'none' ? null : overlayRaw;
  if (brandOverlay && !BRAND_OVERLAYS[brandOverlay]) throw new Error(`TRUSTWORK_BRAND: unknown brand overlay ${brandOverlay}`);
  const brandName = env.MAIL_BRAND_NAME?.trim() || null;
  if (brandName && (brandName.length > 80 || /[\r\n<>]/.test(brandName))) throw new Error('MAIL_BRAND_NAME must be a short single-line name');

  const paths = { ...DEFAULT_LINK_PATHS };
  for (const [kind, key] of Object.entries(LINK_ENV) as [LinkKind, string][]) {
    const value = env[key]?.trim();
    if (!value) continue;
    if (!value.startsWith('/') || value.startsWith('//')) throw new Error(`${key} must be a path starting with a single /`);
    paths[kind] = value;
  }

  let smtp: SmtpConfig | null = null;
  if (transport === 'smtp') {
    const host = env.MAIL_SMTP_HOST?.trim();
    if (!host) throw new Error('MAIL_SMTP_HOST is required for MAIL_TRANSPORT=smtp');
    const security = (env.MAIL_SMTP_SECURITY?.trim() || 'starttls') as SmtpConfig['security'];
    if (!['starttls', 'tls', 'none'].includes(security)) throw new Error('MAIL_SMTP_SECURITY must be starttls, tls or none');
    if (security === 'none' && production && !isLoopbackHost(host)) throw new Error('MAIL_SMTP_SECURITY=none is allowed only for a loopback relay in production');
    const user = env.MAIL_SMTP_USER ?? '';
    const password = env.MAIL_SMTP_PASSWORD ?? '';
    if (Boolean(user) !== Boolean(password)) throw new Error('MAIL_SMTP_USER and MAIL_SMTP_PASSWORD go together');
    if (user && security === 'none' && !isLoopbackHost(host)) throw new Error('SMTP credentials are never sent without TLS to a non-loopback host');
    smtp = {
      host,
      port: integer(env, 'MAIL_SMTP_PORT', security === 'tls' ? 465 : 587, 1, 65535),
      security,
      auth: user ? { user, password } : null,
      clientName: (env.MAIL_SMTP_CLIENT_NAME?.trim() || hostname() || 'trustwork-worker').replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 200),
      connectTimeoutMs: integer(env, 'MAIL_SMTP_CONNECT_TIMEOUT_MS', DEFAULT_SMTP_TIMEOUTS.connectTimeoutMs, 100, 120_000),
      commandTimeoutMs: integer(env, 'MAIL_SMTP_COMMAND_TIMEOUT_MS', DEFAULT_SMTP_TIMEOUTS.commandTimeoutMs, 100, 120_000),
      dataTimeoutMs: integer(env, 'MAIL_SMTP_DATA_TIMEOUT_MS', DEFAULT_SMTP_TIMEOUTS.dataTimeoutMs, 100, 600_000),
      ca: env.MAIL_SMTP_CA_PEM || undefined,
    };
  }

  return {
    transport,
    smtp,
    secretKey: mailSecretKeyFromEnv(env),
    from,
    replyTo,
    render: { defaultLocale, locales, brandName, brandOverlay, links: { origin: origin.origin, paths } },
    limits: { recipientPerHour: integer(env, 'MAIL_RECIPIENT_LIMIT_PER_HOUR', 10, 1, 10_000), perMinute: integer(env, 'MAIL_SEND_LIMIT_PER_MINUTE', 120, 1, 1_000_000) },
    messageIdDomain: from.slice(from.lastIndexOf('@') + 1),
  };
}
