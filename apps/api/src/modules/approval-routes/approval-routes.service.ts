import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { Principal } from '../../deps/contracts.js';
import { auditEvents, type Transaction } from '../../deps/data.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  ApprovalRoutePayloadSchema, approvalDelegations, approvalRequests, approvalRoutes, SOD_RULES, type ApprovalSubjectKind,
} from './deps.js';
import { approvalRefusal } from './errors.js';
import type { ApprovalMandateCheck, ApprovalMandatePort } from './mandates.js';
import { APPROVAL_ROUTE_TEMPLATES, routeDigest, templateOf } from './resolution.js';
import type { ActivateRouteBodySchema, DecideBodySchema, DelegateBodySchema, DraftRouteBodySchema, RequestsQuerySchema, RevokeDelegationBodySchema, WithdrawBodySchema } from './schemas.js';
import { decisionView, delegationView, requestView, routeView, stepView } from './views.js';
import type { z } from 'zod';

type In<T extends z.ZodType> = z.infer<T>;
type Actor = { via: 'person' } | { via: 'agent'; mandateId: string };

export interface ApprovalRoutesOptions {
  /** Hub setting `routeActivationSecondPerson` (procurement domain): the drafter cannot activate. Default: engine default (off). */
  routeActivationSecondPerson: boolean;
}

/**
 * Approval routes use cases (PRC-001 step 4). Route activation and decisions are the human-only verb `approve`: they
 * run only for the person in their own first-party session (the page or the assistant overlay) and refuse an agent
 * actor outright, whatever a mandate says; the database repeats it (`approval_first_party_session`). Drafting a
 * route, delegating, withdrawing and revoking are reachable by the person's agent under a `prepare` or
 * `maintain_records` mandate (agent parity, ADR 010 decision 23). Every mutation runs in one principal transaction
 * with its audit row and completes its idempotency record there (BE-005).
 */
