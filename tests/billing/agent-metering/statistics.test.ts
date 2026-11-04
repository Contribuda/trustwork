import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { principalFor } from '../../data/helpers/seed.js';
import { AbuseSignalListSchema, AgentUsageStatsSchema } from '../../../packages/contracts/src/agent-metering.js';
import { agentStatistics } from '../../../packages/data/src/repositories/agent-usage.js';
import { meteringHttpWorld } from './helpers.js';

const url = '/v1/admin/billing/metered';
const reason = 'Synthetic statistics test';
const monthsAgo = (n: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 15)); };
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const period = monthOf(monthsAgo(1));

const h = await startHarness('agent_metering_statistics');
test('AGT-004 cohort statistics and abuse signals never expose a person', { skip: h ? false : SKIP_REASON, timeout: 200_000 }, async (t) => {
  if (!h) return;
  const w = await meteringHttpWorld(h);
  t.after(async () => { await w.app.close(); await h.close(); });
  const admin = <T>(fn: Parameters<typeof withMaintenance<T>>[1]) => withMaintenance(h.db.admin, fn);
  await w.elevate();
  const people: string[] = [];

  /** Synthetic closed steps, as metering leaves them: one principal, one run, one succeeded action. */
  const steps = async (moduleKey: string, count: number, over: { state?: 'succeeded' | 'outcome_unknown'; chargedMinor?: string; planVersionId?: string | null; at?: Date } = {}) => admin(async (trx) => {
    for (let i = 0; i < count; i += 1) {
      const person = (await trx.insertInto('person').values({ display_name: `Synthetic principal ${moduleKey} ${i}` }).returning('id').executeTakeFirstOrThrow()).id;
      people.push(person);
      const account = await trx.insertInto('billing_account').values({ hub_id: w.hubA, owner_person_id: person, owner_company_id: null, currency: 'USD', created_by: person }).returning('id').executeTakeFirstOrThrow();
      const state = over.state ?? 'succeeded';
      await trx.insertInto('metered_step').values({ hub_id: w.hubA, principal_person_id: person, principal_company_id: null, acting_person_id: person, billing_account_id: account.id, module_key: moduleKey, capability_id: null,
        run_id: randomUUID(), run_step_id: randomUUID(), attempt_id: randomUUID(), connection_id: null, meter: 'agent_actions', provider_class: null, model_key: null, source_kind: 'direct', source_ref: randomUUID(), plan_version_id: over.planVersionId ?? null,
        window_ids: [], estimated_units: 1, within_units: 1, beyond_units: 0, price_version_id: null, output_price_version_id: null, reservation_id: null, estimate_minor: 0, currency: 'USD', state,
        actual_units: state === 'succeeded' ? 1 : null, overrun_units: 0, charged_minor: over.chargedMinor ?? '3', cost_micro: '1000000', usage_record_id: null, evidence_ref: null, closed_at: state === 'succeeded' ? new Date() : null, created_at: over.at ?? monthsAgo(1) }).execute();
    }
  });
  const stats = async (p = period) => AgentUsageStatsSchema.parse((await w.clients.owner.get(`${url}/usage?period=${p}`)).body);

  await t.test('only staff with the usage permission read statistics, and a period is one whole month', async () => {
    assert.equal((await w.anonymous.get(`${url}/usage?period=${period}`)).status, 401);
    assert.equal((await w.clients.outsider.get(`${url}/usage?period=${period}`)).status, 403);
    assert.equal((await w.clients.otherOwner.get(`${url}/usage?period=${period}`)).status, 403, 'staff of another hub have no scope here');
    for (const bad of ['2026', '2026-13', '2026-11-01', `${period}&personId=${w.p.owner}`, `${period}&from=2026-01-01`, monthOf(new Date()), monthOf(monthsAgo(-1))]) {
      assert.equal((await w.clients.owner.get(`${url}/usage?period=${bad}`)).status, 422, bad);
    }
  });

  await t.test('nine principals are not a cohort: the row is left out, cost and revenue included', async () => {
    await steps('profile_keeper', 9);
    const s = await stats();
    assert.deepEqual(s.modules, []);
    assert.deepEqual(s.cohorts, []);
  });

  await t.test('ten principals are a cohort, and every count under ten inside the row is suppressed', async () => {
    await steps('profile_keeper', 1);
    const [row] = (await stats()).modules;
    assert.equal(row?.moduleKey, 'profile_keeper');
    assert.equal(row?.activePrincipals, 10);
    assert.equal(row?.runs, 10);
    assert.equal(row?.actionsSucceeded, 10);
    assert.equal(row?.actionsEscalatedToHumans, null, 'none is under ten, so it reads fewer than 10');
    assert.deepEqual(row?.cost, { minorUnits: '10', currency: 'USD' });
    assert.deepEqual(row?.revenue, { minorUnits: '30', currency: 'USD' });
    assert.deepEqual((await w.a.cmd(w.p.otherOwner, (trx, ctx) => agentStatistics.usage(trx, ctx, w.hubB, period))).modules, [], 'another hub\'s staff see only their own hub');
    await assert.rejects(w.a.cmd(w.p.otherOwner, (trx, ctx) => agentStatistics.usage(trx, ctx, w.hubA, period)), (e: { hint?: string }) => e.hint === 'admin.forbidden');
  });

  await t.test('an unknown-outcome count between 1 and 9 withholds the whole row; it is never rounded or reported as 0', async () => {
    const row = async (moduleKey: string) => (await stats()).modules.find((m) => m.moduleKey === moduleKey);
    assert.equal((await row('profile_keeper'))?.outcomeUnknown, 0, 'a cohort with 0 unknown outcomes publishes');
    await steps('task_marketplace', 10);
    assert.equal((await row('task_marketplace'))?.outcomeUnknown, 0);
    await steps('task_marketplace', 1, { state: 'outcome_unknown' });
    assert.equal(await row('task_marketplace'), undefined, '1 withholds the row');
    await steps('task_marketplace', 2, { state: 'outcome_unknown' });
    assert.equal(await row('task_marketplace'), undefined, 'a cohort with enough members but 3 unknown outcomes publishes no row');
    assert.equal((await row('profile_keeper'))?.activePrincipals, 10, 'other rows are unaffected');
    await steps('task_marketplace', 6, { state: 'outcome_unknown' });
    assert.equal(await row('task_marketplace'), undefined, '9 withholds the row');
    await steps('task_marketplace', 1, { state: 'outcome_unknown' });
    const published = await row('task_marketplace');
    assert.equal(published?.outcomeUnknown, 10, 'a cohort with 10 publishes the exact count');
    assert.equal(published?.activePrincipals, 20);
    for (const m of (await stats()).modules) assert.ok(m.outcomeUnknown === 0 || m.outcomeUnknown >= 10, `${m.moduleKey} shows ${m.outcomeUnknown}`);
  });

  await t.test('a withheld row cannot be recovered by subtraction from the plan total', async () => {
    const at = monthsAgo(2);
    await steps('profile_keeper', 20, { at });
    await steps('project_planner', 1, { at });
    const s = await stats(monthOf(at));
    assert.equal(s.cohorts[0]?.activePrincipals, 21, 'the plan total is published');
    assert.deepEqual(s.modules, [], 'publishing module A beside the total would give one person\'s spend as the difference');
  });

  await t.test('complementary suppression withholds only as much as it needs', async () => {
    const at = monthsAgo(3);
    await steps('profile_keeper', 30, { at });
    await steps('task_marketplace', 15, { at });
    await steps('project_planner', 1, { at });
    const s = await stats(monthOf(at));
    assert.deepEqual(s.modules.map((m) => m.moduleKey), ['profile_keeper'], 'the smallest other row covers the one withheld; the largest stays');
    const unknown = monthsAgo(4);
    await steps('profile_keeper', 12, { at: unknown });
    await steps('task_marketplace', 12, { at: unknown });
    await steps('task_marketplace', 2, { at: unknown, state: 'outcome_unknown' });
    assert.deepEqual((await stats(monthOf(unknown))).modules.map((m) => m.moduleKey), ['profile_keeper'], 'a row withheld for its unknown count already covers ten principals, so nothing else goes');
  });

  await t.test('one person in several rows counts once toward what is withheld', async () => {
    const at = monthsAgo(5);
    await steps('profile_keeper', 20, { at });
    await steps('project_planner', 5, { at });
    await admin(async (trx) => {
      const rows = await trx.selectFrom('metered_step').selectAll().where('module_key', '=', 'project_planner').where('created_at', '>=', new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))).where('created_at', '<', new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))).execute();
      for (const row of rows) await trx.insertInto('metered_step').values({ ...row, id: randomUUID(), module_key: 'task_marketplace', run_id: randomUUID(), run_step_id: randomUUID(), attempt_id: randomUUID(), source_ref: randomUUID() }).execute();
    });
    assert.deepEqual((await stats(monthOf(at))).modules, [], 'two rows of the same five people do not make a cohort of ten');
  });

  await t.test('the answer holds no identifier of any person, company, run or step', async () => {
    const text = JSON.stringify((await w.clients.owner.get(`${url}/usage?period=${period}`)).body);
    for (const id of people) assert.ok(!text.includes(id));
    assert.doesNotMatch(text.replaceAll(w.hubA, ''), /[0-9a-f]{8}-[0-9a-f]{4}-/, 'no identifier beyond the hub itself');
  });

  await t.test('a single small plan cohort cannot be worked out from the total', async () => {
    const small = await admin(async (trx) => {
      const offer = await trx.insertInto('offer').values({ hub_id: w.hubA, code: 'synthetic_small', name: 'Synthetic small', kind: 'plan', status: 'active', created_by: w.p.owner }).returning('id').executeTakeFirstOrThrow();
      const price = await trx.insertInto('price_version').values({ offer_id: offer.id, version: 1, amount_minor: '1', currency: 'USD', effective_from: new Date(Date.now() + 60000), effective_to: null, acceptance_text_version: 'synthetic', drafted_by: w.p.owner }).returning('id').executeTakeFirstOrThrow();
      return (await trx.insertInto('subscription_plan_version').values({ offer_id: offer.id, version: 1, payer_kind: 'person', payload: '{}', price_version_id: price.id, drafted_by: w.p.owner }).returning('id').executeTakeFirstOrThrow()).id;
    });
    await steps('project_planner', 3, { planVersionId: small });
    const hidden = await stats();
    assert.deepEqual(hidden.cohorts, [], 'the small plan and the next smallest are both hidden, so no subtraction is possible');
    const medium = await admin(async (trx) => {
      const offer = await trx.insertInto('offer').values({ hub_id: w.hubA, code: 'synthetic_medium', name: 'Synthetic medium', kind: 'plan', status: 'active', created_by: w.p.owner }).returning('id').executeTakeFirstOrThrow();
      const price = await trx.insertInto('price_version').values({ offer_id: offer.id, version: 1, amount_minor: '1', currency: 'USD', effective_from: new Date(Date.now() + 60000), effective_to: null, acceptance_text_version: 'synthetic', drafted_by: w.p.owner }).returning('id').executeTakeFirstOrThrow();
      return (await trx.insertInto('subscription_plan_version').values({ offer_id: offer.id, version: 1, payer_kind: 'person', payload: '{}', price_version_id: price.id, drafted_by: w.p.owner }).returning('id').executeTakeFirstOrThrow()).id;
    });
    await steps('project_planner', 12, { planVersionId: medium });
    const keys = (await stats()).cohorts.map((c) => c.key);
    assert.ok(!keys.includes('synthetic_small'));
    assert.equal(keys.length, 1, 'with one cohort hidden, the next smallest is hidden too');
  });

  const sweep = (threshold: number, deadlineSeconds = 0) => admin((trx) => agentStatistics.abuseSweep(trx, threshold, deadlineSeconds));
  const signals = async () => AbuseSignalListSchema.parse((await w.clients.owner.get(`${url}/abuse-signals`)).body).signals;

  await t.test('a signal is a count: repeated unknown outcomes raise one, and the staff list names nobody', async () => {
    assert.equal(await sweep(2), 0, 'one unknown outcome per principal raises nothing');
    await admin(async (trx) => {
      const person = people[0]!;
      const account = await trx.selectFrom('billing_account').select('id').where('owner_person_id', '=', person).executeTakeFirstOrThrow();
      for (let i = 0; i < 3; i += 1) {
        await trx.insertInto('metered_step').values({ hub_id: w.hubA, principal_person_id: person, principal_company_id: null, acting_person_id: person, billing_account_id: account.id, module_key: 'profile_keeper', capability_id: null,
          run_id: randomUUID(), run_step_id: randomUUID(), attempt_id: randomUUID(), connection_id: null, meter: 'agent_actions', provider_class: null, model_key: null, source_kind: 'direct', source_ref: randomUUID(), plan_version_id: null,
          window_ids: [], estimated_units: 1, within_units: 1, beyond_units: 0, price_version_id: null, output_price_version_id: null, reservation_id: null, estimate_minor: 0, currency: 'USD', state: 'outcome_unknown',
          actual_units: null, overrun_units: 0, charged_minor: 0, cost_micro: 0, usage_record_id: null, evidence_ref: null, closed_at: null }).execute();
      }
    });
    assert.equal(await sweep(4), 0, 'under the threshold nothing is raised');
    assert.equal(await sweep(3, 3600), 0, 'an outcome inside its deadline is only slow');
    assert.equal(await sweep(3), 1);
    assert.equal(await sweep(3), 1, 'the same week updates the same signal');
    const list = await signals();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.kind, 'unknown_outcomes');
    assert.equal(list[0]?.observed, 3);
    const text = JSON.stringify((await w.clients.owner.get(`${url}/abuse-signals`)).body);
    assert.ok(!text.includes(people[0]!), 'a signal is not yet anybody\'s case');
  });

  await t.test('a worker outage raises no signal about anyone', async () => {
    const before = (await signals()).length;
    await admin(async (trx) => {
      const person = people[1]!;
      const account = await trx.selectFrom('billing_account').select('id').where('owner_person_id', '=', person).executeTakeFirstOrThrow();
      for (let i = 0; i < 5; i += 1) {
        await trx.insertInto('metered_step').values({ hub_id: w.hubA, principal_person_id: person, principal_company_id: null, acting_person_id: person, billing_account_id: account.id, module_key: 'profile_keeper', capability_id: null,
          run_id: randomUUID(), run_step_id: randomUUID(), attempt_id: randomUUID(), connection_id: null, meter: 'agent_actions', provider_class: null, model_key: null, source_kind: 'direct', source_ref: randomUUID(), plan_version_id: null,
          window_ids: [], estimated_units: 1, within_units: 1, beyond_units: 0, price_version_id: null, output_price_version_id: null, reservation_id: null, estimate_minor: 0, currency: 'USD', state: 'outcome_unknown',
          actual_units: null, overrun_units: 0, charged_minor: 0, cost_micro: 0, usage_record_id: null, evidence_ref: 'sweep:lease_expired', closed_at: null }).execute();
      }
    });
    await sweep(3);
    assert.equal((await signals()).length, before, 'steps that lost their lease say nothing about the principal');
  });

  await t.test('neither the principal nor another hub reads a signal, and a signal changes nothing by itself', async () => {
    const stranger = await principalFor(h.db.admin, w.p.outsider);
    await assert.rejects(withPrincipal(h.pool, stranger, (trx) => sql`SELECT * FROM trustwork.agent_abuse_signal`.execute(trx)), /permission denied/);
    assert.equal((await w.clients.outsider.get(`${url}/abuse-signals`)).status, 403);
    assert.equal((await w.clients.otherOwner.get(`${url}/abuse-signals`)).status, 403);
    assert.deepEqual((await w.a.cmd(w.p.otherOwner, (trx, ctx) => agentStatistics.abuseList(trx, ctx, w.hubB))).signals, []);
    const sanctions = await h.db.admin.query<{ n: number }>('SELECT count(*)::int n FROM trustwork.sanction');
    assert.equal(sanctions.rows[0]?.n, 0, 'no sanction is ever applied by a signal');
    const cases = await h.db.admin.query<{ n: number }>('SELECT count(*)::int n FROM trustwork.moderation_case');
    assert.equal(cases.rows[0]?.n, 0);
  });

  await t.test('a person opens the case, once; the subject reaches the case and only the case', async () => {
    const [signal] = await signals();
    const opened = await w.clients.owner.post(`${url}/abuse-signals/${signal!.id}/open-case`, { reason });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const caseId = (opened.body as { moderationCaseId: string }).moderationCaseId;
    const row = await admin((trx) => trx.selectFrom('moderation_case').selectAll().where('id', '=', caseId).executeTakeFirstOrThrow());
    assert.equal(row.subject_person_id, people[0]);
    assert.equal(row.opened_by, w.p.owner);
    assert.deepEqual(row.clause_codes, ['agent.abuse.unknown_outcomes']);
    assert.equal(row.status, 'open', 'a case, not a decision');
    assert.equal((await w.clients.owner.post(`${url}/abuse-signals/${signal!.id}/open-case`, { reason })).status, 409);
    assert.equal((await w.clients.otherOwner.post(`${url}/abuse-signals/${signal!.id}/open-case`, { reason })).status, 403);
    assert.equal((await signals())[0]?.status, 'case_opened');
  });
});
