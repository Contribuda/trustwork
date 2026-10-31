import { executionAgreements, executionClaims, executionConfirmations } from '../../packages/data/src/repositories/execution.js';
import type { ObligationRow } from '../../packages/data/src/schema/transactions.js';
import { as, type Fixture } from '../trust/helpers.js';

/**
 * REP-001 fixtures on top of the EXE-001 ones (tests/trust/helpers.ts): the obligor claims an obligation of the
 * synthetic agreement and the counterparty's person decides, which materializes EXE-001 performance observations, the
 * only input of timeliness. Every name is synthetic.
 */
export async function claimAndDecide(f: Fixture, agreementId: string, o: ObligationRow, decision: 'accepted' | 'partially_accepted' | 'rejected' = 'accepted', performedAt = new Date()): Promise<void> {
  const { petr, boris } = f.people;
  const obligorIsPetr = o.obligor_person_id === petr;
  const claimant = obligorIsPetr ? petr : boris;
  const decider = obligorIsPetr ? boris : petr;
  const claim = await as(f, claimant, (trx) => executionClaims.insert(trx, {
    agreement_id: agreementId, obligation_id: o.id, defect_id: null, kind: o.kind === 'deliver' ? 'goods_delivery' : o.kind === 'perform' ? 'work_performed' : 'payment_made',
    claimant_person_id: o.obligor_person_id, claimant_company_id: o.obligor_company_id, lines: o.kind === 'deliver' ? [{ ref: 'q1', quantity: { value: '40', unit: 'm2' } }] : [],
    period_from: null, period_to: null, performed_at: performedAt, statement: 'Synthetic statement', supersedes_claim_id: null, recorded_by_person_id: claimant, via: 'person', mandate_id: null,
  }));
  await as(f, decider, async (trx) => {
    await executionConfirmations.insert(trx, {
      claim_id: claim.id, agreement_id: agreementId, decision, lines: [], note: decision === 'accepted' ? null : 'Synthetic reason', stage_code: null, decided_by_person_id: decider,
      on_behalf_person_id: obligorIsPetr ? null : petr, on_behalf_company_id: obligorIsPetr ? f.supplier : null,
    });
    await executionAgreements.observe(trx, agreementId);
  });
}

export const PETR = (f: Fixture) => ({ kind: 'person' as const, id: f.people.petr });
export const SUPPLIER = (f: Fixture) => ({ kind: 'company' as const, id: f.supplier });
