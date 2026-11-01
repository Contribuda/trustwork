import { sql } from 'kysely';
import { z } from 'zod';
import type { Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import { commissionOn, type CommissionQuote } from '../../../../../../packages/contracts/src/consultations.js';
import { PublicFeeSchema } from './deps.js';
import type { ConsultationCommissionPort } from '../../consultations/ports.js';

/** Production adapter. Its source hub comes only from server configuration, never from a command body. */
export class VersionedConsultationFees implements ConsultationCommissionPort {
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
      throw error;
    }
  }
  async origin(trx: Transaction, kind: 'offering' | 'request', id: string): Promise<void> {
    await this.run(() => sql`SELECT trustwork.billing_consultation_origin(${this.hub()}::uuid,${kind},${id}::uuid)`.execute(trx));
  }
  async quote(trx: Transaction, input: Parameters<ConsultationCommissionPort['quote']>[1]): Promise<CommissionQuote> {
    return this.run(async () => {
      const result = await sql<{value:unknown}>`SELECT trustwork.billing_consultation_quote(${this.hub()}::uuid,${input.requestId}::uuid) AS value`.execute(trx);
      const { buyerFee,sellerFee } = z.strictObject({buyerFee:PublicFeeSchema,sellerFee:PublicFeeSchema}).parse(result.rows[0]?.value);
      const price = input.price ?? { minorUnits:'0',currency:buyerFee.terms.currency };
      if (buyerFee.terms.currency !== price.currency || sellerFee.terms.currency !== price.currency) throw new ApiError('validation.revision_conflict','fee currency unavailable',{reason:'billing.unavailable'});
      const amount = (fee:typeof buyerFee, payer:'client'|'expert') => {
        const c = commissionOn(price,{id:fee.id,version:fee.version,rateBps:fee.terms.basisPoints??0,
          fixedFee:fee.terms.fixedMinor===null?null:{minorUnits:fee.terms.fixedMinor,currency:fee.terms.currency},payer});
        if(c.status!=='published') throw new Error('commission calculation did not publish a value');
        return c.amount;
      };
      const buyerAmount=amount(buyerFee,'client'); const sellerAmount=amount(sellerFee,'expert');
      if(BigInt(sellerAmount.minorUnits)>BigInt(price.minorUnits)) throw new ApiError('validation.revision_conflict','fee exceeds expert proceeds',{reason:'billing.unavailable'});
      return {status:'versioned_fees',buyerFee,sellerFee,buyerAmount,sellerAmount};
    });
  }
  async proposed(trx: Transaction, bookingId:string):Promise<void> {
    await this.run(()=>sql`SELECT trustwork.billing_consultation_proposed(${this.hub()}::uuid,${bookingId}::uuid)`.execute(trx));
  }
  async confirmed(trx:Transaction,bookingId:string,side:'buyer'|'seller'):Promise<void> {
    await this.run(()=>sql`SELECT trustwork.billing_consultation_confirm(${this.hub()}::uuid,${bookingId}::uuid,${side})`.execute(trx));
  }
}
