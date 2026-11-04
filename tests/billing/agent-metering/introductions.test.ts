import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { principalFor } from '../../data/helpers/seed.js';
import { activatePolicy, buildAgentWorld } from '../../agent-modules/helpers.js';
import { negotiationPolicy } from '../../agent-modules/fixtures.js';
import { CapabilityAuthority, type AgentActor } from '../../../apps/api/src/modules/agent-modules/authority.js';
import { AgentPlanEntitlements } from '../../../apps/api/src/modules/billing/agent-metering/entitlements.js';
import { meteredSteps } from '../../../packages/data/src/repositories/agent-usage.js';
import { runs } from '../../../packages/data/src/repositories/assistant.js';

const h = await startHarness('agent_metering_introductions');
test('AGT-004 introductions never depend on plan or payment', { skip: h ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const world = await buildAgentWorld(h);
  const hubId = world.hubId;
  // The hub sells the negotiation module and gives it no free quota: the exact case where a plan could gate it.
  await activatePolicy(h, world, negotiationPolicy(hubId));
  const { paying, free } = await withMaintenance(h.db.admin, async (trx) => {
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const payingId = await person('Synthetic paying principal');
    const freeId = await person('Synthetic free principal');
    const owner = world.w.people.owner;
    const offer = await trx.insertInto('offer').values({ hub_id: hubId, code: 'synthetic_deals', name: 'Synthetic deals plan', kind: 'plan', status: 'active', created_by: owner }).returning('id').executeTakeFirstOrThrow();
    const price = await trx.insertInto('price_version').values({ offer_id: offer.id, version: 1, amount_minor: '100', currency: 'USD', effective_from: new Date(Date.now() + 200), effective_to: null, acceptance_text_version: 'synthetic', drafted_by: owner }).returning('id').executeTakeFirstOrThrow();
    await trx.updateTable('price_version').set({ status: 'active', activated_by: world.w.people.officer }).where('id', '=', price.id).execute();
    const planId = randomUUID();
    await trx.insertInto('subscription_plan_version').values({ id: planId, offer_id: offer.id, version: 1, payer_kind: 'person', price_version_id: price.id, drafted_by: owner,
      payload: JSON.stringify({ id: planId, offerId: offer.id, version: 1, payerKind: 'person', moduleKeys: ['negotiation'], includedQuota: [], connections: 1, channels: 0, representativeIncluded: false, priceVersionId: price.id, status: 'draft' }) }).execute();
    await trx.updateTable('subscription_plan_version').set({ status: 'active', activated_by: world.w.people.officer }).where('id', '=', planId).execute();
    const account = await trx.insertInto('billing_account').values({ hub_id: hubId, owner_person_id: payingId, owner_company_id: null, currency: 'USD', created_by: payingId }).returning('id').executeTakeFirstOrThrow();
    const acceptance = await trx.insertInto('price_acceptance').values({ price_version_id: price.id, billing_account_id: account.id, payer_person_id: payingId, payer_company_id: null, accepted_by_person_id: payingId, amount_minor: '100', currency: 'USD', acceptance_text_version: 'synthetic' }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('subscription').values({ billing_account_id: account.id, offer_id: offer.id, subscription_plan_version_id: planId, price_version_id: price.id, price_acceptance_id: acceptance.id, status: 'active',
      current_period_start: new Date(Date.now() - 1000), current_period_end: new Date(Date.now() + 86400000), renews_at: null }).execute();
    return { paying: payingId, free: freeId };
  });
  const authority = new CapabilityAuthority({ hubId, entitlements: new AgentPlanEntitlements() });
  const actor = (personId: string): AgentActor => ({ personId, onBehalfCompanyId: null, representativeOf: null, connectionId: null });
  const as = async <T>(personId: string, fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(h.pool, await principalFor(h.db.admin, personId), fn);
  const decide = (personId: string, capability: string, action: string) => as(personId, (trx) => authority.check(trx, actor(personId), capability, action));

  await t.test('the plan really gates this module, so the comparison below is not empty', async () => {
    const payer = await decide(paying, 'negotiation.negotiate', 'negotiate');
    const other = await decide(free, 'negotiation.negotiate', 'negotiate');
    assert.equal(payer.allowed, true, JSON.stringify(payer));
    assert.equal(other.allowed, false);
    assert.ok(!other.allowed && other.reason === 'capability.off_for_plan');
  });

  await t.test('a paying and a non-paying principal get the same answer for an introduction', async () => {
    const payer = await decide(paying, 'negotiation.introduce', 'introduce');
    const other = await decide(free, 'negotiation.introduce', 'introduce');
    assert.deepEqual(payer, other);
    assert.equal(payer.allowed, true, JSON.stringify(payer));
  });

  await t.test('hub policy still stops an introduction, for both alike', async () => {
    const draft = negotiationPolicy(hubId);
    draft.capabilities = [...(draft.capabilities ?? []), { capabilityId: 'negotiation.introduce', offForHub: true, offForPrincipalKinds: [], offForPlans: [] }];
    await activatePolicy(h, world, draft);
    const payer = await decide(paying, 'negotiation.introduce', 'introduce');
    const other = await decide(free, 'negotiation.introduce', 'introduce');
    assert.deepEqual(payer, other);
    assert.equal(payer.allowed, false);
    await activatePolicy(h, world, negotiationPolicy(hubId));
  });

  await t.test('an introduction is never metered: no quota, price or budget stops it, for either principal', async () => {
    for (const personId of [paying, free]) {
      const stop = await as(personId, async (trx) => (await sql<{ stop: string | null }>`SELECT trustwork.billing_meter_action_stop(${hubId}::uuid, 'negotiation', 'negotiation.introduce', ${randomUUID()}::uuid, NULL) AS stop`.execute(trx)).rows[0]?.stop);
      assert.equal(stop, null);
      const run = await as(personId, (trx) => runs.start(trx, { principal_person_id: personId, kind: 'conversation' }));
      await assert.rejects(as(personId, (trx) => meteredSteps.admit(trx, { hubId, principal: { kind: 'person', id: personId }, moduleKey: 'negotiation', capabilityId: 'negotiation.introduce', runId: run.id, runStepId: randomUUID(), attemptId: randomUUID(),
        connectionId: null, meter: 'agent_actions', providerClass: null, estimatedUnits: 1, budgetId: null, projectId: null })), (e: { hint?: string }) => e.hint === 'billing.invalid_terms');
    }
    const declared = await withMaintenance(h.db.admin, async (trx) => (await sql<{ d: boolean }>`SELECT trustwork.billing_meter_declared('negotiation.introduce', 'agent_actions') AS d`.execute(trx)).rows[0]?.d);
    assert.equal(declared, false);
  });
});
