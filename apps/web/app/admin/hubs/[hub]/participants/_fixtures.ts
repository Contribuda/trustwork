import { CredentialTypeSchema, IssuedCredentialSchema, type CredentialType, type IssuedCredential } from '@trustwork/contracts/client';
import { HUB_SAMARKAND_ID, HUB_US_ID } from '../../../_fixtures/ids.js';

/**
 * Section-local fixtures of the participants screens HC-20 to HC-25 (HUBC-004). Synthetic people and companies on
 * the US demo hub ("Synthetic …", "(demo)", `.invalid` domains, EIN-shaped identifiers with the never-issued prefix
 * 00), the US claim recipe of docs/engine/hub-console/modules.md, credential types parsed with the frozen contract
 * schemas, and cohort counts that the screens suppress below ten. The Samarkand example hub has almost nothing yet
 * (empty states). Nothing here describes a real person or organisation.
 */

const digest = (seed: string) => ({ algorithm: 'trustwork-digest-1' as const, value: seed.repeat(64 / seed.length) });
const en = (value: string) => ({ value, lang: 'en' });
type Text = { value: string; lang: string };

/* ---------- HC-20 People ---------- */

export const TRADES = ['electrician', 'roofer', 'general_contractor', 'architect', 'plumber', 'tile_setter', 'client'] as const;
export type Trade = (typeof TRADES)[number];

export type PublicProfile = {
  id: string;
  hubId: string;
  name: Text;
  trade: Trade;
  place: Text;
  employer: Text | null;
  /** Private profiles never reach the console's people list; they exist here only so tests can prove that. */
  visibility: 'public' | 'private';
  portrait: 'licensed' | 'missing' | 'none';
  consentProblem: boolean;
  /** The support account this public profile belongs to (opened only from a support case). */
  accountId: string;
};

export const PROFILES: readonly PublicProfile[] = [
  { id: 'pr-maya', hubId: HUB_US_ID, name: en('Synthetic Electrician Maya'), trade: 'electrician', place: en('San Diego, California'), employer: en('Synthetic Harbor Electric Inc. (demo)'), visibility: 'public', portrait: 'licensed', consentProblem: false, accountId: 'acct-maya' },
  { id: 'pr-luis', hubId: HUB_US_ID, name: en('Synthetic Roofer Luis'), trade: 'roofer', place: en('Chula Vista, California'), employer: en('Synthetic Ridge Roofing (demo)'), visibility: 'public', portrait: 'missing', consentProblem: false, accountId: 'acct-luis' },
  { id: 'pr-dana', hubId: HUB_US_ID, name: en('Synthetic Architect Dana'), trade: 'architect', place: en('La Jolla, California'), employer: null, visibility: 'public', portrait: 'licensed', consentProblem: true, accountId: 'acct-dana' },
  { id: 'pr-sam', hubId: HUB_US_ID, name: en('Synthetic Contractor Sam'), trade: 'general_contractor', place: en('San Diego, California'), employer: en('Synthetic Coastal Builders LLC (demo)'), visibility: 'public', portrait: 'none', consentProblem: false, accountId: 'acct-sam' },
  { id: 'pr-hidden', hubId: HUB_US_ID, name: en('Synthetic Private Client Jordan'), trade: 'client', place: en('Escondido, California'), employer: null, visibility: 'private', portrait: 'none', consentProblem: false, accountId: 'acct-jordan' },
];

export const ACCOUNT_STATES = ['active', 'pending_verification', 'locked', 'suspended', 'deletion_requested', 'erased'] as const;
export const ACCOUNT_STATE_COUNTS: Readonly<Record<string, Record<(typeof ACCOUNT_STATES)[number], number>>> = {
  [HUB_US_ID]: { active: 1240, pending_verification: 37, locked: 4, suspended: 0, deletion_requested: 2, erased: 11 },
  [HUB_SAMARKAND_ID]: { active: 6, pending_verification: 1, locked: 0, suspended: 0, deletion_requested: 0, erased: 0 },
};
export const PROFILE_PROBLEMS: Readonly<Record<string, { consentWithdrawn: number; portraitMissing: number }>> = {
  [HUB_US_ID]: { consentWithdrawn: 3, portraitMissing: 12 },
  [HUB_SAMARKAND_ID]: { consentWithdrawn: 0, portraitMissing: 0 },
};
export const FLAG_CATEGORIES = ['misleading_claim', 'impersonation_report', 'portrait_without_licence', 'harassment', 'spam'] as const;

/* ---------- HC-21 Companies ---------- */

