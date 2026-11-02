import { z } from 'zod';
import { AllowedUsesSchema, type AllowedUses } from './hub.js';
import { evaluateRobots, intersectUses, MOST_RESTRICTIVE_USES, type RslReading } from './sources.js';

/**
 * The pre-collection gate (SRC-002; docs/engine/editorial-office.md, docs/engine/hub-console/autonomous-editorial.md
 * "Sources", ADR 026 decision 1). Before any request for a URL leaves the node, the gate decides whether it may be
 * fetched and for which uses, from the source's registry state (SRC-001), restricted places, access barriers,
 * robots.txt (RFC 9309), the recorded terms and legal basis, the licence flags, RSL, the IETF Content-Usage signal and
 * TDMRep reservations. The decision travels with every run.
 *
 * One rule runs through every reading: an unknown, unparsable or conflicting signal narrows the allowed uses to the most
 * restrictive reading, and a robots.txt that cannot be fetched (5xx, timeout) disallows everything. A changed digest of
 * any signal is a reason to pause the source until a person re-checks it (SRC-001 already pauses on a robots or terms
 * change). Nothing here fetches: the worker adapter (apps/worker/src/collect) feeds the readings in.
 */

export const COLLECTION_VERDICTS = ['allow', 'deny', 'wait'] as const;
export const CollectionVerdictSchema = z.enum(COLLECTION_VERDICTS);
export type CollectionVerdict = z.infer<typeof CollectionVerdictSchema>;

export const COLLECTION_REASONS = [
  // Registry and law: nothing is fetched.
  'source_not_active', 'restricted_place', 'terms_unchecked', 'terms_forbid_automated', 'legal_basis_missing', 'signal_changed',
  // Barriers: never collect behind a login, a paywall or a challenge.
  'barrier_login', 'barrier_paywall', 'barrier_challenge',
  // Robots.
  'robots_disallow', 'robots_unavailable',
  // Uses narrowed (the fetch may proceed for the remaining uses).
  'tdm_reserved', 'content_usage_restricts', 'rsl_restricts', 'signal_unparsable', 'signal_conflict',
  // Politeness.
  'host_wait',
] as const;
export const CollectionReasonSchema = z.enum(COLLECTION_REASONS);
export type CollectionReason = z.infer<typeof CollectionReasonSchema>;

/** Reasons that stop the fetch outright; every other reason only narrows uses or delays. */
export const DENY_REASONS: readonly CollectionReason[] = [
  'source_not_active', 'restricted_place', 'terms_unchecked', 'terms_forbid_automated', 'legal_basis_missing', 'signal_changed', 'barrier_login', 'barrier_paywall',
  'barrier_challenge', 'robots_disallow', 'robots_unavailable',
];

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SignalDigestsSchema = z.strictObject({
  robots: Digest.nullable(), terms: Digest.nullable(), rsl: Digest.nullable(), tdm: Digest.nullable(), contentUsage: Digest.nullable(),
});
export type SignalDigests = z.infer<typeof SignalDigestsSchema>;

export const CollectionDecisionSchema = z.strictObject({
  verdict: CollectionVerdictSchema,
  reasons: z.array(CollectionReasonSchema),
  /** The uses the fetched content may serve: never more than the source's flags. */
  allowedUses: AllowedUsesSchema,
  waitUntil: z.iso.datetime().nullable(),
  /** The digests of the signals this decision read (recorded with the run). */
  digests: SignalDigestsSchema,
  changed: z.array(z.enum(['robots', 'terms', 'rsl', 'tdm', 'contentUsage'])),
}).refine((d) => (d.verdict === 'wait') === (d.waitUntil !== null), { message: 'only a wait names when to try again', path: ['waitUntil'] })
  .refine((d) => d.verdict !== 'allow' || !d.reasons.some((r) => DENY_REASONS.includes(r)), { message: 'a deny reason never allows', path: ['verdict'] });
export type CollectionDecision = z.infer<typeof CollectionDecisionSchema>;

/* ---------- TDMRep (W3C Community Group final report) ---------- */

