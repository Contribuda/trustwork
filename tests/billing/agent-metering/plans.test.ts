import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../../backend/helpers/app.js';
import { principalFor } from '../../data/helpers/seed.js';
import { PublicPricingSchema } from '../../../packages/contracts/src/billing-fees.js';
import { AgentPlanTermsSchema, AgentPlanVersionViewSchema, AgentUsageViewSchema, CreditPackTermsSchema, CreditPackVersionViewSchema, type AgentPlanTerms, type CreditPackTerms } from '../../../packages/contracts/src/agent-metering.js';
import { PROTECTION_LIMIT_KEYS, protectionLimitReached, SubscriptionPlanVersionSchema } from '../../../packages/contracts/src/agent-catalog.js';
import { creditPacks } from '../../../packages/data/src/repositories/agent-usage.js';
import { directory } from '../../../packages/data/src/repositories/directory.js';
import { subscriptions } from '../../../packages/data/src/repositories/billing.js';
import { AgentPlanEntitlements } from '../../../apps/api/src/modules/billing/agent-metering/entitlements.js';
import { pendingDeadlines } from '../../../apps/api/src/modules/agent-modules/occurrences.js';
import { neutralOutputs } from '../fees/neutrality.js';
import { meteringHttpWorld } from './helpers.js';

const url = '/v1/admin/billing/metered';
const reason = 'Synthetic agent plan governance test';
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const planTerms = (over: Partial<AgentPlanTerms> = {}): AgentPlanTerms => ({
  planKey: 'synthetic_team', name: 'Synthetic team plan',
  plan: { payerKind: 'person', moduleKeys: ['reputation_builder', 'profile_keeper'], includedQuota: [{ moduleKey: 'profile_keeper', meter: 'agent_actions', units: '500', window: 'month' }], connections: 2, channels: 1, representativeIncluded: false },
  price: { amountMinor: '1000', currency: 'USD', effectiveFrom: later(600000), effectiveTo: null, acceptanceTextVersion: 'synthetic-plan-1' }, ...over,
});
const packTerms = (over: Partial<CreditPackTerms> = {}): CreditPackTerms => ({
  packKey: 'synthetic_pack', name: 'Synthetic pack', amountMinor: '900', currency: 'USD', creditsMinor: '1000', validityDays: 365, reminderDays: 30, refundPolicyVersion: 1,
  effectiveFrom: later(600000), effectiveTo: null, acceptanceTextVersion: 'synthetic-pack-1', ...over,
});

