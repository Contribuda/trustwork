import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { principalFor } from '../data/helpers/seed.js';
import { privacyWorld } from './helpers.js';
import { privacyPlanFixture } from './plan-fixture.js';
import { caseGrants, supportCases } from '../../packages/data/src/repositories/admin.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { PrivacyService } from '../../apps/api/src/modules/platform-admin/privacy/privacy.service.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { ApiError } from '../../apps/api/src/common/errors.js';
import { PRIVACY_MODULE_INVENTORY, PrivacyResponseDraftPackageSchema, type PrivacyResponseDraftPackage } from '../../packages/contracts/src/privacy.js';

interface DraftBody { id: string; state: string; prepared_via: string; mandate_id: string | null; package: PrivacyResponseDraftPackage }

test('PRV-001 response packages at Draft: prepared by people, decided by people; delegated principals refused until AGT-030', async (t) => {
  const h = await startHarness('privacy_response_draft');
  if (!h) { t.skip(SKIP_REASON); return; }
  t.after(() => h.close());
  const w = await privacyWorld(h);
  const service = h.created.app.get(PrivacyService);
  const subject = { kind: 'person' as const, id: w.people.subject };
  const SENTINEL = 'Synthetic private correction 5150';
  const requestOf = async (body: Record<string, unknown>) => {
    const r = await w.subject.post('/v1/privacy/requests', { subject, country: 'US', ...body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body as { id: string }).id;
  };
  const erasureId = await requestOf({ kind: 'erasure' });
  const correctionId = await requestOf({ kind: 'correction', correction: { field: 'profile', proposedValue: SENTINEL } });
  const count = async (table: string, condition = 'true') => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM trustwork.${table} WHERE ${condition}`)).rows[0]!.n;
  const requestState = async (id: string) => (await h.db.admin.query<{ state: string }>('SELECT state FROM trustwork.privacy_request WHERE id=$1', [id])).rows[0]!.state;
  // Preparing and reading need a case grant naming the request (tests/privacy/response-draft-authority.test.ts).
  const officerCtx = await w.context(w.people.officer); const reviewerCtx = await w.context(w.people.reviewer);
  const hubId = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.hub ORDER BY id LIMIT 1')).rows[0]!.id;
  const support = await w.as(w.people.officer, (trx) => supportCases.open(trx, officerCtx, { hubId, requesterPersonId: w.people.subject, subject, category: 'privacy', summary: 'Synthetic Draft preparation' }));
  const grantInput = { supportCaseId: support.id, objectType: 'privacy_request', objectIds: [erasureId, correctionId], projectionClass: 'support_private_limited' as const, purpose: 'Synthetic Draft preparation', expiresInSeconds: 3600 };
  let officerGrant = await w.as(w.people.officer, (trx) => caseGrants.request(trx, officerCtx, grantInput));
  officerGrant = await w.as(w.people.reviewer, (trx) => caseGrants.decide(trx, reviewerCtx, officerGrant.id, 'approve', officerGrant.request_digest));
  let reviewerGrant = await w.as(w.people.reviewer, (trx) => caseGrants.request(trx, reviewerCtx, grantInput));
  reviewerGrant = await w.as(w.people.officer, (trx) => caseGrants.decide(trx, officerCtx, reviewerGrant.id, 'approve', reviewerGrant.request_digest));
  const asOfficer = { grantId: officerGrant.id };

  await t.test('a privacy officer prepares a Draft without an elevation; it names the human decisions and carries no subject payload', async () => {
    const r = await w.officer.post(`/v1/admin/privacy/requests/${erasureId}/response-draft`, asOfficer);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const draft = r.body as DraftBody;
    assert.equal(draft.state, 'Draft'); assert.equal(draft.prepared_via, 'person'); assert.equal(draft.mandate_id, null);
    const pkg = PrivacyResponseDraftPackageSchema.parse(draft.package);
    assert.deepEqual(pkg.erasure, { ready: false, reason: 'country_policy_UNKNOWN' });
    assert.deepEqual(pkg.request.subject, subject); assert.equal(pkg.request.deadlineAt, null); assert.equal(pkg.holds.active, 0);
    assert.deepEqual(pkg.exportCoverage.map((c) => c.module).sort(), [...PRIVACY_MODULE_INVENTORY].sort());
    assert.deepEqual(pkg.humanDecisionsRequired, ['privacy.plan_propose', 'privacy.plan_approve', 'privacy.plan_execute']);
    assert.ok(pkg.unresolved.length >= PRIVACY_MODULE_INVENTORY.length - 1 && pkg.unresolved.every((u) => u.capability === 'erase'));
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(await requestState(erasureId), 'open', 'a Draft changes nothing on the request');
    assert.equal(await count('legal_hold'), 0); assert.equal(await count('privacy_subject_plan'), 0); assert.equal(await count('second_person_approval', "action='privacy.execute_erasure'"), 0);
    const again = await w.officer.post(`/v1/admin/privacy/requests/${erasureId}/response-draft`, asOfficer);
    assert.equal(again.status, 201); assert.equal((again.body as DraftBody).id, draft.id, 'an unchanged package is the same Draft');
    const correction = await w.officer.post(`/v1/admin/privacy/requests/${correctionId}/response-draft`, asOfficer);
    assert.equal(correction.status, 201, JSON.stringify(correction.body));
    const correctionPackage = PrivacyResponseDraftPackageSchema.parse((correction.body as DraftBody).package);
    assert.equal(correctionPackage.request.hasCorrection, true); assert.equal(correctionPackage.erasure, null);
    assert.ok(!JSON.stringify(correction.body).includes(SENTINEL), 'the proposed correction text stays in the protected request row');
    assert.ok(!JSON.stringify(correction.body).includes('@example.invalid'));
    const listed = await w.officer.get(`/v1/admin/privacy/requests/${erasureId}/response-drafts?grantId=${officerGrant.id}`);
    assert.equal(listed.status, 200); assert.deepEqual((listed.body as { drafts: DraftBody[] }).drafts.map((d) => d.id), [draft.id]);
  });
  await t.test('the subject, another person and an anonymous client can neither prepare nor read Drafts', async () => {
    assert.equal((await w.subject.post(`/v1/admin/privacy/requests/${erasureId}/response-draft`, asOfficer)).status, 403);
    assert.equal((await w.subject.get(`/v1/admin/privacy/requests/${erasureId}/response-drafts?grantId=${officerGrant.id}`)).status, 403);
    assert.equal((await h.client().post(`/v1/admin/privacy/requests/${erasureId}/response-draft`, asOfficer)).status, 401);
    // An unknown request answers like a request the grant does not name: the refusal confirms nothing about either.
    assert.equal((await w.officer.post(`/v1/admin/privacy/requests/${randomUUID()}/response-draft`, asOfficer)).status, 403);
    await assert.rejects(h.pool.query('SELECT * FROM trustwork.privacy_response_draft'), /permission denied/);
    assert.equal(await count('privacy_response_draft'), 2);
  });
  await t.test('a Draft is immutable, even for the maintenance identity', async () => {
    await assert.rejects(withMaintenance(h.db.admin, (trx) => trx.updateTable('privacy_response_draft').set({ state: 'Draft', digest: '0'.repeat(64) }).execute()));
    await assert.rejects(withMaintenance(h.db.admin, (trx) => trx.deleteFrom('privacy_response_draft').execute()));
    assert.equal(await count('privacy_response_draft'), 2);
  });
  await t.test('a delegated principal of the officer is refused everywhere, including Draft preparation, and leaves no trace', async () => {
    const officer = w.people.officer;
    const session = await withMaintenance(h.db.admin, (trx) => trx.insertInto('session').values({ person_id: officer, token_hash: randomBytes(32),
      idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
    const base = await principalFor(h.db.admin, officer);
    const delegated: RequestState = {
      requestId: `req-${randomUUID()}`, sessionTokenHash: null, client: { userAgentFamily: 'synthetic', ipPrefix: '127.0.0.0/8', ip: '127.0.0.1' },
      session: { id: session.id, personId: officer, authenticatedAt: new Date(), createdAt: new Date(), authMethod: 'password' },
      principal: { ...base, emailVerified: true, authenticatedAt: new Date().toISOString(), membership: null, staff: ['privacy-officer'],
        delegation: { mandateId: 'synthetic-operator-mandate-1', mandateRevision: 3, principalPersonId: officer } },
    };
    const draftsBefore = await count('privacy_response_draft');
    // The database refuses a delegated preparation on its own: a participant's mandate is not an operator grant (AGT-030).
    await assert.rejects(w.as(officer, (trx) => privacy.prepareResponseDraft(trx, { requestId: erasureId, grantId: officerGrant.id, coverage: [], delegation: delegated.principal!.delegation, auditRequestId: 'req-synthetic' })),
      (e: { hint?: string }) => e.hint === 'privacy.operator_grant_required');
    await assert.rejects(withMaintenance(h.db.admin, (trx) => trx.insertInto('privacy_response_draft').values({ request_id: erasureId, prepared_by: officer, prepared_via: 'delegated_agent',
      mandate_id: 'synthetic-operator-mandate-1', mandate_revision: 3, package: JSON.stringify({}), digest: '3'.repeat(64) }).execute()), /privacy_response_draft_person_only/);
    assert.equal(await count('privacy_response_draft'), draftsBefore);
    const fixture = await privacyPlanFixture(h, w);
    const ctx = fixture.ctx;
    const before = { drafts: await count('privacy_response_draft'), holds: await count('legal_hold'), plans: await count('privacy_subject_plan'), sourcePlans: await count('privacy_source_plan'),
      approvals: await count('second_person_approval'), proofs: await count('privacy_source_proof'), cases: await count('support_external_source_subject'),
      audit: await count('admin_audit_event'), requests: await count('privacy_request'), exports: await count('privacy_export'), preferences: await count('privacy_preference') };
    const refused = (e: unknown) => e instanceof ApiError && e.code === 'access.forbidden';
    const decisions: (() => Promise<unknown>)[] = [
      () => service.prepareResponseDraft(delegated, erasureId, officerGrant.id),
      () => service.responseDrafts(delegated, erasureId, officerGrant.id),
      () => service.hold(delegated, ctx.elevationId, { requestId: fixture.request.id, reasonCode: 'litigation', evidenceRef: randomUUID() }),
      () => service.releaseHold(delegated, ctx.elevationId, randomUUID(), 'hold_resolved'),
      () => service.erasureCheck(delegated, ctx.elevationId, fixture.request.id),
      () => service.proposePlan(delegated, ctx.elevationId, fixture.request.id, fixture.first.id),
      () => service.approvePlan(delegated, ctx.elevationId, randomUUID(), fixture.second.id, '0'.repeat(64)),
      () => service.executePlan(delegated, ctx.elevationId, randomUUID(), '0'.repeat(64)),
      () => service.proposeSourcePlan(delegated, ctx.elevationId, fixture.request.id, fixture.first.id),
      () => service.approveSourcePlan(delegated, ctx.elevationId, randomUUID(), fixture.second.id, '0'.repeat(64)),
      () => service.executeSourcePlan(delegated, ctx.elevationId, randomUUID(), '0'.repeat(64)),
      () => service.externalSourceCase(delegated, ctx.elevationId, { hubId: randomUUID(), sourceFieldId: randomUUID(), action: 'objection', proposedValue: null, country: 'US', method: 'signed_statement', evidenceDigest: '1'.repeat(64) }),
      () => service.sourceProof(delegated, ctx.elevationId, { sourceFieldId: randomUUID(), grantId: fixture.first.id, action: 'objection', tokenHash: '2'.repeat(64), method: 'signed_statement', evidenceRef: randomUUID() }),
      () => service.request(delegated, { subject: { kind: 'person', id: officer }, kind: 'access', country: 'US', correction: null }),
      () => service.preference(delegated, { optOutSale: true, optOutSharing: true, limitSensitive: true, directMarketingObjection: true, gpc: true }),
      () => service.createExport(delegated, { kind: 'person', id: officer }),
    ];
    for (const decision of decisions) await assert.rejects(decision, refused);
    const after = { drafts: await count('privacy_response_draft'), holds: await count('legal_hold'), plans: await count('privacy_subject_plan'), sourcePlans: await count('privacy_source_plan'),
      approvals: await count('second_person_approval'), proofs: await count('privacy_source_proof'), cases: await count('support_external_source_subject'),
      audit: await count('admin_audit_event'), requests: await count('privacy_request'), exports: await count('privacy_export'), preferences: await count('privacy_preference') };
    assert.deepEqual(after, before, 'a refused delegated decision writes nothing');
    assert.equal(await requestState(fixture.request.id), 'open');
    // The same person, acting in person with a live elevation, is allowed to decide; the next Draft reflects it.
    const held = await w.officer.post('/v1/admin/privacy/holds', { requestId: fixture.request.id, reasonCode: 'litigation', evidenceRef: randomUUID() });
    assert.equal(held.status, 201, JSON.stringify(held.body));
    const afterHold = await w.officer.post(`/v1/admin/privacy/requests/${fixture.request.id}/response-draft`, { grantId: fixture.first.id });
    assert.equal(afterHold.status, 201, JSON.stringify(afterHold.body));
    assert.deepEqual((afterHold.body as DraftBody).package.erasure, { ready: false, reason: 'legal_hold' });
    assert.equal((afterHold.body as DraftBody).package.holds.active, 1);
    assert.equal((afterHold.body as DraftBody).prepared_via, 'person');
  });
  await t.test('decision routes keep requiring a live elevation of the person; the Draft route does not grant one', async () => {
    // The second officer ends the elevation of this session; the staff role and the privacy permission remain.
    const ended = await w.reviewer.post('/v1/admin/session/end', undefined, { idempotencyKey: null });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    const prepared = await w.reviewer.post(`/v1/admin/privacy/requests/${erasureId}/response-draft`, { grantId: reviewerGrant.id });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    assert.equal((prepared.body as DraftBody).prepared_via, 'person');
    const hold = await w.reviewer.post('/v1/admin/privacy/holds', { requestId: erasureId, reasonCode: 'litigation', evidenceRef: randomUUID() });
    assert.equal(hold.status, 403, JSON.stringify(hold.body));
    assert.equal((hold.body as { details?: { required?: string } }).details?.required, 'elevation');
    assert.equal((await w.reviewer.post(`/v1/admin/privacy/requests/${erasureId}/erasure-readiness`, {})).status, 403);
    assert.equal((await w.reviewer.post('/v1/admin/privacy/plans', { requestId: erasureId, grantId: randomUUID() })).status, 403);
    assert.equal(await count('legal_hold', `request_id='${erasureId}'`), 0);
    assert.equal(await count('privacy_subject_plan', `request_id='${erasureId}'`), 0);
  });
});
