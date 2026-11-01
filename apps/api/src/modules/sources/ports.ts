/**
 * Adapter ports of the source registry (SRC-001). This slice ships only fakes: no crawling, no network call, no
 * provider account. Both ports are read-only towards the outside world, so repeating a call after an unknown outcome
 * has no side effect; `unavailable` is never recorded as a check.
 */
export type FetchResult = { status: 'found'; body: string } | { status: 'not_found' } | { status: 'unavailable' };

/** Fetches a site's robots.txt and RSL document for the registry's checks. */
export interface SourcePolicyFetcher {
  /** Stored with nothing but used in logs: names the adapter that answered. */
  readonly code: string;
  robots(robotsUrl: string): Promise<FetchResult>;
  rsl(rslUrl: string): Promise<FetchResult>;
}

const SYNTHETIC_RSL: Record<string, string> = {
  'license-open.xml': `<?xml version="1.0" encoding="UTF-8"?>
<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">all</permits><payment type="attribution"/></license></content></rsl>`,
  'license-search.xml': `<?xml version="1.0" encoding="UTF-8"?>
<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">search</permits><prohibits type="usage">ai-all</prohibits></license></content></rsl>`,
  'license-paid.xml': `<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">ai-input,ai-index,search</permits><payment type="use"/></license></content></rsl>`,
  'license-broken.xml': '<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">search',
};

/**
 * Deterministic synthetic sites, keyed by the host's first label: `allow.` serves a robots.txt allowing everything,
 * `restricted.` disallows `/private/` with a crawl delay of 5 s, `deny.` disallows everything, `missing.` has no
 * robots.txt; any other host is unreachable. RSL documents are served by file name (`license-open.xml`,
 * `license-search.xml`, `license-paid.xml`, `license-broken.xml`); other paths are not found. `overrides` lets a test
 * serve exact documents for exact URLs.
 */
export class FakeSourcePolicyFetcher implements SourcePolicyFetcher {
  readonly code = 'fake.synthetic-sites';
  readonly calls: string[] = [];
  readonly overrides = new Map<string, FetchResult>();
  async robots(robotsUrl: string): Promise<FetchResult> {
    this.calls.push(robotsUrl);
    const override = this.overrides.get(robotsUrl);
    if (override) return override;
    const label = new URL(robotsUrl).hostname.split('.')[0];
    if (label === 'allow') return { status: 'found', body: 'User-agent: *\nAllow: /\n' };
    if (label === 'restricted') return { status: 'found', body: 'User-agent: *\nDisallow: /private/\nCrawl-delay: 5\nLicense: /license-search.xml\n' };
    if (label === 'deny') return { status: 'found', body: 'User-agent: *\nDisallow: /\n' };
    if (label === 'missing') return { status: 'not_found' };
    return { status: 'unavailable' };
  }
  async rsl(rslUrl: string): Promise<FetchResult> {
    this.calls.push(rslUrl);
    const override = this.overrides.get(rslUrl);
    if (override) return override;
    const url = new URL(rslUrl);
    if (url.hostname.split('.')[0] === 'down') return { status: 'unavailable' };
    const doc = SYNTHETIC_RSL[url.pathname.split('/').pop() ?? ''];
    return doc ? { status: 'found', body: doc } : { status: 'not_found' };
  }
}

/** Drafts a short summary of an imported item through a model provider (only for items whose licence allows it). */
export interface SummaryDrafter {
  readonly code: string;
  draft(input: { title: string; text: string; language: string; attribution: string }): Promise<{ summary: string }>;
}

/** Deterministic synthetic drafter: it records every call (a negative test asserts that none happened) and labels its output as synthetic. */
export class FakeSummaryDrafter implements SummaryDrafter {
  readonly code = 'fake.synthetic-drafter';
  readonly calls: { title: string; text: string; language: string; attribution: string }[] = [];
  async draft(input: { title: string; text: string; language: string; attribution: string }): Promise<{ summary: string }> {
    this.calls.push(input);
    return { summary: `Synthetic summary (fake drafter) of: ${input.title}`.slice(0, 2000) };
  }
}

/** The composition root's default instances (tests read their call logs). */
export const defaultPolicyFetcher = new FakeSourcePolicyFetcher();
export const defaultSummaryDrafter = new FakeSummaryDrafter();

/** Bounds an outside call: no answer in time is `unavailable`, never a recorded check. */
export async function bounded<T>(call: Promise<T>, fallback: T, timeoutMs = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); });
  try {
    return await Promise.race([call.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
