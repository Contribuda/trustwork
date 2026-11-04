import type { Transaction } from '../../deps/data.js';
import { screeningOf, type ScreeningView, type SupplierScreeningPort } from '../supplier-base/screening.js';
import type { SupplierRecordRow, SupplierStatus } from './deps.js';
import type { EligibilityRule } from './schemas.js';

/**
 * Eligibility of a supplier against the buyer's private rules (PRC-004). Each rule answers pass, fail or unknown from
 * evidence the buyer may read: the region of its own supplier record, the one screening fact a counterparty may know, and
 * prequalification passport sections the supplier shared by consent. Unknown is not failure and is never guessed.
 *
 * The prequalification passport does not exist yet (PREQ-001), so the licence, insurance and passport rules read
 * `PrequalificationEvidencePort`, whose default answers nothing: those rules stay `unknown` until a real port is wired.
 */
export type RuleResult = 'pass' | 'fail' | 'unknown';
export type EvidenceSource = 'supplier_record' | 'screening' | 'prequalification_passport' | 'not_available';

export interface PrequalificationEvidencePort {
  /** The answer from passport sections the supplier shared with this buyer by consent; null when nothing was shared. */
  check(trx: Transaction, input: { buyerCompanyId: string; supplierCompanyId: string; rule: EligibilityRule; now: Date }): Promise<'pass' | 'fail' | null>;
}
export const noPrequalificationEvidence: PrequalificationEvidencePort = { check: async () => null };

export function regionResult(rule: Extract<EligibilityRule, { kind: 'region' }>, record: Pick<SupplierRecordRow, 'regions'>): RuleResult {
  if (record.regions.length === 0) return 'unknown';
  return rule.regions.some((r) => record.regions.includes(r)) ? 'pass' : 'fail';
}

/** A supplier that cannot transact now fails; a counterparty off the platform or an unreadable state stays unknown. */
export function screeningResult(view: ScreeningView): RuleResult {
  if (view === 'clear') return 'pass';
  return view === 'cannot_transact_now' ? 'fail' : 'unknown';
}

export function overall(results: readonly RuleResult[]): RuleResult {
  if (results.includes('fail')) return 'fail';
  return results.includes('unknown') ? 'unknown' : 'pass';
}

export interface RuleEvaluation { rule: EligibilityRule; result: RuleResult; source: EvidenceSource }

export async function evaluateRules(trx: Transaction, input: {
  rules: readonly EligibilityRule[]; record: SupplierRecordRow; buyerCompanyId: string; screening: SupplierScreeningPort; prequalification: PrequalificationEvidencePort; now: Date;
}): Promise<RuleEvaluation[]> {
  const company = input.record.linked_company_id;
  const out: RuleEvaluation[] = [];
  for (const rule of input.rules) {
    if (rule.kind === 'region') out.push({ rule, result: regionResult(rule, input.record), source: 'supplier_record' });
    else if (rule.kind === 'screening_clear') out.push({ rule, result: screeningResult(await screeningOf(trx, input.screening, company, input.now)), source: 'screening' });
    else {
      const answer = company === null ? null : await input.prequalification.check(trx, { buyerCompanyId: input.buyerCompanyId, supplierCompanyId: company, rule, now: input.now });
      out.push({ rule, result: answer ?? 'unknown', source: answer === null ? 'not_available' : 'prequalification_passport' });
    }
  }
  return out;
}

const STATUS_RANK: Readonly<Record<SupplierStatus, number>> = { preferred: 0, approved: 1, prospect: 2, on_hold: 3, blocked: 4, archived: 5 };

/**
 * Invitation candidates: suppliers that fail a rule go last, then the buyer's own status, then the oldest record first,
 * then the id. The input type carries no plan, entitlement, subscription or sponsorship, so payment cannot move a
 * supplier: the comparison test in tests/sourcing proves the order is identical with and without paid entitlements.
 */
export function orderCandidates<T extends { eligibility: RuleResult; status: SupplierStatus; createdAt: string; supplierRecordId: string }>(items: readonly T[]): T[] {
  const failed = (c: T) => (c.eligibility === 'fail' ? 1 : 0);
  return [...items].sort((a, b) => failed(a) - failed(b) || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.createdAt.localeCompare(b.createdAt) || a.supplierRecordId.localeCompare(b.supplierRecordId));
}
