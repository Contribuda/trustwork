import { BASELINE_LIST_CODES, ConfirmationPolicySchema, type ConfirmationPolicy } from '@trustwork/contracts/client';
import { HUB_SAMARKAND_ID, HUB_US_ID } from '../../../_fixtures/ids.js';

/**
 * Section-local fixtures of the trust and safety screens HC-70 to HC-75 (HUBC-004): reports and moderation cases
 * with the clause library and sanction ladder, disputes, reputation method versions with bounded local parameters,
 * one appeals queue, sanctions screening (baseline lists, matches, jurisdiction holds, re-screen runs, cohort
 * metrics) and the confirmation policy parsed with `ConfirmationPolicySchema`. No fixture holds a score, a rank or a
 * badge: the console has nothing that could set one. Everything is synthetic.
 */

const en = (value: string) => ({ value, lang: 'en' });
type Text = { value: string; lang: string };

/* ---------- HC-70 Moderation ---------- */

export const CLAUSES: ReadonlyArray<{ key: string; law: Text }> = [
  { key: 'harassment', law: en('Community rule 3.1; state anti-harassment law') },
  { key: 'false_claims', law: en('Community rule 4.2; state consumer protection law') },
  { key: 'privacy', law: en('Community rule 5.1; California privacy law (CCPA/CPRA)') },
  { key: 'spam', law: en('Community rule 6.1; CAN-SPAM Act') },
];
export const SANCTION_LEVELS = [1, 2, 3, 4] as const;

export type Report = { id: string; hubId: string; target: 'profile' | 'publication' | 'review' | 'company_page'; clause: string; source: 'participant' | 'anonymous' | 'automated'; receivedAt: string; state: 'new' | 'in_case' };
export const REPORTS: readonly Report[] = [
  { id: 'rp-881', hubId: HUB_US_ID, target: 'review', clause: 'harassment', source: 'participant', receivedAt: '2026-10-31T08:20:00Z', state: 'new' },
  { id: 'rp-882', hubId: HUB_US_ID, target: 'company_page', clause: 'false_claims', source: 'participant', receivedAt: '2026-10-31T09:05:00Z', state: 'new' },
  { id: 'rp-870', hubId: HUB_US_ID, target: 'publication', clause: 'spam', source: 'automated', receivedAt: '2026-10-29T17:00:00Z', state: 'in_case' },
];

export type ModerationCase = { id: string; hubId: string; clause: string; evidence: number; decision: 'pending' | 'no_action' | 'sanction'; level: number | null; appeal: 'none' | 'filed' | 'decided'; openedAt: string };
export const MODERATION_CASES: readonly ModerationCase[] = [
  { id: 'mc-410', hubId: HUB_US_ID, clause: 'spam', evidence: 3, decision: 'pending', level: null, appeal: 'none', openedAt: '2026-10-29T17:30:00Z' },
  { id: 'mc-402', hubId: HUB_US_ID, clause: 'harassment', evidence: 5, decision: 'sanction', level: 2, appeal: 'filed', openedAt: '2026-10-22T10:00:00Z' },
];

/* ---------- HC-71 Disputes ---------- */

export type Dispute = {
  id: string;
  hubId: string;
  assertion: 'delivery_late' | 'work_incomplete' | 'payment_late';
  observation: string;
  parties: readonly [Text, Text];
  evidence: number;
  statements: ReadonlyArray<{ party: 0 | 1; text: Text }>;
  state: 'open' | 'excluded_pending' | 'decided';
  openedAt: string;
};
export const DISPUTES: readonly Dispute[] = [
  {
    id: 'dp-55', hubId: HUB_US_ID, assertion: 'delivery_late', observation: 'ob-7710', parties: [en('Synthetic Coastal Builders LLC (demo)'), en('Synthetic Mesa Lumber Supply (demo)')], evidence: 4,
    statements: [{ party: 0, text: en('The lumber arrived nine days after the agreed date.') }, { party: 1, text: en('The delivery date moved after the buyer changed the order.') }],
    state: 'open', openedAt: '2026-10-27T12:00:00Z',
  },
  {
    id: 'dp-51', hubId: HUB_US_ID, assertion: 'work_incomplete', observation: 'ob-7602', parties: [en('Synthetic Client Jordan'), en('Synthetic Ridge Roofing (demo)')], evidence: 2,
    statements: [{ party: 0, text: en('Flashing around the chimney was not installed.') }],
    state: 'excluded_pending', openedAt: '2026-10-18T12:00:00Z',
  },
];
export const DISPUTE_DECISIONS = ['observation_stands', 'observation_corrected', 'observation_removed'] as const;

/* ---------- HC-72 Reputation methods ---------- */

/** Local method parameters inside engine bounds; there is no parameter that sets a score. */
export const METHOD_PARAMETERS = {
  windowMonths: { min: 6, max: 36 },
  minimumSamples: { min: 3, max: 50 },
  confirmationDays: { min: 7, max: 60 },
} as const;
export type MethodParameter = keyof typeof METHOD_PARAMETERS;

