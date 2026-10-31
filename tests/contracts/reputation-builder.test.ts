import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AnswerConfirmationCommandSchema, AppealLinkSchema, AppealLimitationCommandSchema, CreatePortfolioEntryCommandSchema, FileReputationAppealCommandSchema, LimitationRefSchema,
  RecordCredentialCommandSchema, REPUTATION_RULES, ReputationBuilderOwnViewSchema, RequestConfirmationCommandSchema,
} from '../../packages/contracts/src/reputation-builder.js';

/** REP-001 contracts: strict shapes, attestations instead of incentives, human answers, appeal links and no score. */
const party = { kind: 'company' as const, id: 'c1' };
const person = { kind: 'person' as const, id: 'p1' };

test('a confirmation request is tied to a context, attests no incentive and no conflict, and has no incentive or actor field', () => {
  const request = { requester: party, addressedTo: person, context: { kind: 'agreement', id: 'a1' }, portfolioEntryId: null, statementKind: 'delivered', statement: 'Delivered 40 m2', attestation: { noIncentiveOffered: true, notEmployeeOrRelative: true } };
  assert.equal(RequestConfirmationCommandSchema.safeParse(request).success, true);
  assert.equal(RequestConfirmationCommandSchema.safeParse({ ...request, attestation: { noIncentiveOffered: false, notEmployeeOrRelative: true } }).success, false);
  assert.equal(RequestConfirmationCommandSchema.safeParse({ ...request, attestation: { noIncentiveOffered: true } }).success, false);
  assert.equal(RequestConfirmationCommandSchema.safeParse({ ...request, incentive: { discount: '10%' } }).success, false);
  assert.equal(RequestConfirmationCommandSchema.safeParse({ ...request, actor: { via: 'agent', mandateId: 'm1' } }).success, false);
  assert.equal(RequestConfirmationCommandSchema.safeParse({ ...request, context: { kind: 'publication', id: 'x' } }).success, false, 'only recorded relationships are contexts');
  assert.deepEqual(REPUTATION_RULES, { requestTtlDays: 30, reminderDelayDays: 3, dailyRequestLimit: 20 });
});

test('an answer is the counterparty person\'s own: partial and declined answers say why; nothing is shown from a declined one', () => {
  const answer = { onBehalfOf: person, decision: 'confirmed', comment: null, consentToShow: true, attestation: { noIncentiveReceived: true, notEmployeeOrRelative: true } };
  assert.equal(AnswerConfirmationCommandSchema.safeParse(answer).success, true);
  assert.equal(AnswerConfirmationCommandSchema.safeParse({ ...answer, decision: 'partially' }).success, false);
  assert.equal(AnswerConfirmationCommandSchema.safeParse({ ...answer, decision: 'declined', comment: 'Not delivered', consentToShow: true }).success, false);
  assert.equal(AnswerConfirmationCommandSchema.safeParse({ ...answer, decision: 'declined', comment: 'Not delivered', consentToShow: false }).success, true);
  assert.equal(AnswerConfirmationCommandSchema.safeParse({ ...answer, actor: { via: 'agent', mandateId: 'm1' } }).success, false, 'no agent path');
});

test('credentials and portfolio entries: coverage only for insurance and bonds; a context or an external description, never both', () => {
  const credential = { holder: party, kind: 'licence', jurisdiction: 'US-CA', credentialType: 'US-CA-CSLB-B', issuer: 'Synthetic board', number: 'SYN-OK-1', classification: null, coverage: null, validFrom: null, validUntil: null, visibility: 'public', supersedesId: null };
  assert.equal(RecordCredentialCommandSchema.safeParse(credential).success, true);
  assert.equal(RecordCredentialCommandSchema.safeParse({ ...credential, coverage: { minorUnits: '100', currency: 'USD' } }).success, false);
  assert.equal(RecordCredentialCommandSchema.safeParse({ ...credential, kind: 'insurance', coverage: { minorUnits: '100', currency: 'USD' } }).success, true);
  assert.equal(RecordCredentialCommandSchema.safeParse({ ...credential, validFrom: '2027-01-01', validUntil: '2026-01-01' }).success, false);
  assert.equal(RecordCredentialCommandSchema.safeParse({ ...credential, jurisdiction: 'California' }).success, false);
  const entry = { holder: party, context: { kind: 'project', id: 'pr1' }, externalDescription: null, title: 'Patio', role: 'Installer', period: { from: null, to: null }, scopeSummary: null, visibility: 'public', supersedesId: null };
  assert.equal(CreatePortfolioEntryCommandSchema.safeParse(entry).success, true);
  assert.equal(CreatePortfolioEntryCommandSchema.safeParse({ ...entry, externalDescription: 'Also external' }).success, false);
  assert.equal(CreatePortfolioEntryCommandSchema.safeParse({ ...entry, context: null }).success, false);
  assert.equal(CreatePortfolioEntryCommandSchema.safeParse({ ...entry, address: '1 Main St' }).success, false, 'no address field exists');
});

test('appeals: a recorded subject or a limitation reference, never both; the own view never carries a score', () => {
  const limitation = { scope: 'confirmation_request', reasonCode: 'no_recorded_relationship', requester: party, addressedTo: person, context: { kind: 'agreement', id: 'a1' }, statementKind: 'delivered' };
  assert.equal(LimitationRefSchema.safeParse(limitation).success, true);
  assert.equal(LimitationRefSchema.safeParse({ ...limitation, reasonCode: 'made_up' }).success, false);
  assert.equal(AppealLimitationCommandSchema.safeParse({ limitation, reason: 'Synthetic' }).success, true);
  assert.equal(AppealLinkSchema.safeParse({ method: 'POST', href: '/v1/reputation-builder/appeals', subject: { kind: 'timeliness_observation', id: 't1' }, limitation: null }).success, true);
  assert.equal(AppealLinkSchema.safeParse({ method: 'POST', href: '/v1/reputation-builder/appeals', subject: null, limitation: null }).success, false);
  assert.equal(FileReputationAppealCommandSchema.safeParse({ subject: { kind: 'review', id: 'r1' }, reason: 'x' }).success, false, 'reviews are appealed through EXE-001');
  const own = { projection: 'owner_private', subject: party, credentials: [], portfolio: [], confirmationsSent: [], contributions: [], timeliness: { observations: [], summary: { counted: 0, onTime: 0, late: 0, excluded: {}, byKind: {} } }, limitations: [], relations: [] };
  assert.equal(ReputationBuilderOwnViewSchema.safeParse({ ...own, publicScore: null }).success, true);
  assert.equal(ReputationBuilderOwnViewSchema.safeParse({ ...own, publicScore: 87 }).success, false, 'no public numeric score until O07');
});