/** Uses that text-and-data mining covers: a TDM reservation (EU DSM directive article 4) closes them. */
export const TDM_GOVERNED_USES: readonly (keyof AllowedUses)[] = ['storeFullText', 'sendToModelProviders', 'rewriteWithAttribution', 'translate'];
export interface TdmReading { status: 'none' | 'reserved' | 'not_reserved' | 'unparsable' | 'conflict'; policyUrl: string | null }

/**
 * The TDMRep reading for a URL path from the `tdm-reservation` / `tdm-policy` response headers and the site's
 * `/.well-known/tdmrep.json` (an array of `{ location, tdm-reservation, tdm-policy }`, the first matching location
 * wins). Headers and file that disagree are a conflict; anything unreadable is unparsable.
 */
export function readTdm(input: { headers: Readonly<Record<string, string | undefined>>; wellKnown: string | null; path: string }): TdmReading {
  const header = input.headers['tdm-reservation'];
  const fromHeader: TdmReading | null = header === undefined ? null
    : header.trim() === '1' ? { status: 'reserved', policyUrl: input.headers['tdm-policy']?.trim() || null }
      : header.trim() === '0' ? { status: 'not_reserved', policyUrl: null } : { status: 'unparsable', policyUrl: null };
  let fromFile: TdmReading | null = null;
  if (input.wellKnown !== null) {
    try {
      const rules = JSON.parse(input.wellKnown) as unknown;
      if (!Array.isArray(rules)) throw new Error('not an array');
      for (const rule of rules as Array<Record<string, unknown>>) {
        const location = typeof rule.location === 'string' ? rule.location : null;
        if (location === null) throw new Error('location missing');
        const pattern = new RegExp(`^${location.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}`);
        if (!pattern.test(input.path)) continue;
        const reservation = rule['tdm-reservation'];
        fromFile = reservation === 1 ? { status: 'reserved', policyUrl: typeof rule['tdm-policy'] === 'string' ? rule['tdm-policy'] : null }
          : reservation === 0 ? { status: 'not_reserved', policyUrl: null } : { status: 'unparsable', policyUrl: null };
        break;
      }
    } catch {
      fromFile = { status: 'unparsable', policyUrl: null };
    }
  }
  if (fromHeader && fromFile && fromHeader.status !== fromFile.status) return { status: 'conflict', policyUrl: fromHeader.policyUrl ?? fromFile.policyUrl };
  return fromHeader ?? fromFile ?? { status: 'none', policyUrl: null };
}

/* ---------- Content-Usage (IETF AI preferences vocabulary) ---------- */

/** The categories the gate understands; an unknown category is ignored, an unreadable header is unparsable. */
export const CONTENT_USAGE_CATEGORIES = ['tdm', 'ai', 'genai', 'search'] as const;
export interface ContentUsageReading { status: 'none' | 'parsed' | 'unparsable'; preferences: Partial<Record<(typeof CONTENT_USAGE_CATEGORIES)[number], boolean>> }

/** `Content-Usage: tdm=n, search=y` (structured-field dictionary of y / n tokens). */
export function readContentUsage(header: string | undefined): ContentUsageReading {
  if (header === undefined || header.trim() === '') return { status: 'none', preferences: {} };
  const preferences: ContentUsageReading['preferences'] = {};
  for (const part of header.split(',')) {
    const m = /^\s*([a-z][a-z0-9_-]{0,30})\s*=\s*([yn])\s*(?:;.*)?$/.exec(part);
    if (!m) return { status: 'unparsable', preferences: {} };
    const key = m[1] as string;
    if ((CONTENT_USAGE_CATEGORIES as readonly string[]).includes(key)) {
      const value = m[2] === 'y';
      const previous = preferences[key as (typeof CONTENT_USAGE_CATEGORIES)[number]];
      if (previous !== undefined && previous !== value) return { status: 'unparsable', preferences: {} };
      preferences[key as (typeof CONTENT_USAGE_CATEGORIES)[number]] = value;
    }
  }
  return { status: 'parsed', preferences };
}

/* ---------- Barriers ---------- */

export type Barrier = 'login' | 'paywall' | 'challenge';
/**
 * A login wall, paywall or bot challenge in a response: 401 or a WWW-Authenticate header, a redirect to a sign-in
 * page, a structured-data paywall marker (`"isAccessibleForFree": false`), or a challenge page. The gate refuses to
 * collect behind any of them, whatever robots.txt says.
 */
