import { z } from 'zod';
import { Sha256HexSchema } from './common/digest-schema.js';
import { IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { GlobalIdSchema, TAKEDOWN_REASONS } from './federation.js';
import {
  AllowedUsesSchema, consoleCommand, CRAWLING_SOURCE_KINDS, FORBIDDEN_CONTROL_WORDS, HubSourceKindSchema, HubSourceSchema, LegalBasisSchema, LocaleTagSchema, ProposerSchema,
  RobotsCheckSchema, SourceLicenceSchema, SourcePauseReasonSchema, SourcePurposeSchema, SourceStatusSchema, TermsCheckSchema, type AllowedUses, type HubSource,
} from './hub.js';

/**
 * Hub source registry (SRC-001; docs/engine/publishing.md "Hub sources", docs/engine/hub-console/autonomous-editorial.md
 * sections 1 and 2, docs/data/model.md section 24; ADR 010 decision 19, ADR 012 decision 3).
 *
 * Additive to the frozen console contract `hub.ts`: the licence model is the console's `AllowedUsesSchema` (the same
 * flags CNT-001 checks before it publishes), the source read model keeps every `HubSourceSchema` field, and robots and
 * terms checks are the console's `RobotsCheckSchema` and `TermsCheckSchema`. This file adds what the registry needs on
 * top: the licence rules as one function the database mirrors, RSL 1.0 and robots.txt readers (pure, no network),
 * import batches and the human review queue, sourced record fields with provenance, record link proposals, takedowns
 * with tombstones, the per-hub sponsored content policy, the egress rule for model providers and peers, and the console
 * commands and views of the registry routes.
 *
 * Invariants (tested in tests/contracts/sources.test.ts and on PostgreSQL in tests/sources):
 * - imported items are drafts in a review queue; only a person turns one into a publication draft or discards it;
 * - a source licensed only for display never reaches a model provider or a peer;
 * - RSL terms are suggestions an editor confirms; the registry never applies a reading more permissive than the
 *   terms, and a document it cannot read gives the most restrictive flags;
 * - sponsored content is off by default, always labelled, and never a signal for ranking, matching or recommendations.
 */

/* ---------- Licence flags ---------- */

/** The licence flags in their contract order (`AllowedUsesSchema`). */
export const USE_KEYS = Object.keys(AllowedUsesSchema.shape) as (keyof AllowedUses)[];
export type UseKey = keyof AllowedUses;
/** Every flag off: what an unreadable RSL document, an unknown licence term or a taken-down source leaves. */
export const MOST_RESTRICTIVE_USES: AllowedUses = Object.freeze(Object.fromEntries(USE_KEYS.map((k) => [k, false])) as AllowedUses);
/** Every flag on (a test and ceiling helper; no source starts with it). */
export const ALL_USES: AllowedUses = Object.freeze(Object.fromEntries(USE_KEYS.map((k) => [k, true])) as AllowedUses);
/** Licences that allow only a headline with a link, a short summary and search indexing (`HubSourceSchema`). */
export const RESTRICTIVE_LICENCE_KINDS = ['all_rights_reserved', 'unknown'] as const;
/** Flags a source without a licence never holds. */
export const NO_LICENCE_FORBIDDEN_USES: readonly UseKey[] = ['storeFullText', 'sendToModelProviders', 'rewriteWithAttribution', 'syndicateToPeers', 'reuseImages', 'translate'];

/** Per-flag AND: the stricter of two readings. */
export function intersectUses(a: AllowedUses, b: AllowedUses): AllowedUses {
  return Object.fromEntries(USE_KEYS.map((k) => [k, a[k] && b[k]])) as AllowedUses;
}
/** Flags `uses` holds that `ceiling` does not allow. */
export function usesAbove(uses: AllowedUses, ceiling: AllowedUses): UseKey[] {
  return USE_KEYS.filter((k) => uses[k] && !ceiling[k]);
}

export const SourceLicenceKindSchema = SourceLicenceSchema.shape.kind;
export type SourceLicenceKind = z.infer<typeof SourceLicenceKindSchema>;

/**
 * Why a set of allowed uses cannot be confirmed for a source (empty = it can). The database refuses the same cases
 * (`sources_uses_problems`). An RSL ceiling binds unless a publisher agreement is on record: a contract with the
 * publisher is the only thing that overrides its machine-readable terms.
 */
export function allowedUsesProblems(licence: { kind: SourceLicenceKind; agreementRef: string | null }, uses: AllowedUses, rslCeiling: AllowedUses | null): string[] {
  const out: string[] = [];
  if ((RESTRICTIVE_LICENCE_KINDS as readonly string[]).includes(licence.kind) && NO_LICENCE_FORBIDDEN_USES.some((k) => uses[k])) out.push('licence_restricts_use');
  if (uses.rewriteWithAttribution && !uses.storeFullText) out.push('rewrite_needs_full_text');
  if (rslCeiling && !(licence.kind === 'publisher_agreement' && licence.agreementRef !== null) && usesAbove(uses, rslCeiling).length > 0) out.push('rsl_forbids_use');
  return out;
}

/* ---------- Egress: model providers and peers ---------- */

export const EGRESS_CHANNELS = ['model_provider', 'peer'] as const;
export const EgressChannelSchema = z.enum(EGRESS_CHANNELS);
export type EgressChannel = z.infer<typeof EgressChannelSchema>;
/**
 * The refusal for sending an item over a channel, or null when its licence allows it. The effective uses are the
 * stricter of the item's licence snapshot and the source's current flags (a later narrowing applies to old copies, a
 * later widening never re-legitimises them).
 */
export function egressBlocker(effective: AllowedUses, channel: EgressChannel): 'licence_forbids_model_use' | 'licence_forbids_syndication' | null {
  if (channel === 'model_provider') return effective.sendToModelProviders ? null : 'licence_forbids_model_use';
  return effective.syndicateToPeers ? null : 'licence_forbids_syndication';
}

/* ---------- RSL 1.0 (Really Simple Licensing) ---------- */

export const RSL_NAMESPACE = 'https://rslstandard.org/rsl';
/** RSL 1.0 usage tokens. `all` and `ai-all` expand to the tokens they cover. */
export const RSL_USAGES = ['all', 'ai-all', 'ai-train', 'ai-input', 'ai-index', 'search'] as const;
type RslUsage = (typeof RSL_USAGES)[number];
const BASE_USAGES: readonly RslUsage[] = ['ai-train', 'ai-input', 'ai-index', 'search'];
const EXPAND: Readonly<Record<RslUsage, readonly RslUsage[]>> = {
  all: BASE_USAGES, 'ai-all': ['ai-train', 'ai-input', 'ai-index'], 'ai-train': ['ai-train'], 'ai-input': ['ai-input'], 'ai-index': ['ai-index'], search: ['search'],
};
/** Payment types a hub satisfies without a purchase (anything else needs a publisher agreement). */
const FREE_PAYMENTS = new Set(['free', 'attribution']);
/** Elements that carry information only (no condition the hub must evaluate). */
const INFORMATIONAL = new Set(['legal', 'copyright', 'terms', 'schema', 'alternate', 'standard', 'custom', 'amount']);
/** The flags RSL speaks to: search results (headline, link, index) and AI input (model providers need input and indexing). */
export const RSL_GOVERNED_USES: readonly UseKey[] = ['displayHeadlineAndLink', 'indexForSearch', 'sendToModelProviders'];
export const RSL_MAX_BYTES = 65_536;

export const RslStatusSchema = z.enum(['absent', 'parsed', 'failed', 'no_matching_content']);
export type RslStatus = z.infer<typeof RslStatusSchema>;
/**
 * A reading of a source's RSL document. `ceiling` is the most the terms allow (flags RSL does not speak to stay open
 * when the document was read, and close when it was not); `suggested` is what the registry proposes for the editor to
 * confirm: the ceiling on RSL-governed flags, every other flag off. A failed or unmatched reading closes everything.
 */
export const RslReadingSchema = z.strictObject({
  status: RslStatusSchema.exclude(['absent']),
  permittedUsages: z.array(z.enum(['ai-train', 'ai-input', 'ai-index', 'search'])),
  ceiling: AllowedUsesSchema,
  suggested: AllowedUsesSchema,
  problem: z.string().max(200).nullable(),
}).refine((r) => r.status === 'parsed' || USE_KEYS.every((k) => !r.ceiling[k] && !r.suggested[k]), { message: 'an unreadable or unmatched document gives the most restrictive flags', path: ['ceiling'] })
  .refine((r) => usesAbove(r.suggested, r.ceiling).length === 0, { message: 'a suggestion never exceeds the terms', path: ['suggested'] });
export type RslReading = z.infer<typeof RslReadingSchema>;

interface XmlElement { name: string; attrs: Record<string, string>; children: XmlElement[]; text: string }

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(value: string): string {
  return value.replace(/&([^;]{1,10});/g, (_, ref: string) => {
    if (ref in ENTITY) return ENTITY[ref] as string;
    const m = /^#(x[0-9a-fA-F]{1,6}|[0-9]{1,7})$/.exec(ref);
    if (!m) throw new Error('unknown entity');
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** A deliberately small XML reader: elements, attributes, text, comments and the declaration. DTDs, CDATA and processing instructions are refused. */
function parseXml(input: string): XmlElement {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(input)) throw new Error('document type declarations and CDATA are refused');
  let i = 0;
  const text = input.replace(/^﻿/, '');
  const skipMisc = () => {
    for (;;) {
      const rest = text.slice(i);
      const ws = /^\s+/.exec(rest);
      if (ws) { i += ws[0].length; continue; }
      if (rest.startsWith('<!--')) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) throw new Error('unterminated comment');
        i = end + 3;
        continue;
      }
      if (rest.startsWith('<?xml')) {
        if (i !== 0 && text.slice(0, i).trim() !== '') throw new Error('misplaced declaration');
        const end = text.indexOf('?>', i);
        if (end < 0) throw new Error('unterminated declaration');
        i = end + 2;
        continue;
      }
      return;
    }
  };
  const NAME = /^[A-Za-z_][A-Za-z0-9._:-]*/;
  const parseElement = (): XmlElement => {
    if (text[i] !== '<') throw new Error('element expected');
    i += 1;
    const nameMatch = NAME.exec(text.slice(i));
    if (!nameMatch) throw new Error('element name expected');
    const name = nameMatch[0];
    i += name.length;
    const attrs: Record<string, string> = {};
    for (;;) {
      const ws = /^\s*/.exec(text.slice(i));
      i += ws ? ws[0].length : 0;
      if (text.startsWith('/>', i)) { i += 2; return { name, attrs, children: [], text: '' }; }
      if (text[i] === '>') { i += 1; break; }
      const attr = /^([A-Za-z_][A-Za-z0-9._:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(text.slice(i));
      if (!attr) throw new Error('malformed attribute');
      const key = attr[1] as string;
      if (key in attrs) throw new Error('duplicate attribute');
      attrs[key] = decodeEntities(attr[3] ?? attr[4] ?? '');
      i += attr[0].length;
    }
    const children: XmlElement[] = [];
    let body = '';
    for (;;) {
      if (i >= text.length) throw new Error(`unterminated element ${name}`);
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) throw new Error('unterminated comment');
        i = end + 3;
      } else if (text.startsWith('</', i)) {
        const close = new RegExp(`^</${name.replace(/[.]/g, '\\.')}\\s*>`).exec(text.slice(i));
        if (!close) throw new Error(`mismatched end tag for ${name}`);
        i += close[0].length;
        return { name, attrs, children, text: decodeEntities(body).trim() };
      } else if (text[i] === '<') {
        if (text.startsWith('<?', i)) throw new Error('processing instructions are refused');
        children.push(parseElement());
      } else {
        const next = text.indexOf('<', i);
        if (next < 0) throw new Error(`unterminated element ${name}`);
        body += text.slice(i, next);
        i = next;
      }
    }
  };
  skipMisc();
  const root = parseElement();
  skipMisc();
  if (i !== text.length) throw new Error('content after the root element');
  return root;
}

/** Strips the RSL namespace prefix (default namespace or a prefix declared on the root); other namespaces are refused. */
function rslTree(root: XmlElement): XmlElement {
  let prefix: string | null = null;
  const [rootPrefix, rootLocal] = root.name.includes(':') ? root.name.split(':', 2) as [string, string] : [null, root.name];
  if (rootPrefix === null) {
    if (root.attrs.xmlns !== RSL_NAMESPACE) throw new Error('the root is not an RSL 1.0 document');
  } else if (root.attrs[`xmlns:${rootPrefix}`] === RSL_NAMESPACE) {
    prefix = rootPrefix;
  } else {
    throw new Error('the root is not an RSL 1.0 document');
  }
  if (rootLocal !== 'rsl') throw new Error('the root element is not rsl');
  const strip = (e: XmlElement): XmlElement => {
    // Namespace declarations are scoped in XML. Refuse rebinding instead of interpreting foreign terms as RSL.
    for (const [key, value] of Object.entries(e.attrs)) {
      if ((key === 'xmlns' || key.startsWith('xmlns:')) && (key !== (prefix === null ? 'xmlns' : `xmlns:${prefix}`) || value !== RSL_NAMESPACE)) {
        throw new Error('foreign or rebound namespace');
      }
    }
    let local = e.name;
    if (e.name.includes(':')) {
      const [p, l] = e.name.split(':', 2) as [string, string];
      if (p !== prefix) throw new Error(`element ${e.name} is outside the RSL namespace`);
      local = l;
    } else if (prefix !== null) {
      throw new Error(`element ${e.name} is outside the RSL namespace`);
    }
    return { ...e, name: local, children: e.children.map(strip) };
  };
  return strip(root);
}

function usageTokens(value: string): RslUsage[] {
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('an empty usage list');
  return tokens.map((t) => {
    if (!(RSL_USAGES as readonly string[]).includes(t)) throw new Error(`unknown usage ${t}`);
    return t as RslUsage;
  });
}

/** Does an RSL content `url` pattern cover the source URL? Relative patterns resolve against the source's origin; `*` and a final `$` follow robots.txt. Returns the pattern length, or -1. */
function contentMatch(pattern: string, sourceUrl: URL): number {
  let absolute: string;
  try {
    absolute = new URL(pattern.replace(/\$$/, ''), sourceUrl.origin).href;
  } catch {
    throw new Error('a content url is not a URL');
  }
  const anchored = pattern.endsWith('$');
  const target = sourceUrl.href;
  const re = new RegExp(`^${absolute.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(target) ? absolute.length : -1;
}

/** Usages one licence grants without paying, or null when the hub cannot satisfy its conditions. */
function licenceUsages(licence: XmlElement): Set<RslUsage> | null {
  let permits: Set<RslUsage> | null = null;
  const prohibited = new Set<RslUsage>();
  for (const el of licence.children) {
    if (INFORMATIONAL.has(el.name)) continue;
    if (el.name === 'payment') {
      const type = el.attrs.type ?? 'purchase';
      if (!FREE_PAYMENTS.has(type)) return null;
      continue;
    }
    if (el.name !== 'permits' && el.name !== 'prohibits') throw new Error(`unknown licence element ${el.name}`);
    const type = el.attrs.type;
    if (type === 'usage') {
      const tokens = usageTokens(el.text).flatMap((t) => EXPAND[t]);
      if (el.name === 'permits') permits = new Set([...(permits ?? []), ...tokens]);
      else tokens.forEach((t) => prohibited.add(t));
    } else if (type === 'user') {
      const users = el.text.split(/[\s,]+/).filter(Boolean);
      if (el.name === 'permits' ? !users.includes('commercial') : users.includes('commercial')) return null;
    } else {
      // Geographic and any other restriction: the hub does not evaluate it, so the licence does not count.
      return null;
    }
  }
  const granted = new Set<RslUsage>(permits ?? BASE_USAGES);
  for (const p of prohibited) granted.delete(p);
  return granted;
}

function readingOf(status: RslReading['status'], usages: Set<RslUsage>, problem: string | null): RslReading {
  if (status !== 'parsed') return { status, permittedUsages: [], ceiling: { ...MOST_RESTRICTIVE_USES }, suggested: { ...MOST_RESTRICTIVE_USES }, problem };
  const governed: Record<string, boolean> = {
    displayHeadlineAndLink: usages.has('search'),
    indexForSearch: usages.has('search'),
    sendToModelProviders: usages.has('ai-input') && usages.has('ai-index'),
  };
  const ceiling = Object.fromEntries(USE_KEYS.map((k) => [k, k in governed ? governed[k] : true])) as AllowedUses;
  const suggested = Object.fromEntries(USE_KEYS.map((k) => [k, k in governed ? governed[k] : false])) as AllowedUses;
  return { status, permittedUsages: BASE_USAGES.filter((u) => usages.has(u)) as RslReading['permittedUsages'], ceiling, suggested, problem };
}

/**
 * Reads an RSL 1.0 document for one source URL. Never throws: anything it cannot read (malformed XML, a document type
 * declaration, another namespace, an unknown element or usage token, more than 64 KiB) is `failed`, and a document
 * without a `content` entry covering the URL is `no_matching_content`; both give the most restrictive flags. Licences
 * that need payment, restrict users to non-commercial use or restrict geography do not count (the hub cannot satisfy
 * or evaluate them), so they can only make the reading stricter.
 */
export function parseRsl(document: string, sourceUrl: string): RslReading {
  try {
    if (new TextEncoder().encode(document).length > RSL_MAX_BYTES) throw new Error('the document is larger than 64 KiB');
    const url = new URL(sourceUrl);
    const root = rslTree(parseXml(document));
    const contents = root.children.filter((c) => c.name === 'content');
    if (root.children.some((c) => c.name !== 'content' && !INFORMATIONAL.has(c.name))) throw new Error('unknown top-level element');
    if (contents.length === 0) throw new Error('no content element');
    let best: { length: number; content: XmlElement } | null = null;
    for (const content of contents) {
      const pattern = content.attrs.url;
      if (!pattern) throw new Error('a content element without url');
      const length = contentMatch(pattern, url);
      if (length >= 0 && (!best || length > best.length)) best = { length, content };
    }
    if (!best) return readingOf('no_matching_content', new Set(), 'no content entry covers the source URL');
    const licences = best.content.children.filter((c) => c.name === 'license');
    if (best.content.children.some((c) => c.name !== 'license' && !INFORMATIONAL.has(c.name))) throw new Error('unknown content element');
    const granted = new Set<RslUsage>();
    for (const licence of licences) for (const u of licenceUsages(licence) ?? []) granted.add(u);
    return readingOf('parsed', granted, null);
  } catch (error) {
    return readingOf('failed', new Set(), (error instanceof Error ? error.message : 'unreadable').slice(0, 200));
  }
}

/* ---------- robots.txt (RFC 9309) ---------- */

export const ROBOTS_MAX_BYTES = 512_000;
export const CrawlPolicyStatusSchema = z.enum(['allowed', 'restricted', 'forbidden']);
export interface RobotsEvaluation {
  allowed: boolean;
  status: z.infer<typeof CrawlPolicyStatusSchema>;
  crawlDelaySeconds: number | null;
  allowedPaths: string[];
  disallowedPaths: string[];
  /** `License:` lines (where a site points crawlers at its RSL document). */
  licenceUrls: string[];
}

function robotsPatternLength(pattern: string, path: string): number {
  if (pattern === '') return -1;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path) ? pattern.length : -1;
}

/**
 * Evaluates robots.txt for one user agent and URL path: the group naming the agent's product token (or `*`), the
 * longest matching rule, allow on a tie. A file larger than 500 KB is read as disallowing everything (never more
 * permissive than what could not be read).
 */
export function evaluateRobots(robotsTxt: string, userAgent: string, path: string): RobotsEvaluation {
  const licenceUrls: string[] = [];
  if (new TextEncoder().encode(robotsTxt).length > ROBOTS_MAX_BYTES) return { allowed: false, status: 'forbidden', crawlDelaySeconds: null, allowedPaths: [], disallowedPaths: ['/'], licenceUrls };
  const token = (userAgent.split('/')[0] ?? userAgent).trim().toLowerCase();
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [], delay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'license') { licenceUrls.push(value); continue; }
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') current.rules.push({ allow: key === 'allow', pattern: value });
    else if (key === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value)) current.delay = Math.ceil(Number(value));
  }
  const named = groups.filter((g) => g.agents.includes(token));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== null);
  let best: { allow: boolean; length: number } | null = null;
  if (path !== '/robots.txt') {
    for (const rule of rules) {
      const length = robotsPatternLength(rule.pattern, path);
      if (length < 0) continue;
      if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
    }
  }
  const allowed = best ? best.allow : true;
  const disallowedPaths = rules.filter((r) => !r.allow && r.pattern !== '').map((r) => r.pattern);
  return {
    allowed,
    status: !allowed ? 'forbidden' : disallowedPaths.length > 0 ? 'restricted' : 'allowed',
    crawlDelaySeconds: delays.length ? Math.max(...delays) : null,
    allowedPaths: rules.filter((r) => r.allow && r.pattern !== '').map((r) => r.pattern),
    disallowedPaths,
    licenceUrls,
  };
}

/* ---------- Vocabularies ---------- */

/** The source type a reader sees next to a cited item (CNT-001's source kinds, without own reporting). */
export const SOURCE_READER_KINDS = ['industry_media', 'press_release', 'official_register', 'procurement_notice', 'standards_body', 'statistics', 'company_statement', 'other'] as const;
export const SourceReaderKindSchema = z.enum(SOURCE_READER_KINDS);
/** Statuses the registry uses (a subset of the console's `SourceStatusSchema`; review is the activation step itself). */
export const REGISTRY_SOURCE_STATUSES = ['proposed', 'active', 'paused', 'rejected', 'retired', 'taken_down'] as const;
export const SourceTransitionSchema = z.enum(['active', 'paused', 'rejected', 'retired']);
export const ImportBatchStatusSchema = z.enum(['staged', 'activated', 'rejected', 'taken_down']);
export const SourceItemStatusSchema = z.enum(['queued', 'drafted', 'discarded', 'taken_down']);
export const SOURCED_RECORD_KINDS = ['company', 'company_identifier', 'company_registration', 'professional_credential', 'product_entry', 'learning_resource', 'event'] as const;
export const SourcedRecordKindSchema = z.enum(SOURCED_RECORD_KINDS);
/** Field names of sourced records: plain keys that never set a score, rank, badge or weight. */
export const SourcedFieldNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,60}$/).refine((f) => !FORBIDDEN_CONTROL_WORDS.test(f), { message: 'a sourced field never sets a score, rank, badge or weight' });
export const LinkEvidenceSchema = z.enum(['identifier_match', 'signed_statement', 'person_confirmed']);
export const LinkSideKindSchema = z.enum(['company', 'person', 'sourced_record']);
export const LinkStateSchema = z.enum(['proposed', 'accepted', 'rejected', 'withdrawn']);
export const TakedownReasonCategorySchema = z.enum(TAKEDOWN_REASONS);
export const TombstoneChannelSchema = z.enum(['retrieval', 'federation']);
export const TombstoneTargetKindSchema = z.enum(['source', 'source_item', 'sourced_record']);
/** Hours a peer has to apply a federation tombstone (the agreement default). */
export const FEDERATION_TOMBSTONE_HOURS = 72;

/* ---------- Commands (console envelope: contract version, idempotency key, staff reason) ---------- */

const HttpUrlSchema = z.url({ protocol: /^https?$/ }).max(2000);
const UuidSchema = z.uuid();

/** The registry fields of a source an editor sets (the licence model is the console's). */
const SourceTermsShape = {
  readerKind: SourceReaderKindSchema,
  purposes: z.array(SourcePurposeSchema).min(1).max(7),
  licence: SourceLicenceSchema,
  allowedUses: AllowedUsesSchema,
  attributionTemplate: ShortTextSchema,
  takedownContact: ShortTextSchema,
  personalData: z.boolean(),
  legalBasis: LegalBasisSchema.nullable(),
} as const;
const sourceTermsRefinements = <T extends z.ZodType<{ licence: { kind: SourceLicenceKind; agreementRef: string | null }; allowedUses: AllowedUses; personalData: boolean; legalBasis: string | null; purposes: string[] }>>(schema: T) => schema
  .refine((c) => allowedUsesProblems(c.licence, c.allowedUses, null).length === 0, { message: 'the licence does not allow these uses (without a licence: headline, link, short summary and indexing only; rewriting needs the stored text)', path: ['allowedUses'] })
  .refine((c) => !c.personalData || c.legalBasis !== null, { message: 'personal data needs a recorded legal basis', path: ['legalBasis'] })
  .refine((c) => new Set(c.purposes).size === c.purposes.length, { message: 'each purpose once', path: ['purposes'] });

export const RegisterSourceCommandSchema = sourceTermsRefinements(consoleCommand({
  kind: HubSourceKindSchema,
  name: NameSchema,
  url: HttpUrlSchema.nullable(),
  ownerPersonId: UuidSchema,
  ...SourceTermsShape,
})).refine((c) => !CRAWLING_SOURCE_KINDS.includes(c.kind) || c.url !== null, { message: 'a crawled source names its URL', path: ['url'] });
export type RegisterSourceCommand = z.infer<typeof RegisterSourceCommandSchema>;
export const SetSourceTermsCommandSchema = sourceTermsRefinements(consoleCommand({ expectedRevision: RevisionSchema, ...SourceTermsShape }));
export type SetSourceTermsCommand = z.infer<typeof SetSourceTermsCommandSchema>;
export const RecordTermsCheckCommandSchema = consoleCommand({
  expectedRevision: RevisionSchema,
  termsUrl: HttpUrlSchema.nullable(),
  termsDigest: Sha256HexSchema.nullable(),
  automatedAccess: TermsCheckSchema.shape.automatedAccess,
  notes: z.string().max(2000),
}).refine((c) => (c.termsUrl === null) === (c.termsDigest === null), { message: 'a terms page is recorded with its digest', path: ['termsDigest'] })
  .refine((c) => c.automatedAccess === 'not_applicable' || c.termsUrl !== null, { message: 'a decision about automated access cites the terms page', path: ['termsUrl'] });
export const CheckRobotsCommandSchema = consoleCommand({ userAgent: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,60}(\/[A-Za-z0-9._-]{1,30})?$/) });
export const CheckRslCommandSchema = consoleCommand({ rslUrl: HttpUrlSchema });
export const SourceStatusCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, to: SourceTransitionSchema });
export const TakedownCommandSchema = consoleCommand({ reasonCategory: TakedownReasonCategorySchema, note: ShortTextSchema });

export const StagedItemSchema = z.strictObject({
  externalId: z.string().min(1).max(200),
  url: HttpUrlSchema,
  title: NameSchema,
  summary: z.string().min(1).max(2000).nullable(),
  fullText: z.string().min(1).max(100_000).nullable(),
  sourceTime: TimestampSchema.nullable(),
  sponsored: z.strictObject({ sponsorName: NameSchema }).nullable(),
});
export const StagedFieldSchema = z.strictObject({
  recordKind: SourcedRecordKindSchema,
  recordId: UuidSchema,
  field: SourcedFieldNameSchema,
  value: z.string().min(1).max(2000),
  itemExternalId: z.string().min(1).max(200).nullable(),
});
const LinkSideSchema = z.strictObject({ kind: LinkSideKindSchema, id: UuidSchema });
export const StagedLinkSchema = z.strictObject({
  left: LinkSideSchema,
  rightLocalId: UuidSchema.nullable(),
  rightGlobalId: GlobalIdSchema.nullable(),
  evidence: LinkEvidenceSchema,
}).refine((l) => (l.rightLocalId === null) !== (l.rightGlobalId === null), { message: 'a link names exactly one right side', path: ['rightLocalId'] })
  .refine((l) => l.rightLocalId !== l.left.id, { message: 'cannot link a record to itself', path: ['rightLocalId'] });
/** A file drop or manual import: items, field-level facts and link proposals, staged for a second person to activate. */
export const StageBatchCommandSchema = consoleCommand({
  items: z.array(StagedItemSchema).min(1).max(200),
  fields: z.array(StagedFieldSchema).max(500),
  links: z.array(StagedLinkSchema).max(200),
}).refine((c) => new Set(c.items.map((i) => i.externalId)).size === c.items.length, { message: 'each external id once per batch', path: ['items'] })
  .refine((c) => c.fields.every((f) => f.itemExternalId === null || c.items.some((i) => i.externalId === f.itemExternalId)), { message: 'a field names an item of this batch', path: ['fields'] });
export type StageBatchCommand = z.infer<typeof StageBatchCommandSchema>;
export const DecideBatchCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, decision: z.enum(['activate', 'reject']) });
/** The person's decision on an imported item: a publication draft (CNT-001, still reviewed before it is published) or discard. */
export const DecideItemCommandSchema = consoleCommand({
  expectedRevision: RevisionSchema,
  decision: z.enum(['draft', 'discard']),
  treatment: z.enum(['headline_link', 'summary']).nullable(),
  /** Language of the draft and the editorial credit shown with it (staff-entered content, not interface copy). */
  language: LocaleTagSchema.nullable(),
  credit: ShortTextSchema.nullable(),
  eventTime: TimestampSchema.nullable(),
  useAssistedSummary: z.boolean(),
}).refine((c) => (c.decision === 'draft') === (c.treatment !== null && c.language !== null && c.credit !== null), { message: 'a draft names its treatment, language and credit, a discard none', path: ['treatment'] })
  .refine((c) => c.decision === 'draft' || !c.useAssistedSummary, { message: 'only a draft uses the assisted summary', path: ['useAssistedSummary'] });
export type DecideItemCommand = z.infer<typeof DecideItemCommandSchema>;
export const AssistItemCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, language: LocaleTagSchema });
export const ProposeLinkCommandSchema = consoleCommand({
  left: LinkSideSchema,
  rightLocalId: UuidSchema.nullable(),
  rightGlobalId: GlobalIdSchema.nullable(),
  evidence: LinkEvidenceSchema,
}).refine((l) => (l.rightLocalId === null) !== (l.rightGlobalId === null), { message: 'a link names exactly one right side', path: ['rightLocalId'] })
  .refine((l) => l.rightLocalId !== l.left.id, { message: 'cannot link a record to itself', path: ['rightLocalId'] });
export const DecideLinkCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, decision: z.enum(['accept', 'reject']) });
export const SetSponsoredPolicyCommandSchema = consoleCommand({
  allowed: z.boolean(),
  maxSlotsPerPage: z.int().min(0).max(3),
  requireVerifiedSponsor: z.boolean(),
  approvalId: UuidSchema.nullable(),
}).refine((c) => c.allowed || c.maxSlotsPerPage === 0, { message: 'no slots when not allowed', path: ['maxSlotsPerPage'] })
  .refine((c) => c.allowed || c.approvalId === null, { message: 'turning sponsored content off needs no second person', path: ['approvalId'] });
export type SetSponsoredPolicyCommand = z.infer<typeof SetSponsoredPolicyCommandSchema>;

/** Every registry request schema by name (tests walk them for ranking words and unknown fields). */
export const SOURCES_REQUEST_SCHEMAS = {
  RegisterSourceCommandSchema, SetSourceTermsCommandSchema, RecordTermsCheckCommandSchema, CheckRobotsCommandSchema, CheckRslCommandSchema, SourceStatusCommandSchema,
  TakedownCommandSchema, StageBatchCommandSchema, DecideBatchCommandSchema, DecideItemCommandSchema, AssistItemCommandSchema, ProposeLinkCommandSchema, DecideLinkCommandSchema,
  SetSponsoredPolicyCommandSchema,
} as const;

/** What the second person approves when sponsored content is switched on (`sponsored.enable`); the database recomputes it. */
export function sponsoredPolicyDigestInput(input: { hubId: string; version: number; allowed: boolean; maxSlotsPerPage: number; requireVerifiedSponsor: boolean }) {
  return {
    action: 'sponsored.enable', object: 'sponsored_content_policy', hubId: input.hubId, version: input.version, allowed: input.allowed, maxSlotsPerPage: input.maxSlotsPerPage,
    requireVerifiedSponsor: input.requireVerifiedSponsor,
  };
}

/* ---------- Views ---------- */

const Iso = TimestampSchema;
export const CrawlPolicyViewSchema = z.strictObject({
  id: IdSchema,
  domain: z.string().min(1).max(253),
  robotsUrl: HttpUrlSchema,
  userAgent: z.string().min(1).max(200),
  robotsDigest: Sha256HexSchema,
  allowed: z.boolean(),
  status: CrawlPolicyStatusSchema,
  crawlDelaySeconds: z.int().min(0).nullable(),
  allowedPaths: z.array(z.string().max(500)),
  disallowedPaths: z.array(z.string().max(500)),
  licenceUrls: z.array(z.string().max(2000)),
  recordedBy: IdSchema,
  fetchedAt: Iso,
});
export type CrawlPolicyView = z.infer<typeof CrawlPolicyViewSchema>;
export const RslStateSchema = z.strictObject({
  status: RslStatusSchema,
  digest: Sha256HexSchema.nullable(),
  checkedAt: Iso.nullable(),
  ceiling: AllowedUsesSchema.nullable(),
  suggested: AllowedUsesSchema.nullable(),
});
/**
 * The registry's read model of a source: every field of the console's `HubSourceSchema` (robots from the latest crawl
 * policy, terms from the recorded check) plus what the registry adds. `toHubSource` returns the console form.
 */
export const SourceViewSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  kind: HubSourceKindSchema,
  name: NameSchema,
  url: HttpUrlSchema.nullable(),
  purposes: z.array(SourcePurposeSchema).min(1),
  licence: SourceLicenceSchema,
  robots: RobotsCheckSchema.nullable(),
  terms: TermsCheckSchema.nullable(),
  allowedUses: AllowedUsesSchema,
  attributionTemplate: ShortTextSchema,
  takedownContact: ShortTextSchema,
  ownerPersonId: IdSchema,
  personalData: z.boolean(),
  legalBasis: LegalBasisSchema.nullable(),
  proposedBy: ProposerSchema,
  status: SourceStatusSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: Iso.nullable(),
  pauseReason: SourcePauseReasonSchema.nullable(),
  revision: RevisionSchema,
  readerKind: SourceReaderKindSchema,
  editedBy: IdSchema,
  crawlPolicy: CrawlPolicyViewSchema.nullable(),
  rsl: RslStateSchema,
  createdAt: Iso,
  updatedAt: Iso,
});
export type SourceView = z.infer<typeof SourceViewSchema>;
const HUB_SOURCE_KEYS = Object.keys(HubSourceSchema.shape) as (keyof HubSource)[];
/** The console contract form of a registry source (validated: the console's refinements hold for every active source). */
export function toHubSource(view: SourceView): HubSource {
  return HubSourceSchema.parse(Object.fromEntries(HUB_SOURCE_KEYS.map((k) => [k, view[k as keyof SourceView]])));
}

export const LicenceSnapshotSchema = z.strictObject({
  licenceKind: SourceLicenceKindSchema,
  licenceName: z.string().max(200).nullable(),
  allowedUses: AllowedUsesSchema,
});
export type LicenceSnapshot = z.infer<typeof LicenceSnapshotSchema>;
export const ImportBatchViewSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  sourceId: IdSchema,
  status: ImportBatchStatusSchema,
  stagedBy: IdSchema,
  counts: z.strictObject({ items: z.int().min(0), duplicates: z.int().min(0), fields: z.int().min(0), links: z.int().min(0) }),
  licenceSnapshot: LicenceSnapshotSchema,
  decidedBy: IdSchema.nullable(),
  decidedAt: Iso.nullable(),
  revision: RevisionSchema,
  createdAt: Iso,
});
export type ImportBatchView = z.infer<typeof ImportBatchViewSchema>;
export const SourceItemViewSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  sourceId: IdSchema,
  batchId: IdSchema,
  externalId: z.string(),
  url: HttpUrlSchema,
  title: z.string(),
  summary: z.string().nullable(),
  hasFullText: z.boolean(),
  sourceTime: Iso.nullable(),
  observedAt: Iso,
  contentDigest: Sha256HexSchema,
  licenceSnapshot: LicenceSnapshotSchema,
  /** The stricter of the snapshot and the source's current flags; what egress and drafting use. */
  effectiveUses: AllowedUsesSchema,
  status: SourceItemStatusSchema,
  decidedBy: IdSchema.nullable(),
  decidedAt: Iso.nullable(),
  publicationId: IdSchema.nullable(),
  /** Sponsored items are always labelled; they never feed ranking, matching or recommendations. */
  sponsored: z.strictObject({ sponsorName: z.string(), label: z.literal('sponsored') }).nullable(),
  assistedSummary: z.strictObject({ text: z.string(), language: LocaleTagSchema, draftedAt: Iso, label: z.literal('machine_assisted') }).nullable(),
  revision: RevisionSchema,
});
export type SourceItemView = z.infer<typeof SourceItemViewSchema>;
export const LinkProposalViewSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  left: LinkSideSchema,
  rightLocalId: IdSchema.nullable(),
  rightGlobalId: z.string().nullable(),
  evidence: LinkEvidenceSchema,
  proposedBy: z.enum(['import', 'peer', 'person']),
  proposedByPerson: IdSchema.nullable(),
  batchId: IdSchema.nullable(),
  state: LinkStateSchema,
  decidedBy: IdSchema.nullable(),
  decidedAt: Iso.nullable(),
  effect: z.literal('link'),
  revision: RevisionSchema,
});
export type LinkProposalView = z.infer<typeof LinkProposalViewSchema>;
export const TombstoneViewSchema = z.strictObject({
  id: IdSchema,
  channel: TombstoneChannelSchema,
  targetKind: TombstoneTargetKindSchema,
  targetId: IdSchema,
  recordKind: SourcedRecordKindSchema.nullable(),
  reason: z.enum(['takedown', 'licence_ended']),
  issuedAt: Iso,
  applyBy: Iso.nullable(),
});
export const TakedownViewSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  target: z.strictObject({ kind: z.enum(['source', 'source_item']), id: IdSchema }),
  reasonCategory: TakedownReasonCategorySchema,
  executedBy: IdSchema,
  executedAt: Iso,
  itemsTakenDown: z.int().min(0),
  fieldsDeactivated: z.int().min(0),
  /** Publication drafts or publications made from the items: CNT-001 retraction is the editor-in-chief's separate decision. */
  publicationIds: z.array(IdSchema),
  tombstones: z.array(TombstoneViewSchema),
});
export type TakedownView = z.infer<typeof TakedownViewSchema>;
export const SponsoredPolicyViewSchema = z.strictObject({
  hubId: IdSchema,
  version: z.int().min(0),
  allowed: z.boolean(),
  readerLabel: z.literal(true),
  separateSlotOnly: z.literal(true),
  affectsRankingOrMatching: z.literal(false),
  requireVerifiedSponsor: z.boolean(),
  maxSlotsPerPage: z.int().min(0).max(3),
  setBy: IdSchema.nullable(),
  approvalId: IdSchema.nullable(),
}).refine((p) => p.allowed || p.maxSlotsPerPage === 0, { message: 'no slots when not allowed', path: ['maxSlotsPerPage'] });
export type SponsoredPolicyView = z.infer<typeof SponsoredPolicyViewSchema>;
/** The policy every hub has until someone changes it: off (ADR 012 decision 3). Version 0 means "never set". */
export function defaultSponsoredPolicyView(hubId: string): SponsoredPolicyView {
  return { hubId, version: 0, allowed: false, readerLabel: true, separateSlotOnly: true, affectsRankingOrMatching: false, requireVerifiedSponsor: true, maxSlotsPerPage: 0, setBy: null, approvalId: null };
}

/** The public provenance of a sourced record: field values with their source, labelled "from sources" until the company claims it. */
export const PublicProvenanceSchema = z.strictObject({
  projection: z.literal('public'),
  recordKind: SourcedRecordKindSchema,
  recordId: IdSchema,
  label: z.literal('sourced'),
  fields: z.array(z.strictObject({
    field: z.string(),
    value: z.string(),
    observedAt: Iso,
    source: z.strictObject({ name: z.string(), attribution: z.string(), url: z.string().nullable() }),
    correction: z.strictObject({ kind: z.literal('verified_subject_correction'), at: TimestampSchema }).nullable(),
  })),
});
export type PublicProvenance = z.infer<typeof PublicProvenanceSchema>;
/** One labelled sponsored slot entry (shown apart from every list; empty while the hub keeps sponsored content off). */
export const SponsoredSlotSchema = z.strictObject({
  projection: z.literal('public'),
  label: z.literal('sponsored'),
  items: z.array(z.strictObject({ itemId: IdSchema, title: z.string(), url: z.string(), sponsorName: z.string(), sourceName: z.string() })),
});

/** The source reference CNT-001 stores on a version drafted from an item: name, reader kind, licence label and the item's effective uses. */
export function contentSourceRef(source: { name: string; readerKind: z.infer<typeof SourceReaderKindSchema>; licence: { kind: SourceLicenceKind; name: string | null } },
  item: { url: string; sourceTime: string | null; observedAt: string; effectiveUses: AllowedUses }) {
  return {
    uri: item.url, name: source.name, kind: source.readerKind, sourceTime: item.sourceTime, observedAt: item.observedAt,
    license: (source.licence.name ?? source.licence.kind).slice(0, 100), allowedUses: { ...item.effectiveUses },
  };
}
