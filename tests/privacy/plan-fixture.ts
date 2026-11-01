import type { Harness } from '../backend/helpers/app.js';
import type { privacyWorld } from './helpers.js';
import { caseGrants, supportCases } from '../../packages/data/src/repositories/admin.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';

export async function privacyPlanFixture(h: Harness, w: Awaited<ReturnType<typeof privacyWorld>>, country = 'US') {
  const ctx = await w.context(w.people.officer); const reviewCtx = await w.context(w.people.reviewer);
  const request = await w.as(w.people.subject, (trx) => privacy.request(trx, { subject: { kind: 'person', id: w.people.subject }, country, kind: 'erasure' }));
  const hubId = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.hub ORDER BY id LIMIT 1')).rows[0]!.id;
  const support = await w.as(w.people.officer, (trx) => supportCases.open(trx, ctx, { hubId, requesterPersonId: w.people.subject,
    subject: { kind: 'person', id: w.people.subject }, category: 'privacy', summary: 'Synthetic two-person privacy review' }));
  const grantInput = { supportCaseId: support.id, objectType: 'privacy_request', objectIds: [request.id], projectionClass: 'support_private_limited' as const,
    purpose: 'Synthetic exact privacy plan', expiresInSeconds: 3600 };
  let first = await w.as(w.people.officer, (trx) => caseGrants.request(trx, ctx, grantInput));
  first = await w.as(w.people.reviewer, (trx) => caseGrants.decide(trx, reviewCtx, first.id, 'approve', first.request_digest));
  let second = await w.as(w.people.reviewer, (trx) => caseGrants.request(trx, reviewCtx, grantInput));
  second = await w.as(w.people.officer, (trx) => caseGrants.decide(trx, ctx, second.id, 'approve', second.request_digest));
  return { ctx, reviewCtx, request, first, second, support };
}