export type CompanyState = 'sourced' | 'claimed' | 'verified';
export type CompanyRecord = {
  id: string;
  hubId: string;
  name: Text;
  state: CompanyState;
  kind: 'contractor' | 'manufacturer' | 'supplier';
  identifiers: ReadonlyArray<{ kind: 'ein' | 'state_licence'; value: string }>;
  verifiedAt: string | null;
  categories: readonly string[];
  recheckDue: string | null;
  representative: { state: 'active' | 'suspended' | 'accountable_missing' | 'none'; accountable: Text | null };
  source: { name: Text; url: string } | null;
  takedownPending: boolean;
  publicMembers: ReadonlyArray<{ name: Text; role: Text }>;
};

export const COMPANIES: readonly CompanyRecord[] = [
  {
    id: 'co-coastal', hubId: HUB_US_ID, name: en('Synthetic Coastal Builders LLC (demo)'), state: 'verified', kind: 'contractor',
    identifiers: [{ kind: 'ein', value: '00-0000101' }, { kind: 'state_licence', value: 'US-CA:cslb 000101' }],
    verifiedAt: '2026-09-12T16:00:00Z', categories: ['general_contractor', 'remodeling'], recheckDue: '2026-12-12T00:00:00Z',
    representative: { state: 'active', accountable: en('Synthetic Contractor Sam') }, source: null, takedownPending: false,
    publicMembers: [{ name: en('Synthetic Contractor Sam'), role: en('Owner') }],
  },
  {
    id: 'co-harbor', hubId: HUB_US_ID, name: en('Synthetic Harbor Electric Inc. (demo)'), state: 'claimed', kind: 'contractor',
    identifiers: [{ kind: 'ein', value: '00-0000202' }], verifiedAt: null, categories: ['electrical'], recheckDue: null,
    representative: { state: 'accountable_missing', accountable: null }, source: null, takedownPending: false,
    publicMembers: [{ name: en('Synthetic Electrician Maya'), role: en('Electrician') }],
  },
  {
    id: 'co-ridge', hubId: HUB_US_ID, name: en('Synthetic Ridge Roofing (demo)'), state: 'verified', kind: 'contractor',
    identifiers: [{ kind: 'ein', value: '00-0000303' }], verifiedAt: '2026-06-02T16:00:00Z', categories: ['roofing'], recheckDue: '2026-10-30T00:00:00Z',
    representative: { state: 'suspended', accountable: en('Synthetic Roofer Luis') }, source: null, takedownPending: false,
    publicMembers: [],
  },
  {
    id: 'co-mesa', hubId: HUB_US_ID, name: en('Synthetic Mesa Lumber Supply (demo)'), state: 'sourced', kind: 'supplier',
    identifiers: [], verifiedAt: null, categories: ['lumber'], recheckDue: null, representative: { state: 'none', accountable: null },
    source: { name: en('Synthetic supplier catalogue'), url: 'https://build.example.org/catalogue' }, takedownPending: true, publicMembers: [],
  },
  {
    id: 'co-pacific', hubId: HUB_US_ID, name: en('Synthetic Pacific Tile Manufacturing (demo)'), state: 'sourced', kind: 'manufacturer',
    identifiers: [], verifiedAt: null, categories: ['tile', 'training'], recheckDue: null, representative: { state: 'none', accountable: null },
    source: { name: en('Synthetic manufacturer site'), url: 'https://tiles.example.org/guides' }, takedownPending: false, publicMembers: [],
  },
];
export const VERIFICATION_REVOCATION_CATEGORIES = ['register_inactive', 'evidence_withdrawn', 'fraud', 'licence_lapsed', 'legal_order'] as const;

/* ---------- HC-22 Claims ---------- */

export const RECIPE_STEPS = ['register_match', 'ein_letter', 'signatory_tie', 'domain', 'call_back', 'screening', 'ownership', 'licence_board', 'identity_document'] as const;
export type RecipeStep = (typeof RECIPE_STEPS)[number];
export type StepResult = 'pass' | 'fail' | 'pending' | 'potential_match';

export type Claim = {
  id: string;
  hubId: string;
  companyId: string;
  target: 'claimed' | 'verified';
  recipe: { key: string; version: number };
  submittedAt: string;
  steps: ReadonlyArray<{ step: RecipeStep; result: StepResult; required: boolean }>;
  evidence: ReadonlyArray<{ category: 'register_extract' | 'irs_letter' | 'esign_record' | 'licence_record' | 'ownership_declaration'; count: number }>;
  /** Staff who declared a conflict of interest with this company: they cannot be assigned or decide. */
  conflicts: readonly string[];
  screeningCase: string | null;
  appeal: { originalDecider: string; filedAt: string; deadline: string } | null;
  state: 'open' | 'clarification' | 'appeal' | 'decided';
};