const h = await startHarness('agent_metering_plans');
test('AGT-004 plans, entitlements, credits and payment neutrality', { skip: h ? false : SKIP_REASON, timeout: 240_000 }, async (t) => {
  if (!h) return;
  const w = await meteringHttpWorld(h);
  t.after(async () => { await w.app.close(); await h.close(); });
  const admin = <T>(fn: Parameters<typeof withMaintenance<T>>[1]) => withMaintenance(h.db.admin, fn);
  const asPerson = async <T>(personId: string, fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(h.pool, await principalFor(h.db.admin, personId), fn);
  const buyer = w.p.outsider;
  const pricing = async () => PublicPricingSchema.parse((await w.anonymous.get('/v1/pricing')).body);
  const entitlements = new AgentPlanEntitlements();
  const actor = { personId: buyer, companyId: null };
  await w.elevate();

  await t.test('a plan cannot name a protection limit, a rank or a participant', async () => {
    for (const key of [...PROTECTION_LIMIT_KEYS, 'ranking', 'matchBoost', 'reputation', 'priority', 'alertLeadSeconds', 'personId']) {
      assert.equal(AgentPlanTermsSchema.safeParse({ ...planTerms(), plan: { ...planTerms().plan, [key]: 1 } }).success, false, key);
      assert.equal((await w.clients.owner.post(`${url}/plans`, { reason, terms: { ...planTerms(), plan: { ...planTerms().plan, [key]: 1 } } })).status, 422, key);
    }
    assert.equal((await w.clients.owner.post(`${url}/plans`, { reason, terms: planTerms({ planKey: 'free' }) })).status, 422, 'free is the absence of a plan');
  });

  await t.test('only hub staff draft, and only a second person activates', async () => {
    const body = { reason, terms: planTerms() };
    assert.equal((await w.anonymous.post(`${url}/plans`, body)).status, 401);
    assert.equal((await w.clients.outsider.post(`${url}/plans`, body)).status, 403);
    assert.equal((await w.clients.otherOwner.post(`${url}/plans`, body)).status, 403);
  });

  const drafted = AgentPlanVersionViewSchema.parse((await w.clients.owner.post(`${url}/plans`, { reason, terms: planTerms() })).body);

  await t.test('the stored plan is the contract payload and its activation digest covers price and capacity', async () => {
    const row = await admin((trx) => trx.selectFrom('subscription_plan_version').selectAll().where('id', '=', drafted.id).executeTakeFirstOrThrow());
    assert.equal(SubscriptionPlanVersionSchema.parse(row.payload).priceVersionId, drafted.priceVersionId);
    assert.equal(((await w.clients.owner.post(`${url}/plans/${drafted.id}/activate`, { reason, digest: drafted.digest, approvalId: randomUUID() })).body as { code: string }).code, 'access.second_approver_required');
    assert.equal(((await w.clients.officer.post(`${url}/plans/${drafted.id}/activate`, { reason, digest: 'c'.repeat(64), approvalId: randomUUID() })).body as { code: string }).code, 'access.approval_digest_mismatch');
  });

  await t.test('activation publishes the plan and its capacity on the price page', async () => {
    const r = await w.clients.officer.post(`${url}/plans/${drafted.id}/activate`, { reason, digest: drafted.digest, approvalId: await w.approve(drafted.digest) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await pricing()).prices.find((x) => x.planVersion?.id === drafted.id);
    assert.equal(row?.amountMinor, '1000');
    assert.deepEqual(row?.disclosure?.plan?.moduleKeys, ['reputation_builder', 'profile_keeper']);
  });

  /** Everything a paying principal could hope to change, read before and after they pay. */
  const snapshot = async () => {
    const page = { after: null, limit: 100 };
    const deadline = { contextKind: 'goal' as const, contextId: '00000000-0000-4000-8000-000000000001', deadlineKey: 'horizon', revision: 1, calendarVersionId: '00000000-0000-4000-8000-000000000002', deadline: new Date('2027-03-15T17:00:00Z'), timeZone: 'America/New_York' };
    return {
      companies: await asPerson(buyer, (trx) => directory.listCompanies(trx, page)),
      companiesForOthers: await asPerson(w.p.owner, (trx) => directory.listCompanies(trx, page)),
      people: await admin((trx) => directory.listPeople(trx, page)),
      neutral: neutralOutputs(buyer),
      // Alert timing: when a deadline job falls due. Same inputs, same instants, whoever pays.
      alerts: pendingDeadlines('00000000-0000-4000-8000-000000000003', { kind: 'deadline', contextKind: 'goal', offsetsDays: [7, 1, 0] }, deadline).map((x) => x.dueAt.toISOString()),
      // Introduction quota: the limit comes from the hub policy, and a counter at the limit is refused the same way.
      introductions: [0, 9, 10, 11].map((current) => protectionLimitReached({ openIntroductionsPerPerson: 10, newCounterpartiesPerDay: 1, maxNegotiationRounds: 1, consumerMaxRounds: 1, envelopesPerCounterpartyPerDay: 1, publicRecordsPerConnectionPerDay: 1, connectionsPerPerson: 1, connectionIdleExpiryDays: 1 }, 'openIntroductionsPerPerson', current)),
      runtimeLimits: await admin(async (trx) => (await sql<{ document: unknown }>`SELECT document -> 'policy' -> 'protectionLimits' AS document FROM trustwork.agent_policy_current WHERE hub_id = ${w.hubA}::uuid`.execute(trx)).rows),
    };
  };
  const before = await snapshot();

  await t.test('a plan the principal has not bought decides nothing for free-floor modules and gates what is sold', async () => {
    assert.equal(await asPerson(buyer, (trx) => entitlements.planKey(trx, actor, w.hubA)), 'free');
    assert.equal(await asPerson(buyer, (trx) => entitlements.moduleAllowed(trx, actor, 'profile_keeper', w.hubA)), true, 'the free floor stays');
    assert.equal(await asPerson(buyer, (trx) => entitlements.moduleAllowed(trx, actor, 'reputation_builder', w.hubA)), false, 'sold, no free quota, not in the plan');
    assert.equal(await asPerson(buyer, (trx) => entitlements.moduleAllowed(trx, actor, 'execution_evidence', w.hubA)), true, 'a module nobody sells stays available');
  });

  await t.test('accepting binds the exact version; the wrong amount or another hub is refused', async () => {
    const accept = (id: string, over = {}) => w.clients.outsider.post(`/v1/billing/prices/${id}/accept`, { acceptanceTextVersion: 'synthetic-plan-1', amountMinor: '1000', currency: 'USD', forCompany: false, ...over });
    assert.equal((await w.anonymous.post(`/v1/billing/prices/${drafted.priceVersionId}/accept`, { acceptanceTextVersion: 'x', amountMinor: '1', currency: 'USD', forCompany: false })).status, 401);
    assert.notEqual((await accept(drafted.priceVersionId, { amountMinor: '1' })).status, 201);
    assert.equal((await accept(randomUUID())).status, 404);
    assert.equal((await accept(drafted.priceVersionId, { forCompany: true })).status, 404, 'a company the person does not act for');
    assert.equal((await accept(drafted.priceVersionId)).status, 201);
  });

  await t.test('an active subscription sets the plan key and raises the included quota; the free floor stays beneath it', async () => {
    await admin(async (trx) => {
      const account = await trx.selectFrom('billing_account').select('id').where('owner_person_id', '=', buyer).executeTakeFirstOrThrow();
      const acceptance = await trx.selectFrom('price_acceptance').select('id').where('billing_account_id', '=', account.id).executeTakeFirstOrThrow();
      await subscriptions.start(trx, { billingAccountId: account.id, offerId: drafted.offerId, planVersionId: drafted.id, priceVersionId: drafted.priceVersionId, priceAcceptanceId: acceptance.id, status: 'active',
        periodStart: new Date(Date.now() - 1000), periodEnd: new Date(Date.now() + 86400000), renewsAt: null });
    });
    assert.equal(await asPerson(buyer, (trx) => entitlements.planKey(trx, actor, w.hubA)), 'synthetic_team');
    assert.equal(await asPerson(buyer, (trx) => entitlements.moduleAllowed(trx, actor, 'reputation_builder', w.hubA)), true);
    const quotas = await admin(async (trx) => (await sql<{ window_kind: string; units: string }>`SELECT * FROM trustwork.billing_meter_quotas(${w.hubA}::uuid, ${JSON.stringify(planTerms().plan)}::jsonb, 'profile_keeper', 'agent_actions')`.execute(trx)).rows);
    assert.deepEqual(quotas, [{ window_kind: 'month', units: '500' }]);
    const floor = await admin(async (trx) => (await sql<{ units: string }>`SELECT * FROM trustwork.billing_meter_quotas(${w.hubA}::uuid, ${JSON.stringify({ includedQuota: [{ moduleKey: 'profile_keeper', meter: 'agent_actions', units: '1', window: 'month' }] })}::jsonb, 'profile_keeper', 'agent_actions')`.execute(trx)).rows);
    assert.equal(floor[0]?.units, '50', 'a smaller plan quota never lowers the free floor');
  });

  await t.test('own usage is private: a plan is shown only to its payer, and another person sees an empty view', async () => {
    const mine = AgentUsageViewSchema.parse((await w.clients.outsider.get('/v1/billing/agent-usage')).body);
    assert.equal(mine.planKey, 'synthetic_team');
    const theirs = AgentUsageViewSchema.parse((await w.clients.otherOwner.get('/v1/billing/agent-usage')).body);
    assert.equal(theirs.planKey, 'free');
    assert.deepEqual(theirs.steps, []);
    assert.equal((await w.anonymous.get('/v1/billing/agent-usage')).status, 401);
    assert.equal((await w.clients.outsider.get('/v1/billing/agent-usage?forCompany=true')).status, 404);
    const estimate = await w.clients.outsider.get('/v1/billing/agent-usage/estimate?moduleKey=profile_keeper&meter=agent_actions&units=3');
    assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
    assert.deepEqual(estimate.body, { withinUnits: 3, beyondUnits: 0, estimateMinor: '0', currency: 'USD', stop: null, priced: false, quotaDefined: true });
  });

  await t.test('introduction quotas, alert timing and ranking are identical with and without paid entitlements', async () => {
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('no ranking, matching, reputation, alert or protection path reads a plan, a subscription or a meter', () => {
    const root = join(import.meta.dirname, '../../..');
    const sources = [
      'packages/data/src/repositories/directory.ts', 'packages/data/src/repositories/agent-modules-scheduler.ts', 'apps/api/src/modules/agent-modules/occurrences.ts', 'apps/api/src/modules/agent-modules/goal-feed.ts',
      ...readdirSync(join(root, 'apps/api/src/modules/trust')).filter((f) => f.endsWith('.ts')).map((f) => `apps/api/src/modules/trust/${f}`),
      ...readdirSync(join(root, 'apps/api/src/modules/directory')).filter((f) => f.endsWith('.ts')).map((f) => `apps/api/src/modules/directory/${f}`),
    ];
    for (const file of sources) {
      const text = readFileSync(join(root, file), 'utf8');
      for (const word of ['subscription_plan_version', 'agent_quota_window', 'metered_step', 'usage_record', 'agent-metering', 'agent-usage', 'billing_meter', 'planKey']) assert.ok(!text.includes(word), `${file} reads ${word}`);
    }
    const protection = readFileSync(join(root, 'packages/data/migrations/agent-modules/20261121100700_agent_runtime_limits.sql'), 'utf8');
    for (const word of ['trustwork.subscription', 'entitlement', 'billing_']) assert.ok(!protection.includes(word), `protection limits read ${word}`);
  });

  const pack = CreditPackVersionViewSchema.parse((await w.clients.owner.post(`${url}/credit-packs`, { reason, terms: packTerms() })).body);

  await t.test('a pack shows validity and refund policy before purchase; expiring credits need a reminder', async () => {
    assert.equal(CreditPackTermsSchema.safeParse(packTerms({ reminderDays: null })).success, false);
    assert.equal((await w.clients.owner.post(`${url}/credit-packs`, { reason, terms: packTerms({ reminderDays: null }) })).status, 422);
    assert.equal((await w.clients.owner.post(`${url}/credit-packs`, { reason, terms: packTerms({ validityDays: 5 }) })).status, 422);
    assert.equal(((await w.clients.owner.post(`${url}/credit-packs/${pack.id}/activate`, { reason, digest: pack.digest, approvalId: randomUUID() })).body as { code: string }).code, 'access.second_approver_required');
    assert.equal((await w.clients.officer.post(`${url}/credit-packs/${pack.id}/activate`, { reason, digest: pack.digest, approvalId: await w.approve(pack.digest) })).status, 200);
    const p = await pricing();
    assert.equal(p.coverage?.sections.credit_packs, 'available');
    const row = p.prices.find((x) => x.id === pack.id);
    assert.equal(row?.validity, 'P365D');
    assert.deepEqual(row?.disclosure?.creditPack, { creditsMinor: '1000', validityDays: 365, reminderDays: 30, refundPolicyVersion: 1 });
  });

  await t.test('no runtime role creates credit, and funding is idempotent on payment evidence', async () => {
    const accepted = await w.clients.outsider.post(`/v1/billing/prices/${pack.id}/accept`, { acceptanceTextVersion: 'synthetic-pack-1', amountMinor: '900', currency: 'USD', forCompany: false });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const acceptanceId = (accepted.body as { id: string }).id;
    await assert.rejects(asPerson(buyer, (trx) => creditPacks.fund(trx, acceptanceId, 'synthetic:forged')), /permission denied/);
    const lot = await admin((trx) => creditPacks.fund(trx, acceptanceId, 'synthetic:payment-1'));
    assert.equal(lot.remaining_minor, '1000');
    assert.equal((await admin((trx) => creditPacks.fund(trx, acceptanceId, 'synthetic:payment-1'))).id, lot.id);
  });

  await t.test('credits are spent earliest first and never expire silently', async () => {
    const lot = await admin((trx) => trx.selectFrom('agent_credit_lot').selectAll().executeTakeFirstOrThrow());
    const consume = (step: string, amount: string) => admin(async (trx) => (await sql<{ n: string }>`SELECT trustwork.billing_credit_consume(${lot.billing_account_id}::uuid, ${step}::uuid, ${amount}::bigint) AS n`.execute(trx)).rows[0]!.n);
    const step = randomUUID();
    assert.equal(await consume(step, '300'), '300');
    assert.equal(await consume(step, '300'), '0', 'a replayed step consumes once');
    // Past its validity with no notice sent: still usable, because an expiry was never announced.
    await admin((trx) => trx.updateTable('agent_credit_lot').set({ valid_until: new Date(Date.now() - 1000) }).where('id', '=', lot.id).execute());
    assert.equal(await consume(randomUUID(), '100'), '100');
    const announced = await admin((trx) => creditPacks.noticeSweep(trx, 10));
    assert.equal(announced, 1);
    assert.equal(await admin((trx) => creditPacks.noticeSweep(trx, 10)), 0, 'announced once');
    assert.equal(await consume(randomUUID(), '100'), '100', 'usable for the whole reminder period after the announcement');
    await admin((trx) => trx.updateTable('agent_credit_lot').set({ notice_sent_at: new Date(Date.now() - 31 * 86400000) }).where('id', '=', lot.id).execute());
    assert.equal(await consume(randomUUID(), '100'), '0', 'expired only after the validity and a full announced period');
    const event = await h.db.admin.query<{ n: number }>("SELECT count(*)::int n FROM trustwork.outbox_event WHERE type = 'billing.credit_expiry_notice' AND aggregate_id = $1", [lot.id]);
    assert.equal(event.rows[0]?.n, 1);
  });

  await t.test('a new plan version leaves the published earlier version whole until its end date', async () => {
    const start = later(3600000);
    const v2 = AgentPlanVersionViewSchema.parse((await w.clients.owner.post(`${url}/plans`, { reason, terms: planTerms({ price: { ...planTerms().price, amountMinor: '2000', effectiveFrom: start } }) })).body);
    assert.equal(v2.version, 2);
    assert.equal((await w.clients.officer.post(`${url}/plans/${v2.id}/activate`, { reason, digest: v2.digest, approvalId: await w.approve(v2.digest) })).status, 200);
    const p = await pricing();
    assert.equal(p.coverage?.sections.plans, 'available', 'the reader does not fail on an end-dated earlier version');
    const rows = p.prices.filter((x) => x.kind === 'plan').map((x) => [x.planVersion?.version, x.amountMinor, x.effectiveTo]);
    assert.deepEqual(rows, [[1, '1000', new Date(start).toISOString()], [2, '2000', null]]);
    assert.equal(await asPerson(buyer, (trx) => entitlements.planKey(trx, actor, w.hubA)), 'synthetic_team', 'the payer keeps the version they accepted');
    const held = await admin((trx) => trx.selectFrom('subscription').select('subscription_plan_version_id').where('offer_id', '=', drafted.offerId).executeTakeFirstOrThrow());
    assert.equal(held.subscription_plan_version_id, drafted.id);
  });
});
