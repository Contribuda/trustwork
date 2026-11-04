import type { ConsolePermission } from '@trustwork/contracts/client';

/**
 * Live commands of HC-22 Claims (HUBC-007 on the CLM-001 and HUB-003 routes). Pure: no clock, no I/O. What is checked here
 * only words a mistake early; the database repeats every rule, including the country rule of #595, and no command here
 * writes a badge, a hand-over or a claim status: a decision does that, in one transaction, or refuses.
 */

export const CLAIM_COMMANDS = ['claim.decide', 'claim.bind_evidence', 'claim.check_record', 'claim.screening_record', 'claim.country_correct', 'claim.dispute_propose', 'claim.dispute_confirm'] as const;
export type ClaimCommandId = (typeof CLAIM_COMMANDS)[number];
export function isClaimCommand(value: unknown): value is ClaimCommandId {
  return typeof value === 'string' && (CLAIM_COMMANDS as readonly string[]).includes(value);
}

/** The refusal of a claim rule: `detail` holds the reason code, worded by `adminParticipants.claims.live.reasons.*`. */
export const CLAIM_REJECT_CODES = ['claim_reason'] as const;

export const CLAIM_COMMAND_PERMISSIONS: Record<ClaimCommandId, readonly ConsolePermission[]> = {
  'claim.decide': ['admin.claims.decide'],
  'claim.bind_evidence': ['admin.claims.decide'],
  'claim.check_record': ['admin.claims.decide'],
  'claim.screening_record': ['admin.claims.decide'],
  'claim.country_correct': ['admin.claims.authority.decide'],
  'claim.dispute_propose': ['admin.claims.decide'],
  'claim.dispute_confirm': ['admin.claims.decide'],
};

export const CLAIM_DECISIONS = ['approved', 'rejected'] as const;
export const CHECK_RESULTS = ['pass', 'fail', 'inconclusive', 'unavailable'] as const;
/** What the page says about a company and this hub: the rule of `claims_require_territory`, read, not decided, here. */
export type TerritoryState = 'covered' | 'outside' | 'missing';

type Fields = Readonly<Record<string, string>>;
export type Invalid = { field: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const EVIDENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const text = (value: string | undefined) => (value ?? '').trim();
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]): T | null => (allowed.includes(value as T) ? (value as T) : null);
const revision = (value: string | undefined): number | null => (/^[1-9]\d{0,8}$/.test(value ?? '') ? Number(value) : null);

/** Whether a hub's territories reach a country: the country itself, a region of it or a place in it. */
export function territoryState(territories: ReadonlyArray<{ code: string }>, country: string | null): TerritoryState {
  if (!country) return 'missing';
  return territories.some((t) => t.code.slice(0, 2) === country) ? 'covered' : 'outside';
}

export function decideBody(f: Fields) {
  const expectedRevision = revision(f.revision);
  if (expectedRevision === null) return { field: 'revision' };
  const decision = oneOf(f.decision, CLAIM_DECISIONS);
  if (!decision) return { field: 'decision' };
  const note = text(f.note);
  if (note.length > 1000) return { field: 'note' };
  return { expectedRevision, decision, officerMatch: f.officerMatch === 'on', note: note || null };
}

/** The checks a reviewer ticked: `check.<id>`, one to twelve. */
export function boundChecks(f: Fields) {
  const checkIds = Object.entries(f).filter(([key, value]) => key.startsWith('check.') && value === 'on').map(([key]) => key.slice('check.'.length));
  if (checkIds.length < 1 || checkIds.length > 12 || checkIds.some((id) => !UUID.test(id))) return { field: 'checks' };
  return { checkIds };
}

export function checkBody(f: Fields) {
  if (!UUID.test(f.companyId ?? '')) return { field: 'companyId' };
  if (!UUID.test(f.recipeId ?? '')) return { field: 'recipeId' };
  if (!UUID.test(f.providerId ?? '')) return { field: 'providerId' };
  const result = oneOf(f.result, CHECK_RESULTS);
  if (!result) return { field: 'result' };
  const evidence = text(f.evidenceRef);
  if (evidence && !EVIDENCE.test(evidence)) return { field: 'evidenceRef' };
  return { subject: { kind: 'company' as const, id: f.companyId as string }, recipeId: f.recipeId as string, providerId: f.providerId as string, result, evidenceRef: evidence || null };
}

/** `fromCountry` and `fromRegion` restate what the reviewer saw, so a correction in flight is not overwritten. */
export function countryBody(f: Fields) {
  const fromCountry = text(f.fromCountry) || null;
  const fromRegion = text(f.fromRegion) || null;
  if (fromCountry !== null && !COUNTRY.test(fromCountry)) return { field: 'fromCountry' };
  if (fromRegion !== null && !REGION.test(fromRegion)) return { field: 'fromRegion' };
  const country = text(f.country).toUpperCase();
  if (!COUNTRY.test(country)) return { field: 'country' };
  const region = text(f.region).toUpperCase();
  if (region && !REGION.test(region)) return { field: 'region' };
  return { fromCountry, fromRegion, country, region: region || null };
}

export function proposeBody(f: Fields) {
  const expectedRevision = revision(f.revision);
  if (expectedRevision === null) return { field: 'revision' };
  const winner = f.winner ?? '';
  if (winner !== 'none' && !UUID.test(winner)) return { field: 'winner' };
  const note = text(f.note);
  if (note.length < 10 || note.length > 1000) return { field: 'note' };
  return { expectedRevision, winnerClaimId: winner === 'none' ? null : winner, note };
}

const failed = (body: object): Invalid | null => ('field' in body ? (body as Invalid) : null);

/** What the shell's evaluation checks for these commands after role, elevation and reason: a well-formed form. */
export function claimFormProblem(command: ClaimCommandId, f: Fields): Invalid | null {
  switch (command) {
    case 'claim.decide':
      if (!UUID.test(f.claimId ?? '')) return { field: 'claimId' };
      return failed(decideBody(f));
    case 'claim.bind_evidence':
      if (!UUID.test(f.claimId ?? '')) return { field: 'claimId' };
      return failed(boundChecks(f));
    case 'claim.check_record':
      return failed(checkBody(f));
    case 'claim.screening_record':
      if (!UUID.test(f.companyId ?? '')) return { field: 'companyId' };
      return UUID.test(f.recipeId ?? '') ? null : { field: 'recipeId' };
    case 'claim.country_correct':
      if (!UUID.test(f.companyId ?? '')) return { field: 'companyId' };
      return failed(countryBody(f));
    case 'claim.dispute_propose':
      if (!UUID.test(f.disputeId ?? '')) return { field: 'disputeId' };
      return failed(proposeBody(f));
    case 'claim.dispute_confirm':
      if (!UUID.test(f.disputeId ?? '')) return { field: 'disputeId' };
      return revision(f.revision) === null ? { field: 'revision' } : null;
  }
}
