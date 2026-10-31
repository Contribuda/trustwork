import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { directory } from '../../packages/data/src/repositories/directory.js';
import { budgets, creditGrants, entitlements, priceAcceptances, subscriptions } from '../../packages/data/src/repositories/billing.js';
import { BillingService } from '../../apps/api/src/modules/billing/billing.service.js';
import { seedSyntheticCatalogue, SYNTHETIC_ACCEPTANCE_TEXT_VERSION, type SeededCatalogue } from '../../apps/api/src/modules/billing/synthetic-catalogue.js';
import { FREE_BASIC_FEATURES } from '../../apps/api/src/modules/billing/policy.js';
import { ApiError } from '../../apps/api/src/common/errors.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { actor, buildWorld, days, inSeconds, settle, type BillingWorld } from './helpers.js';

const db = await provisionTestDatabase('billing_service');

async function apiCode(promise: Promise<unknown>): Promise<{ code: string; reason: unknown } | null> {
  const error = await settle(promise);
  if (!error) return null;
  assert.ok(error instanceof ApiError, `expected an ApiError, got ${(error as Error).message}`);
  return { code: error.code, reason: error.details?.reason };
}

test('billing service: free basic floor for both sides, acceptance and the two budget kinds, payment neutrality', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 16 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: BillingWorld = await buildWorld(db.admin);
  const { principal, as, owner } = actor(db.admin, runtime);
  const p = w.people;
  const service = new BillingService(runtime);
  const window = { periodFrom: days(-1), periodTo: days(30) };

  const seeded: SeededCatalogue = await owner((trx) => seedSyntheticCatalogue(trx, { hubId: w.hubId, currency: 'USD', drafter: p.drafter, activator: p.activator, effectiveFrom: inSeconds(5) }));

  await t.test('the synthetic catalogue is labelled, activated by a second person and published; drafts never appear', async () => {
    await assert.rejects(owner((trx) => seedSyntheticCatalogue(trx, { hubId: randomUUID(), currency: 'USD', drafter: p.drafter, activator: p.drafter, effectiveFrom: inSeconds(5) })), (e: { hint?: string }) => e.hint === 'billing.activator_is_drafter');
    const prices = await service.publishedPrices(await principal(p.solo), w.hubId, new Date());
    assert.deepEqual(prices.map((x) => x.offerCode).sort(), ['synthetic_agent_capacity', 'synthetic_analytical_report', 'synthetic_free_basic']);
    for (const price of prices) {
      assert.match(price.offerCode, /^synthetic_/);
      assert.notEqual(price.activatedBy, price.draftedBy);
      assert.equal(typeof price.amountMinorUnits, 'string', 'money is a string of minor units');
    }
  });

  await t.test('free basic participation for persons and companies alike, with no account, plan or payment', async () => {
    for (const person of [p.solo, p.member, p.estimator, p.outsider]) {
      const me = await principal(person);
      for (const key of FREE_BASIC_FEATURES) {
        assert.deepEqual(await service.checkEntitlement(me, { kind: 'person', id: person }, { kind: 'participation', key }, new Date()), { allowed: true, basis: 'free_basic' });
        assert.deepEqual(await service.checkEntitlement(me, { kind: 'company', id: w.company }, { kind: 'participation', key }, new Date()), { allowed: true, basis: 'free_basic' });
      }
    }
    // Paid capacity needs an entitlement; being an administrator does not give one.
    const admin = await principal(p.admin);
    assert.deepEqual(await service.checkEntitlement(admin, { kind: 'company', id: w.company }, { kind: 'module', moduleCode: 'quoting' }, new Date()), { allowed: false, basis: 'none' });
  });

  const companyAccount = await service.openAccount(await principal(p.admin), { hubId: w.hubId, owner: { kind: 'company', id: w.company }, currency: 'USD' });
  const capacity = seeded.offers.synthetic_agent_capacity;

  await t.test('a transaction budget never pays a platform purchase; a platform budget pays it within its limit', async () => {
    const estimatorTx = await service.grantBudget(await principal(p.admin), { kind: 'transaction', owner: 'company', projectId: null, employeePersonId: p.estimator, ...window, limitMinor: '100000', currency: 'USD' });
    assert.equal(estimatorTx.kind, 'transaction');
    const shown = { priceVersionId: capacity.priceVersion.id, amountMinor: capacity.priceVersion.amount_minor, currency: 'USD', acceptanceTextVersion: SYNTHETIC_ACCEPTANCE_TEXT_VERSION };
    // The estimator holds transaction authority and a transaction budget: neither buys platform services.
    const estimator = await principal(p.estimator);
    assert.deepEqual(await service.budgetsFor(estimator, 'subscribe'), [], 'no platform budget is offered to the estimator');
    assert.equal((await service.budgetsFor(estimator, 'place_order')).length, 1);
    const viaTx = await apiCode(service.acceptAndReserve(estimator, { shown, billingAccountId: companyAccount.id, payer: { kind: 'company', id: w.company }, action: 'subscribe', budgetId: estimatorTx.id, actionIntentId: randomUUID(), correlationKey: `s-${randomUUID()}`, ttlSeconds: 600 }));
    assert.ok(viaTx, 'refused');
    assert.ok(['access.forbidden', 'commercial.authority_missing'].includes(viaTx.code), JSON.stringify(viaTx));
    const viaReserve = await apiCode(service.reserve(estimator, { action: 'generate_deliverable', budgetId: estimatorTx.id, amountMinor: '100', currency: 'USD', actionIntentId: randomUUID(), correlationKey: `d-${randomUUID()}`, projectId: null, ttlSeconds: 600 }));
    assert.deepEqual(viaReserve, { code: 'commercial.authority_missing', reason: 'billing.budget_kind_mismatch' });
    // A company-wide platform budget is spent by a member holding company.billing.manage.
    const platform = await service.grantBudget(await principal(p.admin), { kind: 'platform', owner: 'company', projectId: null, employeePersonId: null, ...window, limitMinor: '150', currency: 'USD' });
    const admin = await principal(p.admin);
    const first = await service.acceptAndReserve(admin, { shown, billingAccountId: companyAccount.id, payer: { kind: 'company', id: w.company }, action: 'subscribe', budgetId: platform.id, actionIntentId: randomUUID(), correlationKey: `s-${randomUUID()}`, ttlSeconds: 600 });
    assert.equal(first.reservation.amount.minorUnits, '100');
    assert.equal(first.acceptance.amount.minorUnits, '100');
    // The second purchase does not fit: acceptance and reservation roll back together.
    const before = (await as(p.admin, (trx) => priceAcceptances.listForAccount(trx, companyAccount.id))).length;
    const second = await apiCode(service.acceptAndReserve(admin, { shown, billingAccountId: companyAccount.id, payer: { kind: 'company', id: w.company }, action: 'subscribe', budgetId: platform.id, actionIntentId: randomUUID(), correlationKey: `s-${randomUUID()}`, ttlSeconds: 600 }));
    assert.deepEqual(second, { code: 'commercial.budget_insufficient', reason: 'commercial.budget_insufficient' });
    assert.equal((await as(p.admin, (trx) => priceAcceptances.listForAccount(trx, companyAccount.id))).length, before, 'no acceptance without its reservation');
    // A stale shown price is refused.
    const stale = await apiCode(service.acceptPrice(admin, { shown: { ...shown, amountMinor: '99' }, billingAccountId: companyAccount.id, payer: { kind: 'company', id: w.company } }));
    assert.equal(stale?.code, 'commercial.stale_version');
    // Settle on actual, never above; balance reflects it.
    const over = await apiCode(service.settle(admin, first.reservation.id, '101', 'outcome:demo'));
    assert.deepEqual(over, { code: 'access.approval_required', reason: 'billing.settlement_exceeds_reservation' });
    const settled = await service.settle(admin, first.reservation.id, '100', 'outcome:demo-no-money-moves');
    assert.equal(settled.state, 'settled');
    assert.deepEqual(await service.budgetBalance(admin, platform.id), { limitMinor: '150', consumedMinor: '100', heldMinor: '0', remainingMinor: '50', currency: 'USD' });
    // Floats and fractional amounts never pass.
    assert.equal((await apiCode(service.reserve(admin, { action: 'subscribe', budgetId: platform.id, amountMinor: '1.5', currency: 'USD', actionIntentId: randomUUID(), correlationKey: `f-${randomUUID()}`, projectId: null, ttlSeconds: 600 })))?.code, 'validation.schema');
    assert.equal((await apiCode(service.grantBudget(admin, { kind: 'platform', owner: 'company', projectId: null, employeePersonId: null, ...window, limitMinor: '1e3', currency: 'USD' })))?.code, 'validation.schema');
  });

  await t.test('my billing is private: the payer sees plans and entitlements, no one else does', async () => {
    const acceptance = await service.acceptPrice(await principal(p.solo), { shown: { priceVersionId: seeded.offers.synthetic_free_basic.priceVersion.id, amountMinor: '0', currency: 'USD', acceptanceTextVersion: SYNTHETIC_ACCEPTANCE_TEXT_VERSION }, billingAccountId: (await service.openAccount(await principal(p.solo), { hubId: w.hubId, owner: { kind: 'person', id: p.solo }, currency: 'USD' })).id, payer: { kind: 'person', id: p.solo } });
    const account = (await service.myBilling(await principal(p.solo), { kind: 'person', id: p.solo }, new Date())).accounts[0]!;
    const sub = await owner((trx) => subscriptions.start(trx, { billingAccountId: account.id, offerId: seeded.offers.synthetic_free_basic.offerId, planVersionId: seeded.offers.synthetic_free_basic.planVersionId, priceVersionId: acceptance.priceVersionId, priceAcceptanceId: acceptance.id, status: 'active', periodStart: new Date(), periodEnd: days(30), renewsAt: days(30) }));
    await owner((trx) => entitlements.grant(trx, { billingAccountId: account.id, offerId: seeded.offers.synthetic_free_basic.offerId, subscriptionId: sub.id, moduleCode: 'core', validFrom: new Date(Date.now() - 1000), validUntil: days(30), source: 'subscription' }));
    const mine = await service.myBilling(await principal(p.solo), { kind: 'person', id: p.solo }, new Date());
    assert.equal(mine.subscriptions.length, 1);
    assert.deepEqual(mine.entitlements.map((e) => e.moduleCode), ['core']);
    const theirs = await service.myBilling(await principal(p.solo2), { kind: 'person', id: p.solo }, new Date());
    assert.deepEqual(theirs, { accounts: [], subscriptions: [], entitlements: [] });
    assert.deepEqual(await service.checkEntitlement(await principal(p.solo), { kind: 'person', id: p.solo }, { kind: 'module', moduleCode: 'core' }, new Date()), { allowed: true, basis: 'entitlement', entitlementId: (await as(p.solo, (trx) => entitlements.activeForParty(trx, { kind: 'person', id: p.solo }, new Date())))[0]!.id, source: 'subscription' });
    const cancelled = await service.cancelSubscription(await principal(p.solo), sub.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await apiCode(service.cancelSubscription(await principal(p.solo2), sub.id)))?.code, 'access.not_found');
  });

  await t.test('payment neutrality: directory order and contents are identical with and without paid entitlements, budgets and credits', async () => {
    const page = { after: null, limit: 100 };
    const snapshot = async () => ({
      companiesAsSolo: await as(p.solo, (trx) => directory.listCompanies(trx, page)),
      companiesAsOutsider: await as(p.outsider, (trx) => directory.listCompanies(trx, page)),
      projectsAsSolo: await as(p.solo, (trx) => directory.listProjects(trx, page)),
      people: await withMaintenance(db.admin, (trx) => directory.listPeople(trx, page)),
    });
    const before = await snapshot();
    // Pay for one company only: an account, subscription, entitlements of every source, budgets, a credit.
    const otherAccount = await service.openAccount(await principal(p.outsider), { hubId: w.hubId, owner: { kind: 'company', id: w.otherCompany }, currency: 'USD' });
    for (const source of ['trial', 'credit', 'sponsorship'] as const) {
      await owner((trx) => entitlements.grant(trx, { billingAccountId: otherAccount.id, offerId: capacity.offerId, subscriptionId: null, moduleCode: `quoting`, validFrom: new Date(Date.now() - 1000), validUntil: days(30), source }));
    }
    await as(p.outsider, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'company', projectId: null, employeePersonId: null, ...window, limitMinor: '100000000', currency: 'USD' }));
    await owner((trx) => creditGrants.grant(trx, { billingAccountId: otherAccount.id, amountMinor: '500', reasonCode: 'goodwill', issuedBy: p.drafter, capCheck: { roleKey: 'support_agent', capMinor: '500' }, caseId: null, validUntil: null, expiryDisclosureKey: null }));
    const after = await snapshot();
    assert.deepEqual(after, before, 'paying changes nothing in any directory or ordering');
  });
});
