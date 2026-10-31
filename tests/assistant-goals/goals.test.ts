import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { expectError, SKIP_REASON, startHarness } from '../backend/helpers/app.js';
import { as, fails } from '../assistant/helpers.js';
import { buildWorld, ok, ownDraft, UNTIL } from './helpers.js';

/**
 * AGT-001 goals on the real database under the runtime role: creating a goal checks the current mandates and proposes
 * only the missing changes; nothing is authorized until the person confirms the goal and all of its proposals together,
 * on the first-party form with a recent authentication and the exact digest shown; concurrent confirmations confirm
 * once; a mandate that changed meanwhile voids the confirmation; goals, progress, subscriptions and reports stay
 * private to their principal (reports can be shared with colleagues only).
 */
const h = await startHarness('agents_goals');

interface Digest { algorithm: string; value: string }
interface Confirmation { goalId: string; digest: Digest; covered: { mandateId: string; revision: number }[]; proposals: { proposalId: string; mandateId: string; actions: string[]; digest: Digest }[] }
interface GoalView { id: string; status: string; revision: number; mandateIds: string[]; budgetRange: unknown; confirmation: { stepUp: boolean } | null }

test('goals: missing mandate changes in one structured confirmation, privacy, lifecycle, reports and concurrency', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w = await buildWorld(h);
  const { petr, carl, xenia, pure, boris } = w.clients;
  const rfq = w.rfq.rfq.id;
  const research = ok<{ id: string; revision: number }>(await petr.post('/v1/assistant/mandates', ownDraft(rfq, ['research'], { moduleKeys: ['discovery'] })), 201);
  const goalBody = (over: Record<string, unknown> = {}) => ({
    onBehalfOf: null, text: 'Find a paver supplier for the patio and settle the price within my budget.', successCriteria: ['One accepted quote from a verified supplier'],
    needs: [
      { moduleKey: 'discovery', actions: ['research'], contexts: [{ kind: 'rfq', id: rfq }], perWindow: null, approvalPolicy: { mode: 'pre_authorized' } },
      { moduleKey: 'negotiation', actions: ['negotiate', 'communicate'], contexts: [{ kind: 'rfq', id: rfq }], perWindow: { count: 10, windowHours: 168 }, approvalPolicy: { mode: 'ask_first', count: 2 } },
    ],
    budgetRange: { low: { minorUnits: '5000000', currency: 'USD' }, high: { minorUnits: '7500000', currency: 'USD' } }, horizon: '2027-06-30T00:00:00.000Z', reportCadence: 'weekly', ...over,
  });
  const mandateCount = async (personId: string) => (await h.db.admin.query("SELECT count(*)::int AS n FROM trustwork.mandate WHERE principal_person_id = $1 AND status = 'active'", [personId])).rows[0].n as number;
  let goal: GoalView;
  let confirmation: Confirmation;

  await t.test('creating a goal proposes only the missing mandate changes and authorizes nothing', async () => {
    expectError(await petr.post('/v1/assistant/goals', goalBody({ needs: [{ moduleKey: 'deal_desk', actions: ['place_order'], contexts: [{ kind: 'rfq', id: rfq }], perWindow: null, approvalPolicy: { mode: 'pre_authorized' } }] })), 422, 'validation.schema');
    expectError(await petr.post('/v1/assistant/goals', goalBody({ needs: [{ moduleKey: 'execution_clerk', actions: ['confirm_execution'], contexts: [{ kind: 'rfq', id: rfq }], perWindow: null, approvalPolicy: { mode: 'pre_authorized' } }] })), 422, 'validation.schema');
    expectError(await petr.post('/v1/assistant/goals', goalBody({ onBehalfOf: { kind: 'company', id: w.seed.companies.supplier } })), 404, 'access.not_found');
    expectError(await petr.post('/v1/assistant/goals', { ...goalBody(), status: 'active' }), 422, 'validation.unknown_field');
    const before = await mandateCount(w.seed.people.petr);
    const created = ok<{ goal: GoalView; confirmation: Confirmation }>(await petr.post('/v1/assistant/goals', goalBody()), 201);
    goal = created.goal;
    confirmation = created.confirmation;
    assert.equal(goal.status, 'proposed');
    assert.deepEqual(confirmation.covered.map((c) => c.mandateId), [research.id], 'the research need is already covered');
    assert.deepEqual(confirmation.proposals.map((p) => p.actions), [['negotiate', 'communicate']], 'one proposal for what is missing');
    assert.equal(await mandateCount(w.seed.people.petr), before, 'the goal widened nothing');
    assert.deepEqual(ok<Confirmation>(await petr.get(`/v1/assistant/goals/${goal.id}/confirmation`)), confirmation, 'the same confirmation can be shown again');
    // The goal's proposal is an ordinary inert proposal of origin `goal`.
    const proposals = ok<{ proposals: { id: string; origin: string; status: string }[] }>(await petr.get('/v1/assistant/mandate-proposals')).proposals;
    assert.deepEqual(proposals.map((p) => [p.id, p.origin, p.status]), [[confirmation.proposals[0]!.proposalId, 'goal', 'pending']]);
  });

  await t.test('only the principal confirms, with step-up and the exact digest; the database refuses every other path', async () => {
    expectError(await carl.post(`/v1/assistant/goals/${goal.id}/confirm`, { digest: confirmation.digest }), 404, 'access.not_found');
    expectError(await carl.get(`/v1/assistant/goals/${goal.id}`), 404, 'access.not_found');
    assert.deepEqual(ok<{ goals: unknown[] }>(await carl.get('/v1/assistant/goals')).goals, []);
    expectError(await petr.post(`/v1/assistant/goals/${goal.id}/confirm`, { digest: { algorithm: 'trustwork-digest-1', value: 'c'.repeat(64) } }), 409, 'access.approval_digest_mismatch');
    h.clock.advance(11 * 60_000);
    expectError(await petr.post(`/v1/assistant/goals/${goal.id}/confirm`, { digest: confirmation.digest }), 403, 'auth.step_up_required');
    h.clock.reset();
    await as(h, w.seed.people.petr, (trx) => fails(sql`UPDATE trustwork.goal SET status = 'active' WHERE id = ${goal.id}::uuid`.execute(trx), '42501'));
    await as(h, w.seed.people.petr, (trx) => fails(sql`SELECT * FROM trustwork.agents_confirm_goal(${goal.id}::uuid, ${confirmation.digest.value}, true)`.execute(trx), 'goal.proposals_unconfirmed'));
    await as(h, w.seed.people.carl, (trx) => fails(sql`SELECT * FROM trustwork.agents_confirm_goal(${goal.id}::uuid, ${confirmation.digest.value}, true)`.execute(trx), 'access.not_found'));
    await as(h, w.seed.people.petr, (trx) => fails(sql`INSERT INTO trustwork.goal (principal_person_id, text, success_criteria, allowed_actions, needs, horizon, report_cadence, status, proposed_by, confirmation_digest, confirmed_by_person_id, confirmed_at, confirmed_step_up)
      VALUES (${w.seed.people.petr}::uuid, 'x', '["x"]', '{}', '[]', now() + interval '1 day', 'none', 'active', 'principal', ${'a'.repeat(64)}, ${w.seed.people.petr}::uuid, now(), true)`.execute(trx), 'goal.not_proposed'));
    await as(h, w.seed.people.carl, (trx) => fails(sql`INSERT INTO trustwork.goal (principal_person_id, text, success_criteria, allowed_actions, needs, horizon, report_cadence, proposed_by, confirmation_digest)
      VALUES (${w.seed.people.petr}::uuid, 'x', '["x"]', '{}', '[]', now() + interval '1 day', 'none', 'principal', ${'a'.repeat(64)})`.execute(trx), '42501'));
  });

  await t.test('concurrent confirmations confirm the goal and its mandate changes exactly once', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => petr.post(`/v1/assistant/goals/${goal.id}/confirm`, { digest: confirmation.digest })));
    assert.deepEqual([a!.status, b!.status].sort(), [200, 409]);
    goal = ok<GoalView>(await petr.get(`/v1/assistant/goals/${goal.id}`));
    assert.equal(goal.status, 'active');
    assert.equal(goal.confirmation?.stepUp, true);
    assert.deepEqual([...goal.mandateIds].sort(), [research.id, confirmation.proposals[0]!.mandateId].sort());
    const created = (await h.db.admin.query('SELECT status, revision, grantee_kind FROM trustwork.mandate WHERE id = $1', [confirmation.proposals[0]!.mandateId])).rows[0];
    assert.deepEqual([created.status, created.revision, created.grantee_kind], ['active', 1, 'own_agent']);
    const progress = ok<{ progress: { eventKind: string }[] }>(await petr.get(`/v1/assistant/goals/${goal.id}`)).progress.map((e) => e.eventKind);
    assert.deepEqual(progress, ['created', 'mandate_proposed', 'mandate_confirmed', 'confirmed']);
  });

  await t.test('a mandate the goal relies on that changes before confirmation voids the confirmation', async () => {
    const created = ok<{ goal: GoalView; confirmation: Confirmation }>(await petr.post('/v1/assistant/goals', goalBody({ needs: [goalBody().needs[0]] })), 201);
    assert.equal(created.confirmation.proposals.length, 0);
    ok(await petr.post(`/v1/assistant/mandates/${research.id}/confirm`, { expectedRevision: 1, ...ownDraft(rfq, ['research'], { moduleKeys: ['discovery'], validUntil: UNTIL }) }));
    expectError(await petr.post(`/v1/assistant/goals/${created.goal.id}/confirm`, { digest: created.confirmation.digest }), 409, 'validation.revision_conflict');
    assert.equal(ok<GoalView>(await petr.get(`/v1/assistant/goals/${created.goal.id}`)).status, 'proposed');
  });

  await t.test('job subscriptions start runs only under the principal\'s own mandates and end with their goal', async () => {
    const trigger = { kind: 'goal', goalId: goal.id };
    expectError(await petr.post('/v1/assistant/job-subscriptions', { onBehalfOf: null, moduleKey: 'negotiation', jobTemplateKey: 'weekly_follow_up', trigger, mandateId: research.id.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }), 404, 'access.not_found');
    const foreign = ok<{ id: string }>(await carl.post('/v1/assistant/mandates', ownDraft(rfq, ['research'], { moduleKeys: ['discovery'] })), 201);
    expectError(await petr.post('/v1/assistant/job-subscriptions', { onBehalfOf: null, moduleKey: 'negotiation', jobTemplateKey: 'weekly_follow_up', trigger, mandateId: foreign.id }), 404, 'access.not_found');
    expectError(await carl.post('/v1/assistant/job-subscriptions', { onBehalfOf: null, moduleKey: 'negotiation', jobTemplateKey: 'weekly_follow_up', trigger, mandateId: null }), 404, 'access.not_found');
    const sub = ok<{ id: string; status: string; revision: number }>(await petr.post('/v1/assistant/job-subscriptions', { onBehalfOf: null, moduleKey: 'negotiation', jobTemplateKey: 'weekly_follow_up', trigger, mandateId: confirmation.proposals[0]!.mandateId }), 201);
    const paused = ok<{ status: string; revision: number }>(await petr.post(`/v1/assistant/job-subscriptions/${sub.id}/status`, { status: 'paused', expectedRevision: sub.revision }));
    assert.equal(paused.status, 'paused');
    expectError(await petr.post(`/v1/assistant/job-subscriptions/${sub.id}/status`, { status: 'active', expectedRevision: sub.revision }), 409, 'validation.revision_conflict');
    // Evidence, a report, then closing the goal ends the subscription in the same transaction.
    expectError(await petr.post(`/v1/assistant/goals/${goal.id}/progress`, { evidenceRefs: [{ kind: 'quote', id: w.supplierQuote.id }], code: 'quote_received', note: 'free text' }), 422, 'validation.unknown_field');
    ok(await petr.post(`/v1/assistant/goals/${goal.id}/progress`, { evidenceRefs: [{ kind: 'quote', id: w.supplierQuote.id }], code: 'quote_received' }), 201);
    const paused2 = ok<GoalView>(await petr.post(`/v1/assistant/goals/${goal.id}/status`, { status: 'paused', outcome: null, expectedRevision: goal.revision }));
    expectError(await petr.post(`/v1/assistant/goals/${goal.id}/progress`, { evidenceRefs: [{ kind: 'quote', id: w.supplierQuote.id }], code: 'quote_received' }), 409, 'validation.revision_conflict');
    const closed = ok<GoalView>(await petr.post(`/v1/assistant/goals/${goal.id}/status`, { status: 'closed', outcome: 'achieved', expectedRevision: paused2.revision }));
    assert.equal(closed.status, 'closed');
    const subs = ok<{ subscriptions: { id: string; status: string }[] }>(await petr.get('/v1/assistant/job-subscriptions')).subscriptions;
    assert.equal(subs.find((s) => s.id === sub.id)!.status, 'ended');
    expectError(await petr.post(`/v1/assistant/goals/${goal.id}/status`, { status: 'active', outcome: null, expectedRevision: closed.revision }), 409, 'validation.revision_conflict');
  });

  await t.test('reports are drafts of their author, shared only with colleagues; the budget range never leaves the owner view', async () => {
    const created = ok<{ goal: GoalView; confirmation: Confirmation }>(await xenia.post('/v1/assistant/goals', goalBody({
      onBehalfOf: { kind: 'company', id: w.seed.companies.supplier }, needs: [{ moduleKey: 'negotiation', actions: ['communicate'], contexts: [{ kind: 'rfq', id: rfq }], perWindow: null, approvalPolicy: { mode: 'ask_each' } }],
    })), 201);
    ok(await xenia.post(`/v1/assistant/goals/${created.goal.id}/confirm`, { digest: created.confirmation.digest }));
    const report = ok<{ id: string; sections: { items: { labelKey: string; value: { count: number } }[] }[]; sharedWith: string[] }>(await xenia.post(`/v1/assistant/goals/${created.goal.id}/report`), 201);
    assert.ok(report.sections[0]!.items.some((i) => i.labelKey === 'agents.report.event.confirmed'));
    assert.ok(!JSON.stringify(report).includes('5000000'), 'the report carries no budget range');
    expectError(await xenia.post(`/v1/assistant/reports/${report.id}/share`, { personIds: [w.seed.people.carl] }), 403, 'access.forbidden');
    expectError(await pure.post(`/v1/assistant/reports/${report.id}/share`, { personIds: [w.seed.people.pure] }), 404, 'access.not_found');
    assert.deepEqual(ok<{ reports: unknown[] }>(await pure.get('/v1/assistant/reports')).reports, []);
    ok(await xenia.post(`/v1/assistant/reports/${report.id}/share`, { personIds: [w.seed.people.pure] }));
    const seen = ok<{ reports: { id: string; sharedWith: string[] }[] }>(await pure.get('/v1/assistant/reports')).reports;
    assert.deepEqual(seen.map((r) => [r.id, r.sharedWith]), [[report.id, []]], 'the colleague reads the report, not its reader list');
    assert.deepEqual(ok<{ reports: unknown[] }>(await boris.get('/v1/assistant/reports')).reports, []);
    expectError(await pure.get(`/v1/assistant/goals/${created.goal.id}`), 404, 'access.not_found');
  });
});
