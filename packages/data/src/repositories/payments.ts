import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { PaymentEvidence, PaymentInstruction } from '../../../contracts/src/payments.js';
import { PaymentViewSchema } from '../../../contracts/src/payments.js';

export const payments = {
  async reconcileDue(trx: Transaction): Promise<string[]> {
    return (await sql<{ id: string }>`SELECT trustwork.payments_reconcile_due() AS id`.execute(trx)).rows.map((r) => r.id);
  },
  async request(trx: Transaction, agreementId: string, budgetId: string, sessionId: string) {
    const r = await sql<{ value: unknown }>`SELECT trustwork.payments_request(${agreementId}::uuid,${budgetId}::uuid,${sessionId}::uuid) AS value`.execute(trx);
    return PaymentViewSchema.parse(r.rows[0]?.value);
  },
  async read(trx: Transaction, id: string) {
    const r = await sql<{ value: unknown }>`SELECT trustwork.payments_read(${id}::uuid) AS value`.execute(trx);
    return PaymentViewSchema.parse(r.rows[0]?.value);
  },
  async action(trx: Transaction, id: string, kind: string, sessionId: string) {
    const r = await sql<{ id: string }>`SELECT trustwork.payments_action(${id}::uuid,${kind},${sessionId}::uuid) AS id`.execute(trx);
    return { operationId: r.rows[0]!.id };
  },
  async attachJob(trx: Transaction, operationId: string, jobId: string) {
    await sql`SELECT trustwork.payments_attach_job(${operationId}::uuid,${jobId}::uuid)`.execute(trx);
  },
  async begin(trx: Transaction, operationId: string, jobId: string, fence: string, attempt: string): Promise<PaymentInstruction | null> {
    const r = await sql<{ value: PaymentInstruction | null }>`SELECT trustwork.payments_begin(${operationId}::uuid,${jobId}::uuid,${fence}::bigint,${attempt}) AS value`.execute(trx);
    return r.rows[0]?.value ?? null;
  },
  async dispatchGuard(trx: Transaction, operationId: string, jobId: string, fence: string, attempt: string) {
    await sql`SELECT trustwork.payments_dispatch_guard(${operationId}::uuid,${jobId}::uuid,${fence}::bigint,${attempt})`.execute(trx);
  },
  async instruction(trx: Transaction, operationId: string): Promise<PaymentInstruction | null> {
    const r = await sql<{ value: PaymentInstruction | null }>`SELECT trustwork.payments_instruction(${operationId}::uuid) AS value`.execute(trx);
    return r.rows[0]?.value ?? null;
  },
  async receipt(trx: Transaction, evidence: PaymentEvidence): Promise<string> {
    const r = await sql<{ value: string }>`SELECT trustwork.payments_receipt(${JSON.stringify(evidence)}::jsonb) AS value`.execute(trx);
    return r.rows[0]!.value;
  },
};