export function detectBarrier(response: { status: number; headers: Readonly<Record<string, string | undefined>>; finalUrl: string; bodyStart: string }): Barrier | null {
  const body = response.bodyStart.slice(0, 200_000);
  if (/cf-chl-|cf_chl_|g-recaptcha|hcaptcha|data-sitekey=|challenge-platform|captcha-delivery/i.test(body) || (response.status === 403 && /captcha|challenge/i.test(body))) return 'challenge';
  if (response.status === 401 || response.headers['www-authenticate'] !== undefined) return 'login';
  const final = new URL(response.finalUrl);
  if (/\/(log-?in|sign-?in|account\/login|auth\/login|sso)(\/|$)/i.test(final.pathname)) return 'login';
  if (/"isAccessibleForFree"\s*:\s*(false|"false")/i.test(body) || response.status === 402) return 'paywall';
  return null;
}

/* ---------- The gate ---------- */

export interface RobotsInput { status: 'ok' | 'not_found' | 'unavailable'; body: string | null }
export interface CollectionInput {
  url: string;
  userAgent: string;
  source: {
    status: string;
    allowedUses: AllowedUses;
    /** SRC-001 terms check: `permitted` lets automated access; `not_applicable` covers APIs and feeds. */
    termsAutomatedAccess: 'permitted' | 'forbidden' | 'unclear' | 'not_applicable' | null;
    personalData: boolean;
    legalBasis: string | null;
    recorded: SignalDigests;
  };
  restrictedPlace: boolean;
  robots: RobotsInput;
  rsl: RslReading | null;
  tdm: TdmReading;
  contentUsage: ContentUsageReading;
  barrier: Barrier | null;
  digests: SignalDigests;
  /** The host's next polite slot (crawl delay, backoff, Retry-After); null when the host is free now. */
  hostFreeAt: Date | null;
  now: Date;
}

function narrow(uses: AllowedUses, closed: readonly (keyof AllowedUses)[]): AllowedUses {
  const out = { ...uses };
  for (const k of closed) out[k] = false;
  return out;
}

