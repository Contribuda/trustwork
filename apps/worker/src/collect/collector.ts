import { createHash } from 'node:crypto';
import {
  decideCollection, detectBarrier, HostPoliteness, readContentUsage, readTdm, type CollectionDecision, type CollectionInput, type RobotsInput, type SignalDigests,
} from '../../../../packages/contracts/src/collection-policy.js';
import { ROBOTS_MAX_BYTES, type RslReading } from '../../../../packages/contracts/src/sources.js';
import type { AllowedUses } from '../../../../packages/contracts/src/hub.js';

/**
 * The worker side of the pre-collection gate (SRC-002). It feeds the pure `decideCollection` and sends a request for
 * the target URL only when the decision allows it:
 *
 * 1. registry and law first, with no network at all (an inactive source, a restricted place, unchecked or forbidding
 *    terms, a missing legal basis or an already recorded signal change deny before anything is fetched);
 * 2. robots.txt and `/.well-known/tdmrep.json` of the origin, cached for at most 24 hours (a 5xx or a failure of
 *    robots.txt disallows everything; a 4xx allows, RFC 9309);
 * 3. the host's polite slot (one request in flight, crawl delay, Retry-After backoff);
 * 4. the target itself, then its headers (TDMRep, Content-Usage) and access barriers decide again: content behind a
 *    login, paywall or challenge is dropped and never returned.
 *
 * A changed digest of robots, TDMRep or Content-Usage compared with what the registry recorded comes back in
 * `decision.changed`; the caller pauses the source through the SRC-001 commands until a person re-checks it.
 */
export interface CollectResponse {
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type CollectFetch = (url: string, init: { headers: Record<string, string>; redirect: 'follow'; signal: AbortSignal }) => Promise<CollectResponse>;

export interface CollectSource {
  id: string;
  status: string;
  allowedUses: AllowedUses;
  termsAutomatedAccess: CollectionInput['source']['termsAutomatedAccess'];
  personalData: boolean;
  legalBasis: string | null;
  rsl: RslReading | null;
  recorded: SignalDigests;
}
export interface CollectRequest { url: string; source: CollectSource; restrictedPlace: boolean }
export interface CollectResult { decision: CollectionDecision; body: string | null; contentType: string | null }

const DAY = 86_400_000;
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const NO_DIGESTS = (recorded: SignalDigests): SignalDigests => ({ ...recorded });

interface Cached<T> { value: T; at: number }

export class Collector {
  private readonly robots = new Map<string, Cached<RobotsInput>>();
  private readonly tdmFiles = new Map<string, Cached<string | null>>();
  readonly politeness: HostPoliteness;

