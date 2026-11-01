import { z } from 'zod';
import { ApprovalDecisionSchema } from '../../../_data/schemas.js';
import type { PreferenceStorage } from '../../../_navigation/preferences.js';

export const FixtureReceiptSchema = z.strictObject({
  operationId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Session-only receipts exist for synthetic decisions only; a live decision (`synthetic: false`) is never stored here. */
  decision: ApprovalDecisionSchema.refine((d) => d.synthetic, { message: 'only a synthetic decision has a session receipt', path: ['synthetic'] }),
});
export type FixtureReceipt = z.infer<typeof FixtureReceiptSchema>;

export function receiptMatches(receipt: FixtureReceipt, actor: string, hubId: string, requestId: string): boolean {
  const decision = receipt.decision;
  return decision.synthetic && decision.decidedBy === actor && decision.requestedBy !== actor && decision.hubId === hubId && decision.requestId === requestId
    && (!decision.approval || (decision.approval.scope.kind === 'hub' && decision.approval.scope.hubId === hubId && decision.approval.actionDigest.value === receipt.digest));
}

export function readReceipt(storage: PreferenceStorage, key: string): FixtureReceipt | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  return FixtureReceiptSchema.parse(JSON.parse(raw));
}

/** A tab-local synthetic transaction. Synchronous compare-and-record serializes duplicate UI completions. */
export function recordReceipt(storage: PreferenceStorage, key: string, receipt: FixtureReceipt, actor: string, hubId: string, requestId: string): FixtureReceipt {
  const validated = FixtureReceiptSchema.parse(receipt);
  if (!receiptMatches(validated, actor, hubId, requestId)) throw new Error('Synthetic receipt scope mismatch');
  const existing = readReceipt(storage, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(validated)) throw new Error('Synthetic request already decided');
    return existing;
  }
  storage.setItem(key, JSON.stringify(validated));
  return validated;
}
