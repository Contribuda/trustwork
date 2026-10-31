import test from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN_ONLY_ACTIONS, parityGaps } from '@trustwork/contracts';
import {
  claimState, DecideClaimCommandSchema, disputeOutcome, EXECUTION_EVIDENCE_MANIFEST, OpenDisputeCommandSchema, RecordClaimCommandSchema,
} from '../../apps/api/src/modules/execution/contracts.js';
import { PublicSnapshotViewSchema, ReputationSummarySchema, SubmitReviewCommandSchema } from '../../apps/api/src/modules/trust/contracts.js';
import {
  computeReputation, METHOD_DIGEST, publicScore, REPUTATION_METHOD, REPUTATION_POLICY, type ObservationInput, type ReputationInputs, type ReviewInput,
} from '../../apps/api/src/modules/trust/method.js';

/** EXE-001 pure rules: the reputation method, dispute outcomes, claim states, contracts and the capability registry. */
const NOW = new Date('2027-06-01T12:00:00.000Z');
const subject = { kind: 'company' as const, id: 'company-synthetic-supplier' };
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const obs = (id: string, over: Partial<ObservationInput> = {}): ObservationInput => ({ id, dimension: 'timing', outcome: 'on_time', excludedReason: null, lateDays: 0, createdAt: at(10), dispute: null, appeal: null, ...over });
const review = (id: string, over: Partial<ReviewInput> = {}): ReviewInput => ({ id, source: 'trust', agreementId: `agreement-${id}`, authorSide: 'buyer', ratings: { overall: 4 }, hasText: true, correctedBy: null, createdAt: at(5), appeal: null, ...over });
const empty: ReputationInputs = { subject, observations: [], defects: [], reviews: [], owed: [] };

test('missing evidence is unknown, never failure: no data says "not enough data" and counts nothing against the subject', () => {
  const { summary, publicSummary } = computeReputation({ ...empty, owed: [{ id: 'obligation-1', due: at(30), hasRecord: false }, { id: 'obligation-2', due: null, hasRecord: false }, { id: 'obligation-3', due: at(30), hasRecord: true }] }, NOW);
  assert.equal(summary.facts.timing.late, 0);
  assert.equal(summary.facts.quality.rejected, 0);
  assert.equal(summary.unknown.obligationsWithoutRecord, 1, 'past due without any record is unknown; no due date is not even overdue');
  for (const dimension of ['timing', 'payment', 'quality', 'defects'] as const) assert.deepEqual(publicSummary.facts[dimension], { status: 'not_enough_data' });
  assert.deepEqual(publicSummary.opinions.reviews, { status: 'not_enough_data' });
  assert.equal(summary.publicScore, null);
  ReputationSummarySchema.parse(summary);
});

test('a client-caused change never counts as a supplier delay; disputes and appeals exclude until resolved; old evidence leaves the window', () => {
  const inputs: ReputationInputs = {
    ...empty,
    observations: [
      obs('o1'), obs('o2'), obs('o3', { outcome: 'late', lateDays: 4 }),
      obs('o4', { outcome: 'excused_delay', excludedReason: 'client_caused_change', lateDays: 6 }),
      obs('o5', { outcome: 'unknown', excludedReason: 'unattributed_change', lateDays: 2 }),
      obs('o6', { outcome: 'late', lateDays: 9, dispute: 'pending' }),
      obs('o7', { outcome: 'late', lateDays: 9, dispute: 'overturned' }),
      obs('o8', { outcome: 'late', lateDays: 9, appeal: 'pending' }),
      obs('o9', { outcome: 'late', lateDays: 9, createdAt: at(1000) }),
      obs('o10', { outcome: 'late', lateDays: 1, dispute: 'upheld' }),
    ],
  };
  const { summary, explanation } = computeReputation(inputs, NOW);
  assert.deepEqual([summary.facts.timing.samples, summary.facts.timing.onTime, summary.facts.timing.late, summary.facts.timing.lateDays], [4, 2, 2, 5]);
  assert.equal(summary.facts.timing.status, 'ok');
  assert.deepEqual(
    Object.fromEntries(Object.entries(summary.exclusions).filter(([, n]) => n > 0)),
    { client_caused_change: 1, unattributed_change: 1, dispute_pending: 1, dispute_overturned: 1, appeal_pending: 1, outside_window: 1 },
  );
  assert.deepEqual(explanation.observations.find((o) => o.id === 'o4'), { id: 'o4', counted: false, reason: 'client_caused_change', dimension: 'timing', outcome: 'excused_delay' });
});

