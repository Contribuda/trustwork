import test from 'node:test';
import { buildAgentWorld } from '../agent-modules/helpers.js';
import assert from 'node:assert/strict';
import { jobs } from '@trustwork/data';
import { HandlerRegistry, inTransaction, silentLogger, Worker, type ScheduledTask } from '@trustwork/worker';
import { assistantWorker } from '../../packages/data/src/repositories/assistant.js';
import { assistantSweepTask, fakeEffectProviders, recordAssistantReceipt, registerAssistant, type AssistantRuntime } from '../../apps/worker/src/assistant/index.js';
import { expectError, SKIP_REASON, startHarness, type Client } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { sleep, waitFor } from '../worker/helpers/worker-db.js';
import { assistantService, draft, fails, ok, personalBudget, stateOf, usd, workerLogin, type IntentView, type MandateView } from './helpers.js';

/**
 * AST-001 durable action workflow end to end on real PostgreSQL: the API decides and queues (budget reserved, attempt
 * identity persisted before the call), worker processes dispatch through fake providers, crash and lease loss lead to
 * reconciliation by a second worker (never a replay), acknowledged is not success, accepted-then-rejected releases the
 * reservation, unknown outcomes keep the reservation, cancellation, revocation, expiry and the stop control stop
 * actions before any call, concurrent dispatchers and approvers produce exactly one attempt and one approval, and no
 * private constraint reaches a provider or a worker.
 */
const h = await startHarness('assistant_runtime');

