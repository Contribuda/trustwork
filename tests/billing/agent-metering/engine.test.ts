import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { createPool, withMaintenance, withPrincipal } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { durableWorld, syntheticGovernance } from '../../models/durable-helpers.js';
import { PostgresModelCallStore } from '../../../apps/api/src/modules/models/postgres-store.js';
import { KeysRouteResolver } from '../../../apps/api/src/modules/models/keys-route-resolver.js';
import { RuntimeModelAuthority } from '../../../apps/api/src/modules/models/runtime-authority.js';
import { ModelGateway, reconcileModelOperation } from '../../../apps/api/src/modules/models/gateway.js';
import { FakeModelRegistry, ModelRefusal, type ModelAdapter, type ModelAdapterResult } from '../../../apps/api/src/modules/models/ports.js';
import { actionIntents, runs } from '../../../packages/data/src/repositories/assistant.js';
import { billingAccounts, budgets, catalogue, priceAcceptances } from '../../../packages/data/src/repositories/billing.js';
import { actionQuotaStop, agentStatistics, meteredSteps } from '../../../packages/data/src/repositories/agent-usage.js';
import type { MeteredStepInput } from '../../../packages/contracts/src/agent-metering.js';

/** Tokens the fake adapter reports; a real provider's receipt carries the same two numbers. */
class TokenModel implements ModelAdapter {
  readonly mode = 'fake' as const;
  next: ModelAdapterResult = { kind: 'succeeded', text: 'Synthetic response.', costMinorUnits: '0', inputTokens: 6, outputTokens: 4 };
  lookup: ModelAdapterResult = { kind: 'unknown' };
  calls = 0;
  async invoke(): Promise<ModelAdapterResult> { this.calls += 1; return this.next; }
  async reconcile(): Promise<ModelAdapterResult> { return this.lookup; }
}

