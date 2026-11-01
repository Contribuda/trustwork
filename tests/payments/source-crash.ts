import assert from 'node:assert/strict';
import type { CrashContext } from '../backend/idempotency/cases.js';
import type { sourceWorld } from './source-helpers.js';
import { agreement, ok } from './helpers.js';
import type { PaymentAuthorizationView } from '../../packages/contracts/src/payment-sources.js';

/** Seven real source mutations use the owning BE-005 rollback/replay harness, including automatic publication. */
export async function sourceCrashCases({ h, seed, as, exactlyOnce }: CrashContext, w: Awaited<ReturnType<typeof sourceWorld>>) {
  const buyer = await as('petr'), seller = await as('carl');
  await w.challenge(buyer, false, (input) => exactlyOnce({ action: 'payments.source_challenge', client: buyer, url: '/v1/payments/sources/challenges', body: input,
    effects: async () => (await w.q('SELECT id FROM trustwork.payment_source_challenge WHERE person_id=$1', [seed.people.petr])).length }));
  const payer = await w.bind(buyer), payee = await w.bind(seller, true, false);
  const staff = await w.staffClient('officer'), base = `/v1/admin/payments/source-bindings/${payee.participant}`;
  const material = ok<{ digest: string; action: 'payments.activate_account_binding' }>(await exactlyOnce({ action: 'payments.source_review_material', client: staff,
    url: `${base}/review`, body: { reason: 'Synthetic crash review' },
    effects: async () => (await w.q("SELECT id FROM trustwork.admin_audit_event WHERE object_id=$1 AND action='payments.source_review_material'", [payee.participant])).length }));
  const approvalId = await w.approveDigest(w.w.people.officer, w.w.people.moderator, material.action, material.digest);
  await exactlyOnce({ action: 'payments.source_review_activate', client: staff, url: `${base}/activate`, body: { reason: 'Synthetic crash activation', approvalId },
    effects: async () => (await w.q('SELECT id FROM trustwork.payment_binding_review WHERE participant_binding_id=$1', [payee.participant])).length });
  const a = (await agreement(h, buyer, seller, seed.people.petr, seed.people.carl)).agreement;
  const authorization = ok<PaymentAuthorizationView>(await exactlyOnce({ action: 'payments.authorization_draft', client: buyer, url: '/v1/payments/sources/authorizations',
    body: { agreementId: a.id, payerBindingId: payer.participant, payeeBindingId: payee.participant, accountBindingId: payee.account!, publisherRegistrationId: w.issuers.publisher.id, rail: 'qr' },
    effects: async () => (await w.q('SELECT id FROM trustwork.payment_authorization_version WHERE agreement_id=$1', [a.id])).length }), 201);
  ok(await buyer.post(`/v1/payments/sources/authorizations/${authorization.id}/accept`, { digest: authorization.digest }));
  await exactlyOnce({ action: 'payments.authorization_accept', client: seller, url: `/v1/payments/sources/authorizations/${authorization.id}/accept`, body: { digest: authorization.digest },
    effects: async () => (await w.q('SELECT id FROM trustwork.payment_source_version WHERE authorization_id=$1', [authorization.id])).length });
  assert.equal((await w.q('SELECT * FROM trustwork.payment_authorization_acceptance WHERE authorization_id=$1', [authorization.id])).length, 2);
  await exactlyOnce({ action: 'payments.source_revoke', client: buyer, url: `/v1/payments/sources/${payer.participant}/revoke`, body: { kind: 'participant' },
    effects: async () => (await w.q('SELECT id FROM trustwork.payment_participant_binding_version WHERE id=$1 AND revoked_at IS NOT NULL', [payer.participant])).length });
  const source = (await w.q('SELECT id FROM trustwork.payment_source_version WHERE authorization_id=$1', [authorization.id]))[0]!;
  await exactlyOnce({ action: 'payments.source_staff_revoke', client: staff, url: `/v1/admin/payments/source-bindings/${source.id}/revoke`, body: { kind: 'source', reason: 'Synthetic crash withdrawal' },
    effects: async () => (await w.q('SELECT id FROM trustwork.payment_source_version WHERE id=$1 AND revoked_at IS NOT NULL', [source.id])).length });
}
