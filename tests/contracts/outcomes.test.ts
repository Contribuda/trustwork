import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../../packages/contracts/src/index.js';

const at = '2026-10-27T10:00:00Z';
const action = { actionIntentId: 'intent-1', attemptId: 'attempt-2' };
const reconciliation: c.Reconciliation = {
  id: 'rec-1',
  actionIntentId: 'intent-1',
  attemptId: 'attempt-2',
  operationId: 'op-1',
  lookupReference: 'provider-ref-1',
  outcome: { kind: 'final', result: 'succeeded', providerReference: 'provider-ref-1', evidence: 'provider lookup confirmed order', observedAt: at },
  reconciledBy: 'worker',
  reconciledAt: at,
};

test('unknown, acknowledged and final external outcomes are distinct and ordered', () => {
  for (const outcome of [{ kind: 'unknown', reason: 'timeout', observedAt: at }, { kind: 'acknowledged', providerReference: 'r', observedAt: at }, reconciliation.outcome])
    assert.ok(c.ExternalOutcomeSchema.safeParse(outcome).success);
  assert.equal(c.ExternalOutcomeSchema.safeParse({ kind: 'final', result: 'maybe', providerReference: null, evidence: 'x', observedAt: at }).success, false);
  assert.equal(c.ExternalOutcomeSchema.safeParse({ kind: 'reconciling', observedAt: at }).success, false, 'reconciliation is not an outcome kind');
  assert.ok(c.outcomeTransitionAllowed('unknown', 'acknowledged', action));
  assert.ok(c.outcomeTransitionAllowed('acknowledged', 'final', action));
  assert.ok(c.outcomeTransitionAllowed('acknowledged', 'unknown', action), 'a crash after acknowledgement reopens the question');
  assert.equal(c.outcomeTransitionAllowed('final', 'unknown', action), false);
  assert.equal(c.outcomeTransitionAllowed('final', 'acknowledged', action), false);
});
test('unknown -> final requires a reconciliation record with final evidence (crash reconciliation is distinct)', () => {
  assert.equal(c.outcomeTransitionAllowed('unknown', 'final', action), false);
  assert.ok(c.outcomeTransitionAllowed('unknown', 'final', action, { reconciliation }));
  assert.equal(c.outcomeTransitionAllowed('unknown', 'final', action, { reconciliation: { ...reconciliation, outcome: { kind: 'unknown', reason: 'crash', observedAt: at } } }), false);
  assert.equal(c.outcomeTransitionAllowed('unknown', 'final', { ...action, attemptId: 'attempt-1' }, { reconciliation }), false, 'reconciliation of another attempt does not finalize this one');
  assert.equal(c.outcomeTransitionAllowed('unknown', 'final', { ...action, actionIntentId: 'intent-2' }, { reconciliation }), false, 'reconciliation of another intent is rejected');
  assert.ok(c.ReconciliationSchema.safeParse(reconciliation).success);
  assert.equal(c.ReconciliationSchema.safeParse({ ...reconciliation, lookupReference: '' }).success, false);
});
test('action lifecycle: outcome_unknown only reconciles; failed retries only when safely retryable; revoked is terminal', () => {
  assert.ok(c.actionTransitionAllowed('executing', 'outcome_unknown'));
  assert.ok(c.actionTransitionAllowed('outcome_unknown', 'reconciling'));
  assert.equal(c.actionTransitionAllowed('outcome_unknown', 'succeeded'), false);
  assert.equal(c.actionTransitionAllowed('outcome_unknown', 'queued'), false, 'no blind retry');
  assert.ok(c.actionTransitionAllowed('reconciling', 'failed'));
  assert.equal(c.actionTransitionAllowed('failed', 'queued'), false);
  assert.ok(c.actionTransitionAllowed('failed', 'queued', { safelyRetryable: true }));
  assert.equal(c.actionTransitionAllowed('succeeded', 'queued', { safelyRetryable: true }), false);
  assert.ok(c.actionTransitionAllowed('queued', 'revoked'));
  assert.equal(c.actionTransitionAllowed('executing', 'revoked'), false, 'in-flight external calls cannot be cancelled retroactively');
  assert.equal(c.actionTransitionAllowed('revoked', 'queued'), false);
  assert.ok(c.actionTransitionAllowed('pending', 'succeeded'));
});
test('mandate transitions and approvals bound to an action digest', () => {
  assert.ok(c.mandateTransitionAllowed('draft', 'active'));
  assert.ok(c.mandateTransitionAllowed('active', 'suspended'));
  assert.equal(c.mandateTransitionAllowed('revoked', 'active'), false);
  assert.equal(c.mandateTransitionAllowed('draft', 'suspended'), false);
  const digest = c.computeDigest({ action: 'place_order', amount: '100' });
  const approval: c.Approval = { id: 'approval-1', actionIntentId: 'intent-1', actionDigest: digest, approverPersonId: 'person-a', approvedAt: at, expiresAt: '2026-10-27T11:00:00Z', revokedAt: null };
  const now = new Date('2026-10-27T10:30:00Z');
  assert.ok(c.approvalValid(approval, digest, now));
  assert.equal(c.approvalValid(approval, c.computeDigest({ action: 'place_order', amount: '101' }), now), false, 'changed terms invalidate the approval');
  assert.equal(c.approvalValid(approval, digest, new Date('2026-10-27T12:00:00Z')), false);
  assert.equal(c.approvalValid({ ...approval, revokedAt: at }, digest, now), false);
});
test('mandate and action intent schemas validate structure', () => {
  const mandate: c.Mandate = {
    id: 'mandate-1',
    principal: { personId: 'person-a', onBehalfOf: { kind: 'company', id: 'company-1' } },
    actions: ['prepare', 'place_order'],
    contexts: [{ kind: 'project', id: 'project-1' }],
    limits: { ceiling: { minorUnits: '100000', currency: 'UZS' }, perActionCeiling: null, transactionBudgetId: 'budget-1', platformBudgetId: null },
    conditions: ['only approved suppliers'],
    validUntil: '2026-12-01T00:00:00Z',
    status: 'active',
    revision: 2,
    revokedAt: null,
  };
  assert.ok(c.MandateSchema.safeParse(mandate).success);
  assert.equal(c.MandateSchema.safeParse({ ...mandate, actions: [] }).success, false);
  assert.equal(c.MandateSchema.safeParse({ ...mandate, actions: ['delete_everything'] }).success, false);
  assert.equal(c.MandateSchema.safeParse({ ...mandate, chatAuthority: true }).success, false, 'unknown fields rejected');
  const intent: c.ActionIntent = {
    id: 'intent-1',
    runId: 'run-1',
    mandate: { id: 'mandate-1', revision: 2 },
    action: 'place_order',
    context: { kind: 'project', id: 'project-1' },
    amount: { minorUnits: '100', currency: 'UZS' },
    actionDigest: c.computeDigest({ a: 1 }),
    state: 'queued',
    reservationId: 'reservation-1',
    attemptCount: 0,
    effectCorrelationKey: 'order-project-1-1',
    outcome: null,
    revision: 1,
  };
  assert.ok(c.ActionIntentSchema.safeParse(intent).success);
  assert.equal(c.ActionIntentSchema.safeParse({ ...intent, state: 'done' }).success, false);
  assert.equal(
    c.evaluateDelegation(
      { actions: ['prepare'], contextId: 'x', expiresAt: '2030-01-01T00:00:00Z', revoked: false, ceiling: { minorUnits: '1', currency: 'UZS' } },
      { action: 'place_order', contextId: 'x', amount: { minorUnits: '1', currency: 'UZS' } },
      new Date(),
    ),
    'deny',
  );
});
test('billing: reservation states, budget balance and the two budget kinds', () => {
  const budget: c.Budget = {
    id: 'budget-1',
    kind: 'transaction',
    owner: { kind: 'person', id: 'person-a' },
    scope: { projectId: 'project-1', employeePersonId: null },
    period: { from: at, to: '2027-01-01T00:00:00Z' },
    limit: { minorUnits: '1000', currency: 'UZS' },
    revision: 1,
  };
  const reservation: c.Reservation = {
    id: 'reservation-1',
    budgetId: 'budget-1',
    actionIntentId: 'intent-1',
    amount: { minorUnits: '600', currency: 'UZS' },
    state: 'reserved',
    reservedAt: at,
    settledAmount: null,
    closedAt: null,
    effectCorrelationKey: 'k',
  };
  assert.deepEqual(c.remainingBudget(budget, [reservation]), { minorUnits: '400', currency: 'UZS' });
  assert.equal(c.canReserve(budget, [reservation], { minorUnits: '400', currency: 'UZS' }), 'ok');
  assert.equal(c.canReserve(budget, [reservation], { minorUnits: '401', currency: 'UZS' }), 'commercial.budget_insufficient');
  assert.equal(c.canReserve(budget, [reservation], { minorUnits: '1', currency: 'USD' }), 'commercial.currency_mismatch');
  assert.deepEqual(c.remainingBudget(budget, [{ ...reservation, state: 'released', closedAt: at }]), { minorUnits: '1000', currency: 'UZS' });
  assert.deepEqual(c.remainingBudget(budget, [{ ...reservation, state: 'settled', settledAmount: { minorUnits: '500', currency: 'UZS' }, closedAt: at }]), { minorUnits: '500', currency: 'UZS' });
  assert.ok(c.reservationTransitionAllowed('reserved', 'settled'));
  assert.equal(c.reservationTransitionAllowed('settled', 'released'), false);
  assert.equal(c.budgetKindFor('place_order'), 'transaction');
  assert.equal(c.budgetKindFor('generate_deliverable'), 'platform');
  assert.equal(c.budgetKindFor('send_quote'), null);
  assert.equal(c.BudgetSchema.safeParse({ ...budget, kind: 'both' }).success, false);
  assert.equal(c.ReservationSchema.safeParse({ ...reservation, amount: { minorUnits: '-1', currency: 'UZS' } }).success, false);
});
test('billing: price versions need a distinct activator, no back-dating and no overlap; acceptance is immutable', () => {
  const draft: c.PriceVersion = {
    id: 'price-1',
    offerId: 'offer-1',
    version: 1,
    currency: 'UZS',
    amountMinorUnits: '99000',
    effectiveFrom: '2026-11-01T00:00:00Z',
    effectiveTo: null,
    acceptanceTextVersion: 'terms-1',
    status: 'draft',
    draftedBy: 'person-a',
    activatedBy: null,
    activatedAt: null,
  };
  assert.ok(c.PriceVersionSchema.safeParse(draft).success);
  const active = { ...draft, status: 'active', activatedBy: 'person-b', activatedAt: at };
  assert.ok(c.PriceVersionSchema.safeParse(active).success);
  assert.equal(c.PriceVersionSchema.safeParse({ ...active, activatedBy: 'person-a' }).success, false, 'activator equals drafter');
  assert.equal(c.PriceVersionSchema.safeParse({ ...active, effectiveFrom: '2026-10-01T00:00:00Z' }).success, false, 'back-dated');
  assert.equal(c.PriceVersionSchema.safeParse({ ...active, activatedBy: null }).success, false, 'active without activation');
  const parsed = c.PriceVersionSchema.parse(active);
  assert.ok(c.priceVersionsOverlap(parsed, c.PriceVersionSchema.parse({ ...active, id: 'price-2', version: 2, effectiveFrom: '2026-11-15T00:00:00Z' })));
  assert.equal(c.priceVersionsOverlap(parsed, c.PriceVersionSchema.parse({ ...active, id: 'price-2', version: 2, effectiveTo: null, effectiveFrom: '2026-12-01T00:00:00Z', status: 'superseded' })), false);
  const acceptance = {
    id: 'acceptance-1',
    priceVersionId: 'price-1',
    acceptanceTextVersion: 'terms-1',
    payer: { kind: 'company', id: 'company-1' },
    acceptedByPersonId: 'person-c',
    acceptedAt: at,
    amount: { minorUnits: '99000', currency: 'UZS' },
  };
  assert.ok(c.PriceAcceptanceSchema.safeParse(acceptance).success);
  assert.equal(c.PriceAcceptanceSchema.safeParse({ ...acceptance, payer: { kind: 'person', id: 'p', extra: 1 } }).success, false);
});