const db = await provisionTestDatabase('agent_metering_engine');
test('AGT-004 metered steps on the real model and action paths, under the runtime role', { skip: db ? false : SKIP_REASON, timeout: 300_000 }, async (t) => {
  if (!db) return;
  const w = await durableWorld(db, { runsPerDay: 1000, actionsPerDay: 1000, concurrentRuns: 500 });
  t.after(async () => { await w.pool.end(); await db.close(); });
  const person = w.personId;
  const other = w.world.people.outsider;
  const as = <T>(fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(w.pool, w.principal, fn);
  const admin = <T>(fn: Parameters<typeof withMaintenance<T>>[1]) => withMaintenance(db.admin, fn);

  /** The synthetic module declares its meters and a hub-level free floor, as a shipped manifest does. */
  const quota = async (units: Record<string, string>) => admin(async (trx) => {
    // Test setup only: the manifest is append-only, and each case here needs a different floor for the synthetic module.
    await sql`ALTER TABLE trustwork.agent_engine_manifest DISABLE TRIGGER USER`.execute(trx);
    await sql`UPDATE trustwork.agent_engine_manifest SET document = document
      || jsonb_build_object('meters', '["model_tokens","agent_actions","checks"]'::jsonb, 'freeFloor', ${JSON.stringify(Object.entries(units).map(([meter, u]) => ({ meter, units: u, window: 'month' })))}::jsonb,
        'capabilities', (SELECT jsonb_agg(c || '{"meters":["model_tokens","agent_actions","checks"]}'::jsonb) FROM jsonb_array_elements(document -> 'capabilities') c))
      WHERE module_key = 'research'`.execute(trx);
    await sql`ALTER TABLE trustwork.agent_engine_manifest ENABLE TRIGGER USER`.execute(trx);
  });
  /** Clean slate for one case: a fresh window state, without touching any append-only record. */
  const resetWindows = () => admin((trx) => sql`UPDATE trustwork.agent_quota_window SET used_units = 0, held_units = 0`.execute(trx));
  const windows = () => admin((trx) => trx.selectFrom('agent_quota_window').selectAll().where('principal_person_id', '=', person).execute());
  const stepOf = (ref: string) => admin((trx) => trx.selectFrom('metered_step').selectAll().where('source_ref', '=', ref).executeTakeFirst());
  const usageOf = (runId: string) => admin((trx) => trx.selectFrom('usage_record').selectAll().where('run_id', '=', runId).execute());
  const balance = (id: string) => as((trx) => budgets.balance(trx, id));

  /** Publishes a synthetic price with a real second person; the rate is a test value, not a product price. */
  const publish = async (subject: { kind: string; key: string; direction?: 'input' | 'output'; meter: string }, sale: string, accept = true, currency = 'USD', hubId = w.hubId) => {
    const { officer, owner } = w.world.people;
    const code = 'metered_' + randomUUID().replaceAll('-', '').slice(0, 20);
    const version = await admin(async (trx) => {
      const offer = await catalogue.createOffer(trx, { hubId, code, name: subject.key, kind: 'agent_metered', createdBy: owner, status: 'active' });
      const s = await trx.insertInto('metered_subject').values({ hub_id: hubId, offer_id: offer.id, kind: subject.kind as 'module', subject_key: subject.key, direction: subject.direction ?? null, meter: subject.meter as 'checks',
        unit: subject.meter === 'model_tokens' ? 'thousand_tokens' : 'action' }).returningAll().executeTakeFirstOrThrow();
      const cost = await trx.insertInto('metered_cost_record').values({ subject_id: s.id, version: 1, currency, cost_micro: '500000', basis: 'measured_average', observed_at: new Date(), recorded_by: owner }).returning('id').executeTakeFirstOrThrow();
      const price = await catalogue.draftPriceVersion(trx, { offerId: offer.id, amountMinor: sale.replace('0.', ''), currency, effectiveFrom: new Date(Date.now() + 300), acceptanceTextVersion: 'synthetic-1', draftedBy: owner });
      await trx.insertInto('metered_price_term').values({ price_version_id: price.id, subject_id: s.id, sale_micro: micro(sale), per_units: sale.includes('.') ? '10' : '1', basis: 'flat', markup_percent: null, cost_micro: '500000', cost_basis: 'measured_average', model_pricing_id: null, cost_record_id: cost.id }).execute();
      return catalogue.activatePriceVersion(trx, price.id, officer);
    });
    await delay(350);
    if (accept) await as(async (trx) => {
      const account = await billingAccounts.findActive(trx, { kind: 'person', id: person }, w.hubId, 'USD') ?? await billingAccounts.open(trx, { hubId: w.hubId, owner: { kind: 'person', id: person }, currency: 'USD', createdBy: person });
      await priceAcceptances.accept(trx, { priceVersionId: version.id, billingAccountId: account.id, payer: { kind: 'person', id: person }, acceptedBy: person, amountMinor: version.amount_minor, currency: 'USD', acceptanceTextVersion: 'synthetic-1' });
    });
    return version;
  };
  /** A decimal test rate as millionths of a minor unit. */
  const micro = (sale: string) => { const [whole = '0', frac = ''] = sale.split('.'); return (BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, '0'))).toString(); };

  const adapter = new TokenModel();
  const registry = new FakeModelRegistry();
  registry.register(w.connection.id, adapter);
  registry.register(w.secondary.id, adapter);
  const store = new PostgresModelCallStore(w.pool, w.principal, w.binding, 1);
  const gateway = () => new ModelGateway(new KeysRouteResolver(w.pool), new RuntimeModelAuthority(w.pool, w.principal, w.binding, syntheticGovernance), store, registry);
  const budgetId = await w.budget('1000');
  const mandate = await w.mandate(budgetId, '1000');
  const mandateId = (mandate as { id: string }).id;

  await t.test('a meter nobody limits or prices is recorded and free', async () => {
    await quota({});
    const call = await w.call(mandateId, '0');
    const result = await gateway().call(call);
    assert.equal(result.outcome, 'succeeded');
    const [usage] = await usageOf(call.runId);
    assert.equal(usage?.units, '10');
    assert.equal(usage?.within_included_quota, true);
    assert.equal((await stepOf(call.operationId))?.charged_minor, '0');
    assert.equal((await balance(budgetId))?.consumedMinor, '0');
  });

  await t.test('within the quota nothing is reserved and the window counts actual units', async () => {
    await quota({ model_tokens: '100' });
    const call = await w.call(mandateId, '0');
    await gateway().call(call);
    const step = await stepOf(call.operationId);
    assert.equal(step?.state, 'succeeded');
    assert.equal(step?.reservation_id, null);
    assert.equal(step?.estimated_units, '30', 'the estimate is the call limit, held until the outcome');
    const [window] = await windows();
    assert.equal(window?.used_units, '10');
    assert.equal(window?.held_units, '0');
  });

  await t.test('replaying a model call never charges or counts twice', async () => {
    const call = await w.call(mandateId, '0');
    await gateway().call(call);
    const before = await windows();
    const calls = adapter.calls;
    await gateway().call(call);
    assert.equal(adapter.calls, calls, 'a duplicate never dispatches');
    assert.deepEqual((await windows()).map((x) => x.used_units), before.map((x) => x.used_units));
    assert.equal((await usageOf(call.runId)).length, 1);
  });

  await t.test('without a price the job stops at its quota: no dispatch, no mandate use, no hold', async () => {
    await quota({ model_tokens: '35' });
    await resetWindows();
    const first = await w.call(mandateId, '0');
    await gateway().call(first);
    const calls = adapter.calls;
    const second = await w.call(mandateId, '0');
    await assert.rejects(gateway().call(second), (e: unknown) => e instanceof ModelRefusal && e.reason === 'quota_reached');
    assert.equal(adapter.calls, calls);
    assert.equal(await stepOf(second.operationId), undefined, 'the refusal rolled the whole admission back');
    const row = await admin((trx) => trx.selectFrom('model_call').select('operation_id').where('operation_id', '=', second.operationId).executeTakeFirst());
    assert.equal(row, undefined);
    assert.equal((await balance(budgetId))?.heldMinor, '0');
  });

  await t.test('a published price the payer has not accepted is a question, not a charge', async () => {
    await publish({ kind: 'capability', key: 'research.draft', meter: 'model_tokens' }, '2', false);
    const call = await w.call(mandateId, '0');
    await assert.rejects(gateway().call(call), (e: unknown) => e instanceof ModelRefusal && e.reason === 'quota_reached');
    const quote = await as((trx) => meteredSteps.estimate(trx, { hubId: w.hubId, principal: { kind: 'person', id: person }, moduleKey: 'research', capabilityId: 'research.draft', meter: 'model_tokens', estimatedUnits: 30, budgetId }));
    assert.equal(quote.stop, 'price_not_accepted');
  });

  await t.test('beyond the quota a named budget reserves the estimate and settles on actuals', async () => {
    await publish({ kind: 'model', key: 'synthetic-model', direction: 'input', meter: 'model_tokens' }, '1000');
    await publish({ kind: 'model', key: 'synthetic-model', direction: 'output', meter: 'model_tokens' }, '3000');
    await quota({ model_tokens: '10' });
    await resetWindows();
    const before = await balance(budgetId);
    const call = await w.call(mandateId, '0');
    await gateway().call(call);
    const step = await stepOf(call.operationId);
    assert.equal(step?.state, 'succeeded');
    assert.equal(step?.within_units, '10');
    assert.equal(step?.beyond_units, '20');
    // Estimate: (20 * 1000 + 10 * 3000) / 1000 = 50 minor units for all 30 units, 20/30 of it beyond the quota.
    assert.equal(step?.estimate_minor, '34');
    // Actual: 10 tokens, all inside the quota: nothing is charged and the reservation is released.
    assert.equal(step?.charged_minor, '0');
    assert.equal((await balance(budgetId))?.consumedMinor, before?.consumedMinor);
    assert.equal((await balance(budgetId))?.heldMinor, '0');
    const paid = await w.call(mandateId, '0');
    await gateway().call(paid);
    const charged = await stepOf(paid.operationId);
    // The window is full: 10 tokens (6 in, 4 out) cost (6 * 1000 + 4 * 3000) / 1000 = 18 minor units.
    assert.equal(charged?.charged_minor, '18');
    const [usage] = await usageOf(paid.runId);
    assert.equal(usage?.within_included_quota, false);
    assert.ok(usage?.price_version_id && usage.reservation_id);
    assert.equal(BigInt((await balance(budgetId))!.consumedMinor) - BigInt(before!.consumedMinor), 18n);
  });

  await t.test('an unknown outcome keeps its hold, charges nothing and reconciles exactly once', async () => {
    await resetWindows();
    await admin((trx) => sql`UPDATE trustwork.agent_quota_window SET used_units = limit_units`.execute(trx));
    const before = await balance(budgetId);
    adapter.next = { kind: 'unknown' };
    const call = await w.call(mandateId, '0');
    const result = await gateway().call(call);
    assert.equal(result.outcome, 'outcome_unknown');
    const open = await stepOf(call.operationId);
    assert.equal(open?.state, 'admitted');
    assert.equal(open?.charged_minor, '0');
    assert.equal(BigInt((await balance(budgetId))!.heldMinor), BigInt(open!.estimate_minor), 'the hold stays');
    assert.equal((await usageOf(call.runId)).length, 0);
    adapter.lookup = { kind: 'succeeded', text: 'Synthetic response.', costMinorUnits: '0', inputTokens: 6, outputTokens: 4 };
    await reconcileModelOperation(store, registry, call.operationId, person);
    await reconcileModelOperation(store, registry, call.operationId, person);
    const closed = await stepOf(call.operationId);
    assert.equal(closed?.state, 'succeeded');
    assert.equal(closed?.charged_minor, '18');
    assert.equal((await usageOf(call.runId)).length, 1);
    assert.equal(BigInt((await balance(budgetId))!.consumedMinor) - BigInt(before!.consumedMinor), 18n);
    assert.equal((await balance(budgetId))?.heldMinor, '0');
    adapter.next = { kind: 'succeeded', text: 'Synthetic response.', costMinorUnits: '0', inputTokens: 6, outputTokens: 4 };
  });

  await t.test('a priced call cannot also carry a platform estimate', async () => {
    const call = await w.call(mandateId, '5');
    await assert.rejects(gateway().call(call), (e: { hint?: string }) => e.hint === 'billing.priced_twice');
  });

  let checksPrice: Awaited<ReturnType<typeof publish>>;
  const newRun = () => as((trx) => runs.start(trx, { principal_person_id: person, mandate_id: mandateId, kind: 'conversation' }));
  const direct = (runId: string, over: Partial<MeteredStepInput> = {}): MeteredStepInput => ({
    hubId: w.hubId, principal: { kind: 'person', id: person }, moduleKey: 'research', capabilityId: 'research.draft', runId, runStepId: randomUUID(), attemptId: randomUUID(), connectionId: null,
    meter: 'checks', providerClass: null, estimatedUnits: 2, budgetId, projectId: null, ...over,
  });

  await t.test('a direct step is idempotent per step, attempt and meter, and one step is charged once', async () => {
    checksPrice = await publish({ kind: 'meter', key: 'checks', meter: 'checks' }, '7');
    await quota({ checks: '0' });
    const run = await newRun();
    const input = direct(run.id);
    const first = await as((trx) => meteredSteps.admit(trx, input));
    assert.equal(first.decision, 'admitted');
    assert.equal((await as((trx) => meteredSteps.admit(trx, input))).replayed, true);
    await assert.rejects(as((trx) => meteredSteps.admit(trx, { ...input, estimatedUnits: 3 })), (e: { hint?: string }) => e.hint === 'validation.idempotency_conflict');
    await assert.rejects(as((trx) => meteredSteps.admit(trx, { ...input, attemptId: randomUUID() })), (e: { hint?: string }) => e.hint === 'billing.attempt_open');
    assert.ok(first.decision === 'admitted');
    const done = await as((trx) => meteredSteps.finish(trx, first.stepId, 'succeeded', 2, 'synthetic:check'));
    assert.ok(done.decision === 'closed');
    assert.equal(done.chargedMinor, '14');
    const replay = await as((trx) => meteredSteps.finish(trx, first.stepId, 'succeeded', 2, 'synthetic:check'));
    assert.equal(replay.replayed, true);
    const again = await as((trx) => meteredSteps.admit(trx, { ...input, attemptId: randomUUID() }));
    assert.equal(again.decision, 'already_charged', 'a later attempt id never opens a second charge');
    await assert.rejects(as((trx) => meteredSteps.finish(trx, first.stepId, 'failed', null, 'synthetic:check')), (e: { hint?: string }) => e.hint === 'billing.step_closed');
    assert.equal((await usageOf(run.id)).length, 1);
  });

  await t.test('usage above the estimate is recorded, never charged beyond the reservation', async () => {
    const run = await newRun();
    const step = await as((trx) => meteredSteps.admit(trx, direct(run.id)));
    assert.ok(step.decision === 'admitted');
    const done = await as((trx) => meteredSteps.finish(trx, step.stepId, 'succeeded', 9, 'synthetic:overrun'));
    assert.ok(done.decision === 'closed');
    assert.equal(done.chargedMinor, '14', 'capped at the reservation: no surprise overage');
    const row = await admin((trx) => trx.selectFrom('metered_step').selectAll().where('id', '=', step.stepId).executeTakeFirstOrThrow());
    assert.equal(row.actual_units, '9');
    assert.equal(row.overrun_units, '9');
  });

  await t.test('a failed step releases everything and charges nothing', async () => {
    const run = await newRun();
    const before = await balance(budgetId);
    const step = await as((trx) => meteredSteps.admit(trx, direct(run.id)));
    assert.ok(step.decision === 'admitted');
    await as((trx) => meteredSteps.finish(trx, step.stepId, 'failed', null, 'synthetic:failed'));
    assert.deepEqual(await balance(budgetId), before);
    assert.equal((await usageOf(run.id)).length, 0);
  });

  await t.test('without a platform budget a job stops at its quota and asks; it never runs into debt', async () => {
    const run = await newRun();
    const stopped = await as((trx) => meteredSteps.admit(trx, direct(run.id, { budgetId: null })));
    assert.ok(stopped.decision === 'stopped');
    assert.equal(stopped.reason, 'no_budget');
    assert.equal(stopped.estimateMinor, '14', 'the person sees what continuing would cost');
    const small = await w.budget('5');
    const short = await as((trx) => meteredSteps.admit(trx, direct(run.id, { budgetId: small })));
    assert.ok(short.decision === 'stopped');
    assert.equal(short.reason, 'budget_insufficient');
    assert.equal((await usageOf(run.id)).length, 0);
  });

  await t.test('the last included units go to exactly the steps that fit, across concurrent admissions', async () => {
    await quota({ checks: '5' });
    await resetWindows();
    const run = await newRun();
    const inputs = Array.from({ length: 12 }, () => direct(run.id, { estimatedUnits: 1, budgetId: null }));
    const decisions = await Promise.all(inputs.map((input) => as((trx) => meteredSteps.admit(trx, input))));
    assert.equal(decisions.filter((d) => d.decision === 'admitted').length, 5);
    assert.equal(decisions.filter((d) => d.decision === 'stopped').length, 7);
    const window = (await windows()).find((x) => x.meter === 'checks');
    assert.equal(window?.held_units, '5');
    for (const d of decisions) if (d.decision === 'admitted') await as((trx) => meteredSteps.finish(trx, d.stepId, 'failed', null, 'synthetic:race'));
  });

  await t.test('concurrent replays of one step and meter produce one record and one charge', async () => {
    await quota({ checks: '0' });
    const run = await newRun();
    const input = direct(run.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => as((trx) => meteredSteps.admit(trx, input))));
    const ids = new Set(results.map((r) => (r.decision === 'admitted' ? r.stepId : 'stopped')));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    const id = [...ids][0]!;
    const closes = await Promise.all(Array.from({ length: 6 }, () => as((trx) => meteredSteps.finish(trx, id, 'succeeded', 2, 'synthetic:replay'))));
    assert.equal(closes.filter((r) => !r.replayed).length, 1);
    const [usage, ...rest] = await usageOf(run.id);
    assert.equal(rest.length, 0);
    assert.equal(usage?.units, '2');
    assert.equal((await admin((trx) => trx.selectFrom('metered_step').select('charged_minor').where('id', '=', id).executeTakeFirstOrThrow())).charged_minor, '14');
  });

  await t.test('the budget is never overspent by concurrent paid steps', async () => {
    const tight = await w.budget('30');
    const run = await newRun();
    const decisions = await Promise.all(Array.from({ length: 8 }, () => as((trx) => meteredSteps.admit(trx, direct(run.id, { budgetId: tight })))));
    assert.equal(decisions.filter((d) => d.decision === 'admitted').length, 2, '14 minor units each out of 30');
    assert.equal((await balance(tight))?.heldMinor, '28');
  });

  await t.test('nobody meters, closes or reads another person\'s step', async () => {
    const run = await newRun();
    const mine = await as((trx) => meteredSteps.admit(trx, direct(run.id)));
    assert.ok(mine.decision === 'admitted');
    const stranger = await (await import('../../data/helpers/seed.js')).principalFor(db.admin, other);
    const asOther = <T>(fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(w.pool, stranger, fn);
    const denied = (e: { hint?: string }) => e.hint === 'access.not_found';
    await assert.rejects(asOther((trx) => meteredSteps.admit(trx, direct(run.id))), denied);
    await assert.rejects(asOther((trx) => meteredSteps.admit(trx, direct(run.id, { principal: { kind: 'person', id: other } }))), denied, 'a run of someone else is unknown');
    await assert.rejects(asOther((trx) => meteredSteps.finish(trx, mine.stepId, 'succeeded', 1, 'synthetic:theft')), denied);
    await assert.rejects(asOther((trx) => meteredSteps.estimate(trx, { hubId: w.hubId, principal: { kind: 'person', id: person }, moduleKey: 'research', capabilityId: null, meter: 'checks', estimatedUnits: 1, budgetId: null })), denied);
    assert.deepEqual(await asOther((trx) => trx.selectFrom('metered_step').selectAll().execute()), []);
    assert.deepEqual(await asOther((trx) => trx.selectFrom('agent_quota_window').selectAll().execute()), []);
    await assert.rejects(as((trx) => sql`INSERT INTO trustwork.usage_record (principal_person_id, billing_account_id, module_key, run_id, run_step_id, attempt_id, meter, units, within_included_quota)
      SELECT ${person}::uuid, id, 'research', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'checks', 1, true FROM trustwork.billing_account LIMIT 1`.execute(trx)), /permission denied/);
    await assert.rejects(as((trx) => sql`SELECT trustwork.billing_meter_admit_core('{}'::jsonb)`.execute(trx)), /permission denied/);
    await assert.rejects(as((trx) => sql`SELECT trustwork.billing_meter_finish_core(${mine.stepId}::uuid, 'succeeded', 1, NULL, NULL, 'x')`.execute(trx)), /permission denied/);
  });

  await t.test('a lost lease makes a step unknown and keeps its holds', async () => {
    const run = await newRun();
    const step = await as((trx) => meteredSteps.admit(trx, direct(run.id)));
    assert.ok(step.decision === 'admitted');
    const held = (await balance(budgetId))!.heldMinor;
    const worker = createPool({ ...db.appConfig, max: 1 });
    t.after(() => worker.end());
    const swept = await admin(async (trx) => (await sql<{ n: number }>`SELECT trustwork.billing_meter_sweep(interval '0 seconds', 1000) AS n`.execute(trx)).rows[0]!.n);
    assert.ok(swept >= 1);
    const row = await admin((trx) => trx.selectFrom('metered_step').selectAll().where('id', '=', step.stepId).executeTakeFirstOrThrow());
    assert.equal(row.state, 'outcome_unknown');
    assert.equal((await balance(budgetId))!.heldMinor, held);
    const done = await as((trx) => meteredSteps.finish(trx, step.stepId, 'succeeded', 2, 'synthetic:late'));
    assert.ok(done.decision === 'closed');
    assert.equal(done.chargedMinor, '14');
  });

  const intent = async (runId: string) => {
    const digest = computeDigest({ synthetic: randomUUID() }).value;
    const recorded = await as((trx) => actionIntents.record(trx, {
      runId, mandateId, mandateRevision: 1, capabilityId: 'research.draft', moduleKey: 'research', action: 'research', context: { kind: 'profile', id: person }, resolvedFromSelector: false, amount: null, digest,
      effect: { provider: 'synthetic', operation: 'research', payload: { synthetic: true } }, decision: 'allow', askReasons: [],
    }));
    return recorded.intentId!;
  };
  const boundRun = async () => {
    const call = await w.call(mandateId, '0');
    return call.runId;
  };
  const moveTo = (id: string, states: string[]) => admin(async (trx) => { for (const state of states) await sql`UPDATE trustwork.action_intent SET state = ${state} WHERE id = ${id}::uuid`.execute(trx); });
  const finish = (id: string, state: 'succeeded' | 'failed') => admin((trx) => sql`SELECT trustwork.assistant_finish_intent(${id}::uuid, ${state}, 'synthetic', 'synthetic evidence')`.execute(trx));

  await t.test('agent actions count on final success only; unknown is charged only if reconciliation succeeds', async () => {
    await publish({ kind: 'module', key: 'research', meter: 'agent_actions' }, '3');
    await quota({ agent_actions: '0' });
    const ok = await intent(await boundRun());
    await as((trx) => actionIntents.queue(trx, ok, 300, null));
    assert.equal((await stepOf(ok))?.state, 'admitted');
    await moveTo(ok, ['executing']);
    await finish(ok, 'succeeded');
    assert.equal((await stepOf(ok))?.charged_minor, '3');
    const failed = await intent(await boundRun());
    await as((trx) => actionIntents.queue(trx, failed, 300, null));
    await moveTo(failed, ['executing']);
    await finish(failed, 'failed');
    assert.equal((await stepOf(failed))?.state, 'failed');
    assert.equal((await stepOf(failed))?.charged_minor, '0');
    const lost = await intent(await boundRun());
    await as((trx) => actionIntents.queue(trx, lost, 300, null));
    await moveTo(lost, ['executing', 'outcome_unknown']);
    assert.equal((await stepOf(lost))?.state, 'outcome_unknown');
    assert.equal((await stepOf(lost))?.charged_minor, '0');
    await moveTo(lost, ['reconciling']);
    await finish(lost, 'succeeded');
    assert.equal((await stepOf(lost))?.state, 'succeeded');
    assert.equal((await stepOf(lost))?.charged_minor, '3');
    const gone = await intent(await boundRun());
    await as((trx) => actionIntents.queue(trx, gone, 300, null));
    await moveTo(gone, ['executing', 'outcome_unknown', 'reconciling']);
    await finish(gone, 'failed');
    assert.equal((await stepOf(gone))?.state, 'failed');
    assert.equal((await stepOf(gone))?.charged_minor, '0');
  });

  await t.test('the sweep never parks a healthy action: a step follows its source', async () => {
    const pending = await intent(await boundRun());
    await as((trx) => actionIntents.queue(trx, pending, 300, null));
    await moveTo(pending, ['executing', 'pending']);
    await admin((trx) => sql`SELECT trustwork.billing_meter_sweep(interval '0 seconds', 1000)`.execute(trx));
    assert.equal((await stepOf(pending))?.state, 'admitted', 'a pending action is healthy, however long it takes');
    await finish(pending, 'succeeded');
    assert.equal((await stepOf(pending))?.state, 'succeeded');
  });

  await t.test('an action past its quota without a way to pay is refused at the queue, and nothing is reserved', async () => {
    const noBudget = await w.budget('1');
    const poor = await w.mandate(noBudget, '1000');
    const call = await w.call((poor as { id: string }).id, '0');
    const digest = computeDigest({ synthetic: randomUUID() }).value;
    const recorded = await as((trx) => actionIntents.record(trx, {
      runId: call.runId, mandateId: (poor as { id: string }).id, mandateRevision: 1, capabilityId: 'research.draft', moduleKey: 'research', action: 'research', context: { kind: 'profile', id: person }, resolvedFromSelector: false, amount: null, digest,
      effect: { provider: 'synthetic', operation: 'research', payload: { synthetic: true } }, decision: 'allow', askReasons: [],
    }));
    await assert.rejects(as((trx) => actionIntents.queue(trx, recorded.intentId!, 300, null)), (e: { hint?: string }) => e.hint === 'billing.quota_reached');
    assert.equal(await stepOf(recorded.intentId!), undefined);
  });

  await t.test('a hub with no currency still runs a free step under its allowance, and bills nothing', async () => {
    await quota({ checks: '3' });
    const bareHub = await admin(async (trx) => (await trx.insertInto('hub').values({ slug: `synthetic-bare-${randomUUID().slice(0, 8)}`, lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow()).id);
    const run = await newRun();
    const accounts = () => admin((trx) => trx.selectFrom('billing_account').select('id').where('hub_id', '=', bareHub).execute());
    const free = await as((trx) => meteredSteps.admit(trx, direct(run.id, { hubId: bareHub, estimatedUnits: 2, budgetId: null })));
    assert.ok(free.decision === 'admitted', JSON.stringify(free));
    assert.equal(free.currency, null);
    const done = await as((trx) => meteredSteps.finish(trx, free.stepId, 'succeeded', 2, 'synthetic:bare'));
    assert.ok(done.decision === 'closed');
    assert.equal(done.chargedMinor, '0');
    assert.equal((await as((trx) => meteredSteps.finish(trx, free.stepId, 'succeeded', 2, 'synthetic:bare'))).replayed, true);
    assert.deepEqual(await accounts(), [], 'no billing identity is invented');
    assert.equal((await usageOf(run.id)).length, 0);
    const window = await admin((trx) => trx.selectFrom('agent_quota_window').selectAll().where('hub_id', '=', bareHub).where('meter', '=', 'checks').executeTakeFirstOrThrow());
    assert.equal(window.used_units, '2', 'the allowance is still enforced');
    const over = await as((trx) => meteredSteps.admit(trx, direct(run.id, { hubId: bareHub, estimatedUnits: 2, budgetId })));
    assert.ok(over.decision === 'stopped');
    assert.equal(over.reason, 'no_price', 'past the free allowance it stops: nothing here can pay');
  });

  await t.test('a price that cannot be verified stops the step and never makes it free', async () => {
    await quota({});
    const run = await newRun();
    const free = await as((trx) => meteredSteps.admit(trx, direct(run.id, { meter: 'deliverables', budgetId })));
    assert.equal(free.decision, 'admitted', 'before any price this meter is free');
    await publish({ kind: 'module', key: 'research', meter: 'deliverables' }, '5', false, 'EUR');
    const foreign = await as((trx) => meteredSteps.admit(trx, direct(run.id, { meter: 'deliverables', budgetId })));
    assert.ok(foreign.decision === 'stopped');
    assert.equal(foreign.reason, 'price_not_accepted', 'a price in another currency is not a free step');
    const bareHub = await admin(async (trx) => (await trx.insertInto('hub').values({ slug: `synthetic-priced-${randomUUID().slice(0, 8)}`, lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow()).id);
    await publish({ kind: 'module', key: 'research', meter: 'checks' }, '5', false, 'USD', bareHub);
    const unverifiable = await as((trx) => meteredSteps.admit(trx, direct(run.id, { hubId: bareHub, budgetId })));
    assert.ok(unverifiable.decision === 'stopped');
    assert.equal(unverifiable.reason, 'price_not_accepted', 'a hub with no currency cannot verify a published price');
  });

  await t.test('a mandate ceiling bounds metered spend, however large the budget', async () => {
    await quota({ checks: '0' });
    const rich = await w.budget('1000000');
    const capped = await w.mandate(rich, '20');
    const cappedId = (capped as { id: string }).id;
    const run = await as((trx) => runs.start(trx, { principal_person_id: person, mandate_id: cappedId, kind: 'conversation' }));
    const step = (units = 2) => as((trx) => meteredSteps.admit(trx, direct(run.id, { budgetId: rich, estimatedUnits: units })));
    const used = async () => (await admin((trx) => trx.selectFrom('mandate_use').select(['amount_minor']).where('mandate_id', '=', cappedId).where('voided_at', 'is', null).execute())).reduce((n, u) => n + BigInt(u.amount_minor ?? '0'), 0n);
    const first = await step();
    assert.ok(first.decision === 'admitted');
    assert.equal(await used(), 14n, 'an open step counts at its estimate');
    const second = await step();
    assert.ok(second.decision === 'stopped');
    assert.equal(second.reason, 'mandate_ceiling', '14 + 14 is past a ceiling of 20, with a budget of a million');
    await as((trx) => meteredSteps.finish(trx, first.stepId, 'succeeded', 1, 'synthetic:ceiling'));
    assert.equal(await used(), 7n, 'a closed step counts at what it settled');
    const refused = await step();
    assert.ok(refused.decision === 'stopped', '7 + 14 is still past 20');
    const third = await step(1);
    assert.ok(third.decision === 'admitted', 'the freed room is usable: 7 + 7 fits');
    await as((trx) => meteredSteps.finish(trx, third.stepId, 'failed', null, 'synthetic:ceiling'));
    assert.equal(await used(), 7n, 'a failed step gives its room back');
    const racers = await Promise.all(Array.from({ length: 6 }, () => step(1)));
    assert.equal(racers.filter((d) => d.decision === 'admitted').length, 1, 'with 7 used and 7 each, exactly one concurrent step fits under 20');
  });

  await t.test('metered rows never count as actions in the mandate window', async () => {
    const rows = await admin((trx) => trx.selectFrom('mandate_use').select(['action', 'metered_step_id']).where('metered_step_id', 'is not', null).execute());
    assert.ok(rows.length > 0);
    assert.ok(rows.every((u) => u.action.startsWith('metered:')));
  });

  await t.test('an action past its mandate ceiling is refused at the queue', async () => {
    await publish({ kind: 'capability', key: 'project_planner.share_item', meter: 'agent_actions' }, '4', false);
    await quota({ agent_actions: '0' });
    const rich = await w.budget('1000000');
    const capped = (await w.mandate(rich, '2')) as { id: string };
    const call = await w.call(capped.id, '0');
    const recorded = await as((trx) => actionIntents.record(trx, {
      runId: call.runId, mandateId: capped.id, mandateRevision: 1, capabilityId: 'research.draft', moduleKey: 'research', action: 'research', context: { kind: 'profile', id: person }, resolvedFromSelector: false, amount: null,
      digest: computeDigest({ synthetic: randomUUID() }).value, effect: { provider: 'synthetic', operation: 'research', payload: { synthetic: true } }, decision: 'allow', askReasons: [],
    }));
    await assert.rejects(as((trx) => actionIntents.queue(trx, recorded.intentId!, 300, null)), (e: { hint?: string; detail?: string }) => e.hint === 'billing.quota_reached' && e.detail === 'mandate_ceiling');
    assert.equal(await stepOf(recorded.intentId!), undefined);
  });

  await t.test('usage settles only on the principal\'s own budget, for a company as for a person', async () => {
    await quota({ checks: '0' });
    const company = await admin(async (trx) => {
      const id = (await trx.insertInto('company').values({ display_name: 'Synthetic Metering Builders LLC', claim_status: 'unclaimed' }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('membership').values({ person_id: other, company_id: id, role: 'administrator', permissions: ['company.members.manage', 'company.billing.manage', 'company.billing.view'], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
      return id;
    });
    const member = await (await import('../../data/helpers/seed.js')).principalFor(db.admin, other);
    const asMember = <T>(fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(w.pool, member, fn);
    const companyBudget = await asMember((trx) => budgets.grant(trx, { kind: 'platform', owner: 'company', projectId: null, employeePersonId: null, periodFrom: new Date(Date.now() - 60000), periodTo: new Date(Date.now() + 86400000), limitMinor: '100', currency: 'USD' }));
    const memberBudget = await asMember((trx) => budgets.grant(trx, { kind: 'platform', owner: 'person', projectId: null, employeePersonId: null, periodFrom: new Date(Date.now() - 60000), periodTo: new Date(Date.now() + 86400000), limitMinor: '100', currency: 'USD' }));
    await asMember(async (trx) => {
      for (const owner of [{ kind: 'company' as const, id: company }, { kind: 'person' as const, id: other }]) {
        const account = await billingAccounts.open(trx, { hubId: w.hubId, owner, currency: 'USD', createdBy: other });
        await priceAcceptances.accept(trx, { priceVersionId: checksPrice.id, billingAccountId: account.id, payer: owner, acceptedBy: other, amountMinor: checksPrice.amount_minor, currency: 'USD', acceptanceTextVersion: 'synthetic-1' });
      }
    });
    const run = await asMember((trx) => runs.start(trx, { principal_person_id: other, kind: 'conversation' }));
    const asCompany = { principal: { kind: 'company' as const, id: company } };
    const asPersonal = { principal: { kind: 'person' as const, id: other } };
    const mismatch = await asMember((trx) => meteredSteps.admit(trx, direct(run.id, { ...asPersonal, budgetId: companyBudget })));
    assert.ok(mismatch.decision === 'stopped');
    assert.equal(mismatch.reason, 'budget_not_principal', 'a personal step cannot name a company budget');
    const reverse = await asMember((trx) => meteredSteps.admit(trx, direct(run.id, { ...asCompany, budgetId: memberBudget })));
    assert.ok(reverse.decision === 'stopped');
    assert.equal(reverse.reason, 'budget_not_principal', 'a company step cannot name a personal budget');
    const held = await asMember((trx) => budgets.balance(trx, companyBudget));
    assert.equal(held?.heldMinor, '0', 'nothing was held by the refusals');
    const ok = await asMember((trx) => meteredSteps.admit(trx, direct(run.id, { ...asCompany, budgetId: companyBudget })));
    assert.ok(ok.decision === 'admitted');
    const done = await asMember((trx) => meteredSteps.finish(trx, ok.stepId, 'succeeded', 2, 'synthetic:company'));
    assert.ok(done.decision === 'closed');
    assert.equal(done.chargedMinor, '14');
    const [usage] = await usageOf(run.id);
    assert.equal(usage?.principal_company_id, company);
    assert.equal(usage?.principal_person_id, null);
    assert.equal((await asMember((trx) => budgets.balance(trx, companyBudget)))?.consumedMinor, '14');
  });

  await t.test('rounding happens once per billing month, not per step', async () => {
    await publish({ kind: 'meter', key: 'model_tokens', meter: 'model_tokens' }, '0.3');
    await quota({});
    const fractional = await w.budget('1000');
    const run = await newRun();
    const before = (await balance(fractional))!.consumedMinor;
    const period = () => admin((trx) => trx.selectFrom('agent_charge_period as c').innerJoin('billing_account as a', 'a.id', 'c.billing_account_id').select(['c.accrued_micro', 'c.settled_minor']).where('a.owner_person_id', '=', person).executeTakeFirstOrThrow());
    const start = await period();
    let settled = 0n;
    let exact = 0n;
    for (let i = 0; i < 10; i += 1) {
      const step = await as((trx) => meteredSteps.admit(trx, direct(run.id, { meter: 'model_tokens', capabilityId: null, estimatedUnits: 1000, budgetId: fractional })));
      assert.ok(step.decision === 'admitted', JSON.stringify(step));
      assert.equal(step.estimateMinor, '1', 'a reservation holds whole money');
      const done = await as((trx) => meteredSteps.finish(trx, step.stepId, 'succeeded', 1000, 'synthetic:fraction'));
      assert.ok(done.decision === 'closed');
      settled += BigInt(done.chargedMinor);
      const row = await admin((trx) => trx.selectFrom('metered_step').select('charged_micro').where('id', '=', step.stepId).executeTakeFirstOrThrow());
      assert.equal(row.charged_micro, '300000', 'the exact amount of every step is kept');
      exact += BigInt(row.charged_micro);
    }
    assert.equal(exact, 3000000n);
    assert.equal(settled, 3n, 'ten steps at 0.3 settle 3, not 10');
    assert.equal(BigInt((await balance(fractional))!.consumedMinor) - BigInt(before), 3n);
    assert.equal((await balance(fractional))?.heldMinor, '0');
    const end = await period();
    assert.equal(BigInt(end.accrued_micro) - BigInt(start.accrued_micro), 3000000n);
    assert.equal(end.settled_minor, ((BigInt(end.accrued_micro) + 999999n) / 1000000n).toString(), 'the month settles the exact total rounded up once');
  });

  await t.test('an accepted version stops charging past its own end date', async () => {
    await quota({ checks: '0' });
    const run = await newRun();
    await admin((trx) => trx.updateTable('price_version').set({ effective_to: new Date(Date.now() + 300) }).where('id', '=', checksPrice.id).execute());
    await delay(350);
    const stopped = await as((trx) => meteredSteps.admit(trx, direct(run.id)));
    assert.ok(stopped.decision === 'stopped');
    assert.equal(stopped.reason, 'no_price', 'nothing is charged at an ended version');
  });

  await t.test('an estimate reads only a budget the caller may spend', async () => {
    const stranger = await (await import('../../data/helpers/seed.js')).principalFor(db.admin, other);
    await assert.rejects(withPrincipal(w.pool, stranger, (trx) => meteredSteps.estimate(trx, { hubId: w.hubId, principal: { kind: 'person', id: other }, moduleKey: 'research', capabilityId: null, meter: 'checks', estimatedUnits: 1, budgetId })),
      (e: { hint?: string }) => e.hint === 'access.not_found', 'another person\'s budget is unknown, not merely insufficient');
  });

  await t.test('a price that ended with no successor asks; only a meter never priced runs free', async () => {
    await quota({});
    const run = await newRun();
    const pages = () => as((trx) => meteredSteps.admit(trx, direct(run.id, { meter: 'document_pages' })));
    const close = async (decision: Awaited<ReturnType<typeof pages>>) => {
      assert.ok(decision.decision === 'admitted', JSON.stringify(decision));
      await as((trx) => meteredSteps.finish(trx, decision.stepId, 'failed', null, 'synthetic:lapsed'));
      return decision;
    };
    assert.equal((await close(await pages())).priced, false, 'never priced and never limited: recorded and free');
    const version = await publish({ kind: 'module', key: 'research', meter: 'document_pages' }, '5');
    assert.equal((await close(await pages())).estimateMinor, '10');
    await admin((trx) => trx.updateTable('price_version').set({ effective_to: new Date(Date.now() + 300) }).where('id', '=', version.id).execute());
    await delay(350);
    const stopped = await pages();
    assert.ok(stopped.decision === 'stopped', 'with no quota, an ended price is not a free step');
    assert.equal(stopped.reason, 'no_price');
    const shown = await as((trx) => meteredSteps.estimate(trx, { hubId: w.hubId, principal: { kind: 'person', id: person }, moduleKey: 'research', capabilityId: 'research.draft', meter: 'document_pages', estimatedUnits: 2, budgetId }));
    assert.equal(shown.stop, 'no_price', 'the estimate asks as admission does');
    await quota({ document_pages: '5' });
    const included = await close(await pages());
    assert.equal(included.reservationId, null, 'a free quota still runs after the price ended');
    await quota({});
    await publish({ kind: 'meter', key: 'document_pages', meter: 'document_pages' }, '3');
    assert.equal((await close(await pages())).estimateMinor, '6', 'an ended version decides nothing: a broader live price applies');
  });

  const estimate = (input: Record<string, unknown>) => async (trx: Parameters<Parameters<typeof withPrincipal>[2]>[0]) => (await sql<{ value: { stop: string | null } }>`SELECT trustwork.billing_meter_estimate(${JSON.stringify({ hubId: w.hubId, moduleKey: 'research', capabilityId: 'research.draft', meter: 'agent_actions', estimatedUnits: 1, ...input })}::jsonb) AS value`.execute(trx)).rows[0]?.value;
  const unknown = (e: { hint?: string }) => e.hint === 'access.not_found';

  await t.test('an estimate and an action check read a mandate only for the person who holds it', async () => {
    await quota({ agent_actions: '0' });
    const rich = await w.budget('1000000');
    const capped = (await w.mandate(rich, '2')) as { id: string };
    const stranger = await (await import('../../data/helpers/seed.js')).principalFor(db.admin, other);
    const strangerBudget = await withPrincipal(w.pool, stranger, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'person', projectId: null, employeePersonId: null, periodFrom: new Date(Date.now() - 60000), periodTo: new Date(Date.now() + 86400000), limitMinor: '100', currency: 'USD' }));

    assert.equal((await as(estimate({ principal: { kind: 'person', id: person }, budgetId: rich, mandateId: capped.id })))?.stop, 'mandate_ceiling', 'the holder sees their own ceiling');
    await assert.rejects(withPrincipal(w.pool, stranger, estimate({ principal: { kind: 'person', id: other }, budgetId: strangerBudget, mandateId: capped.id })), unknown, 'another person\'s ceiling is not readable through an estimate');

    assert.equal(await as((trx) => actionQuotaStop(trx, w.hubId, 'research', 'research.draft', capped.id, null)), 'mandate_ceiling');
    await assert.rejects(withPrincipal(w.pool, stranger, (trx) => actionQuotaStop(trx, w.hubId, 'research', 'research.draft', capped.id, null)), unknown, 'another person\'s mandate is unknown, not a free pass');
    await assert.rejects(as((trx) => actionQuotaStop(trx, w.hubId, 'research', 'research.draft', randomUUID(), null)), unknown);
  });

  await t.test('a budget for another project or currency stops and asks on the action path', async () => {
    await quota({ agent_actions: '0' });
    const project = await admin(async (trx) => (await trx.insertInto('project').values({ owner_person_id: person, creator_person_id: person, name: 'Synthetic metered project' }).returning('id').executeTakeFirstOrThrow()).id);
    const grant = (projectId: string | null, currency: string) => as((trx) => budgets.grant(trx, { kind: 'platform', owner: 'person', projectId, employeePersonId: null, periodFrom: new Date(Date.now() - 60000), periodTo: new Date(Date.now() + 86400000), limitMinor: '1000', currency }));
    const scoped = await grant(project, 'USD');
    const euro = await grant(null, 'EUR');
    const scopedMandate = (await w.mandate(scoped, '100')) as { id: string };
    const euroMandate = (await w.mandate(euro, '100')) as { id: string };
    const action = async (id: string, context: { kind: 'profile' | 'project'; id: string }) => {
      const call = await w.call(id, '0');
      const recorded = await as((trx) => actionIntents.record(trx, {
        runId: call.runId, mandateId: id, mandateRevision: 1, capabilityId: 'research.draft', moduleKey: 'research', action: 'research', context, resolvedFromSelector: false, amount: null,
        digest: computeDigest({ synthetic: randomUUID() }).value, effect: { provider: 'synthetic', operation: 'research', payload: { synthetic: true } }, decision: 'allow', askReasons: [],
      }));
      return recorded.intentId!;
    };
    const check = (id: string, projectId: string | null) => as((trx) => actionQuotaStop(trx, w.hubId, 'research', 'research.draft', id, projectId));
    const asks = (e: { hint?: string; detail?: string }) => e.hint === 'billing.quota_reached' && e.detail === 'budget_out_of_scope';

    assert.equal(await check(scopedMandate.id, null), 'budget_out_of_scope', 'outside its project the budget cannot pay, and the person is asked');
    const outside = await action(scopedMandate.id, { kind: 'profile', id: person });
    await assert.rejects(as((trx) => actionIntents.queue(trx, outside, 300, null)), asks);
    assert.equal(await stepOf(outside), undefined);

    assert.equal(await check(scopedMandate.id, project), null);
    const inside = await action(scopedMandate.id, { kind: 'project', id: project });
    await as((trx) => actionIntents.queue(trx, inside, 300, project));
    const step = await stepOf(inside);
    assert.equal(step?.state, 'admitted');
    const held = await admin((trx) => trx.selectFrom('reservation').select(['project_id', 'budget_id']).where('id', '=', step!.reservation_id!).executeTakeFirstOrThrow());
    assert.deepEqual(held, { project_id: project, budget_id: scoped }, 'the hold names the project it was admitted under');

    assert.equal(await check(euroMandate.id, null), 'budget_out_of_scope', 'a budget in another currency cannot pay either');
    const foreign = await action(euroMandate.id, { kind: 'profile', id: person });
    await assert.rejects(as((trx) => actionIntents.queue(trx, foreign, 300, null)), asks);
    assert.equal((await balance(euro))?.heldMinor, '0', 'nothing was held by the refusal');

    const shown = (projectId: string | null) => as((trx) => meteredSteps.estimate(trx, { hubId: w.hubId, principal: { kind: 'person', id: person }, moduleKey: 'research', capabilityId: 'research.draft', meter: 'agent_actions', estimatedUnits: 1, budgetId: scoped, projectId }));
    assert.equal((await shown(null)).stop, 'budget_out_of_scope');
    assert.equal((await shown(project)).stop, null, 'an estimate for the project sees the budget that will pay');
  });

  await t.test('only an action truly unknown for a reason that could be the principal\'s raises a signal', async () => {
    await quota({ agent_actions: '1000' });
    const signals = () => admin((trx) => trx.selectFrom('agent_abuse_signal').selectAll().where('principal_person_id', '=', person).execute());
    const unknownAction = async (reason: 'timeout' | 'lease_expired' | 'crash') => {
      const id = await intent(await boundRun());
      await as((trx) => actionIntents.queue(trx, id, 300, null));
      await moveTo(id, ['executing', 'outcome_unknown']);
      await admin((trx) => sql`INSERT INTO trustwork.action_outcome (action_intent_id, kind, reason) VALUES (${id}::uuid, 'unknown', ${reason})`.execute(trx));
    };
    const healthy = await intent(await boundRun());
    await as((trx) => actionIntents.queue(trx, healthy, 300, null));
    await moveTo(healthy, ['executing', 'pending']);
    await unknownAction('lease_expired');
    await unknownAction('crash');
    await admin((trx) => agentStatistics.abuseSweep(trx, 1, 0));
    assert.deepEqual(await signals(), [], 'an outage and a healthy pending action raise nothing');
    await unknownAction('timeout');
    await admin((trx) => agentStatistics.abuseSweep(trx, 1, 0));
    assert.equal((await signals())[0]?.observed, 1, 'only the timeout counts');
  });

  await t.test('windows raise a notice at 80 and 100 percent, once each', async () => {
    await quota({ deliverables: '10' });
    const run = await newRun();
    const notices = () => admin((trx) => trx.selectFrom('agent_quota_notice as n').innerJoin('agent_quota_window as w', 'w.id', 'n.window_id').select(['n.threshold']).where('w.meter', '=', 'deliverables').where('w.principal_person_id', '=', person).execute());
    const spend = async (units: number) => {
      const step = await as((trx) => meteredSteps.admit(trx, direct(run.id, { meter: 'deliverables', estimatedUnits: units, budgetId: null })));
      assert.ok(step.decision === 'admitted');
      await as((trx) => meteredSteps.finish(trx, step.stepId, 'succeeded', units, 'synthetic:spend'));
    };
    await spend(7);
    assert.deepEqual((await notices()).map((n) => n.threshold), []);
    await spend(1);
    assert.deepEqual((await notices()).map((n) => n.threshold), [80]);
    await spend(2);
    assert.deepEqual((await notices()).map((n) => n.threshold).sort(), [100, 80]);
  });

  // Last: joining a company raises this person's authorization epoch, so the shared principal is stale from here on.
  await t.test('a personal mandate never speaks for a company, whatever employer the session has', async () => {
    await quota({ agent_actions: '0' });
    const capped = (await w.mandate(await w.budget('1000000'), '2')) as { id: string };
    const company = await admin(async (trx) => {
      const id = (await trx.insertInto('company').values({ display_name: 'Synthetic Mandate Binding LLC', claim_status: 'unclaimed' }).returning('id').executeTakeFirstOrThrow()).id;
      await trx.insertInto('membership').values({ person_id: person, company_id: id, role: 'administrator', permissions: ['company.billing.view'], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
      return id;
    });
    const employed = await (await import('../../data/helpers/seed.js')).principalFor(db.admin, person);
    await assert.rejects(withPrincipal(w.pool, employed, estimate({ principal: { kind: 'company', id: company }, budgetId: null, mandateId: capped.id })), unknown);
    assert.equal(await withPrincipal(w.pool, employed, (trx) => actionQuotaStop(trx, w.hubId, 'research', 'research.draft', capped.id, null)), 'mandate_ceiling', 'the check reads the person the mandate names, as the queue does');
  });
});
