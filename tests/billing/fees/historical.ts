import type { DataPool, Transaction } from '@trustwork/data';
import type { TaskFeePort } from '../../../apps/api/src/modules/billing/fees/task-adapter.js';
import { NoPublishedCommission, type ConsultationCommissionPort } from '../../../apps/api/src/modules/consultations/ports.js';
import type { Money } from '../../../packages/contracts/src/common/money.js';

/**
 * Explicit synthetic pre-migration fixtures. Only the test's migrator connection can seed the immutable snapshot.
 * Production has no counterpart: the migration captures existing IDs/digests once, and app-role writes are denied.
 */
export class HistoricalTaskFees implements TaskFeePort {
  constructor(private readonly admin: DataPool) {}
  async amount(_trx: Transaction, _side: 'buyer'|'seller', price: Money): Promise<Money> { return price; }
  async origin(): Promise<void> {}
  async confirm(trx: Transaction, id: string): Promise<void> {
    const a=await trx.selectFrom('agreement').select(['id','accepted_terms_digest']).where('id','=',id).executeTakeFirstOrThrow();
    await this.admin.query("INSERT INTO trustwork.billing_fee_legacy_source(source_kind,source_id,source_digest) VALUES('task',$1,$2) ON CONFLICT DO NOTHING",[a.id,a.accepted_terms_digest]);
  }
}
export function historicalConsultationFees(admin: DataPool, quote: ConsultationCommissionPort = new NoPublishedCommission()): ConsultationCommissionPort {
  return {
    quote: (trx,input)=>quote.quote(trx,input),
    proposed: async(trx,id)=>{
      const b=await trx.selectFrom('consultation_booking').select(['id','terms_digest']).where('id','=',id).executeTakeFirstOrThrow();
      await admin.query("INSERT INTO trustwork.billing_fee_legacy_source(source_kind,source_id,source_digest) VALUES('consultation',$1,$2) ON CONFLICT DO NOTHING",[b.id,b.terms_digest]);
    },
  };
}
