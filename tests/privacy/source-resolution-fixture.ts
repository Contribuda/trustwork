import assert from 'node:assert/strict';
import type { startHarness } from '../backend/helpers/app.js';
import type { privacyWorld } from './helpers.js';
import { privacySourceFixture } from './source-fixture.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { caseGrants } from '../../packages/data/src/repositories/admin.js';

export async function sourceResolutionFixture(h: NonNullable<Awaited<ReturnType<typeof startHarness>>>, w: Awaited<ReturnType<typeof privacyWorld>>, action: 'correction' | 'erasure' = 'correction') {
  const f = await privacySourceFixture(h, w, 3600, action, action === 'correction' ? 'Synthetic verified correction' : null);
  await w.as(w.people.officer, (trx) => privacy.sourceProof(trx, f.ctx, f.body));
  const response = await h.client().post('/v1/privacy/public/sourced-requests', { proof: f.proof, action, proposedValue: f.intake.proposedValue }, { idempotencyKey: null });
  assert.equal(response.status, 202);
  const request = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.privacy_source_request WHERE source_field_id=$1', [f.fieldId])).rows[0]!;
  let second = await w.as(w.people.reviewer, (trx) => caseGrants.request(trx, f.reviewCtx, { supportCaseId: f.support.caseId, objectType: 'sourced_record_field', objectIds: [f.fieldId],
    projectionClass: 'support_private_limited', purpose: 'Synthetic source resolution review', expiresInSeconds: 3600 }));
  second = await w.as(w.people.officer, (trx) => caseGrants.decide(trx, f.ctx, second.id, 'approve', second.request_digest));
  return { ...f, request, second };
}

