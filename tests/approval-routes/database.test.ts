import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import { SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { workerLogin } from '../assistant/helpers.js';
import { principalFor } from '../data/helpers/seed.js';
import { approvalDelegations, approvalRequests, approvalRoutes } from '../../packages/data/src/repositories/approval-routes.js';
import { supersedePendingApprovals } from '../../apps/api/src/modules/approval-routes/port.js';
import { routeDigest } from '../../apps/api/src/modules/approval-routes/resolution.js';
import { activeRoute, as, fails, grant, holders, seedWorld, submit, subjectDigest, usd, uuid, type Person, type World } from './helpers.js';

/**
 * PRC-001 under the real runtime role (FORCE RLS, owner-run commands, no mocks): route management and activation,
 * digest binding and supersession, the requester and delegation rules, segregation of duties, steps, quorum,
 * escalation and expiry, the first-party-only decision path, visibility, and concurrent decisions resolving once.
 */
const h = await startHarness('approvals_db');

test('approval routes database: routes, binding, supersession, SoD, delegation, escalation, first-party decisions, visibility and concurrency', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w: World = await seedWorld(h, 'db');
  const P = w.people;
  await grant(h.db.admin, w, 'paul', 'procurement.approval.decide');
  await grant(h.db.admin, w, 'quinn', 'procurement.approval.decide');
  await grant(h.db.admin, w, 'carlos', 'procurement.approval.decide');
  // The API clock (passed as `now`); visibility reads the database clock, so T0 is just before it.
  const T0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
  const revisionOf = async (id: string) => (await h.db.admin.query<{ revision: number }>('SELECT revision FROM trustwork.approval_request WHERE id = $1', [id])).rows[0]!.revision;
  const statusOf = async (id: string) => (await h.db.admin.query<{ status: string }>('SELECT status FROM trustwork.approval_request WHERE id = $1', [id])).rows[0]!.status;
  const decide = async (p: Person, request: { id: string; subjectDigest: { value: string } }, step: string, over: Partial<Parameters<typeof approvalRequests.decide>[1]> = {}) =>
    as(h, w, p, async (trx) => approvalRequests.decide(trx, {
      requestId: request.id, step, decision: 'approve', subjectDigest: request.subjectDigest.value, reason: null, expectedRevision: await revisionOf(request.id),
      sessionId: w.sessions[p], stepUp: true, now: minutes(1), ...over,
    }));
  const requisition = (label: string, amount: string | null = '50000', facts: Record<string, unknown> = {}, kind: 'requisition' | 'trade_invoice' | 'payment_proposal' | 'order' | 'order_change' | 'budget_change' | 'document' = 'requisition') => ({
    subject: { kind, id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest(label), amount: amount === null ? null : usd(amount), facts,
  });

  await t.test('routes: only route managers draft and activate, in their own session; versions freeze; a hub may require a second person', async () => {
    const payload = { steps: [holders('approve')], receiverSoleApprovalThreshold: null };
    const digest = routeDigest({ ownerCompanyId: w.company, subjectKind: 'requisition', payload: payload as never, templateKey: null, templateVersion: null }).value;
    const draftAs = (p: Person, company = w.company, second = false) => as(h, w, p, (trx) => approvalRoutes.draft(trx, { companyId: company, subjectKind: 'requisition', payload, digest, templateKey: null, templateVersion: null, secondPersonRequired: second }));
    await fails(draftAs('rita'), 'approvals.not_authorised');
    await fails(draftAs('otto'), 'approvals.not_authorised');
    await fails(draftAs('otto', w.otherCompany).then(() => draftAs('ada', w.otherCompany)), 'approvals.not_authorised');
    const draft = await draftAs('ada');
    assert.equal(draft.status, 'draft');
    const activate = (p: Person, over: Partial<{ digest: string; sessionId: string; expectedRevision: number }> = {}) =>
      as(h, w, p, (trx) => approvalRoutes.activate(trx, { routeId: draft.id, digest, expectedRevision: draft.revision, sessionId: w.sessions[p], ...over }));
    await fails(activate('ada', { digest: '0'.repeat(64) }), 'approvals.digest_mismatch');
    await fails(activate('ada', { sessionId: w.sessions.paul }), 'approvals.first_party_required');
    await fails(activate('rita'), 'approvals.not_authorised');
    await fails(activate('otto'), 'approvals.not_found');
    const active = await activate('ada');
    assert.equal(active.status, 'active');
    assert.equal(active.activated_by, P.ada);
    // Frozen for every writer: the runtime role has no write grant, the owner cannot change the payload.
    await fails(h.db.app.query('UPDATE trustwork.approval_route_version SET status = $1', ['superseded']), '42501');
    await fails(withMaintenance(h.db.admin, (trx) => trx.updateTable('approval_route_version').set({ digest: 'f'.repeat(64) }).where('id', '=', draft.id).execute()), 'approvals.route_frozen');
    // Every member reads the company's routes; another company sees none.
    assert.equal((await as(h, w, 'rita', (trx) => approvalRoutes.list(trx, w.company, null))).length, 1);
    assert.equal((await as(h, w, 'otto', (trx) => approvalRoutes.list(trx, w.company, null))).length, 0);
    // Hub option: a second person activates.
    const second = await draftAs('ada', w.company, true);
    const activateSecond = (p: Person) => as(h, w, p, (trx) => approvalRoutes.activate(trx, { routeId: second.id, digest, expectedRevision: second.revision, sessionId: w.sessions[p] }));
    await fails(activateSecond('ada'), 'approvals.second_person_required');
    await fails(activateSecond('paul'), 'approvals.not_authorised');
    await grant(h.db.admin, w, 'paul', 'procurement.routes.manage');
    const activated = await activateSecond('paul');
    assert.equal(activated.version, 2);
    assert.equal((await as(h, w, 'ada', (trx) => approvalRoutes.get(trx, draft.id)))?.status, 'superseded', 'the previous active version is superseded');
  });

  await t.test('acceptance 1: a request binds the subject version and digest; a new subject version supersedes the pending request', async () => {
    await activeRoute(h, w, 'requisition', { steps: [holders('approve')], receiverSoleApprovalThreshold: null } as never);
    const subject = { kind: 'requisition' as const, id: uuid() };
    const v1 = await submit(h, w, 'rita', { subject, subjectVersionId: uuid(), subjectDigest: subjectDigest('v1'), amount: usd('120000') }, T0);
    assert.equal(v1.status, 'pending');
    assert.deepEqual(v1.subjectDigest, subjectDigest('v1'));
    await fails(submit(h, w, 'rita', { subject, subjectVersionId: v1.subjectVersionId, subjectDigest: subjectDigest('v1'), amount: usd('120000') }, T0), 'approvals.already_pending');
    const v2 = await submit(h, w, 'rita', { subject, subjectVersionId: uuid(), subjectDigest: subjectDigest('v2'), amount: usd('130000') }, T0);
    assert.equal(await statusOf(v1.id), 'superseded');
    await fails(decide('paul', v1, 'approve'), 'approvals.not_pending');
    // Without resubmitting: the subject module reports a new version and the pending request is superseded.
    const v3 = uuid();
    assert.equal(await as(h, w, 'rita', (trx) => supersedePendingApprovals(trx, { subject, newVersionId: v3 }, T0)), 1);
    assert.equal(await statusOf(v2.id), 'superseded');
    await fails(decide('paul', v2, 'approve'), 'approvals.not_pending');
    const v4 = await submit(h, w, 'rita', { subject, subjectVersionId: v3, subjectDigest: subjectDigest('v3'), amount: usd('130000') }, T0);
    await fails(decide('paul', { id: v4.id, subjectDigest: subjectDigest('v2') }, 'approve'), 'approvals.digest_mismatch');
    await fails(decide('paul', v4, 'approve', { expectedRevision: 99 }), 'approvals.revision_conflict');
    const decision = await decide('paul', v4, 'approve');
    assert.equal(decision.subject_digest, subjectDigest('v3').value);
    assert.equal(await statusOf(v4.id), 'approved');
    // Another company cannot submit for this company, nor bind this company's subject.
    await fails(as(h, w, 'otto', (trx) => approvalRequests.submit(trx, { companyId: w.company, subjectKind: 'requisition', subjectId: subject.id, subjectVersionId: uuid(), subjectDigest: subjectDigest('x').value, amount: null, projectId: null, facts: {}, routeVersionId: v4.routeVersionId, stepKeys: ['approve'], now: T0 })), 'approvals.not_authorised');
  });

  await t.test('acceptance 2: the requester never decides; a delegate never decides above the delegator', async () => {
    await activeRoute(h, w, 'requisition', { steps: [holders('approve')], receiverSoleApprovalThreshold: null } as never);
    // An administrator who would be selected cannot decide their own request; the trigger repeats it for every writer.
    const own = await submit(h, w, 'ada', requisition('own'), T0);
    await fails(decide('ada', own, 'approve'), 'approvals.requester_cannot_decide');
    await fails(withMaintenance(h.db.admin, (trx) => trx.insertInto('approval_decision').values({
      approval_request_id: own.id, step_key: 'approve', approver_person_id: P.ada, on_behalf_company_id: w.company, decision: 'approve', subject_digest: own.subjectDigest.value, session_id: w.sessions.ada, step_up: true, escalation_level: 0, decided_at: T0,
    }).execute()), 'approvals.requester_cannot_decide');

    const delegate = (p: Person, to: Person, kinds: ('requisition' | 'trade_invoice')[], limit: string | null, until = minutes(60 * 24 * 7)) =>
      as(h, w, p, (trx) => approvalDelegations.create(trx, { delegatePersonId: P[to], subjectKinds: kinds, limit: limit === null ? null : usd(limit), validFrom: T0, validUntil: until, now: T0 }));
    // Delegation rules at creation: another active member of the same company, within 90 days.
    await fails(delegate('paul', 'paul', ['requisition'], null), 'approvals.invalid_delegate');
    await fails(delegate('paul', 'otto', ['requisition'], null), 'approvals.invalid_delegate');
    await fails(delegate('paul', 'dana', ['requisition'], null, minutes(60 * 24 * 91)), 'approvals.invalid_delegation');

    // A delegator without the right delegates nothing.
    // Who cannot decide a request does not see it either: such a delegate gets "not found".
    await delegate('rita', 'dana', ['requisition'], null);
    const r1 = await submit(h, w, 'lena', requisition('r1', '500000'), T0);
    await fails(decide('dana', r1, 'approve'), 'approvals.not_found');
    // Paul delegates requisitions up to USD 1,000: not this USD 5,000 one.
    const limited = await delegate('paul', 'dana', ['requisition'], '100000');
    await fails(decide('dana', r1, 'approve'), 'approvals.not_found');
    assert.deepEqual((await as(h, w, 'ada', (trx) => approvalRequests.viewerOptions(trx, r1.id, T0))).map((o) => o.may_decide), [true], 'the administrator is selected');
    const small = await submit(h, w, 'lena', requisition('small', '5000'), T0);
    const byDelegate = await decide('dana', small, 'approve');
    assert.equal(byDelegate.approver_person_id, P.dana);
    assert.equal(byDelegate.delegated_from_person_id, P.paul);
    assert.equal(byDelegate.delegation_id, limited.id);
    assert.equal(byDelegate.voter_person_id, P.paul);
    // Another subject kind is not covered.
    await activeRoute(h, w, 'trade_invoice', { steps: [holders('approve')], receiverSoleApprovalThreshold: null } as never);
    const invoice = await submit(h, w, 'lena', requisition('inv', '5000', {}, 'trade_invoice'), T0);
    await fails(decide('dana', invoice, 'approve'), 'approvals.not_found');
    // A delegation from the requester never lets anyone decide the requester's own subject.
    await delegate('quinn', 'lena', ['requisition'], null);
    const quinns = await submit(h, w, 'quinn', requisition('quinns', '5000'), T0);
    await fails(decide('lena', quinns, 'approve'), 'approvals.not_found');
    // A delegate who is the requester stays the requester.
    const paulToRita = await delegate('paul', 'rita', ['requisition'], null);
    const ritas = await submit(h, w, 'rita', requisition('ritas', '5000'), T0);
    await fails(decide('rita', ritas, 'approve'), 'approvals.requester_cannot_decide');
    // Revocation is audited and final; a revoked delegation counts for nothing.
    const revoked = await as(h, w, 'paul', (trx) => approvalDelegations.revoke(trx, { delegationId: paulToRita.id, reason: 'Back from leave', expectedRevision: paulToRita.revision }));
    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.revoked_by, P.paul);
    await fails(as(h, w, 'paul', (trx) => approvalDelegations.revoke(trx, { delegationId: paulToRita.id, reason: 'Again', expectedRevision: revoked.revision })), 'approvals.invalid_transition');
    await fails(as(h, w, 'dana', (trx) => approvalDelegations.revoke(trx, { delegationId: paulToRita.id, reason: 'Not mine', expectedRevision: revoked.revision })), 'approvals.not_found');
    // The delegator's one vote: after the delegate voted for Paul, Paul does not vote again on that step.
    await activeRoute(h, w, 'requisition', { steps: [holders('both', { selector: { kind: 'any_of', personIds: [P.paul, P.quinn] }, quorum: 2 })], receiverSoleApprovalThreshold: null } as never);
    const two = await submit(h, w, 'lena', requisition('two', '5000'), T0);
    await decide('dana', two, 'both');
    await fails(decide('paul', two, 'both'), 'approvals.already_decided');
    await decide('quinn', two, 'both');
    assert.equal(await statusOf(two.id), 'approved');
    // A delegation counts only inside its window.
    await activeRoute(h, w, 'requisition', { steps: [holders('approve', { selector: { kind: 'named_person', personId: P.quinn } })], receiverSoleApprovalThreshold: null } as never);
    const short = await delegate('quinn', 'dana', ['requisition'], null, minutes(60));
    const late = await submit(h, w, 'lena', requisition('late', '5000'), T0);
    await fails(decide('dana', late, 'approve', { now: minutes(61) }), 'approvals.not_found');
    assert.equal((await decide('dana', late, 'approve', { now: minutes(30) })).delegation_id, short.id);
    // Someone who may read the request (a route manager) learns why a delegation does not cover it.
    const quinnToPaul = await delegate('quinn', 'paul', ['requisition'], '1');
    const covered = await submit(h, w, 'lena', requisition('covered', '5000'), T0);
    await fails(decide('paul', covered, 'approve'), 'approvals.delegation_exceeds_rights');
    await as(h, w, 'quinn', (trx) => approvalDelegations.revoke(trx, { delegationId: quinnToPaul.id, reason: 'Test over', expectedRevision: quinnToPaul.revision }));
    // Delegations are visible to the delegator, the delegate and route managers only.
    assert.ok((await as(h, w, 'dana', (trx) => approvalDelegations.list(trx, w.company))).some((d) => d.id === limited.id));
    assert.equal((await as(h, w, 'lena', (trx) => approvalDelegations.list(trx, w.company))).some((d) => d.id === limited.id), false);
    assert.equal((await as(h, w, 'otto', (trx) => approvalDelegations.list(trx, w.company))).length, 0);
  });

  await t.test('segregation of duties: payee changer, verifier, preparer and receiver rules; a sole eligible approver leaves an audit flag', async () => {
    const twoSteps = { steps: [holders('first'), holders('second', { order: 2 })], receiverSoleApprovalThreshold: null };
    await activeRoute(h, w, 'payment_proposal', { steps: [holders('approve')], receiverSoleApprovalThreshold: null } as never);
    const changed = await submit(h, w, 'rita', requisition('pp-changed', '900000', { payeeChangedByPersonIds: [P.paul] }, 'payment_proposal'), T0);
    await fails(decide('paul', changed, 'approve'), 'approvals.sod_violation', 'payee_changer_never_approves_payment_to_payee');
    await decide('quinn', changed, 'approve');
    const verified = await submit(h, w, 'rita', requisition('pp-verified', '900000', { payeeVerifiedByPersonIds: [P.paul], firstPaymentToPayee: true }, 'payment_proposal'), T0);
    await fails(decide('paul', verified, 'approve'), 'approvals.sod_violation', 'payee_verifier_never_alone_approves_first_payment');
    const prepared = await submit(h, w, 'rita', requisition('pp-prepared', '900000', { proposalPreparedByPersonId: P.paul }, 'payment_proposal'), T0);
    await fails(decide('paul', prepared, 'approve'), 'approvals.sod_violation', 'preparer_never_alone_approves_payment_proposal');
    // Not alone: another person approved the first step, so the preparer may approve the second.
    await activeRoute(h, w, 'payment_proposal', twoSteps as never);
    const together = await submit(h, w, 'rita', requisition('pp-together', '900000', { proposalPreparedByPersonId: P.paul, payeeVerifiedByPersonIds: [P.paul], firstPaymentToPayee: true }, 'payment_proposal'), T0);
    await decide('quinn', together, 'first');
    await decide('paul', together, 'second');
    assert.equal(await statusOf(together.id), 'approved');
    // The receipt recorder alone above the route threshold.
    await activeRoute(h, w, 'trade_invoice', { steps: [holders('approve')], receiverSoleApprovalThreshold: usd('100000') } as never);
    const above = await submit(h, w, 'rita', requisition('ti-above', '500000', { receiptRecordedByPersonIds: [P.carlos] }, 'trade_invoice'), T0);
    await fails(decide('carlos', above, 'approve'), 'approvals.sod_violation', 'receiver_never_alone_approves_matching_invoice_above_threshold');
    const below = await submit(h, w, 'rita', requisition('ti-below', '50000', { receiptRecordedByPersonIds: [P.carlos] }, 'trade_invoice'), T0);
    await decide('carlos', below, 'approve');
    const euro = await submit(h, w, 'rita', { ...requisition('ti-eur', null, { receiptRecordedByPersonIds: [P.carlos] }, 'trade_invoice'), amount: { minorUnits: '5000', currency: 'EUR' } }, T0);
    await fails(decide('carlos', euro, 'approve'), 'approvals.sod_violation', 'receiver_never_alone_approves_matching_invoice_above_threshold');
    // Exactly one eligible approver: an explicit audit flag instead of a silent bypass; the payee-changer rule has no exception.
    await activeRoute(h, w, 'payment_proposal', { steps: [holders('approve', { selector: { kind: 'named_person', personId: P.paul } })], receiverSoleApprovalThreshold: null } as never);
    const sole = await submit(h, w, 'rita', requisition('pp-sole', '900000', { proposalPreparedByPersonId: P.paul }, 'payment_proposal'), T0);
    const flagged = await decide('paul', sole, 'approve');
    assert.equal(flagged.sod_flag, 'preparer_never_alone_approves_payment_proposal');
    const soleChanged = await submit(h, w, 'rita', requisition('pp-sole-changed', '900000', { payeeChangedByPersonIds: [P.paul] }, 'payment_proposal'), T0);
    await fails(decide('paul', soleChanged, 'approve'), 'approvals.sod_violation', 'payee_changer_never_approves_payment_to_payee');
  });

  await t.test('steps: conditions, order, quorum, reasons; nothing without an eligible approver or an applicable step', async () => {
    await activeRoute(h, w, 'budget_change', {
      steps: [holders('manager'), holders('director', { order: 2, conditions: [{ kind: 'amount_above', amount: usd('1000000') }], selector: { kind: 'named_person', personId: P.ada } })],
      receiverSoleApprovalThreshold: null,
    } as never);
    const big = await submit(h, w, 'rita', requisition('bc-big', '5000000', {}, 'budget_change'), T0);
    await fails(decide('ada', big, 'director'), 'approvals.step_not_pending');
    await decide('paul', big, 'manager');
    const steps = await as(h, w, 'rita', (trx) => approvalRequests.steps(trx, big.id));
    assert.deepEqual(steps.map((s) => [s.step_key, s.status]), [['manager', 'approved'], ['director', 'pending']]);
    await fails(decide('ada', big, 'director', { decision: 'reject' }), 'approvals.reason_required');
    await decide('ada', big, 'director', { decision: 'reject', reason: 'Over the plan budget for this phase' });
    assert.equal(await statusOf(big.id), 'rejected');
    const small = await submit(h, w, 'rita', requisition('bc-small', '50000', {}, 'budget_change'), T0);
    assert.deepEqual((await as(h, w, 'rita', (trx) => approvalRequests.steps(trx, small.id))).map((s) => s.step_key), ['manager'], 'the director step does not apply');
    await decide('quinn', small, 'manager', { decision: 'return', reason: 'Split by cost code' });
    assert.equal(await statusOf(small.id), 'returned');
    // Unknown amount fails closed: the conditional step applies.
    const unknown = await submit(h, w, 'rita', requisition('bc-unknown', null, {}, 'budget_change'), T0);
    assert.deepEqual((await as(h, w, 'rita', (trx) => approvalRequests.steps(trx, unknown.id))).map((s) => s.step_key), ['manager', 'director']);
    // Quorum: two distinct people.
    await activeRoute(h, w, 'order', { steps: [holders('two', { selector: { kind: 'any_of', personIds: [P.paul, P.quinn, P.carlos] }, quorum: 2 })], receiverSoleApprovalThreshold: null } as never);
    const order = await submit(h, w, 'rita', requisition('order', '5000', {}, 'order'), T0);
    await decide('paul', order, 'two');
    assert.equal(await statusOf(order.id), 'pending');
    await fails(decide('paul', order, 'two'), 'approvals.already_decided');
    await decide('carlos', order, 'two');
    assert.equal(await statusOf(order.id), 'approved');
    // Refusals at submission.
    await activeRoute(h, w, 'document', { steps: [holders('only', { conditions: [{ kind: 'amount_above', amount: usd('100') }] })], receiverSoleApprovalThreshold: null } as never);
    await fails(submit(h, w, 'rita', requisition('doc', '50', {}, 'document'), T0), 'approvals.no_applicable_step');
    await activeRoute(h, w, 'document', { steps: [holders('rita', { selector: { kind: 'named_person', personId: P.rita } })], receiverSoleApprovalThreshold: null } as never);
    await fails(submit(h, w, 'rita', requisition('doc2', '50', {}, 'document'), T0), 'approvals.no_eligible_approver');
    await fails(submit(h, w, 'rita', { subject: { kind: 'supplier_status', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('ss'), amount: null }, T0), 'approvals.no_active_route');
    // Project scope and the project leader resolve against the request's project.
    await activeRoute(h, w, 'substitution', { steps: [holders('leader', { selector: { kind: 'project_leader' } })], receiverSoleApprovalThreshold: null } as never);
    await fails(submit(h, w, 'rita', { subject: { kind: 'substitution', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('sub0'), amount: null }, T0), 'approvals.no_eligible_approver');
    const sub = await submit(h, w, 'rita', { subject: { kind: 'substitution', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('sub'), amount: null, facts: { projectId: w.project } }, T0);
    await fails(decide('paul', sub, 'leader'), 'approvals.not_an_approver');
    await decide('lena', sub, 'leader');
    assert.equal(await statusOf(sub.id), 'approved');
  });

  await t.test('timeouts escalate to the next person and then expire; nothing is approved by silence', async () => {
    await activeRoute(h, w, 'order_change', {
      steps: [holders('pm', { selector: { kind: 'named_person', personId: P.paul }, timeoutHours: 1, escalation: { kind: 'next_selector', selector: { kind: 'named_person', personId: P.quinn } } })],
      receiverSoleApprovalThreshold: null,
    } as never);
    const escalated = await submit(h, w, 'rita', requisition('oc-1', null, {}, 'order_change'), T0);
    await fails(decide('quinn', escalated, 'pm', { now: minutes(30) }), 'approvals.not_found');
    const waitingFor = async (p: Person, at: Date) => (await as(h, w, p, (trx) => approvalRequests.waiting(trx, at, 50))).map((x) => x.request_id);
    assert.ok((await waitingFor('paul', minutes(30))).includes(escalated.id));
    assert.ok(!(await waitingFor('quinn', minutes(30))).includes(escalated.id));
    assert.ok((await waitingFor('quinn', minutes(90))).includes(escalated.id), 'after the timeout the escalation target sees it');
    await fails(decide('paul', escalated, 'pm', { now: minutes(90) }), 'approvals.not_an_approver');
    const decision = await decide('quinn', escalated, 'pm', { now: minutes(90) });
    assert.equal(decision.escalation_level, 1);
    assert.equal(await statusOf(escalated.id), 'approved');

    const silent = await submit(h, w, 'rita', requisition('oc-2', null, {}, 'order_change'), T0);
    const workers = await workerLogin(h);
    try {
      const worker = workers.pool(1);
      await fails(worker.query('SELECT * FROM trustwork.approval_decide($1, $2, $3, $4, NULL, 1, $5, true, now())', [silent.id, 'pm', 'approve', silent.subjectDigest.value, w.sessions.paul]), '42501');
      assert.equal((await worker.query<{ n: number }>('SELECT trustwork.approval_escalate_due($1, 100) AS n', [minutes(90)])).rows[0]?.n, 1);
      assert.equal(await statusOf(silent.id), 'pending');
      assert.equal((await worker.query<{ n: number }>('SELECT trustwork.approval_escalate_due($1, 100) AS n', [minutes(181)])).rows[0]?.n, 1);
    } finally {
      await workers.close();
    }
    assert.equal(await statusOf(silent.id), 'expired');
    assert.equal(Number((await h.db.admin.query<{ n: string }>("SELECT count(*) AS n FROM trustwork.approval_decision WHERE approval_request_id = $1", [silent.id])).rows[0]?.n), 0, 'no decision appears by itself');
    await fails(decide('quinn', silent, 'pm', { now: minutes(200) }), 'approvals.not_pending');
  });

  await t.test('acceptance 3: decisions need the person in their own first-party session; no agent, worker, mandate, connection or extension path exists', async () => {
    await activeRoute(h, w, 'requisition', { steps: [holders('approve')], receiverSoleApprovalThreshold: null } as never);
    const r = await submit(h, w, 'rita', requisition('fp', '700000'), T0);
    await fails(decide('paul', r, 'approve', { sessionId: w.sessions.quinn }), 'approvals.first_party_required');
    await fails(decide('paul', r, 'approve', { sessionId: uuid() }), 'approvals.first_party_required');
    await fails(decide('paul', r, 'approve', { stepUp: false }), 'approvals.step_up_required');
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('session').set({ revoked_at: new Date(), revoked_reason: 'logout' }).where('id', '=', w.sessions.carlos).execute());
    await fails(decide('carlos', r, 'approve'), 'approvals.first_party_required');
    // The runtime role writes no table directly.
    await fails(h.db.app.query("INSERT INTO trustwork.approval_decision (approval_request_id, step_key, approver_person_id, on_behalf_company_id, decision, subject_digest, session_id, step_up, escalation_level, decided_at) VALUES ($1, 'approve', $2, $3, 'approve', $4, $5, true, 0, now())",
      [r.id, P.paul, w.company, r.subjectDigest.value, w.sessions.paul]), '42501');
    await fails(h.db.app.query("UPDATE trustwork.approval_request SET status = 'approved'"), '42501');
    // A decision row has no mandate, connection, extension or agent column.
    const { rows } = await h.db.admin.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = 'approval_decision'");
    assert.deepEqual(rows.map((c) => c.column_name).filter((c) => /mandate|connection|extension|agent|intent|run_id/.test(c)), []);
    await decide('paul', r, 'approve');
    assert.equal(await statusOf(r.id), 'approved');
  });

  await t.test('visibility: the requester, deciders, eligible approvers and route managers; nobody else', async () => {
    await activeRoute(h, w, 'requisition', { steps: [holders('approve', { selector: { kind: 'named_person', personId: P.quinn } })], receiverSoleApprovalThreshold: null } as never);
    const r = await submit(h, w, 'rita', requisition('vis', '5000'), T0);
    const sees = async (p: Person) => (await as(h, w, p, (trx) => approvalRequests.get(trx, r.id))) !== undefined;
    assert.deepEqual({ rita: await sees('rita'), quinn: await sees('quinn'), ada: await sees('ada'), paul: await sees('paul'), dana: await sees('dana'), lena: await sees('lena'), otto: await sees('otto') },
      { rita: true, quinn: true, ada: true, paul: true, dana: false, lena: true, otto: false }, 'paul manages routes since the first subtest; lena is a live delegate of quinn; dana\'s delegation from quinn ended');
    assert.equal((await as(h, w, 'otto', (trx) => trx.selectFrom('approval_request_step').selectAll().execute())).length, 0);
    assert.equal((await as(h, w, 'otto', (trx) => trx.selectFrom('approval_decision').selectAll().execute())).length, 0);
    assert.equal((await as(h, w, 'dana', (trx) => approvalRequests.viewerOptions(trx, r.id, T0))).length, 0);
    const options = await as(h, w, 'quinn', (trx) => approvalRequests.viewerOptions(trx, r.id, T0));
    assert.deepEqual(options.map((o) => [o.step_key, o.may_decide]), [['approve', true]]);
    const adaOptions = await as(h, w, 'ada', (trx) => approvalRequests.viewerOptions(trx, r.id, T0));
    assert.deepEqual(adaOptions.map((o) => [o.may_decide, o.refusal]), [[false, 'not_an_approver']]);
  });

  await t.test('acceptance 4: concurrent decisions on the same step resolve once', async () => {
    await activeRoute(h, w, 'requisition', { steps: [holders('approve')], receiverSoleApprovalThreshold: null } as never);
    // Deterministic interleaving: Paul holds the request lock; Quinn's decision waits for it and then finds the request decided.
    const r = await submit(h, w, 'rita', requisition('race', '5000'), T0);
    const revision = await revisionOf(r.id);
    const [paul, quinn] = [await h.db.app.connect(), await h.db.app.connect()];
    try {
      const begin = async (c: typeof paul, p: Person) => {
        await c.query('BEGIN');
        const principal = await principalFor(h.db.admin, P[p]);
        await c.query('SELECT trustwork.set_principal($1::uuid, $2::integer)', [principal.personId, principal.authzEpoch]);
      };
      const sqlDecide = (c: typeof paul, p: Person, decision: string, reason: string | null) =>
        c.query('SELECT id FROM trustwork.approval_decide($1, $2, $3, $4, $5, $6, $7, true, $8)', [r.id, 'approve', decision, r.subjectDigest.value, reason, revision, w.sessions[p], minutes(1)]);
      await begin(paul, 'paul');
      await begin(quinn, 'quinn');
      await sqlDecide(paul, 'paul', 'approve', null);
      const blocked = sqlDecide(quinn, 'quinn', 'reject', 'Duplicate of another requisition').then(() => 'committed', (e: { hint?: string }) => e.hint ?? 'error');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await paul.query('COMMIT');
      assert.equal(await blocked, 'approvals.not_pending', 'the waiting decision finds the step decided');
      await quinn.query('ROLLBACK');
    } finally {
      paul.release();
      quinn.release();
    }
    assert.equal(await statusOf(r.id), 'approved');
    const count = async (id: string) => Number((await h.db.admin.query<{ n: string }>('SELECT count(*) AS n FROM trustwork.approval_decision WHERE approval_request_id = $1', [id])).rows[0]?.n);
    const closed = async (id: string) => Number((await h.db.admin.query<{ n: string }>("SELECT count(*) AS n FROM trustwork.outbox_event WHERE aggregate_id = $1 AND type = 'approval.request_closed'", [id])).rows[0]?.n);
    assert.equal(await count(r.id), 1);
    assert.equal(await closed(r.id), 1);

    // A free-for-all: six simultaneous approvals and rejections from three people on one step; exactly one wins.
    const race = await submit(h, w, 'rita', requisition('race-2', '5000'), T0);
    const attempts = (['paul', 'quinn', 'ada', 'paul', 'quinn', 'ada'] as const).map((p, i) => decide(p, race, 'approve', i % 2 === 0 ? {} : { decision: 'reject', reason: 'Concurrent reject' }).then(() => 'ok', (e: { hint?: string }) => e.hint ?? String(e)));
    const results = await Promise.all(attempts);
    assert.equal(results.filter((x) => x === 'ok').length, 1, JSON.stringify(results));
    assert.ok(results.filter((x) => x !== 'ok').every((x) => ['approvals.revision_conflict', 'approvals.not_pending', 'approvals.already_decided'].includes(x)), JSON.stringify(results));
    assert.equal(await count(race.id), 1);
    assert.equal(await closed(race.id), 1);

    // Quorum two: concurrent votes with the same revision never double-count; the second voter retries on the new revision.
    await activeRoute(h, w, 'requisition', { steps: [holders('two', { quorum: 2 })], receiverSoleApprovalThreshold: null } as never);
    const quorum = await submit(h, w, 'rita', requisition('race-3', '5000'), T0);
    const seen = await revisionOf(quorum.id);
    const both = await Promise.all((['paul', 'quinn'] as const).map((p) => decide(p, quorum, 'two', { expectedRevision: seen }).then(() => 'ok', (e: { hint?: string }) => e.hint ?? String(e))));
    assert.deepEqual([...both].sort(), ['approvals.revision_conflict', 'ok']);
    const steps = await as(h, w, 'rita', (trx) => approvalRequests.steps(trx, quorum.id));
    assert.equal(steps[0]?.approvals, 1);
    assert.equal(await statusOf(quorum.id), 'pending');
    await decide(both[0] === 'ok' ? 'quinn' : 'paul', quorum, 'two');
    assert.equal(await statusOf(quorum.id), 'approved');
  });

  await t.test('a delegation ends with the delegator\'s membership', async () => {
    await activeRoute(h, w, 'requisition', { steps: [holders('approve', { selector: { kind: 'named_person', personId: P.carlos } })], receiverSoleApprovalThreshold: null } as never);
    await as(h, w, 'carlos', (trx) => approvalDelegations.create(trx, { delegatePersonId: P.dana, subjectKinds: ['requisition'], limit: null, validFrom: T0, validUntil: minutes(60 * 24), now: T0 }));
    const r = await submit(h, w, 'rita', requisition('ended', '5000'), T0);
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: P.ada, ended_reason: 'synthetic: left the company' }).where('person_id', '=', P.carlos).execute());
    await fails(decide('dana', r, 'approve'), 'approvals.not_found');
  });
});
