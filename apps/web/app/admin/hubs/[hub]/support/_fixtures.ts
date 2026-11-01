import {
  AccessLogEntrySchema,
  CaseAccessGrantSchema,
  DenyReasonSchema,
  SupportAccountSummarySchema,
  type AccessLogEntry,
  type CaseAccessGrant,
  type ProjectionClass,
  type SupportAccountSummary,
} from '@trustwork/contracts/client';
import { HUB_US_ID } from '../../../_fixtures/ids.js';

/**
 * Section-local fixtures of the support workspace HC-30 to HC-35 (HUBC-004). Account cards are parsed with the frozen
 * allowlist `SupportAccountSummarySchema` (masked e-mail, counts, no tokens, no message bodies); grants with
 * `CaseAccessGrantSchema` (requester differs from approver, at most 72 hours, private field classes excluded); reads
 * with `AccessLogEntrySchema`. The exact e-mail used for lookup lives only in `LOOKUP_INDEX` and is never rendered.
 * Everything is synthetic; the fixture clock is 2026-10-31 12:00 UTC.
 */

type DenyReason = (typeof DenyReasonSchema.options)[number];

const digest = (seed: string) => ({ algorithm: 'trustwork-digest-1' as const, value: seed.repeat(64 / seed.length) });
const sha = (seed: string) => seed.repeat(64 / seed.length);
const en = (value: string) => ({ value, lang: 'en' });
type Text = { value: string; lang: string };

/* ---------- Accounts (HC-31) ---------- */

const summary = (input: SupportAccountSummary) => SupportAccountSummarySchema.parse(input);

export type SupportAccount = { hubId: string; summary: SupportAccountSummary; publicProfileId: string | null };

export const ACCOUNTS: readonly SupportAccount[] = [
  {
    hubId: HUB_US_ID,
    publicProfileId: 'pr-maya',
    summary: summary({
      personId: 'acct-maya', displayName: 'Synthetic Electrician Maya', maskedEmail: 'ma***@harbor.example.invalid', emailVerified: true, accountState: 'active',
      secondFactor: { enrolled: true, methods: 2 }, activeSessions: 2, recovery: 'none',
      employer: { companyId: 'co-harbor', companyName: 'Synthetic Harbor Electric Inc. (demo)', role: 'Electrician' },
      entitlements: [{ offerCode: 'agent-free-30', validUntil: null }], openCases: 1,
      consents: [{ kind: 'profile_publication', version: '2', state: 'given', at: '2026-08-01T10:00:00Z' }, { kind: 'portrait_licence', version: '1', state: 'given', at: '2026-08-01T10:00:00Z' }],
    }),
  },
  {
    hubId: HUB_US_ID,
    publicProfileId: 'pr-luis',
    summary: summary({
      personId: 'acct-luis', displayName: 'Synthetic Roofer Luis', maskedEmail: 'lu***@example.invalid', emailVerified: true, accountState: 'locked',
      secondFactor: { enrolled: true, methods: 1 }, activeSessions: 0, recovery: 'cooling_off',
      employer: { companyId: 'co-ridge', companyName: 'Synthetic Ridge Roofing (demo)', role: 'Roofer' },
      entitlements: [{ offerCode: 'agent-free-30', validUntil: null }], openCases: 1,
      consents: [{ kind: 'profile_publication', version: '2', state: 'given', at: '2026-07-11T10:00:00Z' }],
    }),
  },
  {
    hubId: HUB_US_ID,
    publicProfileId: null,
    summary: summary({
      personId: 'acct-jordan', displayName: 'Synthetic Client Jordan', maskedEmail: 'jo***@example.invalid', emailVerified: false, accountState: 'pending_verification',
      secondFactor: { enrolled: false, methods: 0 }, activeSessions: 1, recovery: 'none', employer: null,
      entitlements: [], openCases: 0, consents: [],
    }),
  },
  {
    hubId: HUB_US_ID,
    publicProfileId: null,
    summary: summary({
      personId: 'acct-erased', displayName: 'Erased account', maskedEmail: 'er***@erased.invalid', emailVerified: false, accountState: 'erased',
      secondFactor: { enrolled: false, methods: 0 }, activeSessions: 0, recovery: 'none', employer: null, entitlements: [], openCases: 0, consents: [],
    }),
  },
  {
    // The support lead's own participant account: every servicing action is disabled for them on it.
    hubId: HUB_US_ID,
    publicProfileId: null,
    summary: summary({
      personId: 'p-support', displayName: 'Synthetic Support Lead', maskedEmail: 'su***@staff.example.invalid', emailVerified: true, accountState: 'active',
      secondFactor: { enrolled: true, methods: 2 }, activeSessions: 1, recovery: 'none', employer: null, entitlements: [], openCases: 0, consents: [],
    }),
  },
];