test('facts and opinions never mix: a one-star review changes no fact; corrections count once; a task review of the same side is a duplicate', () => {
  const facts = [obs('q1', { dimension: 'quality', outcome: 'accepted' }), obs('q2', { dimension: 'quality', outcome: 'rejected' }), obs('q3', { dimension: 'quality', outcome: 'partially_accepted' })];
  const base = computeReputation({ ...empty, observations: facts }, NOW);
  const withReviews = computeReputation({
    ...empty, observations: facts,
    reviews: [
      review('r1', { ratings: { overall: 1, quality: 1 } }), review('r2', { correctedBy: 'r3' }), review('r3', { ratings: { overall: 5 } }),
      review('r4', { source: 'task', agreementId: 'agreement-r1', ratings: { overall: 2 } }), review('r5', { appeal: 'overturned' }), review('r6', { source: 'task', agreementId: 'agreement-x', authorSide: 'seller', ratings: { overall: 3 } }),
    ],
  }, NOW);
  assert.deepEqual(withReviews.summary.facts, base.summary.facts, 'reviews never change timing, quality, payment or defects');
  assert.equal(withReviews.summary.opinions.reviews.samples, 3);
  assert.deepEqual(withReviews.summary.opinions.reviews.overall, { 1: 1, 2: 0, 3: 1, 4: 0, 5: 1 });
  assert.deepEqual([withReviews.summary.exclusions.corrected, withReviews.summary.exclusions.duplicate, withReviews.summary.exclusions.appeal_overturned], [1, 1, 1]);
});

test('the public summary is masked below the minimum sample and carries no identifiers or text; the subject keeps the explanation', () => {
  const inputs: ReputationInputs = {
    ...empty,
    observations: [obs('PRIVATE-observation-1'), obs('PRIVATE-observation-2'), obs('PRIVATE-observation-3'), obs('PRIVATE-observation-4', { dimension: 'quality', outcome: 'rejected' })],
    defects: [{ id: 'PRIVATE-defect-1', severity: 'major', resolved: true, createdAt: at(3), dispute: null }],
    reviews: [review('PRIVATE-review-1', { ratings: { overall: 1 } })],
  };
  const { summary, publicSummary, explanation } = computeReputation(inputs, NOW);
  assert.equal(summary.facts.timing.status, 'ok');
  assert.deepEqual(publicSummary.facts.quality, { status: 'not_enough_data' }, 'a single rejection never shows publicly');
  assert.deepEqual(publicSummary.opinions.reviews, { status: 'not_enough_data' }, 'a single review never produces a public figure');
  assert.ok(!JSON.stringify(publicSummary).includes('PRIVATE-'), 'no identifiers in the public summary');
  assert.ok(!('withText' in (publicSummary.facts.timing as object)));
  assert.equal(explanation.observations.length, 4);
  PublicSnapshotViewSchema.parse({ projection: 'public', subject, snapshot: { method: publicSummary.method, summary: publicSummary, computedAt: NOW.toISOString(), newerEvidence: false } });
});

