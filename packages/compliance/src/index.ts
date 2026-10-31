import { z } from 'zod';

/**
 * Sanctions compliance primitives (ADR-009, INTL-SAN). Two things live here:
 *
 * 1. The partner ownership declaration every company representative signs at onboarding: where the
 *    company is organised and operates, and whether anyone on a sanctions list owns 50% or more of it.
 * 2. A screening adapter for the US Consolidated Screening List (trade.gov). The adapter is a contract
 *    plus a thin HTTP client: without an API key it refuses to run, and it never returns "clear" on its
 *    own authority — an empty match list is reported as `screened` only when the list was actually queried.
 *
 * Nothing here decides anything by itself; the decision belongs to the operator's review queue.
 */

/** Places where the platform is not offered (ADR-009 decision 2). ISO 3166-1 codes plus region markers. */
export const RESTRICTED_PLACES = ['RU', 'CU', 'IR', 'KP', 'UA-43', 'UA-40', 'UA-14', 'UA-09'] as const;

export const OwnershipDeclarationSchema = z.strictObject({
  companyId: z.string().min(1),
  declaredBy: z.string().min(1),
  declaredAt: z.iso.datetime(),
  /** Country of organisation (ISO 3166-1 alpha-2). */
  organisedIn: z.string().regex(/^[A-Z]{2}$/),
  /** Countries and regions where the company operates or delivers (ISO 3166-1 / 3166-2). */
  operatesIn: z.array(z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/)).min(1),
  /** True when any listed person or blocked government owns or controls 50% or more. */
  listedOwnershipFiftyPercentOrMore: z.boolean(),
  /** True when the company, or anyone acting for it, appears on a US sanctions or export-restriction list. */
  appearsOnList: z.boolean(),
  /** The signer confirms the declaration is true and will notify the platform when it stops being true. */
  confirmed: z.literal(true),
});
export type OwnershipDeclaration = z.infer<typeof OwnershipDeclarationSchema>;

export type DeclarationVerdict = { ok: true } | { ok: false; reasons: string[] };

/** Deterministic checks on the declaration itself; a `false` verdict blocks onboarding until operator review. */
export function evaluateDeclaration(declaration: OwnershipDeclaration): DeclarationVerdict {
  const reasons: string[] = [];
  const restricted = new Set<string>(RESTRICTED_PLACES);
  if (restricted.has(declaration.organisedIn)) reasons.push(`organised_in_restricted_place:${declaration.organisedIn}`);
  for (const place of declaration.operatesIn) {
    if (restricted.has(place) || restricted.has(place.slice(0, 2))) reasons.push(`operates_in_restricted_place:${place}`);
  }
  if (declaration.listedOwnershipFiftyPercentOrMore) reasons.push('listed_ownership_fifty_percent_or_more');
  if (declaration.appearsOnList) reasons.push('appears_on_list');
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

export const ScreeningSubjectSchema = z.strictObject({
  name: z.string().min(2),
  /** ISO 3166-1 alpha-2 when known; the list search is name-based. */
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export type ScreeningSubject = z.infer<typeof ScreeningSubjectSchema>;

export const ScreeningMatchSchema = z.strictObject({
  source: z.string(),
  name: z.string(),
  score: z.number().min(0).max(100).optional(),
  programs: z.array(z.string()).default([]),
  entryId: z.string().optional(),
});
export type ScreeningMatch = z.infer<typeof ScreeningMatchSchema>;

/**
 * Outcome of one screening call. `not_run` is a first-class state: the UI shows "screening pending",
 * never "clear", until a real query happened. `error` keeps the subject in the review queue.
 */
export type ScreeningResult =
  | { status: 'not_run'; reason: 'missing_key' | 'disabled' }
  | { status: 'screened'; matches: ScreeningMatch[]; source: string; checkedAt: string }
  | { status: 'error'; message: string };

export type ScreeningAdapter = {
  readonly id: string;
  screen(subject: ScreeningSubject): Promise<ScreeningResult>;
};

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const CSL_ENDPOINT = 'https://data.trade.gov/consolidated_screening_list/v1/search';

/**
 * US Consolidated Screening List adapter (trade.gov). The operator provisions the key out of band; the
 * engine ships with it empty. With no key the adapter returns `not_run` and performs no network call.
 */
export function consolidatedScreeningList(options: { apiKey?: string | undefined; fetch?: FetchLike | undefined; endpoint?: string | undefined; now?: () => Date } = {}): ScreeningAdapter {
  const key = options.apiKey?.trim() ?? '';
  const endpoint = options.endpoint ?? CSL_ENDPOINT;
  const now = options.now ?? (() => new Date());
  return {
    id: 'us-consolidated-screening-list',
    async screen(subject) {
      const parsed = ScreeningSubjectSchema.parse(subject);
      if (!key) return { status: 'not_run', reason: 'missing_key' };
      const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
      if (!doFetch) return { status: 'error', message: 'fetch is not available' };
      const params = new URLSearchParams({ name: parsed.name, fuzzy_name: 'true' });
      if (parsed.country) params.set('countries', parsed.country);
      try {
        const response = await doFetch(`${endpoint}?${params.toString()}`, { headers: { 'subscription-key': key, accept: 'application/json' } });
        if (!response.ok) return { status: 'error', message: `screening list responded ${response.status}` };
        const body = (await response.json()) as { results?: Array<Record<string, unknown>> };
        const matches = (body.results ?? []).map((r) =>
          ScreeningMatchSchema.parse({
            source: String(r.source ?? 'csl'),
            name: String(r.name ?? ''),
            ...(typeof r.score === 'number' ? { score: r.score } : {}),
            programs: Array.isArray(r.programs) ? r.programs.map(String) : [],
            ...(typeof r.id === 'string' ? { entryId: r.id } : {}),
          }),
        );
        return { status: 'screened', matches, source: endpoint, checkedAt: now().toISOString() };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : 'screening failed' };
      }
    },
  };
}

/** What the onboarding queue shows: a declaration verdict plus the screening state, never collapsed into one boolean. */
export type OnboardingComplianceState = { declaration: DeclarationVerdict; screening: ScreeningResult; requiresReview: boolean };

export async function assessPartner(declaration: OwnershipDeclaration, subject: ScreeningSubject, adapter: ScreeningAdapter): Promise<OnboardingComplianceState> {
  const verdict = evaluateDeclaration(declaration);
  const screening = await adapter.screen(subject);
  const requiresReview = !verdict.ok || screening.status !== 'screened' || screening.matches.length > 0;
  return { declaration: verdict, screening, requiresReview };
}