/** Exact-e-mail lookup, matched on the normalised value. Never rendered, never returned to a page. */
export const LOOKUP_INDEX: ReadonlyArray<{ hubId: string; personId: string; email: string }> = [
  { hubId: HUB_US_ID, personId: 'acct-maya', email: 'maya@harbor.example.invalid' },
  { hubId: HUB_US_ID, personId: 'acct-luis', email: 'luis@example.invalid' },
  { hubId: HUB_US_ID, personId: 'acct-jordan', email: 'jordan@example.invalid' },
];

export const COMMUNICATIONS: ReadonlyArray<{ personId: string; template: string; version: number; channel: 'email' | 'sms' | 'in_app'; state: 'delivered' | 'bounced' | 'queued'; at: string }> = [
  { personId: 'acct-maya', template: 'verification_email', version: 3, channel: 'email', state: 'delivered', at: '2026-08-01T09:58:00Z' },
  { personId: 'acct-maya', template: 'project_invitation', version: 2, channel: 'email', state: 'delivered', at: '2026-10-29T14:10:00Z' },
  { personId: 'acct-luis', template: 'lockout_notice', version: 1, channel: 'email', state: 'delivered', at: '2026-10-30T07:00:00Z' },
  { personId: 'acct-luis', template: 'recovery_change_notice', version: 2, channel: 'sms', state: 'delivered', at: '2026-10-30T12:05:00Z' },
  { personId: 'acct-jordan', template: 'verification_email', version: 3, channel: 'email', state: 'bounced', at: '2026-10-31T08:00:00Z' },
];

export const USAGE: ReadonlyArray<{ personId: string; offerCode: string; meter: 'agent_runs' | 'plan_drafts'; used: number; included: number; period: string }> = [
  { personId: 'acct-maya', offerCode: 'agent-free-30', meter: 'agent_runs', used: 24, included: 30, period: '2026-10' },
  { personId: 'acct-luis', offerCode: 'agent-free-30', meter: 'agent_runs', used: 30, included: 30, period: '2026-10' },
];

export const MEMBERSHIPS: ReadonlyArray<{ personId: string; company: Text; role: Text; from: string; to: string | null }> = [
  { personId: 'acct-maya', company: en('Synthetic Harbor Electric Inc. (demo)'), role: en('Electrician'), from: '2025-03-01T00:00:00Z', to: null },
  { personId: 'acct-maya', company: en('Synthetic Coastal Builders LLC (demo)'), role: en('Apprentice'), from: '2023-01-10T00:00:00Z', to: '2025-02-28T00:00:00Z' },
  { personId: 'acct-luis', company: en('Synthetic Ridge Roofing (demo)'), role: en('Roofer'), from: '2024-05-01T00:00:00Z', to: null },
];

export const GUIDED_TASKS = ['reinvite_colleague', 'verify_email_again', 'share_diagnostics', 'enrol_second_factor'] as const;
export const SERVICE_ACTIONS = ['resend_verification', 'unlock_after_lockout', 'revoke_all_sessions', 'require_password_reset', 'rebind_recovery_email', 'reset_second_factor', 'start_data_export', 'open_deletion_request', 'send_guided_task'] as const;

/* ---------- Companies (HC-32) ---------- */

export const SUPPORT_COMPANIES: ReadonlyArray<{ hubId: string; companyId: string; openCases: number }> = [
  { hubId: HUB_US_ID, companyId: 'co-coastal', openCases: 0 },
  { hubId: HUB_US_ID, companyId: 'co-harbor', openCases: 1 },
  { hubId: HUB_US_ID, companyId: 'co-ridge', openCases: 0 },
];

/* ---------- Cases and grants (HC-33) ---------- */

