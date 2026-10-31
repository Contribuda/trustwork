import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RequestState } from '../../apps/api/src/common/request.js';
import { ApprovalRoutesService } from '../../apps/api/src/modules/approval-routes/approval-routes.service.js';
import { AllowListApprovalMandates } from '../../apps/api/src/modules/approval-routes/mandates.js';
import { APPROVAL_ROUTE_TEMPLATES } from '../../apps/api/src/modules/approval-routes/resolution.js';
import { expectError, SKIP_REASON, startHarness, type Client } from '../backend/helpers/app.js';
import { grant, holders, ok, seedWorld, signIn, submit, subjectDigest, usd, uuid, type Person, type World } from './helpers.js';

/**
 * PRC-001 through HTTP: route drafting from a template and human-only activation, the decision card and "Your
 * decision is needed", human-only decisions with step-up for money, requester and outsider refusals, delegation and
 * withdrawal, agent parity under mandates (and the refusal of agent decisions whatever the mandate), and the hub's
 * second-person activation option.
 */
const h = await startHarness('approvals_api');

interface RouteView { id: string; digest: { algorithm: string; value: string }; status: string; version: number; templateKey: string | null }
interface RequestView { id: string; status: string; revision: number; subjectDigest: { algorithm: string; value: string } }
interface Card { request: RequestView; steps: { key: string; status: string }[]; decisions: { approverPersonId: string; decision: string; confirmation: { via: string; personId: string; stepUp: boolean } }[]; viewer: { options: { step: string; mayDecide: boolean; refusal: string | null }[]; approveNeedsStepUp: boolean } }

let keys = 0;
/** Commands carry the idempotency key in the body and the header (the frozen supply commands include it). */
const send = (client: Client, url: string, body: Record<string, unknown>) => {
  const key = `approvals-${++keys}`;
  return client.post(url, { ...body, idempotencyKey: key }, { idempotencyKey: key });
};

