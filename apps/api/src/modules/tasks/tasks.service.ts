import type { z } from 'zod';
import { computeAgreementDigest, computeDigest, DIGEST_ALGORITHM, verifyDigest, type Digest, type Money, type Party, type Principal, type VersionRef } from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { mapDealError } from '../sales/common.js';
import { electronicRecordsSatisfied, type ElectronicRecordsConsent } from '../sales/deps.js';
import type { ElectronicRecordsPolicySource } from '../transactions/electronic-records.js';
import {
  acceptanceEvents, agreements, assignmentStatusFor, buildTaskRequestPayload, checkTaskAcceptance, deriveTaskObligations, EMPTY_TASK_OFFER_PRIVATE, EMPTY_TASK_REQUEST_PRIVATE, isoDate,
  milestoneStates, obligations, OfferorTaskOfferViewSchema, OfferorTaskRequestViewSchema, offerMisfits, OpenTaskRequestListSchema, outsideBound, OwnerTaskRequestViewSchema, paymentBlindOrder,
  planItemStates, planParts, plans, projectLocations, reviewAllowed, rowToItem, TASK_EVENT_PAYLOAD_KEYS, TASK_PLAN_ITEM_KINDS, TaskAgreementSchema, TaskAssignmentListSchema, TaskAssignmentSchema,
  TaskAssignmentViewSchema, taskAgreements, taskAssignments, TaskBriefError, TaskExecutionRecordSchema, TaskInvitationListSchema, TaskInvitationSchema, taskInvitations,
  taskOfferDigestInput, TaskOfferListSchema, TaskOfferPayloadSchema, taskOfferPrivate, TaskOfferPrivateSchema, taskOffers, TaskOfferSchema, taskProjects, taskRecords, TaskRequestListSchema,
  TaskRequestPayloadSchema, taskRequestPrivate, TaskRequestPrivateSchema, taskRequests, TaskRequestSchema, taskRequestVersionDigestInput, TaskRequestVersionSchema, taskRequestVersions,
  TaskReviewSchema, taskReviews, TaskSiteSchema, toLocation,
  type AcceptanceEventRow, type AcceptTaskOfferCommandSchema, type AgreementRow, type CancelTaskRequestCommandSchema, type ConfirmTaskAgreementCommandSchema,
  type CreateTaskOfferCommandSchema, type CreateTaskRequestCommandSchema, type DeclineTaskAgreementCommandSchema, type InviteTaskOfferorCommandSchema, type ObligationRow,
  type OfferorTaskOfferView, type OfferorTaskRequestView, type OwnerTaskRequestView, type PartyScope, type PublishTaskRequestCommandSchema, type RecordTaskExecutionCommandSchema,
  type SaveTaskOfferDraftCommandSchema, type SaveTaskRequestDraftCommandSchema, type SaveTaskRequestPrivateCommandSchema, type SendTaskOfferCommandSchema,
  type SubmitTaskReviewCommandSchema, type TaskActorInput, type TaskAgreement, type TaskAssignmentRow, type TaskAssignmentView, type TaskExecutionRecordRow, type TaskInvitationRow,
  type TaskOfferPrivateInput, type TaskOfferRow, type TaskRequestPayload, type TaskRequestPrivateInput, type TaskRequestRow, type TaskRequestTerms,
  type TaskRequestVersionRow, type TaskReviewRow, type WithdrawTaskAgreementCommandSchema, type WithdrawTaskOfferCommandSchema,
} from './deps.js';
import type { TaskMandateCheck, TaskMandatePort } from './mandates.js';

type In<T extends z.ZodType> = z.infer<T>;
type EventPayload = Partial<Record<(typeof TASK_EVENT_PAYLOAD_KEYS)[number], string | number | null>>;
interface ResolvedActor { via: 'person' | 'agent'; personId: string; mandateId: string | null }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: Date | string): string => new Date(value).toISOString();
const digestOf = (value: string): Digest => ({ algorithm: DIGEST_ALGORITHM, value });
const partyOf = (person: string | null, company: string | null): Party => (person ? { kind: 'person', id: person } : { kind: 'company', id: company as string });
const columnsOf = (party: Party) => (party.kind === 'person' ? { person: party.id, company: null } : { person: null, company: party.id });
const money = (minor: string | null, currency: string | null): Money | null => (minor !== null && currency !== null ? { minorUnits: String(minor), currency } : null);

/** Database hints of the tasks guards, mapped to frozen contract codes (checked before the deal and commerce hints). */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'tasks.item_not_in_baseline': { code: 'validation.schema', reason: 'item_not_in_baseline' },
  'tasks.unknown_milestone': { code: 'validation.schema', reason: 'unknown_milestone' },
  'tasks.milestone_not_open': { code: 'validation.revision_conflict', reason: 'milestone_not_open' },
  'tasks.claim_not_open': { code: 'validation.revision_conflict', reason: 'claim_not_open' },
  'tasks.review_not_allowed': { code: 'validation.schema', reason: 'review_not_allowed' },
};
function mapTaskError(error: unknown): never {
  const pg = error as { code?: string; hint?: string };
  const mapped = pg && typeof pg.code === 'string' && pg.hint ? HINTS[pg.hint] : undefined;
  if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
  return mapDealError(error);
}
const CHECK_MESSAGES = {
  'commercial.stale_version': 'the offer answers an earlier request version; it cannot be accepted as the current one',
  'commercial.quote_not_acceptable': 'only a sent offer is accepted',
  'commercial.quote_expired': 'the offer validity has passed',
  'commercial.digest_mismatch': 'the accepted terms do not match the stored versions',
  'commercial.rfq_version_mismatch': 'the request version is not the current published one',
} as const;

/* ---------- Serializers (explicit allowlists, re-validated by the strict contract schemas) ---------- */

