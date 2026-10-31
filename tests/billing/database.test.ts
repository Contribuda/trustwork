import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, type DataPool } from '@trustwork/data';
import {
  billingAccounts, budgets, catalogue, creditGrants, entitlements, ledger, priceAcceptances, reservations, subscriptions, usageRecords,
} from '../../packages/data/src/repositories/billing.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { actor, buildWorld, days, inSeconds, rejects, settle, sleep, type BillingWorld } from './helpers.js';

const db = await provisionTestDatabase('billing_db');

test('billing persistence: versions, acceptances, two budget kinds, atomic reservations and the ledger under the runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 24 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w: BillingWorld = await buildWorld(db.admin);
  const { as, owner } = actor(db.admin, runtime);
  const p = w.people;
  const window = { periodFrom: days(-1), periodTo: days(30) };
  const intent = () => randomUUID();

  await t.test('schema: fifteen billing tables under ENABLE + FORCE row-level security, meters seeded, money columns are bigint', async () => {
    const tables = ['billing_account', 'offer', 'subscription_plan_version', 'price_version', 'price_acceptance', 'subscription', 'entitlement', 'meter', 'meter_rate_version',
      'marketplace_fee_version', 'usage_record', 'budget', 'reservation', 'ledger_entry', 'credit_grant'];
    const { rows } = await db.admin.query<{ relname: string; f: boolean }>(
      "SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND c.relkind = 'r' AND c.relname = ANY($1)", [tables]);
    assert.equal(rows.length, 15);
    assert.ok(rows.every((r) => r.f), 'every billing table forces RLS');
    const money = await db.admin.query<{ column_name: string; data_type: string }>(
      "SELECT table_name || '.' || column_name AS column_name, data_type FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = ANY($1) AND (column_name LIKE '%\\_minor' OR column_name = 'units')", [tables]);
    assert.equal(money.rows.length, 11);
    for (const c of money.rows) assert.equal(c.data_type, 'bigint', `${c.column_name} is integer minor units, never float or numeric`);
    const floats = await db.admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = ANY($1) AND data_type IN ('real', 'double precision', 'numeric', 'money')", [tables]);
    assert.equal(floats.rowCount, 0, 'no float, numeric or money type in billing');
    const meters = await as(p.solo, (trx) => trx.selectFrom('meter').select('code').orderBy('code').execute());
    assert.equal(meters.length, 8);
  });

  // Catalogue shared by the following subtests.
  const offer = await owner((trx) => catalogue.createOffer(trx, { hubId: w.hubId, code: 'synthetic_report', name: 'Synthetic report', kind: 'deliverable', createdBy: p.drafter, status: 'active' }));

  await t.test('price versions: born as drafts, activated by a second person, never back-dated, frozen and never overlapping', async () => {
    await rejects(owner((trx) => trx.insertInto('price_version').values({ offer_id: offer.id, version: 99, amount_minor: '1', currency: 'USD', effective_from: days(1), acceptance_text_version: 't1', drafted_by: p.drafter, status: 'active', activated_by: p.activator, activated_at: new Date() }).execute()), '23514', 'billing.version_not_draft');
    const draft = await owner((trx) => catalogue.draftPriceVersion(trx, { offerId: offer.id, amountMinor: '100', currency: 'USD', effectiveFrom: inSeconds(2), acceptanceTextVersion: 'terms-1', draftedBy: p.drafter }));
    await rejects(owner((trx) => catalogue.activatePriceVersion(trx, draft.id, p.drafter)), '23514', 'billing.activator_is_drafter');
    const past = await owner((trx) => catalogue.draftPriceVersion(trx, { offerId: offer.id, amountMinor: '100', currency: 'USD', effectiveFrom: days(-1), acceptanceTextVersion: 'terms-1', draftedBy: p.drafter }));
    await rejects(owner((trx) => catalogue.activatePriceVersion(trx, past.id, p.activator)), '23514', 'billing.backdated');
    // A caller-supplied activation time is ignored: the database stamps the clock.
    const active = await owner((trx) => trx.updateTable('price_version').set({ status: 'active', activated_by: p.activator, activated_at: days(-10) }).where('id', '=', draft.id).returningAll().executeTakeFirstOrThrow());
    assert.ok(active.activated_at!.getTime() > Date.now() - 60_000, 'activated_at comes from the clock');
    await rejects(owner((trx) => trx.updateTable('price_version').set({ amount_minor: '1' }).where('id', '=', draft.id).execute()), '23000', 'billing.version_frozen');
    await rejects(owner((trx) => trx.updateTable('price_version').set({ status: 'draft' }).where('id', '=', draft.id).execute()), '23514', 'billing.invalid_transition');
    await rejects(owner((trx) => trx.deleteFrom('price_version').where('id', '=', draft.id).execute()), '23000', 'billing.version_frozen');
    // Overlap with the open-ended active version is refused; superseding end-dates the previous one at the new start.
    const next = await owner((trx) => catalogue.draftPriceVersion(trx, { offerId: offer.id, amountMinor: '150', currency: 'USD', effectiveFrom: days(10), acceptanceTextVersion: 'terms-2', draftedBy: p.drafter }));
    await rejects(owner((trx) => catalogue.activatePriceVersion(trx, next.id, p.activator)), '23P01', 'billing.version_overlap');
    const activated = await owner((trx) => catalogue.activatePriceVersion(trx, next.id, p.activator, { supersedePrevious: true }));
    assert.equal(activated.status, 'active');
    const previous = await owner((trx) => catalogue.priceVersion(trx, draft.id));
    assert.equal(previous?.effective_to?.toISOString(), next.effective_from.toISOString());
    // End-dating into the past or lengthening an end date is refused.
    await rejects(owner((trx) => trx.updateTable('price_version').set({ effective_to: days(-1) }).where('id', '=', draft.id).execute()), '23514');
    await rejects(owner((trx) => trx.updateTable('price_version').set({ effective_to: days(20) }).where('id', '=', draft.id).execute()), '23514', 'billing.backdated');
    // Drafts are invisible to participants; activated versions are public.
    const visible = await as(p.solo, (trx) => trx.selectFrom('price_version').select(['id', 'status']).where('offer_id', '=', offer.id).execute());
    assert.deepEqual(new Set(visible.map((v) => v.status)), new Set(['active']));
    assert.ok(!visible.some((v) => v.id === past.id));
    await rejects(as(p.solo, (trx) => trx.updateTable('price_version').set({ amount_minor: '0' }).execute()), '42501');
    await rejects(as(p.solo, (trx) => trx.insertInto('offer').values({ hub_id: w.hubId, code: 'self_made', name: 'x', kind: 'plan', created_by: p.solo }).execute()), '42501');
  });

  await t.test('concurrent activations of overlapping price versions: exactly one wins', async () => {
    const o = await owner((trx) => catalogue.createOffer(trx, { hubId: w.hubId, code: 'synthetic_race', name: 'Synthetic race', kind: 'plan', createdBy: p.drafter, status: 'active' }));
    const drafts = await owner(async (trx) => {
      const out = [];
      for (let i = 0; i < 4; i++) out.push(await catalogue.draftPriceVersion(trx, { offerId: o.id, amountMinor: String(100 + i), currency: 'USD', effectiveFrom: days(1 + i), acceptanceTextVersion: 't', draftedBy: p.drafter }));
      return out;
    });
    const results = await Promise.all(drafts.map((d) => settle(owner((trx) => catalogue.activatePriceVersion(trx, d.id, p.activator)))));
    assert.equal(results.filter((r) => r === null).length, 1, 'one activation wins');
    assert.ok(results.filter((r) => r !== null).every((r) => r?.hint === 'billing.version_overlap'));
  });

  await t.test('meter rates and marketplace fees follow the same discipline (fees also need a second-person approval)', async () => {
    const rate = await owner((trx) => catalogue.draftMeterRate(trx, { hubId: w.hubId, meter: 'model_tokens', providerClass: 'hosted_external', currency: 'USD', pricePerThousandMinor: '2', passThrough: true, effectiveFrom: days(1), draftedBy: p.drafter }));
    await rejects(owner((trx) => catalogue.activateMeterRate(trx, rate.id, p.drafter)), '23514', 'billing.activator_is_drafter');
    await owner((trx) => catalogue.activateMeterRate(trx, rate.id, p.activator));
    const rate2 = await owner((trx) => catalogue.draftMeterRate(trx, { hubId: w.hubId, meter: 'model_tokens', providerClass: 'hosted_external', currency: 'USD', pricePerThousandMinor: '3', passThrough: true, effectiveFrom: days(5), draftedBy: p.drafter }));
    await rejects(owner((trx) => catalogue.activateMeterRate(trx, rate2.id, p.activator)), '23P01', 'billing.version_overlap');
    const fee = await owner((trx) => catalogue.draftFeeVersion(trx, { hubId: w.hubId, kind: 'consultation', categoryKey: 'structural_review', currency: 'USD', basisPoints: 500, fixedMinor: null, payer: 'buyer', effectiveFrom: days(1), acceptanceTextVersion: 'fee-1', draftedBy: p.drafter }));
    await rejects(owner((trx) => trx.updateTable('marketplace_fee_version').set({ status: 'active', activated_by: p.activator }).where('id', '=', fee.id).execute()), '23514', 'billing.approval_missing');
    await rejects(owner((trx) => catalogue.activateFeeVersion(trx, fee.id, p.drafter, randomUUID())), '23514', 'billing.activator_is_drafter');
    const activeFee = await owner((trx) => catalogue.activateFeeVersion(trx, fee.id, p.activator, randomUUID()));
    assert.equal(activeFee.status, 'active');
    await rejects(owner((trx) => catalogue.draftFeeVersion(trx, { hubId: w.hubId, kind: 'ticket', categoryKey: 'not_allowed', currency: 'USD', basisPoints: 100, fixedMinor: null, payer: 'buyer', effectiveFrom: days(1), acceptanceTextVersion: 'fee-1', draftedBy: p.drafter })), '23514');
  });

  // Priced offer for acceptance and budgets, effective in a moment.
  const priced = await owner((trx) => catalogue.createOffer(trx, { hubId: w.hubId, code: 'synthetic_plan', name: 'Synthetic plan', kind: 'plan', createdBy: p.drafter, status: 'active' }));
  const priceDraft = await owner((trx) => catalogue.draftPriceVersion(trx, { offerId: priced.id, amountMinor: '100', currency: 'USD', effectiveFrom: inSeconds(1), acceptanceTextVersion: 'terms-plan-1', draftedBy: p.drafter }));
  const price = await owner((trx) => catalogue.activatePriceVersion(trx, priceDraft.id, p.activator));
  const soloAccount = await as(p.solo, (trx) => billingAccounts.open(trx, { hubId: w.hubId, owner: { kind: 'person', id: p.solo }, currency: 'USD', createdBy: p.solo }));
  const companyAccount = await as(p.admin, (trx) => billingAccounts.open(trx, { hubId: w.hubId, owner: { kind: 'company', id: w.company }, currency: 'USD', createdBy: p.admin }));

  await t.test('billing accounts: personal and company payers; only billing managers open company accounts; private to the payer', async () => {
    await rejects(as(p.estimator, (trx) => billingAccounts.open(trx, { hubId: w.hubId, owner: { kind: 'company', id: w.company }, currency: 'EUR', createdBy: p.estimator })), '42501');
    await rejects(as(p.solo, (trx) => billingAccounts.open(trx, { hubId: w.hubId, owner: { kind: 'person', id: p.solo2 }, currency: 'EUR', createdBy: p.solo })), '42501');
    await rejects(as(p.solo, (trx) => billingAccounts.open(trx, { hubId: w.hubId, owner: { kind: 'person', id: p.solo }, currency: 'USD', createdBy: p.solo })), '23505');
    assert.ok(await as(p.viewer, (trx) => billingAccounts.get(trx, companyAccount.id)), 'billing viewer sees the company account');
    for (const stranger of [p.estimator, p.member, p.outsider, p.solo]) {
      assert.equal(await as(stranger, (trx) => billingAccounts.get(trx, companyAccount.id)), undefined, 'others do not see the company account');
    }
    assert.equal(await as(p.solo2, (trx) => billingAccounts.get(trx, soloAccount.id)), undefined);
    assert.equal((await db.app.query('SELECT count(*)::int AS n FROM trustwork.billing_account')).rows[0]?.n, 0, 'no identity, no rows');
  });

  await t.test('price acceptance: exact version, amount and text; immutable; payer-only; price changes never alter it', async () => {
    await sleep(1100);
    const base = { priceVersionId: price.id, billingAccountId: soloAccount.id, payer: { kind: 'person' as const, id: p.solo }, acceptedBy: p.solo, currency: 'USD', acceptanceTextVersion: 'terms-plan-1' };
    await rejects(as(p.solo, (trx) => priceAcceptances.accept(trx, { ...base, amountMinor: '99' })), '23514', 'billing.acceptance_mismatch');
    await rejects(as(p.solo, (trx) => priceAcceptances.accept(trx, { ...base, amountMinor: '100', acceptanceTextVersion: 'terms-plan-0' })), '23514', 'billing.acceptance_mismatch');
    // Another person cannot accept on the payer's account: the account is invisible to them, so the guard refuses it.
    await rejects(as(p.solo2, (trx) => priceAcceptances.accept(trx, { ...base, acceptedBy: p.solo2, amountMinor: '100' })), '23514', 'billing.account_mismatch');
    // Naming oneself as the payer of someone else's account is refused by the row policy.
    await rejects(as(p.solo2, (trx) => priceAcceptances.accept(trx, { ...base, payer: { kind: 'person', id: p.solo2 }, acceptedBy: p.solo2, amountMinor: '100' })), '23514', 'billing.account_mismatch');
    // A forged acceptor on one's own account is refused by the row policy (accepted_by must be the caller).
    const solo2Account = await as(p.solo2, (trx) => billingAccounts.open(trx, { hubId: w.hubId, owner: { kind: 'person', id: p.solo2 }, currency: 'USD', createdBy: p.solo2 }));
    await rejects(as(p.solo2, (trx) => priceAcceptances.accept(trx, { ...base, billingAccountId: solo2Account.id, payer: { kind: 'person', id: p.solo2 }, acceptedBy: p.solo, amountMinor: '100' })), '42501');
    await rejects(as(p.estimator, (trx) => priceAcceptances.accept(trx, { ...base, billingAccountId: companyAccount.id, payer: { kind: 'company', id: w.company }, acceptedBy: p.estimator, amountMinor: '100' })), '23514', 'billing.account_mismatch');
    // A billing viewer sees the company account but may not commit the company to a price.
    await rejects(as(p.viewer, (trx) => priceAcceptances.accept(trx, { ...base, billingAccountId: companyAccount.id, payer: { kind: 'company', id: w.company }, acceptedBy: p.viewer, amountMinor: '100' })), '42501');
    const accepted = await as(p.solo, (trx) => priceAcceptances.accept(trx, { ...base, amountMinor: '100' }));
    assert.equal(accepted.amount_minor, '100');
    await rejects(owner((trx) => trx.updateTable('price_acceptance').set({ amount_minor: '1' }).where('id', '=', accepted.id).execute()), '23000', 'audit.append_only');
    await rejects(as(p.solo, (trx) => trx.updateTable('price_acceptance').set({ amount_minor: '1' }).execute()), '42501');
    // A later price version does not touch the acceptance.
    const later = await owner((trx) => catalogue.draftPriceVersion(trx, { offerId: priced.id, amountMinor: '250', currency: 'USD', effectiveFrom: days(30), acceptanceTextVersion: 'terms-plan-2', draftedBy: p.drafter }));
    await owner((trx) => catalogue.activatePriceVersion(trx, later.id, p.activator, { supersedePrevious: true }));
    const again = await as(p.solo, (trx) => priceAcceptances.listForAccount(trx, soloAccount.id));
    assert.equal(again[0]?.amount_minor, '100');
    assert.equal(again[0]?.price_version_id, price.id);
    // Subscription starts on the owner-run path from the acceptance; the payer cancels at any time; others cannot.
    const sub = await owner((trx) => subscriptions.start(trx, { billingAccountId: soloAccount.id, offerId: priced.id, planVersionId: null, priceVersionId: price.id, priceAcceptanceId: accepted.id, status: 'active', periodStart: new Date(), periodEnd: days(30), renewsAt: days(30) }));
    await rejects(as(p.solo, (trx) => trx.insertInto('subscription').values({ billing_account_id: soloAccount.id, offer_id: priced.id, price_version_id: price.id, price_acceptance_id: accepted.id, status: 'active', current_period_start: new Date(), current_period_end: days(30) }).execute()), '42501');
    await rejects(as(p.solo, (trx) => trx.updateTable('subscription').set({ status: 'active' }).where('id', '=', sub.id).execute()), '42501');
    assert.equal(await as(p.solo2, (trx) => subscriptions.cancel(trx, sub.id, p.solo2)), undefined, 'a stranger matches no row');
    const cancelled = await as(p.solo, (trx) => subscriptions.cancel(trx, sub.id, p.solo));
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.renews_at, null);
  });

  await t.test('entitlements are separate from roles, written only on the owner-run path and private to the payer', async () => {
    await rejects(as(p.admin, (trx) => trx.insertInto('entitlement').values({ billing_account_id: companyAccount.id, offer_id: priced.id, subscription_id: null, module_code: 'quoting', valid_from: new Date(), valid_until: null, source: 'trial' }).execute()), '42501');
    const e = await owner((trx) => entitlements.grant(trx, { billingAccountId: companyAccount.id, offerId: priced.id, subscriptionId: null, moduleCode: 'quoting', validFrom: new Date(Date.now() - 1000), validUntil: days(14), source: 'trial' }));
    const seenByViewer = await as(p.viewer, (trx) => entitlements.activeForParty(trx, { kind: 'company', id: w.company }, new Date()));
    assert.deepEqual(seenByViewer.map((x) => x.id), [e.id]);
    assert.deepEqual(await as(p.estimator, (trx) => entitlements.activeForParty(trx, { kind: 'company', id: w.company }, new Date())), [], 'a member without billing permissions does not see the plan');
    assert.deepEqual(await as(p.outsider, (trx) => entitlements.activeForParty(trx, { kind: 'company', id: w.company }, new Date())), []);
  });

  await t.test('budgets: grant authority, no self-grant, project and employee scopes, kinds never mix', async () => {
    await rejects(as(p.estimator, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'company', projectId: null, employeePersonId: p.estimator, ...window, limitMinor: '1000', currency: 'USD' })), '42501', 'membership.permission_missing');
    await rejects(as(p.admin, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'company', projectId: null, employeePersonId: p.admin, ...window, limitMinor: '1000', currency: 'USD' })), '42501', 'billing.self_grant');
    await rejects(as(p.admin, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'company', projectId: null, employeePersonId: p.solo, ...window, limitMinor: '1000', currency: 'USD' })), '42501', 'billing.scope_mismatch');
    await rejects(as(p.admin, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'company', projectId: w.soloProject, employeePersonId: null, ...window, limitMinor: '1000', currency: 'USD' })), '42501', 'billing.scope_mismatch');
    await rejects(as(p.solo, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: p.solo2, ...window, limitMinor: '1000', currency: 'USD' })), '22023', 'billing.invalid_budget');
    await rejects(db.app.query("SELECT trustwork.billing_grant_budget('platform', 'person', NULL, NULL, now(), now() + interval '1 day', 10, 'USD')"), '28000');

    // The estimator gets a transaction budget for one project: it never opens platform spending.
    const tx = await as(p.admin, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'company', projectId: w.project, employeePersonId: p.estimator, ...window, limitMinor: '5000', currency: 'USD' }));
    await rejects(as(p.estimator, (trx) => reservations.reserve(trx, { budgetId: tx, kind: 'platform', amountMinor: '10', currency: 'USD', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: w.project, ttlSeconds: 600 })), '42501', 'billing.budget_kind_mismatch');
    await rejects(as(p.estimator, (trx) => reservations.reserve(trx, { budgetId: tx, kind: 'transaction', amountMinor: '10', currency: 'USD', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: null, ttlSeconds: 600 })), '42501', 'billing.scope_mismatch');
    const ok = await as(p.estimator, (trx) => reservations.reserve(trx, { budgetId: tx, kind: 'transaction', amountMinor: '10', currency: 'USD', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: w.project, ttlSeconds: 600 }));
    assert.equal(ok.state, 'reserved');
    // Transaction authority (deals.manage) gives no access to a company-wide platform budget, and the estimator sees none.
    const platform = await as(p.admin, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'company', projectId: null, employeePersonId: null, ...window, limitMinor: '5000', currency: 'USD' }));
    await rejects(as(p.estimator, (trx) => reservations.reserve(trx, { budgetId: platform, kind: 'platform', amountMinor: '10', currency: 'USD', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: null, ttlSeconds: 600 })), '42501', 'access.not_found');
    assert.deepEqual((await as(p.estimator, (trx) => budgets.listVisible(trx, 'platform'))).map((b) => b.id), []);
    // Platform authority (billing.manage) uses the platform budget but never a transaction one by kind confusion.
    await rejects(as(p.admin, (trx) => reservations.reserve(trx, { budgetId: platform, kind: 'transaction', amountMinor: '10', currency: 'USD', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: null, ttlSeconds: 600 })), '42501', 'billing.budget_kind_mismatch');
    await rejects(as(p.admin, (trx) => reservations.reserve(trx, { budgetId: tx, kind: 'transaction', amountMinor: '10', currency: 'USD', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: w.project, ttlSeconds: 600 })), '42501', 'commercial.authority_missing');
    // Outsiders and plain members cannot see or touch company budgets.
    for (const stranger of [p.outsider, p.member, p.solo]) {
      await rejects(as(stranger, (trx) => reservations.reserve(trx, { budgetId: platform, kind: 'platform', amountMinor: '1', currency: 'USD', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: null, ttlSeconds: 600 })), '42501', 'access.not_found');
      assert.equal(await as(stranger, (trx) => budgets.get(trx, platform)), undefined);
    }
    // Currency mismatch and nobody raises their own allowance.
    await rejects(as(p.estimator, (trx) => reservations.reserve(trx, { budgetId: tx, kind: 'transaction', amountMinor: '10', currency: 'EUR', actionIntentId: intent(), correlationKey: `k-${intent()}`, projectId: w.project, ttlSeconds: 600 })), '23514', 'commercial.currency_mismatch');
    const current = await as(p.estimator, (trx) => budgets.get(trx, tx));
    await rejects(as(p.estimator, (trx) => budgets.setLimit(trx, tx, '999999', current!.revision)), '42501', 'billing.self_grant');
    await rejects(as(p.admin, (trx) => budgets.setLimit(trx, tx, '5', current!.revision)), '23514', 'billing.limit_below_committed');
    await rejects(as(p.admin, (trx) => budgets.setLimit(trx, tx, '6000', current!.revision + 7)), '40001', 'validation.revision_conflict');
    const raised = await as(p.admin, (trx) => budgets.setLimit(trx, tx, '6000', current!.revision));
    assert.equal(raised.limit_minor, '6000');
    // The runtime role never writes budgets, reservations or ledger rows directly.
    await rejects(as(p.admin, (trx) => trx.updateTable('budget').set({ limit_minor: '1' }).execute()), '42501');
    await rejects(as(p.admin, (trx) => trx.insertInto('ledger_entry').values({ batch_id: randomUUID(), entry_kind: 'settlement', account_kind: 'budget', account_id: tx, owner_company_id: w.company, amount_minor: '1', currency: 'USD' }).execute()), '42501');
    await rejects(as(p.admin, (trx) => sql`SELECT trustwork.billing_refund(${ok.id}::uuid, 1, 'x')`.execute(trx)), '42501');
    await rejects(as(p.admin, (trx) => sql`SELECT trustwork.billing_expire_reservations()`.execute(trx)), '42501');
  });

  await t.test('concurrent reservations never exceed the balance (24 racers, limit for 10)', async () => {
    const budget = await as(p.solo, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'person', projectId: null, employeePersonId: null, ...window, limitMinor: '1000', currency: 'USD' }));
    const results = await Promise.all(Array.from({ length: 24 }, () => settle(as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'platform', amountMinor: '100', currency: 'USD', actionIntentId: intent(), correlationKey: `race-${intent()}`, projectId: null, ttlSeconds: 600 })))));
    assert.equal(results.filter((r) => r === null).length, 10, 'exactly the balance is reserved');
    assert.ok(results.filter((r) => r !== null).every((r) => r?.hint === 'commercial.budget_insufficient'), JSON.stringify(results.filter((r) => r && r.hint !== 'commercial.budget_insufficient')));
    const balance = await as(p.solo, (trx) => budgets.balance(trx, budget));
    assert.deepEqual(balance, { limitMinor: '1000', consumedMinor: '0', heldMinor: '1000', remainingMinor: '0', currency: 'USD' });
  });

  await t.test('idempotent per correlation key, also under concurrency; other terms are refused', async () => {
    const budget = await as(p.solo, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, ...window, limitMinor: '1000', currency: 'USD' }));
    const key = `same-${intent()}`;
    const actionIntentId = intent();
    const rows = await Promise.all(Array.from({ length: 8 }, () => as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'transaction', amountMinor: '300', currency: 'USD', actionIntentId, correlationKey: key, projectId: null, ttlSeconds: 600 }))));
    assert.equal(new Set(rows.map((r) => r.id)).size, 1, 'one reservation for one effect');
    assert.equal((await as(p.solo, (trx) => budgets.balance(trx, budget)))?.heldMinor, '300');
    await rejects(as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'transaction', amountMinor: '301', currency: 'USD', actionIntentId, correlationKey: key, projectId: null, ttlSeconds: 600 })), '23505', 'validation.idempotency_conflict');
  });

  await t.test('settlement on actual from evidence, no overrun, balanced ledger; release; refund and correction; no float', async () => {
    const big = '9007199254740993'; // 2^53 + 1: not representable as a JavaScript number
    const budget = await as(p.solo, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'person', projectId: null, employeePersonId: null, ...window, limitMinor: big, currency: 'USD' }));
    const r = await as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'platform', amountMinor: '9007199254740000', currency: 'USD', actionIntentId: intent(), correlationKey: `big-${intent()}`, projectId: null, ttlSeconds: 600 }));
    assert.equal((await as(p.solo, (trx) => budgets.balance(trx, budget)))?.remainingMinor, '993', 'exact integer arithmetic beyond 2^53');
    await rejects(as(p.solo, (trx) => reservations.settle(trx, r.id, '9007199254740001', 'outcome:1')), '23514', 'billing.settlement_exceeds_reservation');
    await rejects(as(p.solo, (trx) => reservations.settle(trx, r.id, '10', '')), '22023', 'billing.invalid_amount');
    await rejects(as(p.solo2, (trx) => reservations.settle(trx, r.id, '10', 'outcome:1')), '42501', 'access.not_found');
    const settled = await as(p.solo, (trx) => reservations.settle(trx, r.id, '9007199254739000', 'outcome:1'));
    assert.equal(settled.state, 'settled');
    assert.equal(settled.settled_minor, '9007199254739000');
    const again = await as(p.solo, (trx) => reservations.settle(trx, r.id, '9007199254739000', 'outcome:1'));
    assert.equal(again.id, settled.id, 'same settlement is idempotent');
    await rejects(as(p.solo, (trx) => reservations.release(trx, r.id, 'outcome:2')), '23514', 'billing.reservation_closed');
    const entries = await as(p.solo, (trx) => ledger.entriesForReservation(trx, r.id));
    assert.deepEqual(entries.map((e) => [e.account_kind, e.amount_minor]).sort(), [['budget', '-9007199254739000'], ['hub_revenue', '9007199254739000']]);
    assert.equal((await as(p.solo, (trx) => budgets.balance(trx, budget)))?.remainingMinor, '1993', 'the unsettled remainder is released');

    // Refunds from evidence never exceed the settlement, also concurrently.
    const refunds = await Promise.all([1, 2].map(() => settle(owner((trx) => reservations.refund(trx, r.id, '6000000000000000', 'provider:refund')))));
    assert.equal(refunds.filter((x) => x === null).length, 1, 'one refund fits, the second would exceed the settlement');
    assert.equal(refunds.find((x) => x !== null)?.hint, 'billing.refund_exceeds_settlement');
    const afterRefund = await as(p.solo, (trx) => budgets.balance(trx, budget));
    assert.equal(afterRefund?.consumedMinor, '3007199254739000');
    // Correction: reverses a batch once; reversing the refund would overrun once the room is reserved again.
    const refundEntry = (await as(p.solo, (trx) => ledger.entriesForReservation(trx, r.id))).find((e) => e.entry_kind === 'refund');
    const filler = await as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'platform', amountMinor: afterRefund!.remainingMinor, currency: 'USD', actionIntentId: intent(), correlationKey: `fill-${intent()}`, projectId: null, ttlSeconds: 600 }));
    await rejects(owner((trx) => ledger.correctBatch(trx, refundEntry!.batch_id, 'refund booked twice')), '23514', 'commercial.budget_insufficient');
    await as(p.solo, (trx) => reservations.release(trx, filler.id, 'outcome:cancelled'));
    const corrections = await Promise.all([1, 2].map(() => settle(owner((trx) => ledger.correctBatch(trx, refundEntry!.batch_id, 'refund booked twice')))));
    assert.equal(corrections.filter((x) => x === null).length, 1, 'a batch is corrected once');
    const correctionBatch = (await as(p.solo, (trx) => ledger.entriesForReservation(trx, r.id))).filter((e) => e.entry_kind === 'correction');
    assert.equal(correctionBatch.length, 2);
    await rejects(owner((trx) => ledger.correctBatch(trx, correctionBatch[0]!.batch_id, 'undo the undo')), '23505', 'billing.already_corrected');
    assert.equal((await as(p.solo, (trx) => budgets.balance(trx, budget)))?.consumedMinor, '9007199254739000');
    // Ledger rows are append-only and every batch balances.
    await rejects(owner((trx) => trx.updateTable('ledger_entry').set({ amount_minor: '1' }).where('reservation_id', '=', r.id).execute()), '23000', 'audit.append_only');
    const unbalanced = await db.admin.query("SELECT batch_id FROM trustwork.ledger_entry GROUP BY batch_id, currency HAVING sum(amount_minor) <> 0");
    assert.equal(unbalanced.rowCount, 0);
    await rejects(owner((trx) => trx.insertInto('ledger_entry').values({ batch_id: randomUUID(), entry_kind: 'settlement', account_kind: 'budget', account_id: budget, owner_person_id: p.solo, amount_minor: '-5', currency: 'USD' }).execute()), '23514', 'billing.ledger_unbalanced');
  });

  await t.test('expiry: expired holds stop counting, cannot be settled, and the sweep closes them (also racing settlement)', async () => {
    const budget = await as(p.solo, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, ...window, limitMinor: '500', currency: 'USD' }));
    const short = await as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'transaction', amountMinor: '500', currency: 'USD', actionIntentId: intent(), correlationKey: `exp-${intent()}`, projectId: null, ttlSeconds: 1 }));
    await rejects(as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'transaction', amountMinor: '1', currency: 'USD', actionIntentId: intent(), correlationKey: `exp-${intent()}`, projectId: null, ttlSeconds: 600 })), '23514', 'commercial.budget_insufficient');
    await sleep(1200);
    await rejects(as(p.solo, (trx) => reservations.settle(trx, short.id, '500', 'outcome:late')), '23514', 'billing.reservation_expired');
    const [swept, settledLate] = await Promise.all([owner((trx) => reservations.expireDue(trx)), settle(as(p.solo, (trx) => reservations.settle(trx, short.id, '500', 'outcome:late')))]);
    assert.ok(swept >= 1);
    assert.ok(settledLate !== null, 'an expired reservation is never settled');
    assert.equal((await as(p.solo, (trx) => reservations.get(trx, short.id)))?.state, 'expired');
    const fresh = await as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'transaction', amountMinor: '500', currency: 'USD', actionIntentId: intent(), correlationKey: `exp-${intent()}`, projectId: null, ttlSeconds: 600 }));
    assert.equal(fresh.state, 'reserved', 'the expired hold no longer counts');
    await rejects(owner((trx) => trx.updateTable('reservation').set({ state: 'reserved', closed_at: null }).where('id', '=', short.id).execute()), '23000', 'billing.reservation_closed');
    // A closed budget accepts no new reservation; open ones can still settle.
    await as(p.solo, (trx) => budgets.close(trx, budget));
    await rejects(as(p.solo, (trx) => reservations.reserve(trx, { budgetId: budget, kind: 'transaction', amountMinor: '1', currency: 'USD', actionIntentId: intent(), correlationKey: `exp-${intent()}`, projectId: null, ttlSeconds: 600 })), '23514', 'billing.budget_inactive');
    assert.equal((await as(p.solo, (trx) => reservations.settle(trx, fresh.id, '400', 'outcome:delivered'))).state, 'settled');
  });

  await t.test('former employees lose budget access; employer budgets are invisible after the membership ends', async () => {
    const leaver = await owner(async (trx) => (await trx.insertInto('person').values({ display_name: 'Synthetic Leaver' }).returningAll().executeTakeFirstOrThrow()).id);
    await owner((trx) => trx.insertInto('membership').values({ person_id: leaver, company_id: w.company, role: 'member', permissions: [], status: 'active', valid_from: new Date('2026-10-01T09:00:00Z') }).execute());
    const b = await as(p.admin, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'company', projectId: null, employeePersonId: leaver, ...window, limitMinor: '100', currency: 'USD' }));
    assert.ok(await as(leaver, (trx) => budgets.get(trx, b)));
    await owner((trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: p.admin, ended_reason: 'synthetic: left' }).where('person_id', '=', leaver).execute());
    assert.equal(await as(leaver, (trx) => budgets.get(trx, b)), undefined);
    await rejects(as(leaver, (trx) => reservations.reserve(trx, { budgetId: b, kind: 'platform', amountMinor: '1', currency: 'USD', actionIntentId: intent(), correlationKey: `leaver-${intent()}`, projectId: null, ttlSeconds: 600 })), '42501', 'access.not_found');
  });

  await t.test('usage records: idempotent per run step, attempt and meter; overage needs a rate and a platform reservation', async () => {
    const rate = await owner(async (trx) => {
      const d = await catalogue.draftMeterRate(trx, { hubId: w.hubId, meter: 'agent_actions', providerClass: null, currency: 'USD', pricePerThousandMinor: '1', passThrough: false, effectiveFrom: inSeconds(1), draftedBy: p.drafter });
      return catalogue.activateMeterRate(trx, d.id, p.activator);
    });
    const step = { runId: randomUUID(), runStepId: randomUUID(), attemptId: randomUUID() };
    const base = { principal: { kind: 'person' as const, id: p.solo }, billingAccountId: soloAccount.id, moduleKey: 'quoting', capabilityId: 'quoting.send_quote', connectionId: null, meter: 'agent_actions' as const, providerClass: null, ...step };
    const first = await owner((trx) => usageRecords.record(trx, { ...base, units: '3', withinIncludedQuota: true, meterRateVersionId: null, reservationId: null }));
    const replay = await owner((trx) => usageRecords.record(trx, { ...base, units: '999', withinIncludedQuota: true, meterRateVersionId: null, reservationId: null }));
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.units, '3', 'a replay never changes recorded usage');
    await rejects(owner((trx) => usageRecords.record(trx, { ...base, runStepId: randomUUID(), units: '5', withinIncludedQuota: false, meterRateVersionId: rate.id, reservationId: null })), '23514');
    const txBudget = await as(p.solo, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'person', projectId: null, employeePersonId: null, ...window, limitMinor: '100', currency: 'USD' }));
    const txReservation = await as(p.solo, (trx) => reservations.reserve(trx, { budgetId: txBudget, kind: 'transaction', amountMinor: '5', currency: 'USD', actionIntentId: intent(), correlationKey: `use-${intent()}`, projectId: null, ttlSeconds: 600 }));
    await rejects(owner((trx) => usageRecords.record(trx, { ...base, runStepId: randomUUID(), units: '5', withinIncludedQuota: false, meterRateVersionId: rate.id, reservationId: txReservation.id })), '23514', 'billing.budget_kind_mismatch');
    await rejects(owner((trx) => usageRecords.record(trx, { ...base, principal: { kind: 'person', id: p.solo2 }, runStepId: randomUUID(), units: '1', withinIncludedQuota: true, meterRateVersionId: null, reservationId: null })), '23514', 'billing.account_mismatch');
    await rejects(owner((trx) => trx.updateTable('usage_record').set({ units: '0' }).where('id', '=', first.record.id).execute()), '23000', 'audit.append_only');
    assert.equal((await as(p.solo2, (trx) => trx.selectFrom('usage_record').selectAll().execute())).length, 0, 'usage is private');
  });

  await t.test('credits: capped per staff role, never to oneself or one\'s employer, posted to the ledger, never expiring silently', async () => {
    const cap = { roleKey: 'support_agent', capMinor: '500' };
    await rejects(owner((trx) => creditGrants.grant(trx, { billingAccountId: soloAccount.id, amountMinor: '501', reasonCode: 'goodwill', issuedBy: p.drafter, capCheck: cap, caseId: null, validUntil: null, expiryDisclosureKey: null })), '23514');
    await rejects(owner((trx) => creditGrants.grant(trx, { billingAccountId: soloAccount.id, amountMinor: '100', reasonCode: 'goodwill', issuedBy: p.solo, capCheck: cap, caseId: null, validUntil: null, expiryDisclosureKey: null })), '42501', 'billing.self_credit');
    await rejects(owner((trx) => creditGrants.grant(trx, { billingAccountId: companyAccount.id, amountMinor: '100', reasonCode: 'goodwill', issuedBy: p.viewer, capCheck: cap, caseId: null, validUntil: null, expiryDisclosureKey: null })), '42501', 'billing.self_credit');
    await rejects(owner((trx) => creditGrants.grant(trx, { billingAccountId: soloAccount.id, amountMinor: '100', reasonCode: 'goodwill', issuedBy: p.drafter, capCheck: cap, caseId: null, validUntil: days(90), expiryDisclosureKey: null })), '23514');
    const credit = await owner((trx) => creditGrants.grant(trx, { billingAccountId: soloAccount.id, amountMinor: '100', reasonCode: 'goodwill', issuedBy: p.drafter, capCheck: cap, caseId: randomUUID(), validUntil: days(90), expiryDisclosureKey: 'billing.credit.expiryNotice' }));
    const legs = await owner((trx) => trx.selectFrom('ledger_entry').select(['account_kind', 'amount_minor']).where('credit_grant_id', '=', credit.id).execute());
    assert.deepEqual(legs.map((l) => [l.account_kind, l.amount_minor]).sort(), [['billing_account', '100'], ['hub_revenue', '-100']]);
    assert.equal((await as(p.solo, (trx) => trx.selectFrom('credit_grant').selectAll().execute())).length, 1);
    assert.equal((await as(p.solo2, (trx) => trx.selectFrom('credit_grant').selectAll().execute())).length, 0);
    await rejects(as(p.solo, (trx) => sql`SELECT trustwork.billing_grant_credit(${soloAccount.id}::uuid, 1, 'goodwill', ${p.drafter}::uuid, '{"roleKey":"x","capMinor":"5"}'::jsonb, NULL, NULL, NULL)`.execute(trx)), '42501');
  });
});