export type MethodVersion = {
  id: string;
  hubId: string;
  version: number;
  state: 'draft' | 'in_review' | 'released' | 'superseded';
  parameters: Record<MethodParameter, number>;
  explanations: readonly string[];
  releasedBy: string | null;
  releasedAt: string | null;
};
export const METHODS: readonly MethodVersion[] = [
  { id: 'rm-4', hubId: HUB_US_ID, version: 4, state: 'in_review', parameters: { windowMonths: 24, minimumSamples: 5, confirmationDays: 21 }, explanations: ['en'], releasedBy: null, releasedAt: null },
  { id: 'rm-3', hubId: HUB_US_ID, version: 3, state: 'released', parameters: { windowMonths: 18, minimumSamples: 5, confirmationDays: 14 }, explanations: ['en', 'es'], releasedBy: 'p-hub-owner', releasedAt: '2026-09-01T09:00:00Z' },
  { id: 'rm-2', hubId: HUB_US_ID, version: 2, state: 'superseded', parameters: { windowMonths: 12, minimumSamples: 3, confirmationDays: 14 }, explanations: ['en'], releasedBy: 'p-hub-owner', releasedAt: '2026-05-01T09:00:00Z' },
];
export const RECOMPUTE_JOBS: ReadonlyArray<{ id: string; hubId: string; method: number; state: 'done' | 'running' | 'queued'; processed: number; total: number; startedAt: string }> = [
  { id: 'rj-31', hubId: HUB_US_ID, method: 3, state: 'done', processed: 1980, total: 1980, startedAt: '2026-09-01T09:10:00Z' },
];

/* ---------- HC-73 Appeals ---------- */

export type Appeal = { id: string; hubId: string; against: 'claim' | 'credential' | 'moderation' | 'observation'; ref: string; originalDecider: string; filedAt: string; deadline: string; state: 'open' | 'information_requested' };
export const APPEALS: readonly Appeal[] = [
  { id: 'ap-91', hubId: HUB_US_ID, against: 'claim', ref: 'cl-204', originalDecider: 'p-trust', filedAt: '2026-10-27T09:00:00Z', deadline: '2026-11-10T09:00:00Z', state: 'open' },
  { id: 'ap-92', hubId: HUB_US_ID, against: 'moderation', ref: 'mc-402', originalDecider: 'p-hub-owner', filedAt: '2026-10-28T09:00:00Z', deadline: '2026-11-11T09:00:00Z', state: 'open' },
  { id: 'ap-93', hubId: HUB_US_ID, against: 'credential', ref: 'vc-1003', originalDecider: 'p-compliance', filedAt: '2026-10-25T09:00:00Z', deadline: '2026-11-08T09:00:00Z', state: 'information_requested' },
  { id: 'ap-94', hubId: HUB_US_ID, against: 'observation', ref: 'ob-7602', originalDecider: 'p-trust', filedAt: '2026-10-30T09:00:00Z', deadline: '2026-11-13T09:00:00Z', state: 'open' },
];
export const APPEAL_DECISIONS = ['upheld', 'overturned', 'partly_overturned'] as const;

/* ---------- HC-74 Screening ---------- */

export type ScreeningList = { code: string; hubId: string; baseline: boolean; mode: 'fake' | 'file' | 'live'; version: string; publishedAt: string; entries: number; freshness: 'fresh' | 'warning' | 'stale' };
export const SCREENING_LISTS: readonly ScreeningList[] = [
  ...BASELINE_LIST_CODES.map((code, i) => ({ code, hubId: HUB_US_ID, baseline: true, mode: 'file' as const, version: `2026-10-${30 - i}`, publishedAt: `2026-10-${30 - i}T00:00:00Z`, entries: i === 0 ? 17240 : 412, freshness: 'fresh' as const })),
  { code: 'eu-consolidated', hubId: HUB_US_ID, baseline: false, mode: 'file', version: '2026-10-21', publishedAt: '2026-10-21T00:00:00Z', entries: 5810, freshness: 'warning' },
  ...BASELINE_LIST_CODES.map((code) => ({ code, hubId: HUB_SAMARKAND_ID, baseline: true, mode: 'fake' as const, version: '2026-09-30', publishedAt: '2026-09-30T00:00:00Z', entries: 120, freshness: 'stale' as const })),
];
export const PACK_LIST_FACTS = ['uk-hmt', 'un-consolidated', 'eu-consolidated'] as const;
export const GEO_DATASET: Readonly<Record<string, { dataset: string; mode: 'ranges_file' | 'fake'; ageDays: number }>> = {
  [HUB_US_ID]: { dataset: 'geo:demo-ranges-2026-10', mode: 'ranges_file', ageDays: 6 },
  [HUB_SAMARKAND_ID]: { dataset: 'geo:fake', mode: 'fake', ageDays: 31 },
};