const step = (s: RecipeStep, result: StepResult, required = true) => ({ step: s, result, required });

export const CLAIMS: readonly Claim[] = [
  {
    id: 'cl-201', hubId: HUB_US_ID, companyId: 'co-harbor', target: 'verified', recipe: { key: 'company-claim-us', version: 3 }, submittedAt: '2026-10-28T15:00:00Z',
    steps: [step('register_match', 'pass'), step('ein_letter', 'pass'), step('signatory_tie', 'pass'), step('call_back', 'pending'), step('screening', 'pass'), step('ownership', 'pass'), step('domain', 'pass', false)],
    evidence: [{ category: 'register_extract', count: 1 }, { category: 'irs_letter', count: 1 }, { category: 'esign_record', count: 1 }],
    conflicts: [], screeningCase: null, appeal: null, state: 'open',
  },
  {
    id: 'cl-202', hubId: HUB_US_ID, companyId: 'co-ridge', target: 'claimed', recipe: { key: 'company-claim-us', version: 3 }, submittedAt: '2026-10-29T10:00:00Z',
    steps: [step('register_match', 'pass'), step('signatory_tie', 'pass'), step('screening', 'potential_match')],
    evidence: [{ category: 'register_extract', count: 1 }, { category: 'esign_record', count: 1 }],
    conflicts: [], screeningCase: 'sm-31', appeal: null, state: 'open',
  },
  {
    id: 'cl-203', hubId: HUB_US_ID, companyId: 'co-coastal', target: 'verified', recipe: { key: 'contractor-licence-us', version: 1 }, submittedAt: '2026-10-30T09:00:00Z',
    steps: [step('licence_board', 'pass'), step('screening', 'pass')],
    evidence: [{ category: 'licence_record', count: 1 }],
    conflicts: ['p-trust'], screeningCase: null, appeal: null, state: 'open',
  },
  {
    id: 'cl-204', hubId: HUB_US_ID, companyId: 'co-mesa', target: 'claimed', recipe: { key: 'company-claim-us', version: 3 }, submittedAt: '2026-10-20T09:00:00Z',
    steps: [step('register_match', 'fail'), step('signatory_tie', 'pending'), step('screening', 'pass')],
    evidence: [{ category: 'ownership_declaration', count: 1 }],
    conflicts: [], screeningCase: null, appeal: { originalDecider: 'p-trust', filedAt: '2026-10-27T09:00:00Z', deadline: '2026-11-10T09:00:00Z' }, state: 'appeal',
  },
];
export const CLAIM_DECISIONS = ['claimed', 'verified', 'clarify', 'reject'] as const;
export const EVIDENCE_CATEGORIES = ['register_extract', 'irs_letter', 'esign_record', 'licence_record', 'ownership_declaration', 'call_back_record'] as const;

/* ---------- HC-23 Verification ---------- */

export type Recipe = { id: string; hubId: string; key: string; version: number; subject: 'person' | 'company'; steps: readonly RecipeStep[]; updatedAt: string };
export const RECIPES: readonly Recipe[] = [
  { id: 'rc-company-claim-us', hubId: HUB_US_ID, key: 'company-claim-us', version: 3, subject: 'company', steps: ['register_match', 'ein_letter', 'signatory_tie', 'call_back', 'screening', 'ownership'], updatedAt: '2026-10-01T09:00:00Z' },
  { id: 'rc-contractor-licence-us', hubId: HUB_US_ID, key: 'contractor-licence-us', version: 1, subject: 'company', steps: ['licence_board', 'screening'], updatedAt: '2026-09-20T09:00:00Z' },
  { id: 'rc-person-identity-us', hubId: HUB_US_ID, key: 'person-identity-us', version: 2, subject: 'person', steps: ['identity_document', 'screening'], updatedAt: '2026-09-25T09:00:00Z' },
];

