import { executionAgreements } from '../../../../../packages/data/src/repositories/execution.js';
import type { ExecutionService } from '../execution/execution.service.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings } from './service-bindings.js';

/** Resolve the same agreement side as the owning service; never infer company authority from a payload hub or address. */
const operation = (suffix: string, resource: 'agreement' | 'claim' | 'dispute' = 'agreement'): ServiceCapabilityBinding => ({
  capabilityId: `execution_evidence.${suffix}`,
  async company(trx, _principal, args) {
    const id = args[0];
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) return null;
    let agreementId: string | undefined = id;
    if (resource === 'claim') agreementId = (await trx.selectFrom('execution_claim').select('agreement_id').where('id', '=', id).executeTakeFirst())?.agreement_id;
    if (resource === 'dispute') agreementId = (await trx.selectFrom('execution_dispute').select('agreement_id').where('id', '=', id).executeTakeFirst())?.agreement_id;
    if (!agreementId) return null;
    const side = await executionAgreements.side(trx, agreementId);
    const row = side ? await executionAgreements.get(trx, agreementId) : undefined;
    return side === 'buyer' ? row?.buyer_company_id ?? null : side === 'seller' ? row?.seller_company_id ?? null : null;
  },
});

export const EXECUTION_SERVICE_BINDINGS = {
  view: operation('get_execution'), recordClaim: operation('record_claim'), attachEvidence: operation('attach_evidence'),
  reportDefect: operation('report_defect'), decideClaim: operation('decide_claim', 'claim'), openDispute: operation('open_dispute'), appealDispute: operation('appeal_dispute', 'dispute'),
} satisfies ServiceCapabilityBindings<ExecutionService>;
