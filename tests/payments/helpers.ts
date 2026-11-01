import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPool, withMaintenance } from '@trustwork/data';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import type { BuyerAgreementView, SellerAgreementView, SellerQuoteView } from '../../packages/contracts/src/deals.js';
import { adminSetup, staffRoleDefinitions, staffAssignments, approvals, adminDigests } from '../../packages/data/src/repositories/admin.js';
import { hubConfig } from '../../packages/data/src/repositories/hubs.js';
import { providerConnections } from '../../packages/data/src/repositories/providers.js';
import { configActivationDigestInput } from '../../packages/contracts/src/hub-core.js';
import { actors, KEYS, type Key, type HubWorld } from '../hubs/helpers.js';
import { PROVIDER_DEFINITIONS, setUpHubs, activateResidency, SELF_US } from '../providers/helpers.js';
import { as, personalBudget } from '../assistant/helpers.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import type { Harness, Client, Response } from '../backend/helpers/app.js';

export function ok<T>(r: Response, code = 200): T { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body as T; }
const actor = { via: 'person' };
const electronicRecords = { consented: true, disclosureKey: 'trustwork.electronic-records.v1' };
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const date = { date: '2027-03-20', timeZone: 'America/Los_Angeles' };
const ref = (v: { id: string; version: number; digest: unknown }) => ({ id: v.id, version: v.version, digest: v.digest });

/** Real immutable RFQ/quote/acceptance path, with labelled synthetic parties and an integer total. */
export async function agreement(h: Harness, buyer: Client, seller: Client, buyerId: string, sellerId: string, amount = '1250', buyerCompanyId?: string): Promise<BuyerAgreementView> {
  let rfq = ok<OwnerRfqView>(await buyer.post('/v1/rfqs', {
    owner: buyerCompanyId ? { kind: 'company', id: buyerCompanyId } : { kind: 'person', id: buyerId }, projectId: null, category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: null, source: null, actor,
    payload: { title: 'Synthetic payment fixture', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: 'Net 30', acceptanceCriteria: 'Synthetic acceptance',
      deliveryTerms: { location: { region: 'US-CA' }, window: { from: date, to: date } },
      lines: [{ lineId: 'goods', kind: 'goods', description: 'Synthetic goods', specification: { thickness: '60 mm' }, quantity: { value: '1', unit: 'm2' }, alternativesAllowed: false }] },
  }), 201);
  rfq = ok(await buyer.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor }));
  ok(await buyer.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party: { kind: 'person', id: sellerId }, channel: 'platform', actor }), 201);
  let quote = ok<SellerQuoteView>(await seller.post('/v1/quotes', { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, seller: { kind: 'person', id: sellerId }, privateConstraint: null, actor,
    payload: { currency: 'USD', paymentTerms: 'Net 30', validity: { until: '2027-06-01T00:00:00.000Z' }, exclusions: [], attachments: [], deliveryTerms: { milestones: [{ description: 'Synthetic delivery', due: date }], location: 'Synthetic site' },
      totals: { net: money(amount), tax: money('0'), gross: money(amount) },
      lines: [{ lineId: 'goods', rfqLineId: 'goods', kind: 'goods', specSnapshot: { thickness: '60 mm' }, offeringVersionRef: null, quantity: { value: '1', unit: 'm2' }, unitPrice: money(amount), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: money('0'), lineTotal: money(amount), substitution: null, options: [] }] },
  }), 201);
  quote = ok(await seller.post(`/v1/quotes/${quote.quote.id}/send`, { quoteId: quote.quote.id, version: 1, expectedRevision: quote.quote.revision, actor }));
  const created = ok<BuyerAgreementView>(await buyer.post('/v1/agreements', { rfqId: rfq.rfq.id, quoteVersion: ref(quote.versions[0]!), rfqVersion: ref(rfq.versions[0]!), expectedRevision: quote.quote.revision, electronicRecords, actor }), 201);
  const id = created.agreement.id;
  const transactionBudgetId = buyerCompanyId ? await as(h, buyerId, (trx) => budgets.grant(trx, { kind: 'transaction', owner: 'company', projectId: null, employeePersonId: null, periodFrom: new Date(Date.now() - 3600_000), periodTo: new Date(Date.now() + 365 * 86400_000), limitMinor: '1000000', currency: 'USD' })) : await personalBudget(h, buyerId, 'transaction', '1000000');
  ok(await buyer.post(`/v1/agreements/${id}/orders`, { action: 'place_order', context: { kind: 'rfq', id: rfq.rfq.id }, agreementId: id, quoteVersion: created.agreement.acceptedTerms.quoteVersion, rfqVersion: created.agreement.acceptedTerms.rfqVersion, expectedRevision: created.agreement.revision, transactionBudgetId, platformBudgetId: null, externalReference: null, actor }), 201);
  const side = ok<SellerAgreementView>(await seller.get(`/v1/agreements/${id}`));
  ok(await seller.post(`/v1/agreements/${id}/accept`, { expectedRevision: side.agreement.revision, acceptedTermsDigest: side.agreement.acceptedTerms.digest, electronicRecords, actor }));
  return ok(await buyer.get(`/v1/agreements/${id}`));
}