test('approval routes API: templates, activation, decision card, human-only decisions, delegation, agents and second person', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const w: World = await seedWorld(h, 'api');
  const P = w.people;
  await grant(h.db.admin, w, 'paul', 'procurement.approval.decide');
  await grant(h.db.admin, w, 'quinn', 'procurement.approval.decide');
  const clients = {} as Record<Person, Client>;
  for (const p of ['ada', 'rita', 'paul', 'quinn', 'dana', 'otto'] as const) clients[p] = await signIn(h, p, 'api');
  const { ada, rita, paul, quinn, dana, otto } = clients;
  const template = APPROVAL_ROUTE_TEMPLATES.find((x) => x.key === 'owner_approves')!;

  await t.test('routes: drafted from a template by a route manager, activated by a person in a fresh session', async () => {
    const templates = ok<{ items: { key: string }[] }>(await rita.get('/v1/approvals/templates'));
    assert.deepEqual(templates.items.map((x) => x.key), ['owner_approves', 'project_manager_then_director']);
    const body = { owner: { kind: 'company', id: w.company }, subjectKind: 'requisition', payload: template.payload, templateKey: 'owner_approves' };
    expectError(await rita.post('/v1/approvals/routes', body), 403, 'access.forbidden');
    expectError(await otto.post('/v1/approvals/routes', body), 403, 'access.forbidden');
    expectError(await ada.post('/v1/approvals/routes', { ...body, templateKey: 'no_such_template' }), 422, 'validation.schema');
    const draft = ok<RouteView>(await ada.post('/v1/approvals/routes', body), 201);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.templateKey, 'owner_approves');
    const activation = { routeVersionId: draft.id, digest: draft.digest, expectedRevision: 1 };
    expectError(await send(ada, `/v1/approvals/routes/${draft.id}/activate`, { ...activation, actor: { via: 'agent', mandateId: 'mandate-any' } }), 403, 'access.mandate_scope');
    expectError(await send(ada, `/v1/approvals/routes/${draft.id}/activate`, { ...activation, digest: { ...draft.digest, value: '0'.repeat(64) } }), 409, 'access.approval_digest_mismatch');
    expectError(await ada.post(`/v1/approvals/routes/${draft.id}/activate`, { ...activation, idempotencyKey: 'other-key' }, { idempotencyKey: 'mismatched-key' }), 422, 'validation.schema');
    h.clock.advance(h.created.config.session.stepUpMs + 1_000);
    try {
      expectError(await send(ada, `/v1/approvals/routes/${draft.id}/activate`, activation), 403, 'auth.step_up_required');
    } finally {
      h.clock.reset();
    }
    const active = ok<RouteView>(await send(ada, `/v1/approvals/routes/${draft.id}/activate`, activation));
    assert.equal(active.status, 'active');
    assert.equal(ok<{ items: RouteView[] }>(await rita.get('/v1/approvals/routes?subjectKind=requisition')).items.length, 1);
    assert.equal(ok<{ items: RouteView[] }>(await otto.get('/v1/approvals/routes')).items.length, 0);
    expectError(await otto.get(`/v1/approvals/routes/${draft.id}`), 404, 'access.not_found');
  });

  await t.test('decisions: the card, decisions waiting, refusals, step-up for money, and one approval', async () => {
    const request = await submit(h, w, 'rita', { subject: { kind: 'requisition', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('api-1'), amount: usd('250000') });
    assert.ok(ok<{ items: { request: RequestView; step: string }[] }>(await paul.get('/v1/approvals/requests/waiting')).items.some((x) => x.request.id === request.id && x.step === 'owner'));
    assert.equal(ok<{ items: unknown[] }>(await rita.get('/v1/approvals/requests/waiting')).items.length, 0, 'never your own request');
    assert.equal(ok<{ items: unknown[] }>(await otto.get('/v1/approvals/requests/waiting')).items.length, 0);
    const card = ok<Card>(await paul.get(`/v1/approvals/requests/${request.id}`));
    assert.deepEqual(card.viewer.options, [{ step: 'owner', mayDecide: true, delegatedFromPersonId: null, refusal: null }]);
    assert.equal(card.viewer.approveNeedsStepUp, true);
    expectError(await dana.get(`/v1/approvals/requests/${request.id}`), 404, 'access.not_found');
    expectError(await otto.get(`/v1/approvals/requests/${request.id}`), 404, 'access.not_found');
    assert.ok(ok<{ items: RequestView[] }>(await rita.get('/v1/approvals/requests?mine=true&status=pending')).items.some((x) => x.id === request.id));

    const decision = (over: Record<string, unknown> = {}) => ({ approvalRequestId: request.id, step: 'owner', decision: 'approve', subjectDigest: request.subjectDigest, reason: null, expectedRevision: card.request.revision, ...over });
    const url = `/v1/approvals/requests/${request.id}/decide`;
    expectError(await send(rita, url, decision()), 403, 'access.forbidden');
    expectError(await send(dana, url, decision()), 404, 'access.not_found');
    expectError(await send(paul, url, decision({ actor: { via: 'agent', mandateId: 'mandate-any' } })), 403, 'access.mandate_scope');
    expectError(await send(paul, url, decision({ mandateId: 'mandate-any' })), 422, 'validation.unknown_field');
    expectError(await send(paul, url, decision({ subjectDigest: subjectDigest('another version') })), 409, 'access.approval_digest_mismatch');
    expectError(await send(paul, url, decision({ decision: 'reject' })), 422, 'validation.schema');
    h.clock.advance(h.created.config.session.stepUpMs + 1_000);
    try {
      expectError(await send(paul, url, decision()), 403, 'auth.step_up_required');
    } finally {
      h.clock.reset();
    }
    const approved = ok<{ decision: { confirmation: { via: string; personId: string; stepUp: boolean }; approverPersonId: string }; request: RequestView }>(await send(paul, url, decision()));
    assert.deepEqual(approved.decision.confirmation.via, 'first_party_form');
    assert.equal(approved.decision.confirmation.personId, P.paul);
    assert.equal(approved.decision.confirmation.stepUp, true);
    assert.equal(approved.request.status, 'approved');
    expectError(await send(quinn, url, decision({ expectedRevision: approved.request.revision })), 409, 'validation.revision_conflict');
    const audit = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'approval.decided' AND object_id = $1", [request.id]);
    assert.equal(audit.rows[0]?.n, 1);
    const events = await h.db.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM trustwork.outbox_event WHERE aggregate_id = $1 AND type = 'approval.request_closed'", [request.id]);
    assert.equal(events.rows.length, 1);
    assert.deepEqual(Object.keys(events.rows[0]!.payload).sort(), ['currentStep', 'requestId', 'status', 'subjectId', 'subjectKind', 'subjectVersionId'], 'identifiers only: no amount, no people');
  });

  await t.test('delegation and withdrawal through HTTP', async () => {
    const now = h.clock.now();
    const delegation = { companyId: w.company, delegatePersonId: P.dana, subjectKinds: ['requisition'], validFrom: new Date(now.getTime() - 60_000).toISOString(), validUntil: new Date(now.getTime() + 7 * 86_400_000).toISOString(), expectedRevision: 1 };
    expectError(await send(paul, '/v1/approvals/delegations', { ...delegation, companyId: w.otherCompany }), 403, 'access.forbidden');
    expectError(await send(paul, '/v1/approvals/delegations', { ...delegation, validUntil: new Date(now.getTime() + 100 * 86_400_000).toISOString() }), 422, 'validation.schema');
    const created = ok<{ id: string; status: string; limit: unknown }>(await send(paul, '/v1/approvals/delegations', { ...delegation, limit: usd('500000') }), 201);
    assert.equal(created.status, 'active');
    assert.ok(ok<{ items: { id: string }[] }>(await dana.get('/v1/approvals/delegations')).items.some((d) => d.id === created.id));
    assert.equal(ok<{ items: unknown[] }>(await rita.get('/v1/approvals/delegations')).items.length, 0);
    const request = await submit(h, w, 'rita', { subject: { kind: 'requisition', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('api-2'), amount: usd('100000') });
    const card = ok<Card>(await dana.get(`/v1/approvals/requests/${request.id}`));
    assert.deepEqual(card.viewer.options, [{ step: 'owner', mayDecide: true, delegatedFromPersonId: P.paul, refusal: null }]);
    const decided = ok<{ decision: { delegatedFromPersonId: string; delegationId: string } }>(await send(dana, `/v1/approvals/requests/${request.id}/decide`, {
      approvalRequestId: request.id, step: 'owner', decision: 'return', subjectDigest: request.subjectDigest, reason: 'Add the delivery window', expectedRevision: card.request.revision,
    }));
    assert.equal(decided.decision.delegatedFromPersonId, P.paul);
    assert.equal(decided.decision.delegationId, created.id);
    const revoked = ok<{ status: string }>(await send(paul, `/v1/approvals/delegations/${created.id}/revoke`, { reason: 'Back from leave', expectedRevision: 1 }));
    assert.equal(revoked.status, 'revoked');

    const pending = await submit(h, w, 'rita', { subject: { kind: 'requisition', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('api-3'), amount: null });
    expectError(await send(paul, `/v1/approvals/requests/${pending.id}/withdraw`, { expectedRevision: pending.revision }), 403, 'access.forbidden');
    const withdrawn = ok<RequestView>(await send(rita, `/v1/approvals/requests/${pending.id}/withdraw`, { expectedRevision: pending.revision }));
    assert.equal(withdrawn.status, 'withdrawn');
  });

  await t.test('agent parity: the agent drafts, delegates and withdraws under mandates; it never decides or activates, whatever the mandate', async () => {
    const stateOf = async (client: Client): Promise<RequestState> => {
      const token = client.sessionCookie as string;
      const resolved = await h.services().principals.resolve(token);
      assert.ok(resolved);
      return { requestId: `approvals-agent-${uuid()}`, principal: resolved.principal, session: resolved.session, sessionTokenHash: createHash('sha256').update(token).digest('hex'), client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    };
    const mandates = new AllowListApprovalMandates([
      { personId: P.ada, mandateId: 'mandate-ada', action: 'prepare' }, { personId: P.ada, mandateId: 'mandate-ada', action: 'approve' },
      { personId: P.paul, mandateId: 'mandate-paul', action: 'maintain_records' }, { personId: P.paul, mandateId: 'mandate-paul', action: 'approve' },
    ]);
    const service = new ApprovalRoutesService(h.created.ctx!, h.services().principals, mandates, { routeActivationSecondPerson: false });
    const [adaState, paulState] = [await stateOf(ada), await stateOf(paul)];
    const agentOf = (mandateId: string) => ({ via: 'agent' as const, mandateId });
    const draft = await service.draftRoute(adaState, { owner: { kind: 'company', id: w.company }, subjectKind: 'order', payload: { steps: [holders('approve')], receiverSoleApprovalThreshold: null } as never, templateKey: null, actor: agentOf('mandate-ada') });
    assert.equal(draft.status, 'draft');
    await assert.rejects(service.draftRoute(paulState, { owner: { kind: 'company', id: w.company }, subjectKind: 'order', payload: template.payload, templateKey: null, actor: agentOf('mandate-paul') }), (e: { code?: string }) => e.code === 'access.mandate_scope');
    assert.throws(() => service.activateRoute(adaState, draft.id, { routeVersionId: draft.id, digest: draft.digest, expectedRevision: 1, idempotencyKey: 'k1', actor: agentOf('mandate-ada') }), (e: { code?: string; details?: { reason?: string } }) => e.code === 'access.mandate_scope' && e.details?.reason === 'human_only');
    await service.activateRoute(adaState, draft.id, { routeVersionId: draft.id, digest: draft.digest, expectedRevision: 1, idempotencyKey: 'k2', actor: { via: 'person' } });
    const order = await submit(h, w, 'rita', { subject: { kind: 'order', id: uuid() }, subjectVersionId: uuid(), subjectDigest: subjectDigest('api-agent'), amount: null });
    assert.throws(() => service.decide(paulState, order.id, { approvalRequestId: order.id, step: 'approve', decision: 'approve', subjectDigest: order.subjectDigest, reason: null, expectedRevision: order.revision, idempotencyKey: 'k3', actor: agentOf('mandate-paul') }),
      (e: { code?: string; details?: { reason?: string } }) => e.code === 'access.mandate_scope' && e.details?.reason === 'human_only');
    const delegated = await service.delegate(paulState, { companyId: w.company, delegatePersonId: P.quinn, subjectKinds: ['order'], validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(), expectedRevision: 1, idempotencyKey: 'k4', limit: null, actor: agentOf('mandate-paul') });
    assert.equal(delegated.delegatePersonId, P.quinn);
    assert.equal(mandates.checks.some((c) => c.action === ('approve' as never)), false, 'the human-only commands never consult the mandate port');
    assert.deepEqual(mandates.checks.map((c) => [c.personId === P.ada ? 'ada' : 'paul', c.action, c.context.kind]), [['ada', 'prepare', 'company'], ['paul', 'prepare', 'company'], ['paul', 'maintain_records', 'company']]);
    const decisions = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.approval_decision WHERE approval_request_id = $1', [order.id]);
    assert.equal(decisions.rows[0]?.n, 0, 'no decision exists without the person');
  });

  await t.test('hub option: a second person activates the route', async () => {
    await grant(h.db.admin, w, 'paul', 'procurement.routes.manage');
    const stateOf = async (client: Client): Promise<RequestState> => {
      const token = client.sessionCookie as string;
      const resolved = await h.services().principals.resolve(token);
      assert.ok(resolved);
      return { requestId: `approvals-second-${uuid()}`, principal: resolved.principal, session: resolved.session, sessionTokenHash: null, client: { userAgentFamily: 'test', ipPrefix: '', ip: '127.0.0.1' } };
    };
    const service = new ApprovalRoutesService(h.created.ctx!, h.services().principals, new AllowListApprovalMandates([]), { routeActivationSecondPerson: true });
    const adaState = await stateOf(ada);
    const draft = await service.draftRoute(adaState, { owner: { kind: 'company', id: w.company }, subjectKind: 'document', payload: template.payload, templateKey: 'owner_approves', actor: { via: 'person' } });
    assert.equal(draft.secondPersonRequired, true);
    await assert.rejects(service.activateRoute(adaState, draft.id, { routeVersionId: draft.id, digest: draft.digest, expectedRevision: 1, idempotencyKey: 'k5', actor: { via: 'person' } }), (e: { code?: string }) => e.code === 'access.second_approver_required');
    const activated = await service.activateRoute(await stateOf(paul), draft.id, { routeVersionId: draft.id, digest: draft.digest, expectedRevision: 1, idempotencyKey: 'k6', actor: { via: 'person' } });
    assert.equal(activated.activatedBy, P.paul);
  });
});
