import { withMaintenance, type DataPool } from '@trustwork/data';
import { adminDigests, approvals, staffAssignments, staffRoleDefinitions } from '../../../packages/data/src/repositories/admin.js';
import { actors, buildHubWorld, syncKernel } from '../../hubs/helpers.js';
import type { FeeTerms, PublicFee } from '../../../packages/contracts/src/billing-fees.js';
import { billingFees } from '../../../packages/data/src/repositories/billing-fees.js';

/** Synthetic people, hubs and rates only; real database roles, elevations and approvals. */
export async function feeWorld(admin: DataPool, runtime: DataPool) {
  await syncKernel(admin);
  const w = await buildHubWorld(admin);
  const a = actors(admin, runtime, w);
  const p = w.people;
  await a.assignSensitive({ personId: p.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubA = (await a.createHub('synthetic-fee-a')).hub_id;
  const hubB = (await a.createHub('synthetic-fee-b')).hub_id;
  await withMaintenance(admin, (trx) => staffRoleDefinitions.release(trx, {
    version: 2, role: 'hub-owner', scopes: ['hub'], permissions: ['admin.billing.fees.draft', 'admin.billing.fees.activate', 'admin.audit.read'],
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null,
  }));
  for (const [personId, hubId] of [[p.owner, hubA], [p.officer, hubA], [p.otherOwner, hubB], [p.moderator, hubB]] as const) {
    const scope = { kind: 'hub', hubId } as const;
    const digest = adminDigests.assignment({ breakglass: false, personId, role: 'hub-owner', scope, definitionVersion: 2 });
    const request = await a.cmd(p.founder, (trx, ctx) => approvals.request(trx, ctx, { action: 'staff.assign_sensitive_role', scope, actionDigest: digest }));
    await a.cmd(p.founder2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    await a.cmd(p.founder, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role: 'hub-owner', scope, definitionVersion: 2, approvalId: request.id }));
  }
  const approve = async (f: PublicFee, digest = f.digest, requester = p.officer, approver = p.owner) => {
    const r = await a.cmd(requester, (trx, ctx) => approvals.request(trx, ctx, { action: 'billing.activate_fee_version', scope: { kind: 'hub', hubId: f.hubId }, actionDigest: digest }));
    await a.cmd(approver, (trx, ctx) => approvals.decide(trx, ctx, r.id, 'approve', digest));
    return r.id;
  };
  const draft = (terms: FeeTerms, hubId = hubA, person = p.owner) => a.cmd(person, (trx, ctx) => billingFees.draft(trx, ctx, hubId, terms));
  const activate = (f: PublicFee, approval: string, person = p.officer, digest = f.digest) => a.cmd(person, (trx, ctx) => billingFees.activate(trx, ctx, f.hubId, f.id, digest, approval));
  return { w, a, p, hubA, hubB, approve, draft, activate };
}
export const syntheticTerms = (overrides: Partial<FeeTerms> = {}): FeeTerms => ({
  kind: 'consultation', categoryKey: 'synthetic_review', currency: 'USD', basisPoints: 100, fixedMinor: null, payer: 'buyer',
  effectiveFrom: new Date(Date.now() + 60000).toISOString(), effectiveTo: new Date(Date.now() + 3600000).toISOString(),
  acceptanceTextVersion: 'synthetic-fees-1', ...overrides,
});