export type ScreeningMatch = { id: string; hubId: string; subject: { kind: 'person' | 'company'; name: Text }; list: string; entry: { uid: string; name: Text }; strength: 'strong' | 'weak'; late: boolean; caseId: string; originalDecider: string | null; state: 'open' | 'appeal' };
export const MATCHES: readonly ScreeningMatch[] = [
  { id: 'sm-31', hubId: HUB_US_ID, subject: { kind: 'company', name: en('Synthetic Ridge Roofing (demo)') }, list: 'ofac-sdn', entry: { uid: 'demo-entry-4471', name: en('RIDGE ROOFING TRADING (synthetic entry)') }, strength: 'weak', late: false, caseId: 'sc-sanc-31', originalDecider: null, state: 'open' },
  { id: 'sm-27', hubId: HUB_US_ID, subject: { kind: 'person', name: en('Synthetic Client Jordan') }, list: 'ofac-cons', entry: { uid: 'demo-entry-0912', name: en('JORDAN, SYNTHETIC (synthetic entry)') }, strength: 'strong', late: true, caseId: 'sc-sanc-27', originalDecider: 'p-compliance', state: 'appeal' },
];
export type JurisdictionHoldRow = { id: string; hubId: string; place: string; source: 'geolocation' | 'edge_header' | 'self_declared' | 'payout_country' | 'staff_report'; dataset: string; at: string };
export const HOLDS: readonly JurisdictionHoldRow[] = [
  { id: 'jh-12', hubId: HUB_US_ID, place: 'CU', source: 'geolocation', dataset: 'geo:demo-ranges-2026-10', at: '2026-10-31T06:40:00Z' },
  { id: 'jh-11', hubId: HUB_US_ID, place: 'IR', source: 'payout_country', dataset: 'payout-country', at: '2026-10-30T18:00:00Z' },
];
export const RESCREEN_RUNS: ReadonlyArray<{ id: string; hubId: string; trigger: 'list_version' | 'weekly' | 'manual'; processed: number; total: number; state: 'running' | 'done' }> = [
  { id: 'rs-88', hubId: HUB_US_ID, trigger: 'list_version', processed: 1530, total: 2210, state: 'running' },
  { id: 'rs-87', hubId: HUB_US_ID, trigger: 'weekly', processed: 2190, total: 2190, state: 'done' },
];
export const SCREENING_METRICS: Readonly<Record<string, { refusals: number; holds: number; matches: number; notSamePersonShare: number; cohort: number }>> = {
  [HUB_US_ID]: { refusals: 46, holds: 7, matches: 12, notSamePersonShare: 0.83, cohort: 12 },
  [HUB_SAMARKAND_ID]: { refusals: 0, holds: 0, matches: 0, notSamePersonShare: 0, cohort: 0 },
};

/* ---------- HC-75 Confirmations ---------- */

export const CONFIRMATION_POLICIES: readonly ConfirmationPolicy[] = [
  ConfirmationPolicySchema.parse({
    hubId: HUB_US_ID, version: 2, requireTransactionOrProjectLink: true, maxOpenRequestsPerRequester: 20, maxRequestsPerCounterpartyPerMonth: 3,
    declineCooldownDays: 30, reciprocalConfirmationsFlagged: true, agentsMayRequest: true, agentsMayConfirm: false,
  }),
];
export const FLAGGED_PATTERNS: ReadonlyArray<{ id: string; hubId: string; kind: 'reciprocal' | 'burst' | 'new_accounts'; size: number; window: number; detectedAt: string }> = [
  { id: 'fp-17', hubId: HUB_US_ID, kind: 'reciprocal', size: 2, window: 30, detectedAt: '2026-10-30T05:00:00Z' },
  { id: 'fp-16', hubId: HUB_US_ID, kind: 'burst', size: 14, window: 7, detectedAt: '2026-10-26T05:00:00Z' },
];
export const CONFIRMATION_COUNTS: Readonly<Record<string, { requested: number; accepted: number; declined: number }>> = {
  [HUB_US_ID]: { requested: 812, accepted: 640, declined: 6 },
  [HUB_SAMARKAND_ID]: { requested: 3, accepted: 2, declined: 0 },
};

/** Every trust fixture of one hub. */
export function trustOf(hubId: string) {
  const own = <T extends { hubId: string }>(rows: readonly T[]) => rows.filter((r) => r.hubId === hubId);
  return {
    reports: own(REPORTS),
    cases: own(MODERATION_CASES),
    disputes: own(DISPUTES),
    methods: own(METHODS),
    jobs: own(RECOMPUTE_JOBS),
    appeals: own(APPEALS),
    lists: own(SCREENING_LISTS),
    geo: GEO_DATASET[hubId] ?? null,
    matches: own(MATCHES),
    holds: own(HOLDS),
    runs: own(RESCREEN_RUNS),
    metrics: SCREENING_METRICS[hubId] ?? null,
    policy: CONFIRMATION_POLICIES.find((p) => p.hubId === hubId) ?? null,
    patterns: own(FLAGGED_PATTERNS),
    confirmations: CONFIRMATION_COUNTS[hubId] ?? null,
  };
}
export type TrustData = ReturnType<typeof trustOf>;