  constructor(private readonly deps: { fetch: CollectFetch; userAgent: string; now?: () => number; timeoutMs?: number; politeness?: HostPoliteness }) {
    this.politeness = deps.politeness ?? new HostPoliteness();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private request(url: string): Promise<CollectResponse> {
    return this.deps.fetch(url, { headers: { 'user-agent': this.deps.userAgent, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000) });
  }

  /** robots.txt of the origin, at most 24 hours old. */
  async robotsOf(origin: string): Promise<RobotsInput> {
    const cached = this.robots.get(origin);
    if (cached && this.now() - cached.at < DAY) return cached.value;
    let value: RobotsInput;
    try {
      const response = await this.request(`${origin}/robots.txt`);
      if (response.status >= 200 && response.status < 300) {
        const body = await response.text();
        value = new TextEncoder().encode(body).length > ROBOTS_MAX_BYTES ? { status: 'ok', body: 'User-agent: *\nDisallow: /' } : { status: 'ok', body };
      } else if (response.status >= 400 && response.status < 500) value = { status: 'not_found', body: null };
      else value = { status: 'unavailable', body: null };
    } catch {
      value = { status: 'unavailable', body: null };
    }
    this.robots.set(origin, { value, at: this.now() });
    return value;
  }

  /** `/.well-known/tdmrep.json` of the origin, at most 24 hours old (null when absent). */
  async tdmFileOf(origin: string): Promise<string | null> {
    const cached = this.tdmFiles.get(origin);
    if (cached && this.now() - cached.at < DAY) return cached.value;
    let value: string | null = null;
    try {
      const response = await this.request(`${origin}/.well-known/tdmrep.json`);
      value = response.status >= 200 && response.status < 300 ? (await response.text()).slice(0, 65_536) : null;
    } catch {
      value = null;
    }
    this.tdmFiles.set(origin, { value, at: this.now() });
    return value;
  }

  private input(req: CollectRequest, parts: Partial<CollectionInput>): CollectionInput {
    return {
      url: req.url, userAgent: this.deps.userAgent, restrictedPlace: req.restrictedPlace,
      source: { status: req.source.status, allowedUses: req.source.allowedUses, termsAutomatedAccess: req.source.termsAutomatedAccess, personalData: req.source.personalData,
        legalBasis: req.source.legalBasis, recorded: req.source.recorded },
      robots: { status: 'not_found', body: null }, rsl: req.source.rsl, tdm: { status: 'none', policyUrl: null }, contentUsage: { status: 'none', preferences: {} }, barrier: null,
      digests: NO_DIGESTS(req.source.recorded), hostFreeAt: null, now: new Date(this.now()),
      ...parts,
    };
  }

  async collect(req: CollectRequest): Promise<CollectResult> {
    // 1. Registry and law: no network.
    const offline = decideCollection(this.input(req, {}));
    if (offline.verdict === 'deny') return { decision: offline, body: null, contentType: null };

    // 2. Origin signals.
    const url = new URL(req.url);
    const origin = url.origin;
    const robots = await this.robotsOf(origin);
    const tdmFile = await this.tdmFileOf(origin);
    const path = url.pathname + url.search;
    const digests: SignalDigests = {
      ...req.source.recorded,
      robots: robots.status === 'ok' ? sha256(robots.body ?? '') : req.source.recorded.robots,
      tdm: tdmFile === null ? req.source.recorded.tdm : sha256(tdmFile),
    };
    const before = decideCollection(this.input(req, {
      robots, tdm: readTdm({ headers: {}, wellKnown: tdmFile, path }), digests, hostFreeAt: this.politeness.freeAt(url.host, this.now()),
    }));
    if (before.verdict !== 'allow') return { decision: before, body: null, contentType: null };

    // 3 and 4. The target, politely; then its headers and barriers decide again.
    this.politeness.start(url.host);
    let response: CollectResponse;
    try {
      response = await this.request(req.url);
    } catch (error) {
      this.politeness.finish(url.host, this.now(), { status: 503, retryAfter: null }, null);
      throw error;
    }
    this.politeness.finish(url.host, this.now(), { status: response.status, retryAfter: response.headers.get('retry-after') }, null);
    const header = (name: string) => response.headers.get(name) ?? undefined;
    const contentUsageHeader = header('content-usage');
    const body = await response.text();
    const after = decideCollection(this.input(req, {
      robots,
      tdm: readTdm({ headers: { 'tdm-reservation': header('tdm-reservation'), 'tdm-policy': header('tdm-policy') }, wellKnown: tdmFile, path }),
      contentUsage: readContentUsage(contentUsageHeader),
      barrier: detectBarrier({ status: response.status, headers: { 'www-authenticate': header('www-authenticate') }, finalUrl: response.url || req.url, bodyStart: body }),
      digests: { ...digests, contentUsage: contentUsageHeader === undefined ? req.source.recorded.contentUsage : sha256(contentUsageHeader) },
    }));
    const ok = after.verdict === 'allow' && response.status >= 200 && response.status < 300;
    return { decision: after, body: ok ? body : null, contentType: ok ? response.headers.get('content-type') : null };
  }
}