export const CASE_REASONS = ['access', 'sign_in', 'data_request', 'billing_question', 'bug'] as const;
export type SupportCase = {
  id: string;
  hubId: string;
  subject: { kind: 'person' | 'company'; id: string; name: Text };
  reason: (typeof CASE_REASONS)[number];
  state: 'open' | 'waiting_on_person' | 'closed';
  openedAt: string;
  assignee: string | null;
  thread: ReadonlyArray<{ from: 'person' | 'staff'; staffId: string | null; text: Text; at: string }>;
  snapshots: ReadonlyArray<{ id: string; page: string; versions: string; flags: readonly string[]; errorCodes: readonly string[]; requestIds: readonly string[]; objects: readonly string[]; at: string }>;
};

export const CASES: readonly SupportCase[] = [
  {
    id: 'sc-1001', hubId: HUB_US_ID, subject: { kind: 'person', id: 'acct-maya', name: en('Synthetic Electrician Maya') }, reason: 'access', state: 'open',
    openedAt: '2026-10-30T15:00:00Z', assignee: 'p-support-agent',
    thread: [
      { from: 'person', staffId: null, text: en('The supplier says they never received my request for quotes. Can you check?'), at: '2026-10-30T15:00:00Z' },
      { from: 'staff', staffId: 'p-support-agent', text: en('Thank you. I asked a colleague to approve a short diagnostic view of that request and its invitation.'), at: '2026-10-30T15:40:00Z' },
    ],
    snapshots: [{ id: 'ds-501', page: 'workspace.procurement.rfq', versions: 'web 0.1.0 · api 0.1.0', flags: ['procurement'], errorCodes: ['procurement.invitation_undelivered'], requestIds: ['req-7f3a'], objects: ['rfq-7781'], at: '2026-10-30T15:02:00Z' }],
  },
  {
    id: 'sc-1002', hubId: HUB_US_ID, subject: { kind: 'company', id: 'co-harbor', name: en('Synthetic Harbor Electric Inc. (demo)') }, reason: 'access', state: 'waiting_on_person',
    openedAt: '2026-10-29T10:00:00Z', assignee: 'p-support',
    thread: [{ from: 'person', staffId: null, text: en('A new colleague cannot see our shared project.'), at: '2026-10-29T10:00:00Z' }],
    snapshots: [],
  },
  {
    id: 'sc-1003', hubId: HUB_US_ID, subject: { kind: 'person', id: 'acct-luis', name: en('Synthetic Roofer Luis') }, reason: 'sign_in', state: 'open',
    openedAt: '2026-10-28T08:00:00Z', assignee: 'p-support-agent',
    thread: [{ from: 'person', staffId: null, text: en('I left my old company and lost the mailbox I used to sign in.'), at: '2026-10-28T08:00:00Z' }],
    snapshots: [],
  },
  {
    id: 'sc-0999', hubId: HUB_US_ID, subject: { kind: 'person', id: 'acct-jordan', name: en('Synthetic Client Jordan') }, reason: 'bug', state: 'closed',
    openedAt: '2026-10-20T08:00:00Z', assignee: 'p-support',
    thread: [{ from: 'person', staffId: null, text: en('The verification e-mail did not arrive.'), at: '2026-10-20T08:00:00Z' }],
    snapshots: [],
  },
];

/** A grant request waiting for a different support lead: the exact request is bound by its digest. */
export type GrantRequest = {
  id: string;
  caseId: string;
  requestedBy: string;
  objectType: string;
  ids: readonly string[];
  projectionClass: ProjectionClass;
  purpose: Text;
  hours: number;
  requestedAt: string;
  digest: { algorithm: 'trustwork-digest-1'; value: string };
};

export const GRANT_REQUESTS: readonly GrantRequest[] = [
  { id: 'gr-301', caseId: 'sc-1001', requestedBy: 'p-support-agent', objectType: 'rfq', ids: ['rfq-7781', 'inv-7781-2'], projectionClass: 'diagnostic', purpose: en('Check whether the invitation to the supplier was sent and delivered'), hours: 24, requestedAt: '2026-10-31T09:30:00Z', digest: digest('a1') },
  { id: 'gr-302', caseId: 'sc-1002', requestedBy: 'p-support', objectType: 'project', ids: ['pj-4410'], projectionClass: 'diagnostic', purpose: en('See which participation the new colleague is missing'), hours: 48, requestedAt: '2026-10-31T10:00:00Z', digest: digest('b2') },
];

const grant = (g: CaseAccessGrant) => CaseAccessGrantSchema.parse(g);
const EXCLUDED = ['negotiation_private', 'credentials', 'payment_refs'] as const;