export const PROVIDER_MODES = ['fake', 'file', 'live'] as const;
export type CheckType = {
  id: string;
  hubId: string;
  check: RecipeStep;
  provider: Text;
  mode: (typeof PROVIDER_MODES)[number];
  costMinor: number;
  quotaPerMonth: number;
  usedThisMonth: number;
  retentionDays: number;
  legalBasis: 'contract' | 'legal_obligation' | 'legitimate_interest' | 'consent';
};
export const CHECK_TYPES: readonly CheckType[] = [
  { id: 'ck-register', hubId: HUB_US_ID, check: 'register_match', provider: en('Fake Secretary of State register adapter'), mode: 'fake', costMinor: 0, quotaPerMonth: 500, usedThisMonth: 41, retentionDays: 365, legalBasis: 'legitimate_interest' },
  { id: 'ck-licence', hubId: HUB_US_ID, check: 'licence_board', provider: en('State licence board file import'), mode: 'file', costMinor: 0, quotaPerMonth: 1000, usedThisMonth: 12, retentionDays: 365, legalBasis: 'legitimate_interest' },
  { id: 'ck-esign', hubId: HUB_US_ID, check: 'signatory_tie', provider: en('Fake e-signature adapter (ESIGN and UETA)'), mode: 'fake', costMinor: 150, quotaPerMonth: 200, usedThisMonth: 18, retentionDays: 2555, legalBasis: 'contract' },
  { id: 'ck-identity', hubId: HUB_US_ID, check: 'identity_document', provider: en('Fake identity document check'), mode: 'fake', costMinor: 200, quotaPerMonth: 100, usedThisMonth: 3, retentionDays: 30, legalBasis: 'consent' },
];

/* ---------- HC-24 Credentials ---------- */

const credentialType = (id: string, key: string, version: number, subject: 'person' | 'company', claim: CredentialType['claim'], title: string, recipe: string | null, validityDays: number | null, status: CredentialType['status'] = 'active') =>
  CredentialTypeSchema.parse({ id, hubId: HUB_US_ID, key, version, subject, claim, title: { en: title }, verificationRecipeId: recipe, validityDays, recheckOnSourceChange: recipe !== null, portable: true, status });

export const CREDENTIAL_TYPES: readonly CredentialType[] = [
  credentialType('ct-licence', 'contractor_licence', 2, 'company', 'licence', 'State contractor licence checked', 'rc-contractor-licence-us', 365),
  credentialType('ct-identity', 'verified_identity', 1, 'person', 'identity', 'Identity checked', 'rc-person-identity-us', 730),
  credentialType('ct-completed', 'confirmed_completed_work', 1, 'company', 'completed_work', 'Completed work confirmed by the client', 'rc-company-claim-us', null),
  credentialType('ct-confirmation', 'counterparty_confirmation', 1, 'person', 'counterparty_confirmation', 'Confirmed by a counterparty', null, null),
  credentialType('ct-knowledge', 'knowledge_contribution', 1, 'person', 'knowledge_contribution', 'Knowledge contribution reviewed', null, null, 'draft'),
];
export const CHECKED_CLAIMS: readonly CredentialType['claim'][] = ['identity', 'licence', 'insurance', 'qualification', 'certificate', 'membership', 'completed_work'];

export const ISSUED_COUNTS: ReadonlyArray<{ typeId: string; valid: number; expired: number; suspended: number; revoked: number }> = [
  { typeId: 'ct-licence', valid: 214, expired: 12, suspended: 3, revoked: 0 },
  { typeId: 'ct-identity', valid: 388, expired: 9, suspended: 0, revoked: 14 },
  { typeId: 'ct-completed', valid: 57, expired: 0, suspended: 1, revoked: 2 },
  { typeId: 'ct-confirmation', valid: 640, expired: 0, suspended: 0, revoked: 21 },
];
export const STATUS_LIST = { hubId: HUB_US_ID, publishedAt: '2026-10-31T06:00:00Z', entries: 1361, signature: 'valid' as const, signingKeyId: 'did:web:node.example.invalid#key-2' };

/** A few issued credentials (references and digests only) so revocation and suspension can be validated by id. */
export const ISSUED: readonly IssuedCredential[] = [
  IssuedCredentialSchema.parse({ id: 'vc-1001', hubId: HUB_US_ID, credentialTypeId: 'ct-licence', holder: { kind: 'company', id: 'co-coastal' }, evidenceRefs: ['ev-licence-1'], decidedBy: 'p-trust', issuedAt: '2026-09-12T16:00:00Z', expiresAt: '2027-09-12T16:00:00Z', signingKeyId: STATUS_LIST.signingKeyId, credentialDigest: digest('c1'), statusListIndex: 17, status: 'valid', revocation: null }),
  IssuedCredentialSchema.parse({ id: 'vc-1002', hubId: HUB_US_ID, credentialTypeId: 'ct-licence', holder: { kind: 'company', id: 'co-ridge' }, evidenceRefs: ['ev-licence-2'], decidedBy: 'p-trust', issuedAt: '2026-06-02T16:00:00Z', expiresAt: '2027-06-02T16:00:00Z', signingKeyId: STATUS_LIST.signingKeyId, credentialDigest: digest('c2'), statusListIndex: 18, status: 'suspended', revocation: null }),
  IssuedCredentialSchema.parse({ id: 'vc-1003', hubId: HUB_US_ID, credentialTypeId: 'ct-identity', holder: { kind: 'person', id: 'acct-luis' }, evidenceRefs: ['ev-id-3'], decidedBy: 'p-trust', issuedAt: '2026-05-02T16:00:00Z', expiresAt: '2028-05-01T16:00:00Z', signingKeyId: STATUS_LIST.signingKeyId, credentialDigest: digest('c3'), statusListIndex: 19, status: 'revoked', revocation: { reason: 'holder_request', decidedBy: 'p-trust', at: '2026-10-02T10:00:00Z' } }),
];
export const CREDENTIAL_REVOCATION_REASONS = ['evidence_withdrawn', 'evidence_expired', 'fraud', 'source_changed', 'holder_request', 'legal_order'] as const;