/** Synthetic staff definitions, real two-person hub configuration, and real fake-connection enable path. */
export async function paymentHub(h: Harness) {
  const w = await withMaintenance(h.db.admin, async (trx): Promise<HubWorld> => {
    for (const def of PROVIDER_DEFINITIONS) {
      const permissions = [...def.permissions];
      if (def.role === 'hub-owner' || def.role === 'compliance-officer') permissions.push('admin.hub.payments.edit');
      await staffRoleDefinitions.release(trx, { version: 20, role: def.role, scopes: def.scopes, permissions, caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    }
    const existingNode = await adminSetup.node(trx);
    const { id: nodeId } = existingNode ?? await adminSetup.createNode(trx, 'Synthetic payments node');
    const founders = existingNode ? await trx.selectFrom('staff_role_assignment').select(['person_id', 'role']).where('setup_bootstrap', '=', true).where('revoked_at', 'is', null).execute() : [];
    const people = {} as Record<Key, string>;
    const sessions = {} as Record<Key, string>;
    for (const key of KEYS) {
      const founder = key === 'founder' ? founders.find((f) => f.role === 'platform-owner') : key === 'founder2' ? founders.find((f) => f.role === 'staff-admin') : undefined;
      people[key] = founder?.person_id ?? (await trx.insertInto('person').values({ display_name: `Synthetic payment ${key}` }).returning('id').executeTakeFirstOrThrow()).id;
      sessions[key] = (await trx.insertInto('session').values({ person_id: people[key], token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 86400000), absolute_expires_at: new Date(Date.now() + 86400000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow()).id;
    }
    if (!existingNode) await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder, role: 'platform-owner', scope: { kind: 'platform' }, definitionVersion: 20, reason: 'Synthetic setup' });
    if (!existingNode) await adminSetup.bootstrapFirstAdmin(trx, { personId: people.founder2, role: 'staff-admin', scope: { kind: 'platform' }, definitionVersion: 20, reason: 'Synthetic setup' });
    return { nodeId, people, sessions };
  });
  const base = actors(h.db.admin, h.pool, w);
  const a = { ...base,
    assign: async (input: Parameters<typeof base.assign>[0]) => base.cmd(w.people.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { ...input, definitionVersion: 20 })),
    assignSensitive: async (input: Parameters<typeof base.assignSensitive>[0]) => {
      const digest = adminDigests.assignment({ breakglass: false, ...input, definitionVersion: 20 });
      const ownerCtx = await base.elevate(w.people.founder);
      const request = await base.as(w.people.founder, (trx) => approvals.request(trx, ownerCtx, { action: 'staff.assign_sensitive_role', scope: input.scope, actionDigest: digest }));
      await base.cmd(w.people.founder2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
      return base.as(w.people.founder, (trx) => staffAssignments.assign(trx, ownerCtx, { ...input, definitionVersion: 20, approvalId: request.id }));
    },
  };
  const { hubA } = await setUpHubs(a, w, 'synthetic-payments');
  await activateResidency(a, w.people.owner, w.people.officer, hubA, ['US']);
  let c = await a.cmd(w.people.owner, (trx, ctx) => providerConnections.create(trx, ctx, hubA, { adapterId: 'fake', mode: 'fake', label: 'Synthetic payment provider', capabilities: ['payments', 'payouts'], endpoint: null, hosting: SELF_US, storageCountry: null, region: null, credentialRefId: null }));
  const material = await a.cmd(w.people.owner, (trx, ctx) => providerConnections.testMaterial(trx, ctx, c.id));
  await a.cmd(w.people.owner, (trx, ctx) => providerConnections.recordTest(trx, ctx, c.id, { configDigest: material.config_digest, outcome: 'ok', latencyMs: 1, modelsListed: 0, cost: null, probeDigest: 'a'.repeat(64), secretRefId: material.secret_ref_id }));
  c = await a.cmd(w.people.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, c.id, (await providerConnections.get(trx, c.id))!.revision, null));
  const payload = { hubId: hubA, version: 1, providers: [{ connectionId: c.id, capabilities: ['payments', 'payouts'], licence: null }], fundsHeldBy: 'licensed_payment_provider', operatorAccountInFundsFlow: false, escrowAndRetainage: 'off', demoNoMoneyMoves: true };
  const v = await a.cmd(w.people.owner, (trx, ctx) => hubConfig.draft(trx, ctx, hubA, 'payments', payload));
  const approval = await a.approve(w.people.officer, w.people.owner, 'payments.change_settings', hubA, configActivationDigestInput({ id: v.id, hubId: hubA, domain: 'payments', version: v.version, payloadDigest: v.payload_digest }));
  await a.cmd(w.people.officer, (trx, ctx) => hubConfig.activate(trx, ctx, v.id, null, approval));
  await h.db.admin.query("INSERT INTO trustwork.payment_rail(connection_id,currencies,countries,rails,capabilities,custody,evidence_mode,approval_ref) VALUES($1,ARRAY['USD'],ARRAY['US'],ARRAY['qr'],ARRAY['create','confirm','refund','payout','connected_account'],'provider_connected_accounts','synthetic','synthetic-fixture-only')", [c.id]);
  return { hubId: hubA, connectionId: c.id, a, w };
}

/** Synthetic test-only verifier login; never inherits app/worker privileges or owns data. */
export async function paymentVerifier(h: Harness) {
  const role = `payment_verifier_test_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await h.db.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await h.db.admin.query(`GRANT USAGE ON SCHEMA trustwork TO ${role}`);
  await h.db.admin.query(`GRANT EXECUTE ON FUNCTION trustwork.payments_receipt(jsonb) TO ${role}`);
  const pool = createPool({ ...h.db.appConfig, user: role, password, max: 4 });
  return { pool, async close() {
    await pool.end();
    await h.db.admin.query(`REVOKE ALL ON FUNCTION trustwork.payments_receipt(jsonb) FROM ${role}`);
    await h.db.admin.query(`REVOKE USAGE ON SCHEMA trustwork FROM ${role}`);
    await h.db.admin.query(`DROP ROLE ${role}`);
  } };
}
