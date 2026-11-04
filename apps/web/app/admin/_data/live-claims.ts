import { z } from 'zod';
import { boundChecks, checkBody, countryBody, decideBody, proposeBody, territoryState, type ClaimCommandId, type TerritoryState } from '../hubs/[hub]/participants/claims/_commands.js';
import type { CommandOutcome, RejectCode } from './commands.js';

/**
 * HC-22 Claims on the API (HUBC-007): the queue and disputes from CLM-001, the company's country from the review read, the
 * recipe's checks and standing from HUB-003. The reviewer sees the country rule before deciding, and the database decides
 * it again. Rows the API answers for the viewer's own claim have no reviewer fields, and the page offers them no decision.
 */

const UUID = z.uuid();
const Timestamp = z.iso.datetime();
const ClaimRowSchema = z.object({
  id: UUID, hubId: UUID, companyId: UUID, level: z.enum(['claimed', 'verified']), recipeId: UUID, domainTie: z.string().nullable(), state: z.string(), waitingUntil: Timestamp.nullable(), decidedAt: Timestamp.nullable(), revision: z.int().min(1), createdAt: Timestamp,
  /** Absent on the viewer's own claim: a claimant's projection names no reviewer and no other party. */
  claimantId: UUID.optional(), domainTieDomain: z.string().nullable().optional(), disputeId: UUID.nullable().optional(),
});
const DisputeSchema = z.object({ id: UUID, companyId: UUID, state: z.string(), proposedClaimId: UUID.nullable(), proposedNone: z.boolean().nullable().optional(), proposedBy: UUID.nullable(), proposedNote: z.string().nullable(), revision: z.int().min(1) });
const OverviewSchema = z.object({ claims: z.array(ClaimRowSchema), disputes: z.array(DisputeSchema) });
const DetailSchema = z.object({ claim: z.object({ companyCountry: z.string().nullable().optional(), companyRegion: z.string().nullable().optional(), evidence: z.array(UUID).optional() }) });
const StandingSchema = z.object({ status: z.enum(['passed', 'pending', 'failed']), missing: z.array(z.string()), failed: z.array(z.string()), handoverBlocked: z.boolean() });
const ChecksSchema = z.object({ items: z.array(z.object({ id: UUID, recipeId: UUID, checkType: z.string(), mode: z.string(), result: z.string(), recordedAt: Timestamp, expiresAt: Timestamp.nullable() })) });
const VerificationSchema = z.object({
  providers: z.array(z.object({ id: UUID, checkType: z.string(), adapter: z.string(), mode: z.string(), status: z.string() })),
  recipes: z.array(z.object({ id: UUID, key: z.string(), version: z.int(), steps: z.array(z.union([z.object({ check: z.string(), required: z.boolean() }), z.object({ anyOf: z.array(z.string()) })])) })),
});
const CompanySchema = z.object({ company: z.object({ displayName: z.string().nullable().optional(), name: z.string().nullable().optional() }) });

type ClaimRow = z.infer<typeof ClaimRowSchema>;
type Check = z.infer<typeof ChecksSchema>['items'][number];
export type ClaimDispute = z.infer<typeof DisputeSchema>;
export type ClaimProvider = z.infer<typeof VerificationSchema>['providers'][number];
export type LiveClaim = ClaimRow & {
  own: boolean;
  companyName: string | null;
  /** Null on the viewer's own claim, whose projection carries no country. */
  company: { country: string | null; region: string | null } | null;
  territory: TerritoryState | null;
  recipe: z.infer<typeof VerificationSchema>['recipes'][number] | null;
  standing: z.infer<typeof StandingSchema> | null;
  /** The checks of this recipe recorded after the claim was submitted, bound or ready to bind. */
  checks: Array<Check & { bound: boolean }>;
};
export type ClaimsView = { claims: LiveClaim[]; decided: LiveClaim[]; disputes: ClaimDispute[]; providers: ClaimProvider[] };

export type SectionApi = { get(path: `/v1/${string}`): Promise<unknown> };
type Read = <T>(read: Promise<T>) => Promise<T | null>;
/** Claims still with a reviewer; the rest are listed without their checks. */
const OPEN = new Set(['open', 'waiting', 'disputed']);
const LIST_LIMIT = 50;

