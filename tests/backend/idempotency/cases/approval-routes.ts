import assert from 'node:assert/strict';
import type { Harness } from '../../helpers/app.js';
import { grant, seedWorld, signIn, submit, subjectDigest, uuid } from '../../../approval-routes/helpers.js';
import { APPROVAL_ROUTE_TEMPLATES } from '../../../../apps/api/src/modules/approval-routes/resolution.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[]): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/**
 * PRC-001: every approval route that completes in its transaction, crashed before COMMIT and retried: drafting and
 * activating a route, a decision, a withdrawal, a delegation and its revocation. The company and its people are synthetic.
 */
export default {
  name: 'PRC-001: approval routes, decisions and delegation',
  async run({ h, exactlyOnce }) {
    const w = await seedWorld(h, 'crash');
    await grant(h.db.admin, w, 'paul', 'procurement.approval.decide');
    const [ada, paul, rita] = [await signIn(h, 'ada', 'crash'), await signIn(h, 'paul', 'crash'), await signIn(h, 'rita', 'crash')];
    const key = (action: string) => `crash-${action}`;

    const draft = (await exactlyOnce({
      action: 'approval.route_draft', client: ada, url: '/v1/approvals/routes',
      body: { owner: { kind: 'company', id: w.company }, subjectKind: 'requisition', payload: APPROVAL_ROUTE_TEMPLATES[0]!.payload, templateKey: 'owner_approves' },
      effects: () => count(h, 'SELECT 1 FROM trustwork.approval_route_version WHERE owner_company_id = $1', [w.company]),
    })).body as { id: string; digest: unknown };
    await exactlyOnce({
      action: 'approval.route_activate', client: ada, url: `/v1/approvals/routes/${draft.id}/activate`,
      body: { routeVersionId: draft.id, digest: draft.digest, expectedRevision: 1, idempotencyKey: key('approval.route_activate') },
      effects: () => count(h, 'SELECT 1 FROM trustwork.approval_route_version WHERE owner_company_id = $1 AND activated_at IS NOT NULL', [w.company]),
    });

    const request = await submit(h, w, 'rita', { subject: { kind: 'requisition', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('crash-1'), amount: null });
    await exactlyOnce({
      action: 'approval.decide', client: paul, url: `/v1/approvals/requests/${request.id}/decide`,
      body: { approvalRequestId: request.id, step: 'owner', decision: 'approve', subjectDigest: request.subjectDigest, reason: null, expectedRevision: request.revision, idempotencyKey: key('approval.decide') },
      effects: () => count(h, 'SELECT 1 FROM trustwork.approval_decision WHERE approval_request_id = $1', [request.id]),
    });
    assert.equal(await count(h, "SELECT 1 FROM trustwork.outbox_event WHERE aggregate_id = $1 AND type = 'approval.request_closed'", [request.id]), 1);

    const pending = await submit(h, w, 'rita', { subject: { kind: 'requisition', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('crash-2'), amount: null });
    await exactlyOnce({
      action: 'approval.withdraw', client: rita, url: `/v1/approvals/requests/${pending.id}/withdraw`,
      body: { expectedRevision: pending.revision, idempotencyKey: key('approval.withdraw') },
      effects: () => count(h, "SELECT 1 FROM trustwork.approval_request WHERE id = $1 AND status = 'withdrawn'", [pending.id]),
    });

    const now = Date.now();
    const delegation = (await exactlyOnce({
      action: 'approval.delegate', client: paul, url: '/v1/approvals/delegations',
      body: { companyId: w.company, delegatePersonId: w.people.dana, subjectKinds: ['requisition'], validFrom: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 7 * 86_400_000).toISOString(), expectedRevision: 1, idempotencyKey: key('approval.delegate') },
      effects: () => count(h, 'SELECT 1 FROM trustwork.approval_delegation WHERE company_id = $1', [w.company]),
    })).body as { id: string };
    await exactlyOnce({
      action: 'approval.delegation_revoke', client: paul, url: `/v1/approvals/delegations/${delegation.id}/revoke`,
      body: { reason: 'Synthetic crash test', expectedRevision: 1, idempotencyKey: key('approval.delegation_revoke') },
      effects: () => count(h, "SELECT 1 FROM trustwork.approval_delegation WHERE id = $1 AND status = 'revoked'", [delegation.id]),
    });
  },
} satisfies CrashCase;