/** Decided claims a credential may be issued from (a decision with evidence). */
export const ISSUABLE_DECISIONS: ReadonlyArray<{ id: string; hubId: string; typeId: string; holder: Text; decidedBy: string; evidence: number }> = [
  { id: 'dc-coastal-licence', hubId: HUB_US_ID, typeId: 'ct-licence', holder: en('Synthetic Coastal Builders LLC (demo)'), decidedBy: 'p-trust', evidence: 1 },
  { id: 'dc-maya-identity', hubId: HUB_US_ID, typeId: 'ct-identity', holder: en('Synthetic Electrician Maya'), decidedBy: 'p-trust', evidence: 2 },
];

/* ---------- HC-25 Consents ---------- */

export const CONSENT_KINDS = ['profile_publication', 'portrait_licence', 'marketing_email', 'knowledge_sharing'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const CONSENT_COUNTS: ReadonlyArray<{ hubId: string; kind: ConsentKind; version: string; given: number; withdrawn: number }> = [
  { hubId: HUB_US_ID, kind: 'profile_publication', version: '2', given: 1180, withdrawn: 26 },
  { hubId: HUB_US_ID, kind: 'portrait_licence', version: '1', given: 402, withdrawn: 7 },
  { hubId: HUB_US_ID, kind: 'marketing_email', version: '1', given: 96, withdrawn: 41 },
  { hubId: HUB_US_ID, kind: 'knowledge_sharing', version: '1', given: 8, withdrawn: 0 },
];
export type Withdrawal = { id: string; hubId: string; kind: ConsentKind; subject: Text; requestedAt: string; unpublishBy: string };
export const WITHDRAWALS: readonly Withdrawal[] = [
  { id: 'wd-71', hubId: HUB_US_ID, kind: 'portrait_licence', subject: en('Synthetic Architect Dana'), requestedAt: '2026-10-30T18:00:00Z', unpublishBy: '2026-11-02T18:00:00Z' },
  { id: 'wd-72', hubId: HUB_US_ID, kind: 'knowledge_sharing', subject: en('Synthetic Contractor Sam'), requestedAt: '2026-10-31T08:00:00Z', unpublishBy: '2026-11-07T08:00:00Z' },
];
export const CONSENT_EVIDENCE = ['signed_form', 'in_product_record', 'email_confirmation', 'recorded_call'] as const;
export const PORTRAIT_SCOPES = ['profile_only', 'profile_and_articles', 'magazine'] as const;

/** Every participants fixture of one hub (the screens read through this, never the arrays directly). */
export function participantsOf(hubId: string) {
  const own = <T extends { hubId: string }>(rows: readonly T[]) => rows.filter((r) => r.hubId === hubId);
  return {
    profiles: own(PROFILES).filter((p) => p.visibility === 'public'),
    accountStates: ACCOUNT_STATE_COUNTS[hubId] ?? null,
    problems: PROFILE_PROBLEMS[hubId] ?? null,
    companies: own(COMPANIES),
    claims: own(CLAIMS),
    recipes: own(RECIPES),
    checks: own(CHECK_TYPES),
    credentialTypes: own(CREDENTIAL_TYPES),
    issuedCounts: hubId === HUB_US_ID ? ISSUED_COUNTS : [],
    statusList: hubId === HUB_US_ID ? STATUS_LIST : null,
    issued: own(ISSUED),
    issuable: own(ISSUABLE_DECISIONS),
    consentCounts: own(CONSENT_COUNTS),
    withdrawals: own(WITHDRAWALS),
  };
}
export type ParticipantsData = ReturnType<typeof participantsOf>;