test('deterministic and payment-blind: the method has no payment input and the same evidence gives the same digest', () => {
  const inputs: ReputationInputs = { ...empty, observations: [obs('a'), obs('b', { outcome: 'late', lateDays: 2 })], reviews: [review('c')] };
  const first = computeReputation(inputs, NOW);
  const second = computeReputation({ ...inputs, observations: [...inputs.observations].reverse() }, NOW);
  assert.deepEqual(second, first, 'input order does not matter');
  const keys = JSON.stringify(REPUTATION_METHOD).toLowerCase();
  for (const word of ['entitlement', 'subscription', 'sponsor', 'plan_tier', 'price', 'billing', 'boost']) assert.ok(!keys.includes(word), `the method mentions no ${word}`);
  assert.match(METHOD_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(first.summary.method.version, 'engine-evidence-0.1');
});

test('public numeric scoring stays behind a disabled switch and released weights (O07)', () => {
  const inputs: ReputationInputs = { ...empty, observations: [obs('1'), obs('2'), obs('3', { outcome: 'late', lateDays: 1 }), obs('4')] };
  const { summary } = computeReputation(inputs, NOW);
  assert.equal(REPUTATION_POLICY.publicNumericScore, false);
  assert.equal(REPUTATION_METHOD.weights, null);
  assert.equal(publicScore(summary), null);
  assert.equal(publicScore(summary, REPUTATION_METHOD, { publicNumericScore: true }), null, 'no weights, no score, even with the switch on');
  const weighted = { ...REPUTATION_METHOD, weights: { timing: 1, quality: 1, payment: 1, reviews: 1 } };
  assert.equal(publicScore(summary, weighted, REPUTATION_POLICY), null, 'weights without the switch: still no score');
  assert.equal(publicScore(summary, weighted, { publicNumericScore: true }), 75, 'only both together produce a number (synthetic weights for this test)');
});

test('dispute outcomes and claim states', () => {
  assert.equal(disputeOutcome({ status: 'open', decision: null, appealDecision: null }), null);
  assert.equal(disputeOutcome({ status: 'decided', decision: 'overturned', appealDecision: null }), 'overturned');
  assert.equal(disputeOutcome({ status: 'appealed', decision: 'overturned', appealDecision: null }), null);
  assert.equal(disputeOutcome({ status: 'appeal_decided', decision: 'overturned', appealDecision: 'upheld' }), 'overturned');
  assert.equal(disputeOutcome({ status: 'appeal_decided', decision: 'overturned', appealDecision: 'overturned' }), 'upheld');
  assert.equal(disputeOutcome({ status: 'appeal_decided', decision: 'upheld', appealDecision: 'overturned' }), 'overturned');
  assert.equal(disputeOutcome({ status: 'appeal_decided', decision: 'upheld', appealDecision: 'partially_overturned' }), 'partially');
  assert.equal(claimState({ superseded: false, evidenceCount: 0, decision: null, dispute: null }), 'claimed', 'a claim without evidence is a claim, not a failure');
  assert.equal(claimState({ superseded: false, evidenceCount: 2, decision: null, dispute: null }), 'evidence_attached');
  assert.equal(claimState({ superseded: true, evidenceCount: 2, decision: 'accepted', dispute: null }), 'superseded');
  assert.equal(claimState({ superseded: false, evidenceCount: 0, decision: 'rejected', dispute: { pending: true, outcome: null } }), 'disputed');
  assert.equal(claimState({ superseded: false, evidenceCount: 0, decision: 'rejected', dispute: { pending: false, outcome: 'overturned' } }), 'reversed');
  assert.equal(claimState({ superseded: false, evidenceCount: 0, decision: 'partially_accepted', dispute: { pending: false, outcome: 'upheld' } }), 'partially_confirmed');
});

test('contracts: decisions, disputes and reviews have no agent path; claims fit their target', () => {
  const party = { kind: 'person' as const, id: 'person-synthetic' };
  assert.equal(DecideClaimCommandSchema.safeParse({ onBehalfOf: party, decision: 'accepted', lines: [], note: null, stageCode: null, actor: { via: 'agent', mandateId: 'm-1' } }).success, false);
  assert.equal(DecideClaimCommandSchema.safeParse({ onBehalfOf: party, decision: 'rejected', lines: [], note: null, stageCode: null }).success, false, 'a rejection gives its reason');
  assert.equal(OpenDisputeCommandSchema.safeParse({ target: { kind: 'defect', id: 'd-1' }, opener: party, reason: 'x', actor: { via: 'agent', mandateId: 'm-1' } }).success, false);
  assert.equal(SubmitReviewCommandSchema.safeParse({ author: party, ratings: { overall: 5 }, text: null, language: null, correctsReviewId: null, actor: { via: 'agent', mandateId: 'm-1' } }).success, false);
  assert.equal(SubmitReviewCommandSchema.safeParse({ author: party, ratings: { overall: 6 }, text: null, language: null, correctsReviewId: null }).success, false);
  const claim = { obligationId: 'o-1', defectId: null, kind: 'goods_delivery', claimant: party, lines: [{ ref: 'q1', quantity: { value: '10', unit: 'm2' } }], period: null, performedAt: '2027-03-01T10:00:00.000Z', statement: null, supersedesClaimId: null, actor: { via: 'person' } };
  assert.equal(RecordClaimCommandSchema.safeParse(claim).success, true);
  assert.equal(RecordClaimCommandSchema.safeParse({ ...claim, lines: [] }).success, false, 'a goods delivery lists its lines');
  assert.equal(RecordClaimCommandSchema.safeParse({ ...claim, kind: 'remediation' }).success, false, 'a remediation names a defect');
  assert.equal(RecordClaimCommandSchema.safeParse({ ...claim, period: { from: '2027-03-05', to: '2027-03-01' } }).success, false);
});

test('capability registry: every operation for the interface and the agent; deciding on work is human-only', () => {
  const caps = EXECUTION_EVIDENCE_MANIFEST.capabilities;
  assert.deepEqual(parityGaps(caps), []);
  const decide = caps.find((c) => c.id === 'execution_evidence.decide_claim')!;
  assert.equal(decide.mandateAction, 'confirm_execution');
  assert.ok(HUMAN_ONLY_ACTIONS.includes('confirm_execution'));
  assert.equal(decide.confirmation, 'person_each');
  assert.ok(!decide.surfaces.includes('mcp'), 'connections never decide on delivered work');
  for (const c of caps.filter((x) => x.mandateAction === 'record_evidence')) assert.equal(c.confirmation, 'mandate');
});