export const GRANTS: ReadonlyArray<CaseAccessGrant & { hubId: string }> = [
  {
    hubId: HUB_US_ID,
    ...grant({ id: 'g-201', supportCaseId: 'sc-1003', requestedBy: 'p-support-agent', approvedBy: 'p-support', approvalDigest: digest('c3'), objectSelector: { type: 'account_recovery', ids: ['rr-61'] }, projectionClass: 'support_private_limited', excludedFieldClasses: [...EXCLUDED], purpose: 'Review the recovery request evidence record', requestedAt: '2026-10-31T07:00:00Z', approvedAt: '2026-10-31T07:30:00Z', expiresAt: '2026-11-01T07:30:00Z', revokedAt: null, revokedBy: null, legalExceptionRef: null }),
  },
  {
    hubId: HUB_US_ID,
    ...grant({ id: 'g-150', supportCaseId: 'sc-1003', requestedBy: 'p-support-agent', approvedBy: 'p-support', approvalDigest: digest('d4'), objectSelector: { type: 'company_membership', ids: ['mb-55'] }, projectionClass: 'diagnostic', excludedFieldClasses: [...EXCLUDED], purpose: 'Confirm the membership end date', requestedAt: '2026-10-28T08:30:00Z', approvedAt: '2026-10-28T09:00:00Z', expiresAt: '2026-10-29T09:00:00Z', revokedAt: null, revokedBy: null, legalExceptionRef: null }),
  },
  {
    hubId: HUB_US_ID,
    ...grant({ id: 'g-120', supportCaseId: 'sc-0999', requestedBy: 'p-support', approvedBy: 'p-support-agent', approvalDigest: digest('e5'), objectSelector: { type: 'notification', ids: ['nt-9001'] }, projectionClass: 'diagnostic', excludedFieldClasses: [...EXCLUDED], purpose: 'Check the delivery record of the verification e-mail', requestedAt: '2026-10-20T08:10:00Z', approvedAt: '2026-10-20T08:20:00Z', expiresAt: '2026-10-21T08:20:00Z', revokedAt: '2026-10-20T09:00:00Z', revokedBy: 'p-support', legalExceptionRef: null }),
  },
];

export const ACCESS_LOG: readonly AccessLogEntry[] = [
  AccessLogEntrySchema.parse({ id: 'al-9001', sequence: 41, readAt: '2026-10-31T07:45:00Z', actorPersonId: 'p-support-agent', grantId: 'g-201', caseRef: { kind: 'support_case', id: 'sc-1003' }, kind: 'case_read', objectType: 'account_recovery', objectId: 'rr-61', fieldsHash: sha('9a') }),
  AccessLogEntrySchema.parse({ id: 'al-8800', sequence: 37, readAt: '2026-10-28T09:10:00Z', actorPersonId: 'p-support-agent', grantId: 'g-150', caseRef: { kind: 'support_case', id: 'sc-1003' }, kind: 'case_read', objectType: 'company_membership', objectId: 'mb-55', fieldsHash: sha('8b') }),
];

/** Objects a case grant can name, by type (a selector names up to 100 ids of one type). */
export const GRANT_OBJECT_TYPES = ['rfq', 'project', 'quote_invitation', 'company_membership', 'notification', 'account_recovery'] as const;

/* ---------- Recovery escalations (HC-34) ---------- */

export type RecoveryRequest = {
  id: string;
  hubId: string;
  caseId: string;
  subject: { personId: string; name: Text };
  action: 'rebind_recovery_email' | 'reset_second_factor';
  requestedBy: string;
  approvedBy: string | null;
  evidence: 'recorded' | 'missing';
  requestedAt: string;
  effectiveAt: string | null;
  notified: ReadonlyArray<'email' | 'sms' | 'in_app'>;
  objection: boolean;
  state: 'awaiting_approval' | 'cooling_off' | 'ready' | 'cancelled';
};

