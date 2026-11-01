import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, type Transaction } from '@trustwork/data';
import type { Principal } from '../../packages/contracts/src/index.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { PrincipalService } from '../../apps/api/src/modules/identity/principal.service.js';
import { startHarness, SKIP_REASON, type Client } from '../backend/helpers/app.js';
import { seedPersonas, login } from '../backend/helpers/personas.js';
import { recordState } from '../backend/idempotency/helpers.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { memberships } from '../../packages/data/src/repositories/company.js';
import { paymentSources } from '../../packages/data/src/repositories/payment-sources.js';
import { screenEveryoneClear } from '../screening-gates/helpers.js';
import { sourceWorld } from './source-helpers.js';
import { ok } from './helpers.js';
import type { PaymentView } from '../../packages/contracts/src/payments.js';
const h = await startHarness('payment_request_admission');
test('PAY-001 original HTTP request authority cannot silently refresh before its mutation', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const w = await sourceWorld(h); t.after(async () => { await w.close(); await h.close(); });
  await screenEveryoneClear(h.db.admin);
  const buyer = h.client(), seller = h.client(), staff = await w.staffClient('officer');
  await login(buyer, 'petr'); await login(seller, 'carl');
  const actions = ['create', 'confirm', 'refund', 'payout', 'connected_account', 'source_challenge', 'authorization_draft', 'authorization_accept', 'source_revoke', 'source_review_material', 'source_review_activate', 'source_staff_revoke', 'outside_draft', 'outside_accept'] as const;
  type Action = typeof actions[number];
  const prepare = async (action: Action): Promise<{ client: Client; url: string; body: unknown; status: number }> => {
    if (action === 'source_challenge') return { client: buyer, url: '/v1/payments/sources/challenges', body: { hubId: w.hubId, connectionId: w.connectionId,
      identityRegistrationId: w.issuers.identity_link.id, accountRegistrationId: null, purpose: 'payment_participant' }, status: 201 };
    if (action === 'source_review_material' || action === 'source_review_activate') {
      const b = await w.bind(seller, true, false), body: { reason: string; approvalId?: string } = { reason: 'Synthetic immutable request admission' };
      if (action === 'source_review_activate') {
        const material = await w.a.cmd(w.w.people.officer, (trx, ctx) => paymentSources.reviewMaterial(trx, ctx, b.participant));
        body.approvalId = await w.approveDigest(w.w.people.officer, w.w.people.moderator, material.action, material.digest);
      }
      return { client: staff, url: `/v1/admin/payments/source-bindings/${b.participant}/${action === 'source_review_material' ? 'review' : 'activate'}`, body, status: 200 };
    }
    await w.providerEnabled(true);
    const f = await w.fresh(buyer, seller, seed.people.petr, seed.people.carl);
    if (action === 'outside_draft' || action === 'outside_accept') {
      const publisher = await w.registerDecisionPublisher(); await w.providerEnabled(false);
      const body = { agreementId: f.payment.agreementId, payerBindingId: f.payer.participant, payeeBindingId: f.payee.participant, publisherRegistrationId: publisher.id };
      if (action === 'outside_draft') return { client: buyer, url: '/v1/payments/sources/outside-platform', body, status: 201 };
      const decision = ok<{ id: string; digest: string }>(await buyer.post('/v1/payments/sources/outside-platform', body), 201);
      ok(await buyer.post(`/v1/payments/sources/outside-platform/${decision.id}/accept`, { digest: decision.digest }));
      return { client: seller, url: `/v1/payments/sources/outside-platform/${decision.id}/accept`, body: { digest: decision.digest }, status: 200 };
    }
    if (action === 'authorization_draft') return { client: buyer, url: '/v1/payments/sources/authorizations', body: f.body, status: 201 };
    if (action === 'authorization_accept') return { client: seller, url: `/v1/payments/sources/authorizations/${f.authorization.id}/accept`, body: { digest: f.authorization.digest }, status: 200 };
    if (action === 'source_revoke') return { client: buyer, url: `/v1/payments/sources/${f.payer.participant}/revoke`, body: { kind: 'participant' }, status: 200 };
    for (const client of [buyer, seller]) ok(await client.post(`/v1/payments/sources/authorizations/${f.authorization.id}/accept`, { digest: f.authorization.digest }));
    if (action === 'source_staff_revoke') {
      const [row] = await w.q('SELECT id FROM trustwork.payment_source_version WHERE authorization_id=$1', [f.authorization.id]);
      return { client: staff, url: `/v1/admin/payments/source-bindings/${row!.id}/revoke`, body: { reason: 'Synthetic stale withdrawal', kind: 'source' }, status: 200 };
    }
    if (action === 'create') return { client: buyer, url: '/v1/payments', body: f.payment, status: 201 };
    const payment = ok<PaymentView>(await buyer.post('/v1/payments', f.payment), 201);
    const [op] = await w.q('SELECT id FROM trustwork.payment_operation WHERE payment_id=$1', [payment.id]);
    w.fake.plan(op!.id as string, action === 'confirm' ? 'requires_confirmation' : 'succeeded'); await w.tick();
    return { client: buyer, url: `/v1/payments/${payment.id}/${action === 'connected_account' ? 'connected-account' : action}`, body: {}, status: 200 };
  };
  const counts = () => w.q(`SELECT
    (SELECT count(*) FROM trustwork.payment_outside_platform_version) AS outside_decisions,
    (SELECT count(*) FROM trustwork.payment_outside_platform_acceptance) AS outside_acceptances,
    (SELECT count(*) FROM trustwork.payment_intent) AS intents,
    (SELECT count(*) FROM trustwork.payment_operation) AS operations,
    (SELECT count(*) FROM trustwork.payment_source_challenge) AS challenges,
    (SELECT count(*) FROM trustwork.payment_authorization_version) AS authorizations,
    (SELECT count(*) FROM trustwork.payment_authorization_acceptance) AS acceptances,
    (SELECT count(*) FROM trustwork.payment_binding_review) AS reviews,
    (SELECT count(*) FROM trustwork.payment_source_version) AS sources,
    (SELECT count(*) FROM trustwork.outbox_event) AS outbox,
    (SELECT count(*) FROM trustwork.admin_audit_event) AS staff_audit,
    (SELECT count(*) FROM trustwork.audit_event) AS audit`);
  let captured: RequestState | undefined;
  for (const action of actions) await t.test(`actual HTTP ${action} refuses the already resolved epoch; fresh requests still work`, async () => {
    const request = await prepare(action);
    const original = PrincipalService.prototype.runAs;
    let entered = 0, armed = true, before: Awaited<ReturnType<typeof counts>> | undefined, snapshot: RequestState | undefined;
    PrincipalService.prototype.runAs = async function<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>, options?: Parameters<PrincipalService['runAs']>[2]): Promise<T> {
      if (!armed) return original.call(this, state, fn, options) as Promise<T>;
      armed = false; captured = state; snapshot = structuredClone(state);
      // Real resolved HTTP state is retained. The owning epoch writer wins before the callback transaction.
      if (action === 'authorization_accept') {
        // The owner-run synthetic membership command exercises its real epoch-bump trigger too.
        await withMaintenance(h.db.admin, async (trx) => {
          const m = (await memberships.getById(trx, seed.memberships.carl))!;
          await memberships.changeRole(trx, m.id, m.revision, m.role, [...m.permissions, 'company.billing.view']);
        });
      } else await w.q('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [state.principal!.personId]);
      before = await counts();
      return original.call(this, state, async (trx, principal) => { entered++; return fn(trx, principal); }, options) as Promise<T>;
    };
    const key = `source-original-request-${action}`;
    try {
      const response = await request.client.post(request.url, request.body, { idempotencyKey: key });
      assert.equal(armed, false, 'the real registered controller entered its principal service');
      assert.equal(entered, 0, `${action}: stale original request must not enter a mutation callback`);
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.deepEqual(captured, snapshot, 'no in-place reinterpretation of the original RequestState');
      assert.deepEqual(await counts(), before, 'no mutation, review, consent, audit or outbox completion');
      const record = await recordState(h.db.admin, key);
      // The existing BE-005 interceptor stores the refusal envelope outside the handler. Never a successful completion.
      assert.equal(record?.result?.httpStatus, 409);
    } finally { PrincipalService.prototype.runAs = original; }
    const fresh = await prepare(action);
    assert.equal((await fresh.client.post(fresh.url, fresh.body)).status, fresh.status);
    await w.relay.relayOnce(); await w.q("UPDATE trustwork.job SET state='dead' WHERE kind='payments.dispatch' AND state='queued'");
  });
  await t.test('unrelated default refresh and PRV repeatable-read snapshot behavior remain intact', async () => {
    assert.ok(captured);
    await w.q('UPDATE trustwork.person SET authz_epoch=authz_epoch+1 WHERE id=$1', [captured.principal!.personId]);
    const before = captured.principal!.authzEpoch;
    const result = await h.services().principals.runAs(captured, async (trx, principal) => ({ epoch: principal.authzEpoch,
      isolation: (await sql<{ transaction_isolation: string }>`SHOW transaction_isolation`.execute(trx)).rows[0]!.transaction_isolation }), { snapshot: true });
    assert.ok(result.epoch > before); assert.equal(result.isolation, 'repeatable read');
  });
});