function requestContract(row: TaskRequestRow) {
  return TaskRequestSchema.parse({
    id: row.id, owner: partyOf(row.owner_person_id, null), planItem: { projectId: row.project_id, planId: row.plan_id, planVersionId: row.plan_version_id, itemKey: row.plan_item_key },
    audience: row.audience, status: row.status, currentVersion: row.current_version, currentVersionId: row.current_version_id, closedReason: row.closed_reason, revision: row.revision,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}
function versionContract(row: TaskRequestVersionRow) {
  return TaskRequestVersionSchema.parse({
    id: row.id, taskRequestId: row.task_request_id, version: row.version, status: row.status, payload: row.payload, digest: row.digest ? digestOf(row.digest) : null,
    publishedAt: row.published_at ? iso(row.published_at) : null, amendmentReason: row.amendment_reason,
  });
}
function invitationContract(row: TaskInvitationRow) {
  return TaskInvitationSchema.parse({ id: row.id, taskRequestId: row.task_request_id, party: partyOf(row.party_person_id, row.party_company_id), status: row.status, sentAt: iso(row.created_at) });
}
function offerContract(row: TaskOfferRow) {
  return TaskOfferSchema.parse({
    id: row.id, taskRequestId: row.task_request_id, offeror: partyOf(row.offeror_person_id, row.offeror_company_id), version: row.version,
    requestVersion: { id: row.request_version_id, version: row.request_version, digest: digestOf(row.request_version_digest) }, status: row.status, payload: row.payload,
    digest: row.digest ? digestOf(row.digest) : null, staleReason: row.stale_reason, sentAt: row.sent_at ? iso(row.sent_at) : null, revision: row.revision, createdAt: iso(row.created_at),
  });
}
function obligationContract(row: ObligationRow) {
  return {
    party: partyOf(row.obligor_person_id, row.obligor_company_id), kind: row.kind, due: row.due ? iso(row.due) : null, amount: money(row.amount_minor === null ? null : String(row.amount_minor), row.currency),
    scope: row.scope_value !== null && row.scope_unit !== null ? { value: row.scope_value, unit: row.scope_unit } : null,
  };
}
function eventContract(row: AcceptanceEventRow) {
  return {
    id: row.id, kind: row.kind, acceptedTermsDigest: digestOf(row.accepted_terms_digest), onBehalfOf: partyOf(row.on_behalf_person_id, row.on_behalf_company_id),
    electronicRecords: row.e_records_disclosure_key ? { disclosureKey: row.e_records_disclosure_key, basis: row.e_records_basis } : null, occurredAt: iso(row.occurred_at),
  };
}
function recordContract(row: TaskExecutionRecordRow) {
  return TaskExecutionRecordSchema.parse({
    id: row.id, assignmentId: row.assignment_id, milestoneKey: row.milestone_key, kind: row.kind, claimId: row.claim_id, evidence: row.evidence, note: row.note,
    by: partyOf(row.by_person_id, row.by_company_id), createdAt: iso(row.created_at),
  });
}
function reviewContract(row: TaskReviewRow) {
  return TaskReviewSchema.parse({
    id: row.id, assignmentId: row.assignment_id, authorSide: row.author_side, author: partyOf(row.author_person_id, row.author_company_id),
    subject: partyOf(row.subject_person_id, row.subject_company_id), rating: row.rating, text: row.text, createdAt: iso(row.created_at),
  });
}
function assignmentContract(row: TaskAssignmentRow) {
  return TaskAssignmentSchema.parse({
    id: row.id, taskRequestId: row.task_request_id, planItem: { projectId: row.project_id, planId: row.plan_id, planVersionId: row.plan_version_id, itemKey: row.plan_item_key },
    agreement: { id: row.agreement_id, acceptedTermsDigest: digestOf(row.agreement_digest) }, offer: { id: row.task_offer_id, version: row.offer_version, digest: digestOf(row.offer_digest) },
    requestVersion: { id: row.request_version_id, version: row.request_version, digest: digestOf(row.request_digest) }, owner: partyOf(row.owner_person_id, null),
    assignee: partyOf(row.assignee_person_id, row.assignee_company_id), milestones: row.milestones, status: row.status, completedAt: row.completed_at ? iso(row.completed_at) : null,
    revision: row.revision, createdAt: iso(row.created_at),
  });
}
const summaryOf = (row: TaskAssignmentRow) => ({ id: row.id, status: row.status, assignee: partyOf(row.assignee_person_id, row.assignee_company_id) });
const privateColumns = (input: TaskRequestPrivateInput) => ({ budget_ceiling_minor: input.budgetCeiling?.minorUnits ?? null, budget_ceiling_currency: input.budgetCeiling?.currency ?? null, owner_notes: input.ownerNotes });
const offerPrivateColumns = (input: TaskOfferPrivateInput) => ({ floor_price_minor: input.floorPrice?.minorUnits ?? null, floor_price_currency: input.floorPrice?.currency ?? null, offeror_notes: input.offerorNotes });

/**
 * Scoped tasks from plan items (TASK-001). The owner (a person owning the project, ADR 012 decision 37) cuts a task
 * request from an approved plan item; the brief offerors receive is built field by field from that item; published
 * versions are immutable and digest-bound, and an amendment flags earlier offers stale in the same transaction.
 * Offerors (invited, or anyone for an open request) draft and send versioned offers pinned to the current version;
 * sent offers never change. The owner accepts one exact offer version (agreement with terms_kind `task`, one live per
 * request); the offeror confirms by stating the digest, which creates the assignment, the obligations and closes the
 * request in one transaction. Execution records and reviews follow. Every route runs in one `withPrincipal`
 * transaction that also completes its idempotency record (BE-005); outbox events carry identifiers only (MAIL-001).
 */
export class TasksService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: TaskMandatePort,
    private readonly records: ElectronicRecordsPolicySource,
  ) {}

  /* ---------- Plumbing ---------- */

  private now(): Date {
    return this.ctx.clock.now();
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapTaskError);
  }
  /** A person acts for themself; a company through members holding company.deals.manage. */
  private actsFor(principal: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes('company.deals.manage');
  }
  private scope(principal: Principal): PartyScope {
    return { personId: principal.personId, companyId: principal.membership?.permissions.includes('company.deals.manage') ? principal.membership.companyId : null };
  }
  private async actor(principal: Principal, input: TaskActorInput, action: TaskMandateCheck['action'], context: TaskMandateCheck['context'], amount: Money | null = null): Promise<ResolvedActor> {
    if (input.via === 'person') return { via: 'person', personId: principal.personId, mandateId: null };
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: input.mandateId, action, context, amount, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this object`);
    return { via: 'agent', personId: principal.personId, mandateId: input.mandateId };
  }
  private async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }
  /** Identifiers only (TASK_EVENT_PAYLOAD_KEYS): notifications read the projection under the recipient's authority. */
  private async event(trx: Transaction, aggregateKind: 'task_request' | 'task_offer' | 'agreement' | 'task_assignment', aggregateId: string, revision: number, type: string, payload: EventPayload): Promise<void> {
    for (const key of Object.keys(payload)) if (!(TASK_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`event payload key ${key} is not an identifier`);
    await outbox.append(trx, { aggregate_kind: aggregateKind, aggregate_id: aggregateId, revision, type, payload });
  }
  private consent(input: ElectronicRecordsConsent | null): { required: boolean; disclosureKey: string | null; basis: string[]; at: Date | null } {
    const policy = this.records.current();
    if (!electronicRecordsSatisfied(policy, input)) {
      throw new ApiError('validation.schema', 'acceptance needs consent to electronic records for the current disclosure', { reason: 'electronic_records_consent_required', disclosureKey: policy.disclosureKey });
    }
    return input ? { required: policy.required, disclosureKey: input.disclosureKey, basis: [...policy.basis], at: this.now() } : { required: false, disclosureKey: null, basis: [], at: null };
  }

  /* ---------- Loading ---------- */

  private async ownRequest(trx: Transaction, p: Principal, id: string, lock = true): Promise<TaskRequestRow> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = lock ? await taskRequests.lock(trx, id) : await taskRequests.get(trx, id);
    if (!row || row.owner_person_id !== p.personId) throw new ApiError('access.not_found');
    return row;
  }
  private async planItems(trx: Transaction, planVersionId: string) {
    return (await planParts.items(trx, planVersionId)).map(rowToItem);
  }
  private async brief(trx: Transaction, request: TaskRequestRow, terms: TaskRequestTerms): Promise<TaskRequestPayload> {
    const items = await this.planItems(trx, request.plan_version_id);
    const item = items.find((i) => i.key === request.plan_item_key);
    if (!item) throw new ApiError('validation.schema', 'the item is not in the approved plan', { reason: 'item_not_in_baseline' });
    const plan = await plans.getByProject(trx, request.project_id);
    const location = await projectLocations.get(trx, request.project_id);
    try {
      return buildTaskRequestPayload({ item, baseline: items, location: location ? toLocation(location) : null, terms, timeZone: plan?.time_zone ?? 'UTC' });
    } catch (error) {
      if (error instanceof TaskBriefError) throw new ApiError('validation.schema', 'the brief does not fit the plan item', { reason: error.reason });
      throw error;
    }
  }
  private async agreementView(trx: Transaction, row: AgreementRow): Promise<TaskAgreement> {
    const [events, obligationRows] = await Promise.all([acceptanceEvents.listFor(trx, row.id), obligations.listFor(trx, row.id)]);
    return TaskAgreementSchema.parse({
      id: row.id, termsKind: 'task', buyer: partyOf(row.buyer_person_id, row.buyer_company_id), seller: partyOf(row.seller_person_id, row.seller_company_id),
      offer: { id: row.offer_ref_id, version: row.offer_version, digest: digestOf(row.offer_digest) },
      requestVersion: { id: row.request_ref_id, version: row.request_version, digest: digestOf(row.request_digest) },
      acceptedTermsDigest: digestOf(row.accepted_terms_digest), status: row.status, closedReason: row.closed_reason, events: events.map(eventContract),
      obligations: obligationRows.map(obligationContract), revision: row.revision, createdAt: iso(row.created_at),
    });
  }

  /* ---------- Views ---------- */

  private async ownerView(trx: Transaction, request: TaskRequestRow): Promise<OwnerTaskRequestView> {
    const [versions, privateRow, invitations, offers, assignment] = await Promise.all([
      taskRequestVersions.listFor(trx, request.id), taskRequestPrivate.get(trx, request.id), taskInvitations.listForRequest(trx, request.id), taskOffers.listForRequest(trx, request.id),
      taskAssignments.liveForRequest(trx, request.id),
    ]);
    if (!privateRow) throw new Error(`task request ${request.id} has no private half`);
    const sent = offers.filter((o) => o.status !== 'draft');
    const ordered = paymentBlindOrder(sent.map((o) => ({ id: o.id, at: iso(o.sent_at as Date), row: o }))).map((x) => x.row);
    const agreementRows = await taskAgreements.listForOffers(trx, sent.map((o) => o.id));
    return OwnerTaskRequestViewSchema.parse({
      projection: 'owner_private', request: requestContract(request), versions: versions.map(versionContract),
      privateConstraint: TaskRequestPrivateSchema.parse({ budgetCeiling: money(privateRow.budget_ceiling_minor, privateRow.budget_ceiling_currency), ownerNotes: privateRow.owner_notes, revision: privateRow.revision }),
      invitations: invitations.map(invitationContract), offers: ordered.map(offerContract), agreements: await Promise.all(agreementRows.map((a) => this.agreementView(trx, a))),
      assignment: assignment ? summaryOf(assignment) : null,
    });
  }

  /** shared_party for an invitee or offeror: published versions and its own invitation; nothing about competitors. */
  private async offerorRequestView(trx: Transaction, p: Principal, request: TaskRequestRow): Promise<OfferorTaskRequestView> {
    const scope = this.scope(p);
    const [versions, invitations] = await Promise.all([taskRequestVersions.listFor(trx, request.id), taskInvitations.listForRequest(trx, request.id)]);
    const own = invitations.filter((i) => i.party_person_id === scope.personId || (scope.companyId !== null && i.party_company_id === scope.companyId));
    return OfferorTaskRequestViewSchema.parse({
      projection: 'shared_party',
      request: { id: request.id, owner: partyOf(request.owner_person_id, null), audience: request.audience, status: request.status, currentVersion: request.current_version, currentVersionId: request.current_version_id },
      versions: versions.filter((v) => v.status !== 'draft').map(versionContract), invitation: own.at(-1) ? invitationContract(own.at(-1) as TaskInvitationRow) : null,
    });
  }

  private async offerorView(trx: Transaction, taskRequestId: string, offeror: Party): Promise<OfferorTaskOfferView> {
    const group = await taskOffers.listGroup(trx, taskRequestId, columnsOf(offeror));
    const latest = group.at(-1);
    const privateRow = latest ? await taskOfferPrivate.get(trx, latest.id) : undefined;
    const agreementRows = await taskAgreements.listForOffers(trx, group.map((o) => o.id));
    const assignment = await taskAssignments.liveForRequest(trx, taskRequestId);
    return OfferorTaskOfferViewSchema.parse({
      projection: 'party_private', side: 'offeror', taskRequestId, offeror, versions: group.map(offerContract),
      privateConstraint: privateRow ? TaskOfferPrivateSchema.parse({ offerId: privateRow.task_offer_id, floorPrice: money(privateRow.floor_price_minor, privateRow.floor_price_currency), offerorNotes: privateRow.offeror_notes, revision: privateRow.revision }) : null,
      agreements: await Promise.all(agreementRows.map((a) => this.agreementView(trx, a))),
      assignment: assignment && group.some((o) => o.id === assignment.task_offer_id) ? summaryOf(assignment) : null,
    });
  }

  private async assignmentView(trx: Transaction, p: Principal, row: TaskAssignmentRow): Promise<TaskAssignmentView> {
    const side = row.owner_person_id === p.personId ? 'owner' : 'assignee';
    const agreement = await taskAgreements.get(trx, row.agreement_id);
    if (!agreement) throw new ApiError('access.not_found');
    const [records, reviews, site] = await Promise.all([taskRecords.listFor(trx, row.id), taskReviews.listFor(trx, row.id), taskAssignments.site(trx, row.id)]);
    const contract = assignmentContract(row);
    return TaskAssignmentViewSchema.parse({
      projection: 'party_private', side, assignment: contract, agreement: await this.agreementView(trx, agreement),
      milestoneStates: milestoneStates(contract.milestones, records.map(recordContract)), records: records.map(recordContract), reviews: reviews.map(reviewContract),
      site: site ? TaskSiteSchema.parse({ regionCode: site.region_code, address: site.address ?? null, siteContact: site.site_contact ?? null, siteAccessNotes: site.site_access_notes }) : null,
    });
  }

  /* ---------- Plan item path ---------- */

  /** The plan item records the path `task` with this request (the plans guard refuses a second path). */
  private async linkPlanItem(trx: Transaction, p: Principal, planId: string, projectId: string, itemKey: string, taskRequestId: string): Promise<void> {
    const current = await planItemStates.get(trx, planId, itemKey);
    if (!current) {
      await planItemStates.insert(trx, { plan_id: planId, project_id: projectId, item_key: itemKey, status: 'accepted', path: 'task', link_kind: 'task_request', link_id: taskRequestId, blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: p.personId });
      return;
    }
    const saved = await planItemStates.update(trx, planId, itemKey, current.revision, {
      status: 'accepted', path: 'task', link_kind: 'task_request', link_id: taskRequestId, blocked_from: null, updated_by_person_id: p.personId,
      actual_start: isoDate(current.actual_start), actual_end: isoDate(current.actual_end),
    });
    if (!saved) throw new ApiError('validation.revision_conflict');
  }
  /** Moves the linked plan item forward (accepted -> requested on first publication; requested -> in_progress -> done on completion). */
  private async advancePlanItem(trx: Transaction, p: Principal, request: TaskRequestRow, to: 'requested' | 'done'): Promise<void> {
    let current = await planItemStates.get(trx, request.plan_id, request.plan_item_key);
    if (!current || current.link_id !== request.id) return;
    const steps: ('requested' | 'in_progress' | 'done')[] = to === 'requested' ? (current.status === 'accepted' ? ['requested'] : []) : current.status === 'requested' ? ['in_progress', 'done'] : current.status === 'in_progress' ? ['done'] : [];
    for (const status of steps) {
      const saved = await planItemStates.update(trx, request.plan_id, request.plan_item_key, current.revision, {
        status, path: 'task', link_kind: 'task_request', link_id: request.id, blocked_from: null, updated_by_person_id: p.personId,
        actual_start: status === 'in_progress' ? isoDate(this.now()) : isoDate(current.actual_start), actual_end: status === 'done' ? isoDate(this.now()) : isoDate(current.actual_end),
      });
      if (!saved) return;
      current = saved;
    }
  }

  /* ---------- Owner: requests ---------- */

  async createRequest(input: In<typeof CreateTaskRequestCommandSchema>, state: RequestState): Promise<OwnerTaskRequestView> {
    return this.run(state, async (trx, p) => {
      const { projectId, itemKey } = input.source;
      if (!UUID.test(projectId)) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'project', id: projectId });
      const project = await taskProjects.owner(trx, projectId);
      if (!project) throw new ApiError('access.not_found');
      // ADR 012 decision 37: a consumer's or small owner's works become tasks; inside a company every purchase starts as a requisition.
      if (project.owner_company_id !== null) throw new ApiError('validation.schema', 'a company buys plan items through requisitions', { reason: 'requisition_required' });
      if (project.owner_person_id !== p.personId) throw new ApiError('access.not_found');
      const plan = await plans.getByProject(trx, projectId);
      if (!plan || !plan.current_version_id) throw new ApiError('validation.schema', 'the project has no approved plan', { reason: 'item_not_in_baseline' });
      const items = await this.planItems(trx, plan.current_version_id);
      const item = items.find((i) => i.key === itemKey);
      if (!item) throw new ApiError('validation.schema', 'the item is not in the approved plan', { reason: 'item_not_in_baseline' });
      if (!(TASK_PLAN_ITEM_KINDS as readonly string[]).includes(item.kind)) throw new ApiError('validation.schema', 'works become tasks, goods become RFQs', { reason: 'plan_item_kind' });
      const itemState = await planItemStates.get(trx, plan.id, itemKey);
      if (itemState?.path) throw new ApiError('validation.revision_conflict', 'the item already took a path', { reason: 'item_path_taken' });
      if (itemState && itemState.status !== 'proposed' && itemState.status !== 'accepted') throw new ApiError('validation.schema', 'the item is no longer open', { reason: 'invalid_item_transition' });
      const request = await taskRequests.insert(trx, {
        owner_person_id: p.personId, project_id: projectId, plan_id: plan.id, plan_version_id: plan.current_version_id, plan_item_key: itemKey, audience: input.audience, creator_person_id: p.personId,
      });
      const payload = await this.brief(trx, request, input.terms);
      const draft = await taskRequestVersions.insertDraft(trx, { task_request_id: request.id, version: 1, terms: input.terms, payload, drafted_by_person_id: p.personId });
      await taskRequestPrivate.insert(trx, { task_request_id: request.id, owner_person_id: p.personId, ...privateColumns(input.privateConstraint ?? EMPTY_TASK_REQUEST_PRIVATE), updated_by_person_id: p.personId });
      await this.linkPlanItem(trx, p, plan.id, projectId, itemKey, request.id);
      await this.audit(trx, p, state, 'task.request_created', 'task_request', request.id, { versionId: draft.id, planItem: { projectId, itemKey }, fields: payload.fields, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'task_request', request.id, request.revision, 'task.request_created', { taskRequestId: request.id, versionId: draft.id, version: 1, via: actor.via });
      return this.ownerView(trx, request);
    });
  }

  async saveDraft(id: string, input: In<typeof SaveTaskRequestDraftCommandSchema>, state: RequestState): Promise<OwnerTaskRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id);
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'task_request', id });
      if (request.status !== 'draft' && request.status !== 'published') throw new ApiError('commercial.version_immutable', `a ${request.status} task request is kept as it was`, { reason: 'closed' });
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const bumped = await taskRequests.bump(trx, id, input.expectedRevision);
      if (!bumped) throw new ApiError('validation.revision_conflict');
      const payload = await this.brief(trx, request, input.terms);
      const draft = await taskRequestVersions.draftOf(trx, id);
      let versionId: string;
      if (draft) {
        if (!(await taskRequestVersions.saveDraft(trx, draft.id, { terms: input.terms, payload }))) throw new ApiError('commercial.version_immutable', 'a published version never changes', { reason: 'version_frozen' });
        versionId = draft.id;
      } else {
        const versions = await taskRequestVersions.listFor(trx, id);
        versionId = (await taskRequestVersions.insertDraft(trx, { task_request_id: id, version: Math.max(0, ...versions.map((v) => v.version)) + 1, terms: input.terms, payload, drafted_by_person_id: p.personId })).id;
      }
      await this.audit(trx, p, state, draft ? 'task.draft_saved' : 'task.amendment_opened', 'task_request', id, { versionId, fields: payload.fields, via: actor.via, mandateId: actor.mandateId });
      return this.ownerView(trx, bumped);
    });
  }

  /**
   * Publishes the open draft as the current version: the previous version is superseded, the digest is computed from
   * the stored brief, the pointer moves forward and the database flags offers pinned to earlier versions stale, all in
   * one transaction under the request lock. Refused while an acceptance is pending or agreed.
   */
  async publish(id: string, input: In<typeof PublishTaskRequestCommandSchema>, state: RequestState): Promise<OwnerTaskRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id);
      const actor = await this.actor(p, input.actor, 'publish', { kind: 'task_request', id });
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (request.status !== 'draft' && request.status !== 'published') throw new ApiError('commercial.version_immutable', `a ${request.status} task request is not published again`, { reason: 'closed' });
      const draft = await taskRequestVersions.draftOf(trx, id);
      if (!draft || draft.version !== input.version) throw new ApiError('commercial.version_immutable', 'only the open draft is published', { reason: 'version_frozen' });
      if (draft.version > 1 && input.amendmentReason === null) throw new ApiError('validation.schema', 'an amendment states its reason', { reason: 'amendment_reason_required' });
      if (draft.version === 1 && input.amendmentReason !== null) throw new ApiError('validation.schema', 'the first version is not an amendment', { reason: 'amendment_reason_not_allowed' });
      const payload = TaskRequestPayloadSchema.parse(draft.payload);
      const at = this.now();
      if (Date.parse(payload.responseDeadline) <= at.getTime()) throw new ApiError('validation.schema', 'the response deadline has passed', { reason: 'response_deadline_passed' });
      const previous = request.current_version_id ? await taskRequestVersions.get(trx, request.current_version_id) : undefined;
      if (previous) await taskRequestVersions.supersede(trx, previous.id, at);
      const digest = computeDigest(taskRequestVersionDigestInput({ taskRequestId: id, version: draft.version, payload }));
      const published = await taskRequestVersions.publish(trx, draft.id, { digest: digest.value, personId: p.personId, via: actor.via, mandateId: actor.mandateId, amendmentReason: input.amendmentReason, at });
      if (!published) throw new ApiError('validation.revision_conflict');
      const current = await taskRequests.setCurrent(trx, id, { current_version: published.version, current_version_id: published.id });
      if (!previous) await this.advancePlanItem(trx, p, current, 'requested');
      const stale = previous ? (await taskOffers.listForRequest(trx, id)).filter((o) => o.stale_reason === 'request_amended').length : 0;
      await this.audit(trx, p, state, 'task.version_published', 'task_request', id, { versionId: published.id, version: published.version, digest: digest.value, superseded: previous?.id ?? null, staleCount: stale, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'task_request', id, current.revision, 'task.version_published', { taskRequestId: id, versionId: published.id, version: published.version, via: actor.via });
      return this.ownerView(trx, current);
    });
  }

  async setPrivate(id: string, input: In<typeof SaveTaskRequestPrivateCommandSchema>, state: RequestState): Promise<OwnerTaskRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id, false);
      const { expectedRevision, ...fields } = input;
      const saved = await taskRequestPrivate.update(trx, id, expectedRevision, { ...privateColumns(fields), updated_by_person_id: p.personId });
      if (!saved) throw new ApiError('validation.revision_conflict');
      // Audit names the change only; private values never enter audit, outbox or logs.
      await this.audit(trx, p, state, 'task.private_saved', 'task_request', id, { revision: saved.revision });
      return this.ownerView(trx, request);
    });
  }

  async invite(id: string, input: In<typeof InviteTaskOfferorCommandSchema>, state: RequestState): Promise<z.infer<typeof TaskInvitationSchema>> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id);
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'task_request', id });
      if (request.status !== 'published') throw new ApiError('validation.schema', 'invitations go out for a published request', { reason: 'not_published' });
      if (!UUID.test(input.party.id)) throw new ApiError('validation.schema', 'unknown party', { reason: 'unknown_reference' });
      if (input.party.kind === 'person' && input.party.id === p.personId) throw new ApiError('validation.schema', 'the owner does not invite itself', { reason: 'self_invitation' });
      const row = await taskInvitations.insert(trx, { task_request_id: id, party_person_id: columnsOf(input.party).person, party_company_id: columnsOf(input.party).company, sent_by_person_id: p.personId, sent_via: actor.via, sent_mandate_id: actor.mandateId });
      await this.audit(trx, p, state, 'task.invitation_sent', 'task_request', id, { invitationId: row.id, party: input.party, via: actor.via, mandateId: actor.mandateId });
      // Identifiers only: the notification consumer reads the brief under the invitee's own authority.
      await this.event(trx, 'task_request', id, request.revision, 'task.invitation_sent', { taskRequestId: id, invitationId: row.id, inviteeKind: input.party.kind, inviteeId: input.party.id, via: actor.via });
      return invitationContract(row);
    });
  }

  async cancel(id: string, input: In<typeof CancelTaskRequestCommandSchema>, state: RequestState): Promise<OwnerTaskRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id);
      const actor = await this.actor(p, input.actor, 'publish', { kind: 'task_request', id });
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (request.status !== 'draft' && request.status !== 'published') throw new ApiError('validation.schema', `a ${request.status} task request is not cancelled`, { reason: 'invalid_transition' });
      const saved = await taskRequests.setStatus(trx, id, input.expectedRevision, { status: 'cancelled', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'task.request_cancelled', 'task_request', id, { reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'task_request', id, saved.revision, 'task.request_cancelled', { taskRequestId: id, status: 'cancelled', via: actor.via });
      return this.ownerView(trx, saved);
    });
  }

  /* ---------- Reads ---------- */

  /** The owner: the owner view; an invitee or offeror: the published brief; everyone else: not found. */
  async getRequest(id: string, state: RequestState): Promise<OwnerTaskRequestView | OfferorTaskRequestView> {
    if (!state.principal || !UUID.test(id)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const request = await taskRequests.get(trx, id);
      if (!request) throw new ApiError('access.not_found');
      if (request.owner_person_id === p.personId) return this.ownerView(trx, request);
      return this.offerorRequestView(trx, p, request);
    });
  }

  async listRequests(state: RequestState): Promise<z.infer<typeof TaskRequestListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await taskRequests.listOwned(trx, p.personId);
      const items = [];
      for (const row of rows) {
        const [versions, offers] = await Promise.all([taskRequestVersions.listFor(trx, row.id), taskOffers.listForRequest(trx, row.id)]);
        const shown = versions.find((v) => v.id === row.current_version_id) ?? versions.at(-1);
        items.push({
          id: row.id, title: (shown?.payload as { title: string }).title, status: row.status, audience: row.audience, planItemKey: row.plan_item_key, currentVersion: row.current_version,
          sentOffers: offers.filter((o) => o.status === 'sent').length, revision: row.revision, updatedAt: iso(row.updated_at),
        });
      }
      return TaskRequestListSchema.parse({ requests: items });
    });
  }

  /** The open board: published open requests of others, payment-blind newest first, with only their public picks. */
  async listOpen(state: RequestState): Promise<z.infer<typeof OpenTaskRequestListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await taskRequests.listOpen(trx, p.personId);
      const items = [];
      for (const row of rows) {
        const current = row.current_version_id ? await taskRequestVersions.get(trx, row.current_version_id) : undefined;
        if (!current || !current.published_at) continue;
        const brief = TaskRequestPayloadSchema.parse(current.payload);
        items.push({
          id: row.id, at: iso(current.published_at),
          value: {
            id: row.id, title: brief.title, currentVersionId: current.id, publishedAt: iso(current.published_at), responseDeadline: brief.responseDeadline,
            ...(brief.regionCode !== undefined ? { regionCode: brief.regionCode } : {}), ...(brief.stepTerms ? { stepTerms: brief.stepTerms } : {}), ...(brief.requiredSkills ? { requiredSkills: brief.requiredSkills } : {}),
          },
        });
      }
      return OpenTaskRequestListSchema.parse({ requests: paymentBlindOrder(items).map((x) => x.value) });
    });
  }

  /** Invitations addressed to the principal or to the employer it acts for, payment-blind newest first. */
  async listInvitations(state: RequestState): Promise<z.infer<typeof TaskInvitationListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await taskInvitations.listForParty(trx, this.scope(p));
      const items = [];
      for (const row of rows) {
        const request = await taskRequests.get(trx, row.task_request_id);
        const current = request?.current_version_id ? await taskRequestVersions.get(trx, request.current_version_id) : undefined;
        if (!request || !current) continue;
        const brief = TaskRequestPayloadSchema.parse(current.payload);
        items.push({ id: row.id, at: iso(row.created_at), value: { invitation: invitationContract(row), title: brief.title, requestStatus: request.status, responseDeadline: brief.responseDeadline } });
      }
      return TaskInvitationListSchema.parse({ invitations: paymentBlindOrder(items).map((x) => x.value) });
    });
  }

  /* ---------- Offeror: offers ---------- */

  async createOffer(input: In<typeof CreateTaskOfferCommandSchema>, state: RequestState): Promise<OfferorTaskOfferView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(input.taskRequestId) || !UUID.test(input.requestVersionId)) throw new ApiError('access.not_found');
      const request = await taskRequests.get(trx, input.taskRequestId);
      if (!request) throw new ApiError('access.not_found');
      if (!this.actsFor(p, input.offeror)) throw new ApiError('access.forbidden', 'offers are made for a party you act for', { reason: 'not_authorised' });
      if (request.owner_person_id === p.personId || (input.offeror.kind === 'person' && input.offeror.id === request.owner_person_id)) throw new ApiError('validation.schema', 'the owner does not offer on its own request', { reason: 'self_invitation' });
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'task_request', id: request.id });
      if (request.status !== 'published' || request.current_version_id === null) throw new ApiError('commercial.rfq_version_not_current', 'offers answer a published request', { reason: 'not_published' });
      if (input.requestVersionId !== request.current_version_id) throw new ApiError('commercial.rfq_version_not_current', 'offers pin the current published version', { reason: 'rfq_version_not_current', currentRequestVersionId: request.current_version_id });
      const pinned = await taskRequestVersions.get(trx, request.current_version_id);
      if (!pinned || pinned.digest === null) throw new ApiError('access.not_found');
      const misfits = offerMisfits(input.payload, TaskRequestPayloadSchema.parse(pinned.payload));
      if (misfits.length > 0) throw new ApiError('validation.schema', 'the offer does not answer the brief', { reason: misfits[0], reasons: misfits });
      const offeror = columnsOf(input.offeror);
      const group = await taskOffers.lockGroup(trx, request.id, offeror);
      if (group.some((o) => o.status === 'draft')) throw new ApiError('validation.revision_conflict', 'a draft is already open', { reason: 'draft_exists' });
      const row = await taskOffers.insertDraft(trx, {
        task_request_id: request.id, offeror_person_id: offeror.person, offeror_company_id: offeror.company, version: Math.max(0, ...group.map((o) => o.version)) + 1, request_version_id: pinned.id,
        request_version: pinned.version, request_version_digest: pinned.digest, payload: input.payload, valid_until: input.payload.validUntil, drafted_by_person_id: p.personId,
      });
      await taskOfferPrivate.insert(trx, { task_offer_id: row.id, offeror_person_id: offeror.person, offeror_company_id: offeror.company, ...offerPrivateColumns(input.privateConstraint ?? EMPTY_TASK_OFFER_PRIVATE), updated_by_person_id: p.personId });
      await this.audit(trx, p, state, 'task.offer_drafted', 'task_offer', row.id, { taskRequestId: request.id, version: row.version, requestVersionId: pinned.id, via: actor.via, mandateId: actor.mandateId });
      return this.offerorView(trx, request.id, input.offeror);
    });
  }

  private async ownOffer(trx: Transaction, p: Principal, offerId: string): Promise<TaskOfferRow> {
    if (!UUID.test(offerId)) throw new ApiError('access.not_found');
    const row = await taskOffers.get(trx, offerId);
    if (!row || !this.actsFor(p, partyOf(row.offeror_person_id, row.offeror_company_id))) throw new ApiError('access.not_found');
    const locked = await taskOffers.lock(trx, offerId);
    if (!locked) throw new ApiError('access.not_found');
    return locked;
  }

  async saveOffer(offerId: string, input: In<typeof SaveTaskOfferDraftCommandSchema>, state: RequestState): Promise<OfferorTaskOfferView> {
    return this.run(state, async (trx, p) => {
      const row = await this.ownOffer(trx, p, offerId);
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'task_request', id: row.task_request_id });
      if (row.status !== 'draft') throw new ApiError('commercial.version_immutable', 'a sent offer never changes; open a new version', { reason: 'version_frozen' });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const pinned = await taskRequestVersions.get(trx, row.request_version_id);
      if (!pinned) throw new ApiError('access.not_found');
      const misfits = offerMisfits(input.payload, TaskRequestPayloadSchema.parse(pinned.payload));
      if (misfits.length > 0) throw new ApiError('validation.schema', 'the offer does not answer the brief', { reason: misfits[0], reasons: misfits });
      if (!(await taskOffers.saveDraft(trx, row.id, input.expectedRevision, { payload: input.payload, valid_until: input.payload.validUntil }))) throw new ApiError('validation.revision_conflict');
      if (input.privateConstraint) {
        const columns = { ...offerPrivateColumns(input.privateConstraint), updated_by_person_id: p.personId };
        if (!(await taskOfferPrivate.update(trx, row.id, columns))) await taskOfferPrivate.insert(trx, { task_offer_id: row.id, offeror_person_id: row.offeror_person_id, offeror_company_id: row.offeror_company_id, ...columns });
      }
      await this.audit(trx, p, state, 'task.offer_draft_saved', 'task_offer', row.id, { taskRequestId: row.task_request_id, version: row.version, privateChanged: input.privateConstraint !== null, via: actor.via, mandateId: actor.mandateId });
      return this.offerorView(trx, row.task_request_id, partyOf(row.offeror_person_id, row.offeror_company_id));
    });
  }

  /**
   * Sends the draft: the request must still be published with this version current, the deadline and validity open;
   * the previous sent version is superseded and the digest covers the pinned request version, the offeror, the version
   * number and the payload. An agent never sends a price below the offeror's own floor.
   */
  async sendOffer(offerId: string, input: In<typeof SendTaskOfferCommandSchema>, state: RequestState): Promise<OfferorTaskOfferView> {
    return this.run(state, async (trx, p) => {
      const row = await this.ownOffer(trx, p, offerId);
      const payload = TaskOfferPayloadSchema.parse(row.payload);
      const actor = await this.actor(p, input.actor, 'send_quote', { kind: 'task_request', id: row.task_request_id }, payload.price);
      if (row.status !== 'draft') throw new ApiError('commercial.version_immutable', 'only a draft is sent', { reason: 'version_frozen' });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const request = await taskRequests.get(trx, row.task_request_id);
      if (!request || request.status !== 'published' || request.current_version_id !== row.request_version_id || row.stale_reason !== null) {
        throw new ApiError('commercial.rfq_version_not_current', 'the request changed; draft a new version against the current one', { reason: row.stale_reason ?? 'rfq_version_not_current', currentRequestVersionId: request?.current_version_id ?? null });
      }
      const pinned = await taskRequestVersions.get(trx, row.request_version_id);
      if (!pinned || pinned.digest === null) throw new ApiError('access.not_found');
      const brief = TaskRequestPayloadSchema.parse(pinned.payload);
      const at = this.now();
      if (Date.parse(brief.responseDeadline) <= at.getTime()) throw new ApiError('validation.schema', 'the response deadline has passed', { reason: 'response_deadline_passed' });
      if (Date.parse(payload.validUntil) <= at.getTime()) throw new ApiError('commercial.quote_expired', 'the offer validity has passed', { reason: 'quote_expired' });
      if (actor.via === 'agent') {
        const own = await taskOfferPrivate.get(trx, row.id);
        if (outsideBound(payload.price, money(own?.floor_price_minor ?? null, own?.floor_price_currency ?? null), 'floor')) {
          throw new ApiError('access.mandate_scope', 'the agent acts only within the offeror\'s private limits', { reason: 'outside_private_constraints' });
        }
      }
      const offeror = partyOf(row.offeror_person_id, row.offeror_company_id);
      const previous = (await taskOffers.listGroup(trx, row.task_request_id, columnsOf(offeror))).find((o) => o.status === 'sent');
      if (previous) await taskOffers.supersede(trx, previous.id, at);
      const digest = computeDigest(taskOfferDigestInput({ taskRequestId: row.task_request_id, requestVersion: { id: pinned.id, version: pinned.version, digest: digestOf(pinned.digest) }, offeror, version: row.version, payload }));
      const sent = await taskOffers.send(trx, row.id, input.expectedRevision, { digest: digest.value, personId: p.personId, via: actor.via, mandateId: actor.mandateId, at });
      if (!sent) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'task.offer_sent', 'task_offer', row.id, { taskRequestId: row.task_request_id, version: row.version, digest: digest.value, superseded: previous?.id ?? null, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'task_offer', row.id, sent.revision, 'task.offer_sent', { taskRequestId: row.task_request_id, offerId: row.id, version: row.version, via: actor.via });
      return this.offerorView(trx, row.task_request_id, offeror);
    });
  }

  async withdrawOffer(offerId: string, input: In<typeof WithdrawTaskOfferCommandSchema>, state: RequestState): Promise<OfferorTaskOfferView> {
    return this.run(state, async (trx, p) => {
      const row = await this.ownOffer(trx, p, offerId);
      const actor = await this.actor(p, input.actor, 'send_quote', { kind: 'task_request', id: row.task_request_id });
      if (row.status !== 'sent' && row.status !== 'draft') throw new ApiError('validation.schema', `a ${row.status} offer is not withdrawn`, { reason: 'invalid_transition' });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const saved = await taskOffers.setStatus(trx, row.id, { revision: input.expectedRevision, status: row.status }, { status: 'withdrawn', withdrawn_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'task.offer_withdrawn', 'task_offer', row.id, { taskRequestId: row.task_request_id, version: row.version, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'task_offer', row.id, saved.revision, 'task.offer_withdrawn', { taskRequestId: row.task_request_id, offerId: row.id, status: 'withdrawn', via: actor.via });
      return this.offerorView(trx, row.task_request_id, partyOf(row.offeror_person_id, row.offeror_company_id));
    });
  }

  async getOffer(offerId: string, state: RequestState): Promise<OfferorTaskOfferView> {
    if (!state.principal || !UUID.test(offerId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const row = await taskOffers.get(trx, offerId);
      if (!row) throw new ApiError('access.not_found');
      const offeror = partyOf(row.offeror_person_id, row.offeror_company_id);
      // The owner reads sent offers inside its request view; this desk is the offeror's only.
      if (!this.actsFor(p, offeror)) throw new ApiError('access.not_found');
      return this.offerorView(trx, row.task_request_id, offeror);
    });
  }

  async listOffers(state: RequestState): Promise<z.infer<typeof TaskOfferListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await taskOffers.listForOfferor(trx, this.scope(p));
      const latest = new Map<string, TaskOfferRow>();
      for (const row of rows) latest.set(`${row.task_request_id}:${row.offeror_person_id ?? row.offeror_company_id}`, row);
      const items = [];
      for (const row of latest.values()) {
        const version = await taskRequestVersions.get(trx, row.request_version_id);
        items.push({
          id: row.id, at: iso(row.updated_at),
          value: { offerId: row.id, taskRequestId: row.task_request_id, offeror: partyOf(row.offeror_person_id, row.offeror_company_id), version: row.version, status: row.status, staleReason: row.stale_reason, title: (version?.payload as { title: string } | undefined)?.title ?? '' },
        });
      }
      return TaskOfferListSchema.parse({ offers: paymentBlindOrder(items).map((x) => x.value) });
    });
  }

  /* ---------- Agreements ---------- */

  private async recordEvent(trx: Transaction, p: Principal, row: AgreementRow, kind: AcceptanceEventRow['kind'], party: Party, actor: ResolvedActor, key: string, extra: { consent?: ReturnType<TasksService['consent']>; reason?: string | null } = {}): Promise<AcceptanceEventRow> {
    const cols = columnsOf(party);
    return acceptanceEvents.insert(trx, {
      agreement_id: row.id, kind, terms_kind: 'task', quote_version_id: null, rfq_version_id: null, offer_version: row.offer_version, offer_digest: row.offer_digest, request_version: row.request_version,
      request_digest: row.request_digest, accepted_terms_digest: row.accepted_terms_digest, actor_person_id: p.personId, on_behalf_person_id: cols.person, on_behalf_company_id: cols.company,
      via: actor.via, mandate_id: actor.mandateId, transaction_budget_id: null, reservation_id: null, platform_budget_id: null, e_records_required: extra.consent?.required ?? false,
      e_records_disclosure_key: extra.consent?.disclosureKey ?? null, e_records_basis: extra.consent?.basis ?? [], e_records_consented_at: extra.consent?.at ?? null, reason: extra.reason ?? null, idempotency_key: key,
    });
  }

  /** Both stored digests recomputed from their payloads (tamper check), then the agreement digest from the two refs. */
  private verified(request: TaskRequestRow, version: TaskRequestVersionRow, offer: TaskOfferRow): { offerRef: VersionRef; requestRef: VersionRef; digest: Digest } {
    if (version.digest === null || offer.digest === null) throw new ApiError('commercial.quote_not_acceptable', CHECK_MESSAGES['commercial.quote_not_acceptable'], { reason: 'quote_not_acceptable' });
    const requestRef = { id: version.id, version: version.version, digest: digestOf(version.digest) };
    const offerRef = { id: offer.id, version: offer.version, digest: digestOf(offer.digest) };
    const requestOk = verifyDigest(taskRequestVersionDigestInput({ taskRequestId: request.id, version: version.version, payload: TaskRequestPayloadSchema.parse(version.payload) }), requestRef.digest);
    const offerOk = verifyDigest(taskOfferDigestInput({ taskRequestId: request.id, requestVersion: { id: offer.request_version_id, version: offer.request_version, digest: digestOf(offer.request_version_digest) }, offeror: partyOf(offer.offeror_person_id, offer.offeror_company_id), version: offer.version, payload: TaskOfferPayloadSchema.parse(offer.payload) }), offerRef.digest);
    if (!requestOk || !offerOk) throw new ApiError('commercial.digest_mismatch', 'a stored version no longer reproduces its digest', { reason: 'digest_mismatch' });
    return { offerRef, requestRef, digest: computeAgreementDigest(offerRef, requestRef, 'task') };
  }

  /**
   * The owner accepts the exact offer version against the current request version, by id and digest (a consumer's
   * commitment is the person's own decision; an agent needs a place_order mandate and never goes above the private
   * ceiling). The request row is locked and the database allows one live agreement per request, so two concurrent
   * acceptances cannot both commit; an offer that answers an earlier version is refused as stale.
   */
  async acceptOffer(id: string, input: In<typeof AcceptTaskOfferCommandSchema>, key: string, state: RequestState): Promise<OwnerTaskRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id);
      if (!UUID.test(input.offer.id)) throw new ApiError('access.not_found');
      const offer = await taskOffers.get(trx, input.offer.id);
      if (!offer || offer.task_request_id !== id) throw new ApiError('access.not_found');
      const payload = TaskOfferPayloadSchema.parse(offer.payload);
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'task_request', id }, payload.price);
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (actor.via === 'agent') {
        const own = await taskRequestPrivate.get(trx, id);
        if (outsideBound(payload.price, money(own?.budget_ceiling_minor ?? null, own?.budget_ceiling_currency ?? null), 'ceiling')) {
          throw new ApiError('access.mandate_scope', 'the agent acts only within the owner\'s private limits', { reason: 'outside_private_constraints' });
        }
      }
      const consent = this.consent(input.electronicRecords);
      const currentRow = request.current_version_id ? await taskRequestVersions.get(trx, request.current_version_id) : undefined;
      const current = currentRow && currentRow.digest ? { id: currentRow.id, version: currentRow.version, digest: currentRow.digest } : null;
      const check = checkTaskAcceptance({
        offer: { id: offer.id, version: offer.version, status: offer.status, digest: offer.digest, staleReason: offer.stale_reason, requestVersionId: offer.request_version_id, requestVersionDigest: offer.request_version_digest, payload },
        offerRef: input.offer, requestRef: input.requestVersion, current, now: this.now(),
      });
      if (check !== 'ok') throw new ApiError(check, CHECK_MESSAGES[check], { reason: check.slice('commercial.'.length) });
      if (request.status !== 'published') throw new ApiError('commercial.quote_not_acceptable', 'the request is not open', { reason: 'not_published' });
      if (await taskAssignments.liveForRequest(trx, id)) throw new ApiError('validation.revision_conflict', 'the task is already assigned', { reason: 'agreement_live' });
      const terms = this.verified(request, currentRow as TaskRequestVersionRow, offer);
      const seller = columnsOf(partyOf(offer.offeror_person_id, offer.offeror_company_id));
      const row = await taskAgreements.insert(trx, {
        buyer_person_id: p.personId, seller_person_id: seller.person, seller_company_id: seller.company, offer_ref_id: offer.id, request_ref_id: terms.requestRef.id, offer_version: offer.version,
        offer_digest: terms.offerRef.digest.value, request_version: terms.requestRef.version, request_digest: terms.requestRef.digest.value, accepted_terms_digest: terms.digest.value, created_by_person_id: p.personId,
      });
      const event = await this.recordEvent(trx, p, row, 'buyer_accepts_terms', { kind: 'person', id: p.personId }, actor, key, { consent });
      const bumped = await taskRequests.bump(trx, id, request.revision);
      if (!bumped) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'task.offer_accepted', 'agreement', row.id, { taskRequestId: id, offerId: offer.id, digest: terms.digest.value, eventId: event.id, via: actor.via, mandateId: actor.mandateId, electronicRecords: consent.disclosureKey });
      await this.event(trx, 'agreement', row.id, row.revision, 'task.offer_accepted', { agreementId: row.id, taskRequestId: id, offerId: offer.id, eventKind: 'buyer_accepts_terms', termsKind: 'task', via: actor.via });
      return this.ownerView(trx, bumped);
    });
  }

  private async lockAgreement(trx: Transaction, agreementId: string): Promise<{ agreement: AgreementRow; version: TaskRequestVersionRow; request: TaskRequestRow; offer: TaskOfferRow }> {
    if (!UUID.test(agreementId)) throw new ApiError('access.not_found');
    const agreement = await taskAgreements.lock(trx, agreementId);
    if (!agreement || !agreement.request_ref_id || !agreement.offer_ref_id) throw new ApiError('access.not_found');
    const version = await taskRequestVersions.get(trx, agreement.request_ref_id);
    const request = version ? await taskRequests.get(trx, version.task_request_id) : undefined;
    const offer = await taskOffers.get(trx, agreement.offer_ref_id);
    if (!version || !request || !offer) throw new ApiError('access.not_found');
    return { agreement, version, request, offer };
  }

  async withdrawAcceptance(agreementId: string, input: In<typeof WithdrawTaskAgreementCommandSchema>, key: string, state: RequestState): Promise<OwnerTaskRequestView> {
    return this.run(state, async (trx, p) => {
      const { agreement, request } = await this.lockAgreement(trx, agreementId);
      if (agreement.buyer_person_id !== p.personId) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'agreement', id: agreementId });
      if (agreement.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (agreement.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${agreement.status} agreement is not withdrawn`, { reason: 'invalid_transition' });
      // The event is recorded while the agreement is still open (its guard checks the status), then the status moves.
      await this.recordEvent(trx, p, agreement, 'withdrawn', { kind: 'person', id: p.personId }, actor, key, { reason: input.reason });
      const saved = await agreements.setStatus(trx, agreementId, input.expectedRevision, { status: 'withdrawn', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'task.acceptance_withdrawn', 'agreement', agreementId, { taskRequestId: request.id, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'agreement', agreementId, saved.revision, 'task.acceptance_withdrawn', { agreementId, taskRequestId: request.id, eventKind: 'withdrawn', termsKind: 'task', via: actor.via });
      return this.ownerView(trx, (await taskRequests.get(trx, request.id)) as TaskRequestRow);
    });
  }

  /**
   * The offeror confirms the agreement, stating the digest it accepts (it must equal the digest recomputed from the
   * stored versions). In the same transaction: the agreement is accepted by both, the offer accepted, the obligations
   * derived per milestone, the assignment created with the plan item and the agreement version, and the request
   * closed (database trigger); the site becomes readable to the assignee.
   */
  async confirmAgreement(agreementId: string, input: In<typeof ConfirmTaskAgreementCommandSchema>, key: string, state: RequestState): Promise<TaskAssignmentView> {
    return this.run(state, async (trx, p) => {
      const { agreement, version, request, offer } = await this.lockAgreement(trx, agreementId);
      const seller = partyOf(agreement.seller_person_id, agreement.seller_company_id);
      if (!this.actsFor(p, seller)) throw new ApiError('access.not_found');
      const payload = TaskOfferPayloadSchema.parse(offer.payload);
      const actor = await this.actor(p, input.actor, 'accept_order', { kind: 'agreement', id: agreementId }, payload.price);
      if (agreement.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (agreement.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${agreement.status} agreement is not confirmed`, { reason: 'invalid_transition' });
      const terms = this.verified(request, version, offer);
      if (terms.digest.value !== agreement.accepted_terms_digest || input.acceptedTermsDigest.value !== agreement.accepted_terms_digest) {
        throw new ApiError('commercial.digest_mismatch', CHECK_MESSAGES['commercial.digest_mismatch'], { reason: 'digest_mismatch' });
      }
      if (actor.via === 'agent') {
        const own = await taskOfferPrivate.get(trx, offer.id);
        if (outsideBound(payload.price, money(own?.floor_price_minor ?? null, own?.floor_price_currency ?? null), 'floor')) {
          throw new ApiError('access.mandate_scope', 'the agent acts only within the offeror\'s private limits', { reason: 'outside_private_constraints' });
        }
      }
      const consent = this.consent(input.electronicRecords);
      const event = await this.recordEvent(trx, p, agreement, 'seller_accepts_order', seller, actor, key, { consent });
      const saved = await agreements.setStatus(trx, agreementId, input.expectedRevision, { status: 'accepted_by_both' });
      if (!saved) throw new ApiError('validation.revision_conflict');
      if (!(await taskOffers.setStatus(trx, offer.id, { revision: offer.revision, status: 'sent' }, { status: 'accepted', withdrawn_reason: null }))) throw new ApiError('validation.revision_conflict');
      const owner: Party = { kind: 'person', id: request.owner_person_id };
      const brief = TaskRequestPayloadSchema.parse(version.payload);
      await obligations.insertMany(trx, agreementId, deriveTaskObligations({ owner, assignee: seller }, payload, brief.timeZone).map((o, position) => ({
        position, obligor_person_id: columnsOf(o.party).person, obligor_company_id: columnsOf(o.party).company, kind: o.kind, due: o.due, amount_minor: o.amount?.minorUnits ?? null,
        currency: o.amount?.currency ?? null, scope_value: null, scope_unit: null,
      })));
      const assignment = await taskAssignments.insert(trx, {
        task_request_id: request.id, task_offer_id: offer.id, agreement_id: agreementId, agreement_digest: saved.accepted_terms_digest, offer_version: offer.version, offer_digest: saved.offer_digest,
        request_version_id: version.id, request_version: version.version, request_digest: saved.request_digest, project_id: request.project_id, plan_id: request.plan_id,
        plan_version_id: request.plan_version_id, plan_item_key: request.plan_item_key, owner_person_id: request.owner_person_id, assignee_person_id: columnsOf(seller).person,
        assignee_company_id: columnsOf(seller).company, milestones: payload.milestones, created_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'task.assigned', 'task_assignment', assignment.id, { agreementId, taskRequestId: request.id, offerId: offer.id, digest: saved.accepted_terms_digest, eventId: event.id, planItemKey: request.plan_item_key, via: actor.via, mandateId: actor.mandateId, electronicRecords: consent.disclosureKey });
      await this.event(trx, 'agreement', agreementId, saved.revision, 'task.agreement_confirmed', { agreementId, taskRequestId: request.id, assignmentId: assignment.id, eventKind: 'seller_accepts_order', termsKind: 'task', via: actor.via });
      return this.assignmentView(trx, p, assignment);
    });
  }

  async declineAgreement(agreementId: string, input: In<typeof DeclineTaskAgreementCommandSchema>, key: string, state: RequestState): Promise<OfferorTaskOfferView> {
    return this.run(state, async (trx, p) => {
      const { agreement, request, offer } = await this.lockAgreement(trx, agreementId);
      const seller = partyOf(agreement.seller_person_id, agreement.seller_company_id);
      if (!this.actsFor(p, seller)) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'accept_order', { kind: 'agreement', id: agreementId });
      if (agreement.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (agreement.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${agreement.status} agreement is not declined`, { reason: 'invalid_transition' });
      await this.recordEvent(trx, p, agreement, 'seller_declines', seller, actor, key, { reason: input.reason });
      const saved = await agreements.setStatus(trx, agreementId, input.expectedRevision, { status: 'declined', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      // Declining the acceptance withdraws the offer: it is no longer open for acceptance.
      if (offer.status === 'sent') await taskOffers.setStatus(trx, offer.id, { revision: offer.revision, status: 'sent' }, { status: 'withdrawn', withdrawn_reason: input.reason });
      await this.audit(trx, p, state, 'task.agreement_declined', 'agreement', agreementId, { taskRequestId: request.id, offerId: offer.id, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'agreement', agreementId, saved.revision, 'task.agreement_declined', { agreementId, taskRequestId: request.id, offerId: offer.id, eventKind: 'seller_declines', termsKind: 'task', via: actor.via });
      return this.offerorView(trx, request.id, seller);
    });
  }

  /* ---------- Assignments: execution and reviews ---------- */

  private async ownAssignment(trx: Transaction, p: Principal, id: string, lock: boolean): Promise<{ row: TaskAssignmentRow; side: 'owner' | 'assignee' }> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = lock ? await taskAssignments.lock(trx, id) : await taskAssignments.get(trx, id);
    if (!row) throw new ApiError('access.not_found');
    if (row.owner_person_id === p.personId) return { row, side: 'owner' };
    if (this.actsFor(p, partyOf(row.assignee_person_id, row.assignee_company_id))) return { row, side: 'assignee' };
    throw new ApiError('access.not_found');
  }

  async getAssignment(id: string, state: RequestState): Promise<TaskAssignmentView> {
    if (!state.principal || !UUID.test(id)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => this.assignmentView(trx, p, (await this.ownAssignment(trx, p, id, false)).row));
  }

  async listAssignments(state: RequestState): Promise<z.infer<typeof TaskAssignmentListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await taskAssignments.listForParties(trx, this.scope(p));
      const items = [];
      for (const row of rows) {
        const version = await taskRequestVersions.get(trx, row.request_version_id);
        const side = row.owner_person_id === p.personId ? 'owner' as const : 'assignee' as const;
        items.push({ id: row.id, side, status: row.status, title: (version?.payload as { title: string } | undefined)?.title ?? '', counterparty: side === 'owner' ? partyOf(row.assignee_person_id, row.assignee_company_id) : partyOf(row.owner_person_id, null), createdAt: iso(row.created_at) });
      }
      return TaskAssignmentListSchema.parse({ assignments: items });
    });
  }

  /**
   * Execution evidence: the assignee claims a milestone with evidence (asserted); the owner accepts or rejects the
   * latest claim in person (accepting work is human-only). The assignment status follows the milestones; when every
   * milestone is accepted the task is completed and the plan item is done.
   */
  async record(id: string, input: In<typeof RecordTaskExecutionCommandSchema>, state: RequestState): Promise<TaskAssignmentView> {
    return this.run(state, async (trx, p) => {
      const { row, side } = await this.ownAssignment(trx, p, id, true);
      let actor: ResolvedActor = { via: 'person', personId: p.personId, mandateId: null };
      if (input.kind === 'delivery_claim') {
        if (side !== 'assignee') throw new ApiError('access.forbidden', 'the assignee claims delivery', { reason: 'not_authorised' });
        actor = await this.actor(p, input.actor, 'record_evidence', { kind: 'agreement', id: row.agreement_id });
      } else if (side !== 'owner') {
        throw new ApiError('access.forbidden', 'the owner decides on delivered work', { reason: 'not_authorised' });
      }
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const by = side === 'assignee' ? columnsOf(partyOf(row.assignee_person_id, row.assignee_company_id)) : { person: row.owner_person_id, company: null };
      const record = await taskRecords.insert(trx, {
        assignment_id: row.id, milestone_key: input.milestoneKey, kind: input.kind, claim_id: input.kind === 'delivery_claim' ? null : input.claimId,
        evidence: input.kind === 'delivery_claim' ? input.evidence : [], note: input.note, by_person_id: by.person, by_company_id: by.company, recorded_by_person_id: p.personId,
        via: actor.via, mandate_id: actor.mandateId,
      });
      const records = (await taskRecords.listFor(trx, row.id)).map(recordContract);
      const states = milestoneStates(assignmentContract(row).milestones, records);
      const implied = assignmentStatusFor(states, records.length > 0);
      const next = side === 'assignee' ? (implied === 'assigned' ? row.status : implied) : implied === 'accepted' ? 'accepted' : row.status === 'delivered' && implied === 'in_progress' ? 'in_progress' : row.status;
      const saved = await taskAssignments.setStatus(trx, row.id, input.expectedRevision, { status: next, completed_at: next === 'accepted' ? this.now() : null });
      if (!saved) throw new ApiError('validation.revision_conflict');
      if (next === 'accepted') {
        const request = await taskRequests.get(trx, row.task_request_id);
        if (request) await this.advancePlanItem(trx, p, request, 'done');
      }
      await this.audit(trx, p, state, `task.${input.kind}`, 'task_assignment', row.id, { recordId: record.id, milestoneKey: input.milestoneKey, status: next, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'task_assignment', row.id, saved.revision, `task.${input.kind}`, { assignmentId: row.id, recordId: record.id, status: next, via: actor.via });
      return this.assignmentView(trx, p, saved);
    });
  }

  /** Reviews are allowed only for completed tasks, once per side, in the person's own words. */
  async review(id: string, input: In<typeof SubmitTaskReviewCommandSchema>, state: RequestState): Promise<TaskAssignmentView> {
    return this.run(state, async (trx, p) => {
      const { row, side } = await this.ownAssignment(trx, p, id, false);
      if (!reviewAllowed(row.status)) throw new ApiError('validation.schema', 'reviews are allowed only for completed tasks', { reason: 'review_not_allowed' });
      const owner = { person: row.owner_person_id, company: null };
      const assignee = columnsOf(partyOf(row.assignee_person_id, row.assignee_company_id));
      const [author, subject] = side === 'owner' ? [owner, assignee] : [assignee, owner];
      const review = await taskReviews.insert(trx, {
        assignment_id: row.id, author_side: side, author_person_id: author.person, author_company_id: author.company, subject_person_id: subject.person, subject_company_id: subject.company,
        written_by_person_id: p.personId, rating: input.rating, text: input.text,
      });
      await this.audit(trx, p, state, 'task.reviewed', 'task_assignment', row.id, { reviewId: review.id, side, rating: input.rating });
      await this.event(trx, 'task_assignment', row.id, row.revision, 'task.reviewed', { assignmentId: row.id, reviewId: review.id });
      return this.assignmentView(trx, p, row);
    });
  }
}