/** The section's view for this viewer, or null when the API does not show it (no claims permission, unknown hub). */
export async function readClaims(api: SectionApi, orNothing: Read, hub: { id: string; territories: ReadonlyArray<{ code: string }> }): Promise<ClaimsView | null> {
  const base = `/v1/admin/hubs/${encodeURIComponent(hub.id)}` as const;
  const overview = await orNothing(api.get(`${base}/claims`));
  if (overview === null) return null;
  const { claims, disputes } = OverviewSchema.parse(overview);
  const verification = VerificationSchema.safeParse(await orNothing(api.get(`${base}/verification`))).data ?? { providers: [], recipes: [] };
  const load = async (row: ClaimRow, full: boolean): Promise<LiveClaim> => {
    const own = row.claimantId === undefined;
    const company = CompanySchema.safeParse(await orNothing(api.get(`/v1/companies/${encodeURIComponent(row.companyId)}`))).data?.company;
    const recipe = verification.recipes.find((r) => r.id === row.recipeId) ?? null;
    const shared = { ...row, own, companyName: company?.displayName ?? company?.name ?? null, recipe };
    if (own || !full) return { ...shared, company: null, territory: null, standing: null, checks: [] };
    const subject = encodeURIComponent(row.companyId);
    const [detail, standing, checks] = await Promise.all([
      orNothing(api.get(`${base}/claims/requests/${encodeURIComponent(row.id)}`)),
      orNothing(api.get(`${base}/verification/standing?subjectKind=company&subjectId=${subject}&recipeId=${encodeURIComponent(row.recipeId)}`)),
      orNothing(api.get(`${base}/verification/subjects/company/${subject}/checks`)),
    ]);
    const claim = DetailSchema.safeParse(detail).data?.claim;
    const country = claim?.companyCountry ?? null;
    const bound = new Set(claim?.evidence ?? []);
    return {
      ...shared, company: { country, region: claim?.companyRegion ?? null }, territory: territoryState(hub.territories, country), standing: StandingSchema.safeParse(standing).data ?? null,
      checks: (ChecksSchema.safeParse(checks).data?.items ?? []).filter((c) => c.recipeId === row.recipeId && c.recordedAt >= row.createdAt).map((c) => ({ ...c, bound: bound.has(c.id) })),
    };
  };
  const rows = claims.filter((c) => c.hubId === hub.id);
  return {
    claims: await Promise.all(rows.filter((c) => OPEN.has(c.state)).slice(0, LIST_LIMIT).map((c) => load(c, true))),
    decided: await Promise.all(rows.filter((c) => !OPEN.has(c.state)).slice(0, LIST_LIMIT).map((c) => load(c, false))),
    disputes, providers: verification.providers.filter((p) => p.status === 'active'),
  };
}

export type SectionAnswer = { status: number; code: string | null; body?: unknown };
export type ClaimSend = { send(path: `/v1/${string}`, rest: Record<string, unknown>): Promise<SectionAnswer>; hubId: string };

const RefusalSchema = z.object({ details: z.object({ reason: z.string() }) });
const as = (code: RejectCode, field: string | null = null, detail: string[] = []): CommandOutcome => ({ status: 'rejected', code, field, detail });

/** The API's refusal in the console's words: a claim rule keeps its reason, so a reviewer reads why, not only that. */
export function claimRefusal(answer: SectionAnswer): CommandOutcome {
  const reason = RefusalSchema.safeParse(answer.body).data?.details.reason;
  if (answer.status === 404) return { status: 'not_found' };
  if (answer.status === 401) return as('elevation_required');
  if (reason === 'elevation_required') return as('elevation_required');
  if (reason === 'revision_conflict' || reason === 'invalid_transition') return as('stale');
  if (answer.status === 403 && (reason === undefined || reason === 'forbidden')) return as('denied');
  return reason ? as('claim_reason', null, [reason]) : as('invalid');
}

const done = (answer: SectionAnswer): CommandOutcome => (answer.status >= 200 && answer.status < 300 ? { status: 'applied' } : claimRefusal(answer));

/** One claim command against the API. The form was checked by the shell's evaluation; the database repeats every rule. */
export async function claimCommand(command: ClaimCommandId, f: Readonly<Record<string, string>>, io: ClaimSend): Promise<CommandOutcome> {
  const base = `/v1/admin/hubs/${encodeURIComponent(io.hubId)}` as const;
  const claim = `${base}/claims/requests/${encodeURIComponent(f.claimId ?? '')}` as const;
  const dispute = `${base}/claims/disputes/${encodeURIComponent(f.disputeId ?? '')}` as const;
  const invalid = (body: object): CommandOutcome | null => ('field' in body ? as('invalid', (body as { field: string }).field) : null);
  switch (command) {
    case 'claim.decide': {
      const body = decideBody(f);
      return invalid(body) ?? done(await io.send(`${claim}/decide`, body));
    }
    case 'claim.bind_evidence': {
      const body = boundChecks(f);
      return invalid(body) ?? done(await io.send(`${claim}/evidence`, body));
    }
    case 'claim.check_record': {
      const body = checkBody(f);
      return invalid(body) ?? done(await io.send(`${base}/verification/checks`, body));
    }
    case 'claim.screening_record':
      return done(await io.send(`${base}/verification/checks/screening`, { subject: { kind: 'company', id: f.companyId }, recipeId: f.recipeId }));
    case 'claim.country_correct': {
      const body = countryBody(f);
      return invalid(body) ?? done(await io.send(`${base}/claims/companies/${encodeURIComponent(f.companyId ?? '')}/country`, body));
    }
    case 'claim.dispute_propose': {
      const body = proposeBody(f);
      return invalid(body) ?? done(await io.send(`${dispute}/propose`, body));
    }
    case 'claim.dispute_confirm':
      return done(await io.send(`${dispute}/confirm`, { expectedRevision: Number(f.revision) }));
  }
}