export const RECOVERY: readonly RecoveryRequest[] = [
  { id: 'rr-61', hubId: HUB_US_ID, caseId: 'sc-1003', subject: { personId: 'acct-luis', name: en('Synthetic Roofer Luis') }, action: 'rebind_recovery_email', requestedBy: 'p-support-agent', approvedBy: 'p-support', evidence: 'recorded', requestedAt: '2026-10-30T12:00:00Z', effectiveAt: '2026-11-02T12:00:00Z', notified: ['email', 'sms'], objection: false, state: 'cooling_off' },
  { id: 'rr-62', hubId: HUB_US_ID, caseId: 'sc-1001', subject: { personId: 'acct-maya', name: en('Synthetic Electrician Maya') }, action: 'reset_second_factor', requestedBy: 'p-support-agent', approvedBy: null, evidence: 'recorded', requestedAt: '2026-10-31T11:00:00Z', effectiveAt: null, notified: ['email'], objection: false, state: 'awaiting_approval' },
  { id: 'rr-58', hubId: HUB_US_ID, caseId: 'sc-1003', subject: { personId: 'acct-luis', name: en('Synthetic Roofer Luis') }, action: 'reset_second_factor', requestedBy: 'p-support', approvedBy: 'p-support-agent', evidence: 'recorded', requestedAt: '2026-10-24T09:00:00Z', effectiveAt: '2026-10-27T09:00:00Z', notified: ['email', 'sms'], objection: false, state: 'ready' },
  { id: 'rr-55', hubId: HUB_US_ID, caseId: 'sc-1001', subject: { personId: 'acct-maya', name: en('Synthetic Electrician Maya') }, action: 'rebind_recovery_email', requestedBy: 'p-support-agent', approvedBy: 'p-support', evidence: 'recorded', requestedAt: '2026-10-20T09:00:00Z', effectiveAt: '2026-10-23T09:00:00Z', notified: ['email'], objection: true, state: 'cancelled' },
];

/* ---------- Access explainer (HC-35) ---------- */

export const EXPLAIN_PRINCIPALS: ReadonlyArray<{ id: string; hubId: string; name: Text }> = [
  { id: 'acct-maya', hubId: HUB_US_ID, name: en('Synthetic Electrician Maya') },
  { id: 'acct-jordan', hubId: HUB_US_ID, name: en('Synthetic Client Jordan') },
];
export const EXPLAIN_OBJECTS: ReadonlyArray<{ id: string; hubId: string; kind: 'project' | 'rfq' | 'company_page' }> = [
  { id: 'pj-4410', hubId: HUB_US_ID, kind: 'project' },
  { id: 'rfq-7781', hubId: HUB_US_ID, kind: 'rfq' },
  { id: 'co-harbor', hubId: HUB_US_ID, kind: 'company_page' },
];
/** Policy decisions (`PolicyDecisionSchema` shape): reason codes and the rule they refer to, never object content. */
export const EXPLANATIONS: ReadonlyArray<{ principal: string; object: string; effect: 'allow' | 'deny'; reasons: readonly (DenyReason | 'public_projection' | 'participation')[]; rule: string }> = [
  { principal: 'acct-maya', object: 'pj-4410', effect: 'deny', reasons: ['membership_ended'], rule: 'access-policy 3.2' },
  { principal: 'acct-maya', object: 'rfq-7781', effect: 'allow', reasons: ['participation'], rule: 'access-policy 2.1' },
  { principal: 'acct-maya', object: 'co-harbor', effect: 'allow', reasons: ['public_projection'], rule: 'access-policy 1.4' },
  { principal: 'acct-jordan', object: 'pj-4410', effect: 'deny', reasons: ['no_participation'], rule: 'access-policy 2.1' },
  { principal: 'acct-jordan', object: 'rfq-7781', effect: 'deny', reasons: ['email_unverified'], rule: 'access-policy 4.3' },
  { principal: 'acct-jordan', object: 'co-harbor', effect: 'allow', reasons: ['public_projection'], rule: 'access-policy 1.4' },
];

/** Every support fixture of one hub. */
export function supportOf(hubId: string) {
  const own = <T extends { hubId: string }>(rows: readonly T[]) => rows.filter((r) => r.hubId === hubId);
  const cases = own(CASES);
  const caseIds = new Set(cases.map((c) => c.id));
  return {
    accounts: own(ACCOUNTS),
    lookup: own(LOOKUP_INDEX),
    companies: own(SUPPORT_COMPANIES),
    cases,
    grantRequests: GRANT_REQUESTS.filter((g) => caseIds.has(g.caseId)),
    grants: own(GRANTS),
    accessLog: ACCESS_LOG.filter((a) => caseIds.has(a.caseRef.id)),
    recovery: own(RECOVERY),
    principals: own(EXPLAIN_PRINCIPALS),
    objects: own(EXPLAIN_OBJECTS),
  };
}
export type SupportData = ReturnType<typeof supportOf>;
