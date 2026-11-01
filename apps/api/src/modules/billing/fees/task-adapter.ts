import type { Money } from '../../../../../../packages/contracts/src/common/money.js';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import { FeeDisclosureSchema, type FeeConfirmationSchema } from './deps.js';

export interface TaskFeePort {
  amount(trx: Transaction, side: 'buyer' | 'seller', price: Money, confirmation: z.infer<typeof FeeConfirmationSchema> | undefined): Promise<Money>;
  origin(trx: Transaction, kind: 'request' | 'offer', id: string): Promise<void>;
  confirm(trx: Transaction, agreementId: string, side: 'buyer' | 'seller', confirmation: z.infer<typeof FeeConfirmationSchema> | undefined): Promise<void>;
}
/** Explicit historical test adapter; never selected by production configuration. */
export class HistoricalTaskFees implements TaskFeePort {
  async amount(_trx: Transaction, _side: 'buyer' | 'seller', price: Money): Promise<Money> { return price; }
  async origin(): Promise<void> {}
  async confirm(): Promise<void> {}
}
export class VersionedTaskFees implements TaskFeePort {
  constructor(private readonly hubId: string | null) {}
  private hub(): string {
    if (!this.hubId) throw new ApiError('validation.revision_conflict', 'fee source hub unavailable', { reason: 'billing.unavailable' });
    return this.hubId;
  }
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      const pg = error as { hint?: string };
      if (pg.hint?.startsWith('billing.')) throw new ApiError('validation.revision_conflict', 'published fees unavailable or outdated', { reason: pg.hint });
      if (pg.hint === 'admin.not_found') throw new ApiError('access.not_found');
      if (pg.hint === 'admin.approval_mismatch') throw new ApiError('access.forbidden');
      throw error;
    }
  }
  async amount(trx: Transaction, side: 'buyer' | 'seller', price: Money, confirmation: z.infer<typeof FeeConfirmationSchema> | undefined): Promise<Money> {
    if (!confirmation) throw new ApiError('validation.revision_conflict', 'explicit fee confirmation required', { reason: 'billing.confirmation_required' });
    // The row is protected by person-only RLS; final consumption rechecks authority, validity and source under locks.
    const row = await trx.selectFrom('billing_fee_disclosure').select(['id','digest','snapshot']).where('id','=',confirmation.disclosureId).executeTakeFirst();
    if (!row) throw new ApiError('access.not_found');
    const d = FeeDisclosureSchema.parse(row);
    if (d.digest !== confirmation.digest) throw new ApiError('access.forbidden');
    if (d.snapshot.side !== side || d.snapshot.sourceHubId !== this.hub()) throw new ApiError('access.not_found');
    const fee = side === 'buyer' ? d.snapshot.buyerFee : d.snapshot.sellerFee;
    if (fee.terms.currency !== price.currency) throw new ApiError('validation.revision_conflict', 'fee currency unavailable', { reason: 'billing.unavailable' });
    const charge = (BigInt(price.minorUnits) * BigInt(fee.terms.basisPoints ?? 0) + 5000n) / 10000n + BigInt(fee.terms.fixedMinor ?? '0');
    const value = BigInt(price.minorUnits) + (side === 'buyer' ? charge : -charge);
    if (value < 0n || value > 9223372036854775807n) throw new ApiError('validation.revision_conflict', 'fee exceeds supported amount', { reason: 'billing.unavailable' });
    return {minorUnits:value.toString(),currency:price.currency};
  }
  async origin(trx: Transaction, kind: 'request' | 'offer', id: string): Promise<void> {
    await this.run(() => sql`SELECT trustwork.billing_task_origin(${this.hub()}::uuid,${kind},${id}::uuid)`.execute(trx));
  }
  async disclose(trx: Transaction, offerId: string) {
    return this.run(async () => {
      const r = await sql<{ id: string; digest: string; snapshot: unknown }>`SELECT id,digest,snapshot FROM trustwork.billing_task_disclose(${this.hub()}::uuid,${offerId}::uuid)`.execute(trx);
      return FeeDisclosureSchema.parse(r.rows[0]);
    });
  }
  async confirm(trx: Transaction, agreementId: string, side: 'buyer' | 'seller', confirmation: z.infer<typeof FeeConfirmationSchema> | undefined): Promise<void> {
    if (!confirmation) throw new ApiError('validation.revision_conflict', 'explicit fee confirmation required', { reason: 'billing.confirmation_required' });
    await this.run(() => sql`SELECT trustwork.billing_task_confirm(${this.hub()}::uuid,${agreementId}::uuid,${confirmation.disclosureId}::uuid,${confirmation.digest},${side})`.execute(trx));
  }
}
