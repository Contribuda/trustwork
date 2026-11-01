import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';
import { PaymentAdapterRegistrationSchema, PaymentAuthorizationViewSchema, PaymentSourceChallengeViewSchema, PaymentSourceOwnBindingsSchema,
  PaymentSourceReviewMaterialSchema, type PaymentAdapterRegistration, type PaymentSourceAssertion, type PaymentSourceChallengeCommand } from '../../../contracts/src/payment-sources.js';

async function bounded(trx: Transaction) { await sql`SET LOCAL statement_timeout='5s'`.execute(trx); }
export const paymentSources = {
  async proposeAdapter(trx: Transaction, ctx: CommandContext, input: PaymentAdapterRegistration) {
    await bounded(trx);
    return (await sql<{ value: { id: string; digest: string } }>`SELECT trustwork.payments_propose_source_adapter(${JSON.stringify(ctx)}::jsonb,${JSON.stringify(input)}::jsonb) AS value`.execute(trx)).rows[0]!.value;
  },
  async activateAdapter(trx: Transaction, ctx: CommandContext, id: string, approvalId: string) {
    await bounded(trx); await sql`SELECT trustwork.payments_activate_source_adapter(${JSON.stringify(ctx)}::jsonb,${id}::uuid,${approvalId}::uuid)`.execute(trx);
  },
  async verifierRegistration(trx: Transaction, id: string) {
    await bounded(trx);
    return PaymentAdapterRegistrationSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.payments_source_verifier_registration(${id}::uuid) AS value`.execute(trx)).rows[0]!.value);
  },
  async recordAssertion(trx: Transaction, evidence: PaymentSourceAssertion) {
    await bounded(trx); await sql`SELECT trustwork.payments_source_record_assertion(${JSON.stringify(evidence)}::jsonb)`.execute(trx);
  },
  async challenge(trx: Transaction, sessionId: string, input: PaymentSourceChallengeCommand, nonce: string) {
    await bounded(trx);
    return PaymentSourceChallengeViewSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.payments_source_challenge(${sessionId}::uuid,${JSON.stringify(input)}::jsonb,${nonce}) AS value`.execute(trx)).rows[0]!.value);
  },
  async ownBindings(trx: Transaction) {
    await bounded(trx); return PaymentSourceOwnBindingsSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.payments_source_own_bindings() AS value`.execute(trx)).rows[0]!.value);
  },
  async reviewMaterial(trx: Transaction, ctx: CommandContext, id: string) {
    await bounded(trx);
    return PaymentSourceReviewMaterialSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.payments_source_review_material(${JSON.stringify(ctx)}::jsonb,${id}::uuid) AS value`.execute(trx)).rows[0]!.value);
  },
  async acceptBinding(trx: Transaction, ctx: CommandContext, id: string, approvalId: string) {
    await bounded(trx); await sql`SELECT trustwork.payments_accept_source_binding(${JSON.stringify(ctx)}::jsonb,${id}::uuid,${approvalId}::uuid)`.execute(trx);
    return { accepted: true as const };
  },
  async draftAuthorization(trx: Transaction, sessionId: string, input: unknown) {
    await bounded(trx);
    return PaymentAuthorizationViewSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.payments_draft_authorization(${sessionId}::uuid,${JSON.stringify(input)}::jsonb) AS value`.execute(trx)).rows[0]!.value);
  },
  async authorization(trx: Transaction, id: string) {
    await bounded(trx); return PaymentAuthorizationViewSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.payments_authorization_view(${id}::uuid) AS value`.execute(trx)).rows[0]!.value);
  },
  async acceptAuthorization(trx: Transaction, sessionId: string, id: string, digest: string) {
    await bounded(trx);
    return PaymentAuthorizationViewSchema.parse((await sql<{ value: unknown }>`SELECT trustwork.payments_accept_authorization(${sessionId}::uuid,${id}::uuid,${digest}) AS value`.execute(trx)).rows[0]!.value);
  },
  async staffRevoke(trx: Transaction, ctx: CommandContext, kind: string, id: string) {
    await bounded(trx); await sql`SELECT trustwork.payments_staff_revoke_source(${JSON.stringify(ctx)}::jsonb,${kind},${id}::uuid)`.execute(trx);
    return { revoked: true as const };
  },
  async revoke(trx: Transaction, sessionId: string, kind: string, id: string) {
    await bounded(trx); await sql`SELECT trustwork.payments_revoke_source(${sessionId}::uuid,${kind},${id}::uuid)`.execute(trx);
    return { revoked: true as const };
  },
};
