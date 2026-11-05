import { z } from 'zod';

/**
 * Second-person requests as a section of the live console reads them (HUBC-007). A section whose action has no drafted
 * configuration version (a price, a provider going live) opens its request with the digest its owning module computed and
 * finishes the change from its own screen, so it needs to know where that digest stands: nobody asked, a request waits,
 * or an approval is ready. The API stays the authority: the executing command consumes the approval and checks its
 * requester, action, scope, digest and expiry again.
 */
const ApprovalRowSchema = z.object({
  id: z.string().min(1),
  action: z.string(),
  scope: z.object({ kind: z.string(), hubId: z.string().optional() }),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.string(),
  requestExpiresAt: z.iso.datetime(),
  status: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
const ApprovalListsSchema = z.object({ forMe: z.array(z.unknown()).default([]), mine: z.array(z.unknown()).default([]), decided: z.array(z.unknown()).default([]) });
export type LiveApproval = z.infer<typeof ApprovalRowSchema>;

/**
 * Where a digest stands for this viewer. Only the requester executes an approval, so an approval another person asked for
 * is `requested` here: the viewer sees that it is taken and cannot finish it.
 */
export type ApprovalStage =
  | { stage: 'none' }
  | { stage: 'requested'; requestId: string; requestedBy: string; approved: boolean }
  | { stage: 'approved'; requestId: string };

/** The hub's requests from `GET /v1/admin/approvals`, each once; rows of any other scope are left out. */
export function hubApprovals(body: unknown, hubId: string): LiveApproval[] {
  const lists = ApprovalListsSchema.safeParse(body);
  if (!lists.success) return [];
  const seen = new Map<string, LiveApproval>();
  for (const raw of [...lists.data.forMe, ...lists.data.mine, ...lists.data.decided]) {
    const row = ApprovalRowSchema.safeParse(raw);
    if (row.success && row.data.scope.kind === 'hub' && row.data.scope.hubId === hubId) seen.set(row.data.id, row.data);
  }
  return [...seen.values()];
}

export function approvalStage(rows: readonly LiveApproval[], action: string, digest: string, viewerId: string, now: Date): ApprovalStage {
  const at = now.getTime();
  const same = rows.filter((r) => r.action === action && r.actionDigest === digest);
  const approved = same.find((r) => r.status === 'approved' && r.revokedAt === null && r.expiresAt !== null && Date.parse(r.expiresAt) > at);
  if (approved) return approved.requestedBy === viewerId ? { stage: 'approved', requestId: approved.id } : { stage: 'requested', requestId: approved.id, requestedBy: approved.requestedBy, approved: true };
  const pending = same.find((r) => r.status === 'pending' && Date.parse(r.requestExpiresAt) > at);
  return pending ? { stage: 'requested', requestId: pending.id, requestedBy: pending.requestedBy, approved: false } : { stage: 'none' };
}