export class ApprovalRoutesService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: ApprovalMandatePort,
    private readonly options: ApprovalRoutesOptions,
  ) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  private steppedUp(state: RequestState): boolean {
    return state.session !== null && this.now().getTime() - state.session.authenticatedAt.getTime() <= this.ctx.config.session.stepUpMs;
  }

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(approvalRefusal);
  }

  private companyOf(principal: Principal): string {
    const company = principal.membership?.companyId;
    if (!company) throw new ApiError('access.not_found', 'approval routes belong to a company you are an active member of', { reason: 'no_company' });
    return company;
  }

  private sessionOf(state: RequestState): string {
    if (!state.session) throw new ApiError('auth.session_invalid', 'authentication required');
    return state.session.id;
  }

  /** Approving is human-only: an agent may prepare the decision card, never decide. */
  private humanOnly(actor: Actor): void {
    if (actor.via !== 'person') throw new ApiError('access.mandate_scope', 'approving is human-only: the person decides on the first-party surface', { reason: 'human_only' });
  }

  private async agentAllowed(principal: Principal, actor: Actor, action: ApprovalMandateCheck['action'], companyId: string): Promise<'person' | 'agent'> {
    if (actor.via === 'person') return 'person';
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: actor.mandateId, action, context: { kind: 'company', id: companyId }, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this company`, { reason: 'mandate_scope' });
    return 'agent';
  }

  private audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: Record<string, unknown>): Promise<void> {
    return auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }

  private sameKey(body: { idempotencyKey: string }, header: string | undefined): void {
    if (header !== undefined && header !== body.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key' });
  }

  /* ---------- Routes ---------- */

  templates() {
    return { items: APPROVAL_ROUTE_TEMPLATES.map((t) => ({ key: t.key, version: t.version, labelKey: t.labelKey, payload: t.payload })) };
  }

  listRoutes(state: RequestState, subjectKind: ApprovalSubjectKind | null) {
    return this.run(state, async (trx, p) => ({ items: (await approvalRoutes.list(trx, this.companyOf(p), subjectKind)).map(routeView) }));
  }

  getRoute(state: RequestState, id: string) {
    return this.run(state, async (trx) => {
      const row = await approvalRoutes.get(trx, id);
      if (!row) throw new ApiError('access.not_found');
      return routeView(row);
    });
  }

  draftRoute(state: RequestState, body: In<typeof DraftRouteBodySchema>) {
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      if (body.owner.kind !== 'company' || body.owner.id !== company) throw new ApiError('access.forbidden', 'routes belong to your company', { reason: 'not_authorised' });
      const via = await this.agentAllowed(p, body.actor, 'prepare', company);
      const template = body.templateKey === null ? null : templateOf(body.templateKey);
      if (body.templateKey !== null && !template) throw new ApiError('validation.schema', 'unknown route template', { reason: 'unknown_template' });
      const payload = ApprovalRoutePayloadSchema.parse(body.payload);
      const templateVersion = template?.version ?? null;
      const digest = routeDigest({ ownerCompanyId: company, subjectKind: body.subjectKind, payload, templateKey: body.templateKey, templateVersion });
      const row = await approvalRoutes.draft(trx, {
        companyId: company, subjectKind: body.subjectKind, payload, digest: digest.value, templateKey: body.templateKey, templateVersion, secondPersonRequired: this.options.routeActivationSecondPerson,
      });
      await this.audit(trx, p, state, 'approval.route_drafted', 'approval_route_version', row.id, { subjectKind: row.subject_kind, version: row.version, digest: row.digest, via, mandateId: body.actor.via === 'agent' ? body.actor.mandateId : null });
      return routeView(row);
    });
  }

  activateRoute(state: RequestState, id: string, body: In<typeof ActivateRouteBodySchema>, idempotencyHeader?: string) {
    this.humanOnly(body.actor);
    this.sameKey(body, idempotencyHeader);
    if (body.routeVersionId !== id) throw new ApiError('validation.schema', 'routeVersionId must match the path', { reason: 'route_mismatch' });
    return this.run(state, async (trx, p) => {
      const row = await approvalRoutes.activate(trx, { routeId: id, digest: body.digest.value, expectedRevision: body.expectedRevision, sessionId: this.sessionOf(state) });
      await this.audit(trx, p, state, 'approval.route_activated', 'approval_route_version', row.id, { subjectKind: row.subject_kind, version: row.version, digest: row.digest, stepUp: this.steppedUp(state) });
      return routeView(row);
    });
  }

  /* ---------- Requests and decisions ---------- */

  listRequests(state: RequestState, query: In<typeof RequestsQuerySchema>) {
    return this.run(state, async (trx, p) => ({
      items: (await approvalRequests.list(trx, { companyId: this.companyOf(p), status: query.status ?? null, mineOnly: query.mine === 'true', personId: p.personId, limit: query.limit ?? 50 })).map(requestView),
    }));
  }

  /** "Your decision is needed": pending steps the person may decide now, directly or as a delegate. */
  waiting(state: RequestState) {
    return this.run(state, async (trx) => {
      const rows = await approvalRequests.waiting(trx, this.now(), 50);
      const items = [];
      for (const w of rows) {
        const request = await approvalRequests.get(trx, w.request_id);
        if (!request) continue;
        items.push({ request: requestView(request), step: w.step_key, delegatedFromPersonId: w.delegated_from_person_id, dueAt: w.due_at ? new Date(w.due_at).toISOString() : null });
      }
      return { items };
    });
  }

  /** The decision card: the bound request, its steps and decisions, and what the viewer may do (an agent prepares it, a person decides). */
  getRequest(state: RequestState, id: string) {
    return this.run(state, async (trx) => {
      const row = await approvalRequests.get(trx, id);
      if (!row) throw new ApiError('access.not_found');
      const [steps, decisions, options] = [await approvalRequests.steps(trx, id), await approvalRequests.decisions(trx, id), await approvalRequests.viewerOptions(trx, id, this.now())];
      return {
        request: requestView(row),
        steps: steps.map(stepView),
        decisions: decisions.map(decisionView),
        viewer: {
          options: options.map((o) => ({ step: o.step_key, mayDecide: o.may_decide, delegatedFromPersonId: o.delegated_from_person_id, refusal: o.refusal })),
          approveNeedsStepUp: row.amount_minor !== null,
          steppedUp: this.steppedUp(state),
        },
        sodRules: SOD_RULES,
      };
    });
  }

  decide(state: RequestState, id: string, body: In<typeof DecideBodySchema>, idempotencyHeader?: string) {
    this.humanOnly(body.actor);
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      const decision = await approvalRequests.decide(trx, {
        requestId: id, step: body.step, decision: body.decision, subjectDigest: body.subjectDigest.value, reason: body.reason, expectedRevision: body.expectedRevision,
        sessionId: this.sessionOf(state), stepUp: this.steppedUp(state), now: this.now(),
      });
      const row = await approvalRequests.get(trx, id);
      if (!row) throw new ApiError('access.not_found');
      await this.audit(trx, p, state, 'approval.decided', 'approval_request', id, {
        decisionId: decision.id, step: decision.step_key, decision: decision.decision, digest: decision.subject_digest, delegationId: decision.delegation_id, sodFlag: decision.sod_flag, status: row.status,
      });
      return { decision: decisionView(decision), request: requestView(row) };
    });
  }

  withdraw(state: RequestState, id: string, body: In<typeof WithdrawBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      const via = await this.agentAllowed(p, body.actor, 'maintain_records', this.companyOf(p));
      const row = await approvalRequests.withdraw(trx, { requestId: id, expectedRevision: body.expectedRevision, now: this.now() });
      await this.audit(trx, p, state, 'approval.withdrawn', 'approval_request', id, { via });
      return requestView(row);
    });
  }

  /* ---------- Delegation ---------- */

  listDelegations(state: RequestState) {
    return this.run(state, async (trx, p) => ({ items: (await approvalDelegations.list(trx, this.companyOf(p))).map((r) => delegationView(r, this.now())) }));
  }

  delegate(state: RequestState, body: In<typeof DelegateBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      if (body.companyId !== company) throw new ApiError('access.forbidden', 'delegate within your own company', { reason: 'not_authorised' });
      const via = await this.agentAllowed(p, body.actor, 'maintain_records', company);
      const row = await approvalDelegations.create(trx, {
        delegatePersonId: body.delegatePersonId, subjectKinds: body.subjectKinds, limit: body.limit, validFrom: new Date(body.validFrom), validUntil: new Date(body.validUntil), now: this.now(),
      });
      await this.audit(trx, p, state, 'approval.delegated', 'approval_delegation', row.id, {
        delegatePersonId: row.delegate_person_id, subjectKinds: row.subject_kinds, limited: row.limit_minor !== null, validFrom: body.validFrom, validUntil: body.validUntil, via,
      });
      return delegationView(row, this.now());
    });
  }

  revokeDelegation(state: RequestState, id: string, body: In<typeof RevokeDelegationBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      const via = await this.agentAllowed(p, body.actor, 'maintain_records', this.companyOf(p));
      const row = await approvalDelegations.revoke(trx, { delegationId: id, reason: body.reason, expectedRevision: body.expectedRevision });
      await this.audit(trx, p, state, 'approval.delegation_revoked', 'approval_delegation', row.id, { via });
      return delegationView(row, this.now());
    });
  }
}