test('agent action workflow: dispatch, crash recovery, receipts, reconciliation, cancellation and concurrency', { skip: h ? false : SKIP_REASON, timeout: 300_000 }, async (t) => {
  if (!h) return;
  const worker = await workerLogin(h);
  t.after(async () => {
    await worker.close();
    await h.close();
  });
  await buildAgentWorld(h);
  h.clock.reset();
  const seed = await seedPersonas(h);
  const { petr } = seed.people;
  const petrApi: Client = h.client();
  await login(petrApi, 'petr');
  const project = ok<{ id: string }>(await petrApi.post('/v1/projects', { owner: { kind: 'person', id: petr }, name: 'Demo patio', summary: null, leaderPersonId: null }), 201);
  const budget = await personalBudget(h, petr, 'transaction', '1000000');
  const mandateDraft = (validUntil?: string) => draft({
    moduleKeys: ['deal_desk'], actions: ['place_order', 'communicate'], contexts: [{ kind: 'project', id: project.id }],
    limits: { ceiling: usd('900000'), perActionCeiling: null, transactionBudgetId: budget, platformBudgetId: null, perWindow: null },
    approvalPolicy: { mode: 'ask_above', threshold: usd('100000') }, ...(validUntil ? { validUntil } : {}),
  });
  let mandate = ok<MandateView>(await petrApi.post('/v1/assistant/mandates', { draft: mandateDraft() }), 201);

  const providers = fakeEffectProviders();
  const runtime: AssistantRuntime = { pool: worker.pool(6), providers: providers.all, hubId: null, log: silentLogger };
  const workerA = new Worker({ pool: runtime.pool, registry: registerAssistant(new HandlerRegistry(), runtime), config: { workerId: 'worker-a', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
  const runtimeB: AssistantRuntime = { ...runtime, pool: worker.pool(6) };
  const workerB = new Worker({ pool: runtimeB.pool, registry: registerAssistant(new HandlerRegistry(), runtimeB), config: { workerId: 'worker-b', leaseSeconds: 30, retryJitter: 0 } });
  const expireTask = workerB.scheduler.tasks.find((task) => task.name === 'jobs.expire_leases') as ScheduledTask;
  const sweep = assistantSweepTask(runtimeB);
  const drain = async (w: Worker) => {
    for (let i = 0; i < 20; i++) {
      const leased = await w.runner.tick();
      await w.idle();
      if (leased === 0) return;
    }
  };
  const { service, model } = assistantService(h);
  let requests = 0;
  const effect = (payload: unknown = { supplier: 'Demo Paving Supply', lines: [{ sku: 'pavers-grey', quantity: '40' }] }) => ({ provider: 'fake_orders', operation: 'order.place', payload });
  const propose = async (amount: string, payload?: unknown) => {
    model.push({ text: 'Proposed.', messageKey: null, usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{
      kind: 'propose_action', mandateId: mandate.id, capabilityId: 'deal_desk.place_order', moduleKey: 'deal_desk', action: 'place_order', context: { kind: 'project', id: project.id }, amount: usd(amount), projectId: project.id, effect: effect(payload),
    }] });
    const turn = await service.converse({ text: `Order pavers for ${amount}` }, await stateOf(h, petrApi, `req-runtime-${++requests}`));
    return { action: turn.actions[0]!, run: turn.run };
  };
  const intent = async (id: string) => (await h.db.admin.query<{ state: string; reservation_id: string | null; outcome_kind: string | null; attempt_count: number; effect_correlation_key: string; run_id: string }>('SELECT state, reservation_id, outcome_kind, attempt_count, effect_correlation_key, run_id FROM trustwork.action_intent WHERE id = $1', [id])).rows[0]!;
  const reservation = async (intentId: string) => (await h.db.admin.query<{ state: string; amount_minor: string; settled_minor: string | null }>('SELECT state, amount_minor, settled_minor FROM trustwork.reservation WHERE action_intent_id = $1', [intentId])).rows[0];
  const submissionsFor = (key: string) => providers.orders.submissions.filter((s) => s.correlationKey === key).length;
  const until = async (id: string, states: string[], w: Worker = workerB) => waitFor(async () => {
    await drain(w);
    const row = await intent(id);
    return states.includes(row.state) ? row : null;
  }, 20_000, `intent ${id} to reach ${states.join('/')}`);

  await t.test('a pre-authorized order under the threshold is reserved, dispatched once and settled from final evidence', async () => {
    const { action, run } = await propose('80000');
    assert.equal(action.state, 'queued');
    const id = (action as { intentId: string }).intentId;
    assert.equal(run.state, 'waiting_event');
    assert.deepEqual(await reservation(id), { state: 'reserved', amount_minor: '80000', settled_minor: null });
    await drain(workerA);
    const done = await intent(id);
    assert.equal(done.state, 'succeeded');
    assert.deepEqual(await reservation(id), { state: 'settled', amount_minor: '80000', settled_minor: '80000' });
    const ledger = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.ledger_entry WHERE reservation_id = $1', [done.reservation_id]);
    assert.equal(ledger.rows[0]!.n, 2, 'one balanced settlement batch');
    assert.equal(submissionsFor(done.effect_correlation_key), 1);
    const view = ok<{ state: string; actions: { state: string; outcomes: { kind: string }[] }[] }>(await petrApi.get(`/v1/assistant/runs/${run.id}`));
    assert.equal(view.state, 'completed');
    assert.deepEqual(view.actions[0]!.outcomes.map((o) => o.kind), ['final']);
  });

  await t.test('above the threshold the agent asks; the approval binds the exact digest and queues the action', async () => {
    const { action } = await propose('200000');
    assert.equal(action.state, 'proposed');
    const id = (action as { intentId: string }).intentId;
    assert.ok((action as { reasons: readonly string[] }).reasons.includes('above_threshold'));
    assert.equal(await reservation(id), undefined, 'nothing reserved before the person decides');
    const decision = ok<{ decisions: IntentView[] }>(await petrApi.get('/v1/assistant/decisions')).decisions.find((d) => d.id === id)!;
    expectError(await petrApi.post(`/v1/assistant/decisions/${id}/approve`, { digest: { ...decision.actionDigest, value: '0'.repeat(64) } }), 409, 'access.approval_digest_mismatch');
    const approved = ok<IntentView>(await petrApi.post(`/v1/assistant/decisions/${id}/approve`, { digest: decision.actionDigest }));
    assert.equal(approved.state, 'queued');
    assert.equal((await reservation(id))!.state, 'reserved');
    await drain(workerA);
    assert.equal((await intent(id)).state, 'succeeded');
  });

  await t.test('a crash after the external effect and before the result is saved is reconciled by a second worker, never replayed', async () => {
    const { action } = await propose('50000');
    const id = (action as { intentId: string }).intentId;
    // Worker A: lease, persist the attempt, call the provider (the effect happens), then the process dies.
    const [job] = await inTransaction(runtime.pool, (trx) => jobs.lease(trx, ['assistant.dispatch'], 'crashing-worker', 1, 1));
    assert.ok(job);
    const target = await inTransaction(runtime.pool, (trx) => assistantWorker.beginAttempt(trx, id, job.id, null, job.fencing_token));
    assert.equal(target.status, 'dispatch');
    const dispatch = target as Extract<typeof target, { status: 'dispatch' }>;
    const effectsBefore = providers.orders.effects;
    await providers.orders.submit({ correlationKey: dispatch.correlationKey, operationId: dispatch.operationId, attemptNo: dispatch.attemptNo, operation: dispatch.operation, payload: dispatch.payload, amount: dispatch.amount }, new AbortController().signal);
    assert.equal(providers.orders.effects, effectsBefore + 1);
    assert.equal((await intent(id)).state, 'executing');
    // Worker B: the lease expires and is parked; the sweep turns the attempt into an unknown outcome.
    await waitFor(async () => (await h.db.admin.query("SELECT 1 FROM trustwork.job WHERE id = $1 AND leased_until < now()", [job.id])).rowCount === 1, 15_000, 'lease expiry');
    await expireTask.run();
    assert.equal((await sweep.run()).parked, 1);
    const unknown = await intent(id);
    assert.equal(unknown.state, 'outcome_unknown');
    assert.equal((await reservation(id))!.state, 'reserved', 'an unknown outcome keeps the reservation');
    const reconciled = await until(id, ['succeeded', 'failed']);
    assert.equal(reconciled.state, 'succeeded', 'the lookup found the effect');
    assert.equal(providers.orders.effects, effectsBefore + 1, 'no second effect');
    assert.equal(submissionsFor(dispatch.correlationKey), 1, 'never re-submitted');
    assert.deepEqual(await reservation(id), { state: 'settled', amount_minor: '50000', settled_minor: '50000' });
    const records = await h.db.admin.query<{ reconciled_by: string; lookup_reference: string; kind: string }>("SELECT reconciled_by, lookup_reference, outcome->>'kind' AS kind FROM trustwork.reconciliation WHERE action_intent_id = $1", [id]);
    assert.deepEqual(records.rows.map((r) => [r.reconciled_by, r.kind]), [['worker', 'final']]);
    const outcomes = await h.db.admin.query<{ kind: string; reason: string | null; reconciled: boolean }>('SELECT kind, reason, reconciliation_id IS NOT NULL AS reconciled FROM trustwork.action_outcome WHERE action_intent_id = $1 ORDER BY observed_at', [id]);
    assert.deepEqual(outcomes.rows, [{ kind: 'unknown', reason: 'lease_expired', reconciled: false }, { kind: 'final', reason: null, reconciled: true }]);
    const parked = await h.db.admin.query<{ state: string; last_error: string }>('SELECT state, last_error FROM trustwork.job WHERE id = $1', [job.id]);
    assert.equal(parked.rows[0]!.state, 'succeeded');
    assert.match(parked.rows[0]!.last_error, /^reconciled: assistant\.reconciliation:/);
  });

  await t.test('acknowledged is not success; an accepted-then-rejected order fails and releases its reservation', async () => {
    providers.orders.next('acknowledge');
    const { action } = await propose('60000');
    const id = (action as { intentId: string }).intentId;
    await drain(workerA);
    const pending = await intent(id);
    assert.equal(pending.state, 'pending');
    assert.equal(pending.outcome_kind, 'acknowledged');
    assert.equal((await reservation(id))!.state, 'reserved', 'pending keeps the money held');
    const receipt = providers.orders.complete(pending.effect_correlation_key, 'failed');
    assert.equal(await recordAssistantReceipt(runtime.pool, receipt), 'failed');
    assert.equal(await recordAssistantReceipt(runtime.pool, receipt), 'duplicate');
    assert.equal((await intent(id)).state, 'failed');
    assert.equal((await reservation(id))!.state, 'released');
    const use = await h.db.admin.query<{ voided: boolean }>('SELECT voided_at IS NOT NULL AS voided FROM trustwork.mandate_use WHERE action_intent_id = $1', [id]);
    assert.deepEqual(use.rows, [{ voided: true }], 'a failed action returns its amount to the mandate ceiling');
    // Accepted then confirmed settles.
    providers.orders.next('acknowledge');
    const second = await propose('70000');
    const secondId = (second.action as { intentId: string }).intentId;
    await drain(workerA);
    assert.equal(await recordAssistantReceipt(runtime.pool, providers.orders.complete((await intent(secondId)).effect_correlation_key, 'succeeded')), 'succeeded');
    assert.equal((await reservation(secondId))!.state, 'settled');
  });

  await t.test('an ambiguous timeout keeps the reservation until a definitive lookup; no effect fails and releases, an effect settles', async () => {
    providers.orders.next('timeout_before_effect');
    const before = await propose('40000');
    const id = (before.action as { intentId: string }).intentId;
    await drain(workerA);
    assert.equal((await intent(id)).state, 'outcome_unknown');
    assert.equal((await reservation(id))!.state, 'reserved');
    const held = await h.db.admin.query<{ held: string }>('SELECT held::text FROM trustwork.billing_budget_committed($1::uuid)', [budget]);
    assert.ok(BigInt(held.rows[0]!.held) >= 40000n, 'still counted against the budget');
    const failed = await until(id, ['failed', 'succeeded']);
    assert.equal(failed.state, 'failed');
    assert.equal((await reservation(id))!.state, 'released');
    assert.equal(submissionsFor(failed.effect_correlation_key), 1, 'the lookup replaced any retry');

    providers.orders.next('timeout_after_effect');
    const after = await propose('30000');
    const afterId = (after.action as { intentId: string }).intentId;
    await drain(workerA);
    assert.equal((await intent(afterId)).state, 'outcome_unknown');
    const settled = await until(afterId, ['failed', 'succeeded']);
    assert.equal(settled.state, 'succeeded');
    assert.equal((await reservation(afterId))!.state, 'settled');
    assert.equal(submissionsFor(settled.effect_correlation_key), 1);
  });

  await t.test('a worker that lost its lease cannot record an outcome; the sweep and a lookup finish the action', async () => {
    const { action } = await propose('20000');
    const id = (action as { intentId: string }).intentId;
    const [job] = await inTransaction(runtime.pool, (trx) => jobs.lease(trx, ['assistant.dispatch'], 'slow-worker', 1, 1));
    const target = await inTransaction(runtime.pool, (trx) => assistantWorker.beginAttempt(trx, id, job!.id, null, job!.fencing_token)) as { status: 'dispatch'; attemptId: string; correlationKey: string; operationId: string; attemptNo: number; operation: string; payload: unknown; amount: null };
    await providers.orders.submit({ ...target }, new AbortController().signal);
    await waitFor(async () => (await h.db.admin.query("SELECT 1 FROM trustwork.job WHERE id = $1 AND leased_until < now()", [job!.id])).rowCount === 1, 15_000, 'lease expiry');
    await expireTask.run();
    await inTransaction(runtime.pool, (trx) => fails(assistantWorker.recordOutcome(trx, target.attemptId, { kind: 'final', result: 'succeeded', providerReference: 'late', evidence: 'late result' }), 'assistant.fenced_out'));
    assert.equal((await sweep.run()).parked, 1);
    assert.equal((await until(id, ['succeeded', 'failed'])).state, 'succeeded');
  });

  await t.test('concurrent dispatchers produce one attempt; concurrent approvals produce one approval', async () => {
    const { action } = await propose('15000');
    const id = (action as { intentId: string }).intentId;
    await h.db.admin.query("INSERT INTO trustwork.job (kind, payload) VALUES ('assistant.dispatch', $1::jsonb)", [JSON.stringify({ intentId: id })]);
    const leased = await inTransaction(runtime.pool, (trx) => jobs.lease(trx, ['assistant.dispatch'], 'racer', 30, 5));
    assert.equal(leased.filter((j) => (j.payload as { intentId: string }).intentId === id).length, 2);
    const results = await Promise.all(leased.map((j) => inTransaction(j === leased[0] ? runtime.pool : runtimeB.pool, (trx) => assistantWorker.beginAttempt(trx, id, j.id, null, j.fencing_token))));
    assert.deepEqual(results.map((r) => r.status).sort(), ['dispatch', 'skip']);
    const attempts = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.action_attempt WHERE action_intent_id = $1', [id]);
    assert.equal(attempts.rows[0]!.n, 1);
    const winner = results.find((r) => r.status === 'dispatch') as { attemptId: string };
    await inTransaction(runtime.pool, (trx) => assistantWorker.recordOutcome(trx, winner.attemptId, { kind: 'final', result: 'succeeded', providerReference: 'race-1', evidence: 'synthetic' }));
    for (const j of leased) await inTransaction(runtime.pool, (trx) => jobs.complete(trx, j.id, j.fencing_token));

    const asked = await propose('300000');
    const askedId = (asked.action as { intentId: string }).intentId;
    const decision = ok<{ decisions: IntentView[] }>(await petrApi.get('/v1/assistant/decisions')).decisions.find((d) => d.id === askedId)!;
    const [a, b] = await Promise.all([1, 2].map(() => petrApi.post(`/v1/assistant/decisions/${askedId}/approve`, { digest: decision.actionDigest })));
    assert.deepEqual([a!.status, b!.status].sort(), [200, 409]);
    const approvals = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.approval WHERE action_intent_id = $1', [askedId]);
    assert.equal(approvals.rows[0]!.n, 1);
    await drain(workerA);
    assert.equal((await intent(askedId)).state, 'succeeded');
  });

  await t.test('private constraints never reach a provider or a worker', async () => {
    const leaky = await propose('10000', { supplier: 'Demo Paving Supply', terms: { floorPrice: usd('9000') } });
    assert.deepEqual(leaky.action, { state: 'denied', reason: 'private_field' });
    const { action } = await propose('10000');
    const id = (action as { intentId: string }).intentId;
    const [job] = await inTransaction(runtime.pool, (trx) => jobs.lease(trx, ['assistant.dispatch'], 'inspector', 30, 1));
    const target = await inTransaction(runtime.pool, (trx) => assistantWorker.beginAttempt(trx, id, job!.id, null, job!.fencing_token));
    assert.deepEqual(Object.keys(target).sort(), ['amount', 'attemptId', 'attemptNo', 'correlationKey', 'operation', 'operationId', 'payload', 'provider', 'status']);
    const text = JSON.stringify([target, providers.orders.submissions]);
    for (const forbidden of ['floorPrice', 'ceiling', 'budget', 'privateConstraint', 'conditions', 'approvalPolicy', budget]) assert.ok(!text.includes(forbidden), `${forbidden} never leaves the API`);
    await inTransaction(runtime.pool, (trx) => assistantWorker.recordOutcome(trx, (target as { attemptId: string }).attemptId, { kind: 'final', result: 'succeeded', providerReference: 'inspect-1', evidence: 'synthetic' }));
    await inTransaction(runtime.pool, (trx) => jobs.complete(trx, job!.id, job!.fencing_token));
  });

  await t.test('cancellation, expiry, revocation and the stop control stop queued actions before any call', async () => {
    const effects = () => providers.orders.effects;
    // Cancel the run.
    const cancelled = await propose('11000');
    const cancelledId = (cancelled.action as { intentId: string }).intentId;
    ok(await petrApi.post(`/v1/assistant/runs/${cancelled.run.id}/cancel`, { reason: 'changed my mind' }));
    const beforeCancel = effects();
    await drain(workerA);
    assert.equal((await intent(cancelledId)).state, 'revoked');
    assert.equal((await reservation(cancelledId))!.state, 'released');
    assert.equal(effects(), beforeCancel, 'nothing was called');
    // A mandate that expires while the action waits in the queue: the dispatch recheck refuses.
    mandate = ok<MandateView>(await petrApi.post(`/v1/assistant/mandates/${mandate.id}/confirm`, { expectedRevision: mandate.revision, draft: mandateDraft(new Date(Date.now() + 2500).toISOString()) }));
    const expiring = await propose('12000');
    const expiringId = (expiring.action as { intentId: string }).intentId;
    assert.equal(expiring.action.state, 'queued');
    await sleep(3000);
    await drain(workerA);
    const expired = await h.db.admin.query<{ state: string; state_reason: string }>('SELECT state, state_reason FROM trustwork.action_intent WHERE id = $1', [expiringId]);
    assert.deepEqual(expired.rows[0], { state: 'revoked', state_reason: 'recheck: mandate_expired' });
    assert.equal((await reservation(expiringId))!.state, 'released');
    // Revocation and the stop control revoke queued actions in the same transaction.
    mandate = ok<MandateView>(await petrApi.post(`/v1/assistant/mandates/${mandate.id}/confirm`, { expectedRevision: mandate.revision, draft: mandateDraft() }));
    const stopped = await propose('13000');
    ok(await petrApi.post('/v1/assistant/stop'));
    assert.equal((await intent((stopped.action as { intentId: string }).intentId)).state, 'revoked');
    ok(await petrApi.post('/v1/assistant/stop/release'));
    mandate = ok<MandateView>(await petrApi.get(`/v1/assistant/mandates/${mandate.id}`));
    mandate = ok<MandateView>(await petrApi.post(`/v1/assistant/mandates/${mandate.id}/confirm`, { expectedRevision: mandate.revision, draft: mandateDraft() }));
    const revoked = await propose('14000');
    ok(await petrApi.post(`/v1/assistant/mandates/${mandate.id}/revoke`, { expectedRevision: mandate.revision, reason: 'project finished' }));
    const revokedId = (revoked.action as { intentId: string }).intentId;
    assert.equal((await intent(revokedId)).state, 'revoked');
    const beforeDrain = effects();
    await drain(workerA);
    assert.equal(effects(), beforeDrain);
    assert.equal((await propose('1000')).action.state, 'denied', 'a revoked mandate authorizes nothing');
  });
});