/** The pure decision: deny reasons first, then the narrowing signals, then politeness. */
export function decideCollection(input: CollectionInput): CollectionDecision {
  const reasons: CollectionReason[] = [];
  const s = input.source;
  if (s.status !== 'active') reasons.push('source_not_active');
  if (input.restrictedPlace) reasons.push('restricted_place');
  if (s.termsAutomatedAccess === null) reasons.push('terms_unchecked');
  else if (s.termsAutomatedAccess === 'forbidden' || s.termsAutomatedAccess === 'unclear') reasons.push('terms_forbid_automated');
  if (s.personalData && !s.legalBasis) reasons.push('legal_basis_missing');
  const changed = (['robots', 'terms', 'rsl', 'tdm', 'contentUsage'] as const).filter((k) => s.recorded[k] !== null && input.digests[k] !== null && s.recorded[k] !== input.digests[k]);
  if (changed.length > 0) reasons.push('signal_changed');
  if (input.barrier) reasons.push(input.barrier === 'login' ? 'barrier_login' : input.barrier === 'paywall' ? 'barrier_paywall' : 'barrier_challenge');
  const path = (() => { const u = new URL(input.url); return u.pathname + u.search; })();
  let crawlDelay: number | null = null;
  if (input.robots.status === 'unavailable') reasons.push('robots_unavailable');
  else if (input.robots.status === 'ok') {
    const robots = evaluateRobots(input.robots.body ?? '', input.userAgent, path);
    if (!robots.allowed) reasons.push('robots_disallow');
    crawlDelay = robots.crawlDelaySeconds;
  }
  // RFC 9309: a missing robots.txt (4xx) allows everything.

  let uses: AllowedUses = { ...s.allowedUses };
  if (input.rsl) {
    if (input.rsl.status !== 'parsed') { uses = { ...MOST_RESTRICTIVE_USES }; reasons.push('signal_unparsable'); }
    else {
      const before = JSON.stringify(uses);
      uses = intersectUses(uses, input.rsl.ceiling);
      if (JSON.stringify(uses) !== before) reasons.push('rsl_restricts');
    }
  }
  if (input.tdm.status === 'reserved') { uses = narrow(uses, TDM_GOVERNED_USES); reasons.push('tdm_reserved'); }
  else if (input.tdm.status === 'unparsable' || input.tdm.status === 'conflict') { uses = { ...MOST_RESTRICTIVE_USES }; reasons.push(input.tdm.status === 'conflict' ? 'signal_conflict' : 'signal_unparsable'); }
  if (input.contentUsage.status === 'unparsable') { uses = { ...MOST_RESTRICTIVE_USES }; reasons.push('signal_unparsable'); }
  else if (input.contentUsage.status === 'parsed') {
    const p = input.contentUsage.preferences;
    const closed: (keyof AllowedUses)[] = [];
    if (p.tdm === false) closed.push(...TDM_GOVERNED_USES);
    if (p.ai === false || p.genai === false) closed.push('sendToModelProviders', 'rewriteWithAttribution');
    if (p.search === false) closed.push('indexForSearch');
    if (closed.length) { uses = narrow(uses, closed); reasons.push('content_usage_restricts'); }
    // A TDMRep "not reserved" against a Content-Usage "tdm=n" is a conflict: the stricter reading already applies.
    if (input.tdm.status === 'not_reserved' && p.tdm === false) reasons.push('signal_conflict');
  }

  const unique = [...new Set(reasons)];
  const deny = unique.some((r) => DENY_REASONS.includes(r));
  // The crawl delay is applied by HostPoliteness after each response; here only the host's next slot counts.
  void crawlDelay;
  const delayUntil = input.hostFreeAt;
  const wait = !deny && delayUntil !== null && delayUntil.getTime() > input.now.getTime();
  if (wait) unique.push('host_wait');
  return CollectionDecisionSchema.parse({
    verdict: deny ? 'deny' : wait ? 'wait' : 'allow',
    reasons: unique,
    allowedUses: deny ? { ...MOST_RESTRICTIVE_USES } : uses,
    waitUntil: wait ? (delayUntil as Date).toISOString() : null,
    digests: input.digests,
    changed,
  });
}

/* ---------- Politeness ---------- */

/** The stable bot identity: a product token and a contact page (the hub's own URL). */
export function botUserAgent(contactUrl: string, version = '1'): string {
  return `TrustworkBot/${version} (+${contactUrl})`;
}

export interface HostState { inFlight: number; nextAt: number; failures: number }
/**
 * Per-host politeness: one request in flight by default, the robots crawl delay (at least one second), exponential
 * backoff on 429 and 503 that honours Retry-After (seconds or an HTTP date, capped at a day), and a reset on success.
 */
export class HostPoliteness {
  private readonly hosts = new Map<string, HostState>();
  constructor(private readonly maxConcurrent = 1) {}

  private state(host: string): HostState {
    let s = this.hosts.get(host);
    if (!s) { s = { inFlight: 0, nextAt: 0, failures: 0 }; this.hosts.set(host, s); }
    return s;
  }

  /** When the host may be asked next (null: now). */
  freeAt(host: string, now: number): Date | null {
    const s = this.state(host);
    if (s.inFlight >= this.maxConcurrent) return new Date(Math.max(now + 1000, s.nextAt));
    return s.nextAt > now ? new Date(s.nextAt) : null;
  }

  start(host: string): void {
    this.state(host).inFlight += 1;
  }

  finish(host: string, now: number, response: { status: number; retryAfter: string | null }, crawlDelaySeconds: number | null): void {
    const s = this.state(host);
    s.inFlight = Math.max(0, s.inFlight - 1);
    const delay = Math.max(1, crawlDelaySeconds ?? 1) * 1000;
    if (response.status === 429 || response.status === 503) {
      s.failures += 1;
      const retry = parseRetryAfter(response.retryAfter, now);
      const backoff = Math.min(86_400_000, 2 ** Math.min(s.failures, 16) * 1000);
      s.nextAt = now + Math.min(86_400_000, Math.max(delay, backoff, retry ?? 0));
    } else {
      s.failures = 0;
      s.nextAt = now + delay;
    }
  }
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  if (/^\d{1,9}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
