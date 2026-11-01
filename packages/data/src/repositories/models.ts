import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { ModelCallRow } from '../schema/models.js';
export const modelCalls = {
  async begin(trx: Transaction, request: unknown, binding: unknown, digest: string, route: unknown, candidate: unknown, ttlSeconds: number) {
    const { rows } = await sql<{
      result: { fresh: boolean; row: ModelCallRow };
    }>`SELECT trustwork.models_begin(${JSON.stringify(request)}::jsonb,${JSON.stringify(binding)}::jsonb,
      ${digest},${JSON.stringify(route)}::jsonb,${JSON.stringify(candidate)}::jsonb,${ttlSeconds}::integer) AS result`.execute(trx);
    return rows[0]!.result;
  },
  async checkAuthority(trx: Transaction, request: unknown, binding: unknown): Promise<void> {
    await sql`SELECT trustwork.models_check_authority(${JSON.stringify(request)}::jsonb,${JSON.stringify(binding)}::jsonb)`.execute(trx);
  },
  async checkReceiptAuthority(trx: Transaction, operationId: string, binding: unknown): Promise<void> {
    await sql`SELECT trustwork.models_check_receipt_authority(${operationId},${JSON.stringify(binding)}::jsonb)`.execute(trx);
  },
  get(trx: Transaction, operationId: string) {
    return trx.selectFrom('model_call').selectAll().where('operation_id', '=', operationId).executeTakeFirst();
  },
  async fallback(trx: Transaction, operationId: string, token: string, candidate: unknown): Promise<ModelCallRow> {
    return (await sql<ModelCallRow>`SELECT * FROM trustwork.models_fallback(${operationId},${token}::uuid,${JSON.stringify(candidate)}::jsonb)`.execute(trx))
      .rows[0]!;
  },
  async admit(trx: Transaction, operationId: string, token: string): Promise<boolean> {
    return (await sql<{ ok: boolean }>`SELECT trustwork.models_admit(${operationId},${token}::uuid) AS ok`.execute(trx)).rows[0]!.ok;
  },
  async finish(trx: Transaction, operationId: string, token: string, metadata: unknown): Promise<unknown> {
    return (
      await sql<{ metadata: unknown }>`SELECT trustwork.models_finish(${operationId},${token}::uuid,${JSON.stringify(metadata)}::jsonb) AS metadata`.execute(
        trx,
      )
    ).rows[0]!.metadata;
  },
};
