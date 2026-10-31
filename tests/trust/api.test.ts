import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { executionDisputes } from '../../packages/data/src/repositories/execution.js';
import { EXECUTION_EVENT_PAYLOAD_KEYS, type ExecutionView } from '../../apps/api/src/modules/execution/contracts.js';
import { ExecutionService } from '../../apps/api/src/modules/execution/execution.service.js';
import { AllowListExecutionMandates } from '../../apps/api/src/modules/execution/mandates.js';
import { TRUST_EVENT_PAYLOAD_KEYS, type AgreementReviewsView, type OwnSnapshotView, type PublicSnapshotView } from '../../apps/api/src/modules/trust/contracts.js';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { expectError, SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { approvedChange, artifactOn, as, baselinePlan, buildAgreement, businessDate, staffWorld, type Fixture } from './helpers.js';

/**
 * EXE-001 through the HTTP API (real database, runtime role, CSRF, idempotency): the parties of an agreement record
 * claims and evidence, the counterparty's person decides (never an agent, never the claimant side), a client-caused
 * plan change excuses the supplier's delay, defects are disputed and decided by trust reviewers with an appeal to a
 * different reviewer, reviews exist only for completed work, the subject computes an explainable snapshot, the public
 * reads a masked summary without evidence or score, and paying the platform changes nothing.
 */
const HUB_ID = '00000000-0000-4000-8000-0000000e0001';
process.env.TRUSTWORK_HUB_ID = HUB_ID;
const h = await startHarness('trust_api');

function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}
const reason = (r: Response) => (r.body as { details?: { reason?: string } }).details?.reason;
const PERSON = { via: 'person' as const };

test('execution and trust API: claims, human decisions, fair timing, disputes, reviews and payment-blind snapshots', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  const f: Fixture = { admin: h.db.admin, app: h.db.app, people: { petr: seed.people.petr, boris: seed.people.boris, carl: seed.people.carl, xenia: seed.people.xenia, anna: seed.people.anna }, supplier: seed.companies.supplier, project: seed.project };
  const staff = await staffWorld(f, HUB_ID);
  const login_ = async (key: Parameters<typeof login>[1]): Promise<Client> => { const c = h.client(); await login(c, key); return c; };
  const [petr, boris, carl, xenia] = [await login_('petr'), await login_('boris'), await login_('carl'), await login_('xenia')];
  const anonymous = h.client();
  const petrParty = { kind: 'person' as const, id: f.people.petr };
  const supplierParty = { kind: 'company' as const, id: f.supplier };

  const A = await buildAgreement(f, businessDate(-5), 'Synthetic patio over HTTP');
  const E = `/v1/execution/agreements/${A.agreement.id}`;
  const claimBody = (over: Record<string, unknown> = {}) => ({
    obligationId: A.byKind.deliver.id, defectId: null, kind: 'goods_delivery', claimant: supplierParty, lines: [{ ref: 'q1', quantity: { value: '40', unit: 'm2' } }], period: null,
    performedAt: new Date().toISOString(), statement: 'Synthetic: 40 m2 delivered', supersedesClaimId: null, actor: PERSON, ...over,
  });
  const decision = (over: Record<string, unknown> = {}) => ({ onBehalfOf: petrParty, decision: 'accepted', lines: [], note: null, stageCode: null, ...over });
  let view: ExecutionView;

  await t.test('the two parties read the execution view; everyone else gets not found', async () => {
    expectError(await anonymous.get(E), 401, 'auth.session_invalid');
    for (const outsider of [carl, xenia]) expectError(await outsider.get(E), 404, 'access.not_found');
    view = ok<ExecutionView>(await petr.get(E));
    assert.equal(view.agreement.side, 'buyer');
    assert.deepEqual(view.obligations.map((o) => [o.kind, o.progress]), [['deliver', 'open'], ['perform', 'open'], ['pay', 'open'], ['accept', 'open']]);
    assert.equal(ok<ExecutionView>(await boris.get(E)).agreement.side, 'seller');
    assert.ok(!JSON.stringify(view).includes('PRIVATE-ceiling'), 'private halves never reach the execution view');
  });

  let claimId = '';
  await t.test('claims: the obligor for its own side; agents only under a mandate; evidence from the agreement files', async () => {
    const notObligor = await petr.post(`${E}/claims`, claimBody({ claimant: petrParty }));
    expectError(notObligor, 403, 'access.forbidden');
    assert.equal(reason(notObligor), 'not_obligor');
    expectError(await petr.post(`${E}/claims`, claimBody()), 403, 'access.forbidden');
    expectError(await carl.post(`${E}/claims`, claimBody()), 404, 'access.not_found');
    expectError(await boris.post(`${E}/claims`, claimBody({ actor: { via: 'agent', mandateId: 'mandate-synthetic' } })), 403, 'access.mandate_scope');
    const future = await boris.post(`${E}/claims`, claimBody({ performedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }));
    expectError(future, 422, 'validation.schema');
    assert.equal(reason(future), 'in_future');
    const once = claimBody();
    view = ok<ExecutionView>(await boris.post(`${E}/claims`, once, { idempotencyKey: 'exe-claim-1' }), 201);
    assert.deepEqual(ok<ExecutionView>(await boris.post(`${E}/claims`, once, { idempotencyKey: 'exe-claim-1' }), 201), view, 'a retry replays the recorded result');
    const open = await boris.post(`${E}/claims`, claimBody());
    expectError(open, 409, 'validation.revision_conflict');
    assert.equal(reason(open), 'claim_open');
    claimId = view.claims[0]!.id;
    assert.equal(view.claims[0]!.state, 'claimed', 'a claim without evidence is a claim, not a failure');
    assert.equal(view.obligations[0]!.progress, 'claimed');
    const photo = await artifactOn(f, A.agreement.id, { company: f.supplier }, f.people.boris);
    const evidence = { target: { kind: 'claim', id: claimId }, artifactId: photo.id, artifactSha256: photo.sha256, kind: 'delivery_note', observedAt: null, note: null, actor: PERSON };
    expectError(await boris.post(`${E}/evidence`, { ...evidence, artifactSha256: 'b'.repeat(64) }), 422, 'validation.schema');
    expectError(await petr.post(`${E}/evidence`, evidence), 403, 'access.forbidden');
    view = ok<ExecutionView>(await boris.post(`${E}/evidence`, evidence), 201);
    assert.equal(view.claims[0]!.state, 'evidence_attached');
    assert.equal(view.claims[0]!.evidence[0]!.artifactSha256, photo.sha256);
  });

  await t.test('decisions: the counterparty person, never an agent, never the claimant side; concurrent decisions on one claim: one wins', async () => {
    const D = `/v1/execution/claims/${claimId}/decision`;
    expectError(await boris.post(D, decision()), 403, 'access.forbidden');
    expectError(await boris.post(D, decision({ onBehalfOf: supplierParty })), 403, 'access.forbidden');
    const agent = await petr.post(D, { ...decision(), actor: { via: 'agent', mandateId: 'mandate-synthetic' } });
    assert.equal(agent.status, 422, 'a decision has no actor field: no agent path exists');
    expectError(await petr.post(D, decision({ decision: 'rejected' })), 422, 'validation.schema');
    expectError(await carl.post(D, decision()), 404, 'access.not_found');
    const race = await Promise.all([petr.post(D, decision({ decision: 'partially_accepted', note: 'Two pallets cracked' })), petr.post(D, decision({ decision: 'partially_accepted', note: 'Two pallets cracked' }))]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
    view = ok<ExecutionView>(await petr.get(E));
    assert.equal(view.claims[0]!.state, 'partially_confirmed');
    assert.equal(view.obligations[0]!.progress, 'partially_accepted');
    assert.deepEqual(view.observations.map((o) => [o.dimension, o.outcome]).sort(), [['quality', 'partially_accepted'], ['timing', 'late']]);
  });

  await t.test('a client-caused plan change excuses the supplier\'s delay; the supplier sees why, never the owner\'s reason text', async () => {
    const B = await buildAgreement(f, businessDate(-5), 'Synthetic change over HTTP');
    const plan = await baselinePlan(f);
    await approvedChange(f, plan, { agreementId: B.agreement.id, cause: 'owner_request', accountable: { person: f.people.petr }, impactDays: 10 });
    const EB = `/v1/execution/agreements/${B.agreement.id}`;
    const claimed = ok<ExecutionView>(await boris.post(`${EB}/claims`, { ...claimBody(), obligationId: B.byKind.deliver.id }), 201);
    const decided = ok<ExecutionView>(await petr.post(`/v1/execution/claims/${claimed.claims[0]!.id}/decision`, decision()), 201);
    const timing = decided.observations.find((o) => o.dimension === 'timing')!;
    assert.deepEqual([timing.outcome, timing.attribution, timing.excludedReason], ['excused_delay', 'counterparty', 'client_caused_change']);
    const supplierView = ok<ExecutionView>(await boris.get(EB));
    assert.deepEqual(supplierView.timingFacts.map((x) => [x.cause, x.scheduleImpactDays, x.accountable.id]), [['owner_request', 10, f.people.petr]]);
    assert.ok(!JSON.stringify(supplierView).includes('PRIVATE-change-reason'));
  });

  let defectId = '';
  await t.test('defects and disputes: the subject disputes, a trust reviewer decides, a different reviewer decides the appeal', async () => {
    view = ok<ExecutionView>(await petr.post(`${E}/defects`, { reporter: petrParty, obligationId: A.byKind.deliver.id, claimId, severity: 'major', location: 'North edge', description: 'PRIVATE-defect cracked pavers', observedAt: new Date().toISOString(), actor: PERSON }), 201);
    defectId = view.defects[0]!.id;
    assert.equal(view.defects[0]!.state, 'open');
    expectError(await petr.post(`${E}/disputes`, { target: { kind: 'defect', id: defectId }, opener: petrParty, reason: 'mine' }), 403, 'access.forbidden');
    view = ok<ExecutionView>(await boris.post(`${E}/disputes`, { target: { kind: 'defect', id: defectId }, opener: supplierParty, reason: 'Synthetic: the cracks came from the site traffic' }), 201);
    const dispute = view.disputes[0]!;
    assert.equal(view.defects[0]!.state, 'disputed');
    const early = await petr.post(`/v1/execution/disputes/${dispute.id}/appeal`, { expectedRevision: dispute.revision, reason: 'early' });
    expectError(early, 409, 'validation.revision_conflict');
    const decided = await as(f, staff.reviewerA, async (trx) => executionDisputes.decide(trx, await staff.elevate(staff.reviewerA), dispute.id, 'upheld'));
    view = ok<ExecutionView>(await petr.post(`/v1/execution/disputes/${dispute.id}/appeal`, { expectedRevision: decided.revision, reason: 'Synthetic appeal' }));
    assert.equal(view.disputes[0]!.status, 'appealed');
    expectError(await boris.post(`/v1/execution/disputes/${dispute.id}/appeal`, { expectedRevision: decided.revision + 1, reason: 'again' }), 409, 'validation.revision_conflict');
    await as(f, staff.reviewerB, async (trx) => executionDisputes.decideAppeal(trx, await staff.elevate(staff.reviewerB), dispute.id, 'upheld'));
    view = ok<ExecutionView>(await boris.get(E));
    assert.deepEqual([view.disputes[0]!.status, view.disputes[0]!.outcome, view.defects[0]!.state], ['appeal_decided', 'upheld', 'open'], 'the defect stands after both decisions');
  });

  let reviewAboutSupplier = '';
  await t.test('reviews: only after completed work, once per side, the reviewed party responds and may appeal', async () => {
    const R = `/v1/trust/agreements/${A.agreement.id}/reviews`;
    const reviewBody = (author: typeof petrParty | typeof supplierParty, over: Record<string, unknown> = {}) => ({ author, ratings: { overall: 4, quality: 3 }, text: 'PRIVATE-review-text Good crew', language: 'en', correctsReviewId: null, ...over });
    const early = await petr.post(R, reviewBody(petrParty));
    expectError(early, 422, 'validation.schema');
    assert.equal(reason(early), 'review_not_allowed');
    // Complete the work: the remaining goods, the works, and the defect's remediation.
    const rest = ok<ExecutionView>(await boris.post(`${E}/claims`, claimBody({ lines: [{ ref: 'q1', quantity: { value: '2', unit: 'm2' } }] })), 201);
    await petr.post(`/v1/execution/claims/${rest.claims.at(-1)!.id}/decision`, decision());
    const works = ok<ExecutionView>(await boris.post(`${E}/claims`, claimBody({ obligationId: A.byKind.perform.id, kind: 'work_performed', lines: [], period: { from: businessDate(-7), to: businessDate(-6) } })), 201);
    ok(await petr.post(`/v1/execution/claims/${works.claims.at(-1)!.id}/decision`, decision()), 201);
    const fix = ok<ExecutionView>(await boris.post(`${E}/claims`, claimBody({ obligationId: null, defectId, kind: 'remediation', lines: [], statement: 'Replaced the cracked pavers' })), 201);
    view = ok<ExecutionView>(await petr.post(`/v1/execution/claims/${fix.claims.at(-1)!.id}/decision`, decision()), 201);
    assert.equal(view.defects[0]!.state, 'resolved');
    assert.equal(view.completed, true);
    expectError(await carl.post(R, reviewBody(petrParty)), 404, 'access.not_found');
    expectError(await boris.post(R, reviewBody(petrParty)), 403, 'access.forbidden');
    expectError(await petr.post(R, { ...reviewBody(petrParty), actor: { via: 'agent', mandateId: 'm' } }), 422, 'validation.unknown_field');
    let reviews = ok<AgreementReviewsView>(await petr.post(R, reviewBody(petrParty)), 201);
    reviewAboutSupplier = reviews.reviews[0]!.id;
    expectError(await petr.post(R, reviewBody(petrParty)), 409, 'validation.revision_conflict');
    reviews = ok<AgreementReviewsView>(await boris.post(R, reviewBody(supplierParty, { ratings: { overall: 5, payment: 5 } })), 201);
    expectError(await petr.post(`/v1/trust/reviews/${reviewAboutSupplier}/response`, { responder: petrParty, text: 'x' }), 403, 'access.forbidden');
    reviews = ok<AgreementReviewsView>(await boris.post(`/v1/trust/reviews/${reviewAboutSupplier}/response`, { responder: supplierParty, text: 'Thank you' }), 201);
    expectError(await petr.post('/v1/trust/appeals', { subject: { kind: 'review', id: reviewAboutSupplier }, reason: 'not mine' }), 404, 'access.not_found');
    ok(await boris.post('/v1/trust/appeals', { subject: { kind: 'review', id: reviewAboutSupplier }, reason: 'Synthetic: the remediation was accepted' }), 201);
    reviews = ok<AgreementReviewsView>(await petr.get(R));
    const about = reviews.reviews.find((r) => r.id === reviewAboutSupplier)!;
    assert.deepEqual([about.appeal, about.response?.text], ['submitted', 'Thank you']);
    expectError(await carl.get(R), 404, 'access.not_found');
  });

  await t.test('snapshots: the subject computes an explainable summary; the public reads masked counts without evidence or score; payment changes nothing', async () => {
    expectError(await petr.post('/v1/reputation/snapshots', { subject: supplierParty }), 403, 'access.forbidden');
    const first = ok<OwnSnapshotView>(await boris.post('/v1/reputation/snapshots', { subject: supplierParty }), 201);
    assert.equal(first.summary.method.version, 'engine-evidence-0.1');
    assert.equal(first.summary.publicScore, null);
    assert.ok(first.summary.facts.timing.samples >= 2);
    assert.equal(first.summary.exclusions.client_caused_change, 1, 'the excused delay is listed as an exclusion, not counted');
    assert.equal(first.summary.exclusions.appeal_pending, 1, 'the appealed review is excluded until decided');
    assert.ok(first.explanation.observations.length >= 4);
    expectError(await petr.get(`/v1/reputation/companies/${f.supplier}/own`), 404, 'access.not_found');
    assert.equal(ok<OwnSnapshotView>(await boris.get(`/v1/reputation/companies/${f.supplier}/own`)).id, first.id);
    const publicView = ok<PublicSnapshotView>(await anonymous.get(`/v1/reputation/companies/${f.supplier}`));
    assert.equal(publicView.snapshot?.summary.publicScore, null);
    assert.deepEqual(publicView.snapshot?.summary.opinions.reviews, { status: 'not_enough_data' });
    const json = JSON.stringify(publicView);
    for (const secret of ['PRIVATE-', A.agreement.id, defectId, claimId, reviewAboutSupplier, f.people.petr]) assert.ok(!json.includes(secret), `${secret} leaked publicly`);
    assert.equal(ok<PublicSnapshotView>(await anonymous.get(`/v1/reputation/people/${f.people.xenia}`)).snapshot, null);

    // Paying the platform (entitlements from a subscription, a sponsorship or credits) changes no input and no output.
    await withMaintenance(h.db.admin, async (trx) => {
      const offer = await trx.insertInto('offer').values({ hub_id: HUB_ID, code: 'synthetic_premium', name: 'Synthetic premium', kind: 'plan', status: 'active', created_by: f.people.anna }).returning('id').executeTakeFirstOrThrow();
      for (const owner of [{ owner_company_id: f.supplier, owner_person_id: null }, { owner_company_id: null, owner_person_id: f.people.petr }]) {
        const account = await trx.insertInto('billing_account').values({ hub_id: HUB_ID, ...owner, currency: 'USD', created_by: f.people.anna }).returning('id').executeTakeFirstOrThrow();
        for (const source of ['sponsorship', 'credit', 'trial'] as const) {
          await trx.insertInto('entitlement').values({ billing_account_id: account.id, offer_id: offer.id, module_code: 'reputation_builder', limits: JSON.stringify({ boost: 10, priority: 1 }), valid_from: new Date('2026-10-01T00:00:00Z'), source }).execute();
        }
      }
    });
    const second = ok<OwnSnapshotView>(await boris.post('/v1/reputation/snapshots', { subject: supplierParty }), 201);
    assert.notEqual(second.id, first.id);
    assert.equal(second.inputsDigest, first.inputsDigest, 'the same evidence, whoever pays');
    assert.deepEqual(second.summary, first.summary);
    assert.deepEqual(second.explanation, first.explanation);
    assert.deepEqual(ok<PublicSnapshotView>(await anonymous.get(`/v1/reputation/companies/${f.supplier}`)).snapshot?.summary, publicView.snapshot?.summary);
    // The client builds reputation too: payment discipline is a fact about the buyer; no due date means unknown.
    const own = ok<OwnSnapshotView>(await petr.post('/v1/reputation/snapshots', { subject: petrParty }), 201);
    assert.equal(own.summary.facts.payment.late, 0);
    assert.equal(own.summary.opinions.reviews.samples, 1);
  });

  await t.test('the person\'s agent records claims under a record_evidence mandate and nothing more', async () => {
    const C = await buildAgreement(f, businessDate(1), 'Synthetic agent claim');
    const mandates = new AllowListExecutionMandates([{ personId: f.people.boris, mandateId: 'mandate-synthetic-evidence' }]);
    const service = new ExecutionService(h.created.ctx!, h.services().principals, mandates, { hubId: HUB_ID });
    const token = boris.sessionCookie as string;
    const resolved = await h.services().principals.resolve(token);
    assert.ok(resolved);
    const state: RequestState = { requestId: 'req-agent-1', principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    const result = await service.recordClaim(C.agreement.id, { ...claimBody(), obligationId: C.byKind.deliver.id, actor: { via: 'agent', mandateId: 'mandate-synthetic-evidence' } } as never, state);
    assert.equal(result.claims[0]!.via, 'agent');
    assert.deepEqual(mandates.checks.map((c) => [c.action, c.context.id]), [['record_evidence', C.agreement.id]]);
    await assert.rejects(service.recordClaim(C.agreement.id, { ...claimBody(), obligationId: C.byKind.perform.id, kind: 'work_performed', lines: [], actor: { via: 'agent', mandateId: 'mandate-other' } } as never, { ...state, requestId: 'req-agent-2' }), /record_evidence mandate/);
  });

  await t.test('outbox events and audit carry identifiers only', async () => {
    const events = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('outbox_event').select(['type', 'payload']).where((eb) => eb.or([eb('type', 'like', 'execution.%'), eb('type', 'like', 'trust.%')])).execute());
    assert.ok(events.length >= 10);
    const allowed = new Set<string>([...EXECUTION_EVENT_PAYLOAD_KEYS, ...TRUST_EVENT_PAYLOAD_KEYS]);
    for (const e of events) {
      for (const key of Object.keys(e.payload as object)) assert.ok(allowed.has(key), `${e.type} carries ${key}`);
      assert.ok(!JSON.stringify(e.payload).includes('PRIVATE-'));
    }
    const audit = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('audit_event').select(['action', 'basis']).where((eb) => eb.or([eb('action', 'like', 'execution.%'), eb('action', 'like', 'trust.%')])).execute());
    assert.ok(audit.length >= 10);
    assert.ok(!JSON.stringify(audit).includes('PRIVATE-'), 'audit names the change, never review or defect text');
  });
});
