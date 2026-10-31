import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  TaskAssignmentRow, TaskAssignmentStatusValue, TaskExecutionRecordRow, TaskInvitationRow, TaskOfferPrivateRow, TaskOfferRow, TaskOfferStatusValue, TaskRecordKindValue, TaskRequestPrivateRow,
  TaskRequestRow, TaskRequestStatusValue, TaskRequestVersionRow, TaskReviewRow, TaskVia,
} from '../schema/tasks.js';
import type { AgreementRow } from '../schema/transactions.js';

/**
 * Tasks repository (TASK-001). Thin typed access under `withPrincipal`: RLS scopes every read and write (the owner
 * side of a request, the offeror side of an offer, the two parties of an assignment), and the guards in
 * packages/data/migrations/tasks freeze published versions and sent offers, pin offers to the current request version,
 * check every digest the agreement and the assignment repeat, and keep everything retained. Mutable envelopes change
 * with an expected revision.
 */
const json = (value: unknown): string => JSON.stringify(value);
export type PartyScope = { personId: string; companyId: string | null };
type PartyColumns = { person: string | null; company: string | null };

/* ---------- Requests ---------- */

export const taskRequests = {
  insert(trx: Transaction, row: { owner_person_id: string; project_id: string; plan_id: string; plan_version_id: string; plan_item_key: string; audience: 'invited' | 'open'; creator_person_id: string }): Promise<TaskRequestRow> {
    return trx.insertInto('task_request').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<TaskRequestRow | undefined> {
    return trx.selectFrom('task_request').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Serializes drafting, publication, invitations, acceptance and cancellation of one request (owner side only). */
  lock(trx: Transaction, id: string): Promise<TaskRequestRow | undefined> {
    return trx.selectFrom('task_request').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  listOwned(trx: Transaction, personId: string): Promise<TaskRequestRow[]> {
    return trx.selectFrom('task_request').selectAll().where('owner_person_id', '=', personId).orderBy('updated_at', 'desc').orderBy('id').limit(200).execute();
  },
  /** Published requests open to every signed-in person, except the principal's own (the caller orders them). */
  listOpen(trx: Transaction, personId: string): Promise<TaskRequestRow[]> {
    return trx.selectFrom('task_request').selectAll().where('audience', '=', 'open').where('status', '=', 'published').where('owner_person_id', '<>', personId).limit(500).execute();
  },
  bump(trx: Transaction, id: string, expectedRevision: number): Promise<TaskRequestRow | undefined> {
    return trx.updateTable('task_request').set((eb) => ({ status: eb.ref('status') })).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  setCurrent(trx: Transaction, id: string, input: { current_version: number; current_version_id: string }): Promise<TaskRequestRow> {
    return trx.updateTable('task_request').set({ ...input, status: 'published' }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  setStatus(trx: Transaction, id: string, expectedRevision: number, input: { status: Extract<TaskRequestStatusValue, 'cancelled' | 'expired'>; closed_reason: string | null }): Promise<TaskRequestRow | undefined> {
    return trx.updateTable('task_request').set(input).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export interface TaskRequestPrivateColumns { budget_ceiling_minor: string | null; budget_ceiling_currency: string | null; owner_notes: string | null }
export const taskRequestPrivate = {
  get(trx: Transaction, taskRequestId: string): Promise<TaskRequestPrivateRow | undefined> {
    return trx.selectFrom('task_request_private').selectAll().where('task_request_id', '=', taskRequestId).executeTakeFirst();
  },
  insert(trx: Transaction, row: TaskRequestPrivateColumns & { task_request_id: string; owner_person_id: string; updated_by_person_id: string }): Promise<TaskRequestPrivateRow> {
    return trx.insertInto('task_request_private').values(row).returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, taskRequestId: string, expectedRevision: number, input: TaskRequestPrivateColumns & { updated_by_person_id: string }): Promise<TaskRequestPrivateRow | undefined> {
    return trx.updateTable('task_request_private').set(input).where('task_request_id', '=', taskRequestId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const taskRequestVersions = {
  insertDraft(trx: Transaction, row: { task_request_id: string; version: number; terms: unknown; payload: unknown; drafted_by_person_id: string }): Promise<TaskRequestVersionRow> {
    return trx.insertInto('task_request_version').values({ ...row, terms: json(row.terms), payload: json(row.payload) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<TaskRequestVersionRow | undefined> {
    return trx.selectFrom('task_request_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Every version the principal may read (owner: all; others: published and superseded ones). */
  listFor(trx: Transaction, taskRequestId: string): Promise<TaskRequestVersionRow[]> {
    return trx.selectFrom('task_request_version').selectAll().where('task_request_id', '=', taskRequestId).orderBy('version').execute();
  },
  draftOf(trx: Transaction, taskRequestId: string): Promise<TaskRequestVersionRow | undefined> {
    return trx.selectFrom('task_request_version').selectAll().where('task_request_id', '=', taskRequestId).where('status', '=', 'draft').executeTakeFirst();
  },
  saveDraft(trx: Transaction, id: string, input: { terms: unknown; payload: unknown }): Promise<TaskRequestVersionRow | undefined> {
    return trx.updateTable('task_request_version').set({ terms: json(input.terms), payload: json(input.payload) }).where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  publish(trx: Transaction, id: string, input: { digest: string; personId: string; via: TaskVia; mandateId: string | null; amendmentReason: string | null; at: Date }): Promise<TaskRequestVersionRow | undefined> {
    return trx.updateTable('task_request_version')
      .set({ status: 'published', digest: input.digest, published_at: input.at, published_by_person_id: input.personId, published_via: input.via, published_mandate_id: input.mandateId, amendment_reason: input.amendmentReason })
      .where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  supersede(trx: Transaction, id: string, at: Date): Promise<TaskRequestVersionRow | undefined> {
    return trx.updateTable('task_request_version').set({ status: 'superseded', superseded_at: at }).where('id', '=', id).where('status', '=', 'published').returningAll().executeTakeFirst();
  },
};

export const taskInvitations = {
  insert(trx: Transaction, row: { task_request_id: string; party_person_id: string | null; party_company_id: string | null; sent_by_person_id: string; sent_via: TaskVia; sent_mandate_id: string | null }): Promise<TaskInvitationRow> {
    return trx.insertInto('task_invitation').values(row).returningAll().executeTakeFirstOrThrow();
  },
  /** The owner sees every invitation of its request; an invitee only its own (RLS). */
  listForRequest(trx: Transaction, taskRequestId: string): Promise<TaskInvitationRow[]> {
    return trx.selectFrom('task_invitation').selectAll().where('task_request_id', '=', taskRequestId).orderBy('created_at').orderBy('id').execute();
  },
  listForParty(trx: Transaction, scope: PartyScope): Promise<TaskInvitationRow[]> {
    return trx.selectFrom('task_invitation').selectAll()
      .where((eb) => eb.or([eb('party_person_id', '=', scope.personId), ...(scope.companyId ? [eb('party_company_id', '=', scope.companyId)] : [])]))
      .limit(500).execute();
  },
};

/* ---------- Offers ---------- */

export const taskOffers = {
  insertDraft(trx: Transaction, row: {
    task_request_id: string; offeror_person_id: string | null; offeror_company_id: string | null; version: number; request_version_id: string; request_version: number;
    request_version_digest: string; payload: unknown; valid_until: string; drafted_by_person_id: string;
  }): Promise<TaskOfferRow> {
    return trx.insertInto('task_offer').values({ ...row, payload: json(row.payload) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<TaskOfferRow | undefined> {
    return trx.selectFrom('task_offer').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<TaskOfferRow | undefined> {
    return trx.selectFrom('task_offer').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** Every version of one offeror's offer on a request, oldest first (only the offeror reads drafts). */
  listGroup(trx: Transaction, taskRequestId: string, offeror: PartyColumns): Promise<TaskOfferRow[]> {
    let q = trx.selectFrom('task_offer').selectAll().where('task_request_id', '=', taskRequestId);
    q = offeror.person ? q.where('offeror_person_id', '=', offeror.person) : q.where('offeror_company_id', '=', offeror.company as string);
    return q.orderBy('version').execute();
  },
  /** Locks one offeror's group on a request so two drafts of the next version cannot race (offeror side only). */
  lockGroup(trx: Transaction, taskRequestId: string, offeror: PartyColumns): Promise<TaskOfferRow[]> {
    let q = trx.selectFrom('task_offer').selectAll().where('task_request_id', '=', taskRequestId);
    q = offeror.person ? q.where('offeror_person_id', '=', offeror.person) : q.where('offeror_company_id', '=', offeror.company as string);
    return q.orderBy('version').forUpdate().execute();
  },
  /** Offers on a request the principal may read: the owner sees sent versions of every offeror; an offeror only its own. */
  listForRequest(trx: Transaction, taskRequestId: string): Promise<TaskOfferRow[]> {
    return trx.selectFrom('task_offer').selectAll().where('task_request_id', '=', taskRequestId).orderBy('created_at').orderBy('id').execute();
  },
  listForOfferor(trx: Transaction, scope: PartyScope): Promise<TaskOfferRow[]> {
    return trx.selectFrom('task_offer').selectAll()
      .where((eb) => eb.or([eb('offeror_person_id', '=', scope.personId), ...(scope.companyId ? [eb('offeror_company_id', '=', scope.companyId)] : [])]))
      .orderBy('task_request_id').orderBy('version').limit(1000).execute();
  },
  saveDraft(trx: Transaction, id: string, expectedRevision: number, input: { payload: unknown; valid_until: string }): Promise<TaskOfferRow | undefined> {
    return trx.updateTable('task_offer').set({ payload: json(input.payload), valid_until: input.valid_until }).where('id', '=', id).where('revision', '=', expectedRevision).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  send(trx: Transaction, id: string, expectedRevision: number, input: { digest: string; personId: string; via: TaskVia; mandateId: string | null; at: Date }): Promise<TaskOfferRow | undefined> {
    return trx.updateTable('task_offer').set({ status: 'sent', digest: input.digest, sent_at: input.at, sent_by_person_id: input.personId, sent_via: input.via, sent_mandate_id: input.mandateId })
      .where('id', '=', id).where('revision', '=', expectedRevision).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  supersede(trx: Transaction, id: string, at: Date): Promise<TaskOfferRow | undefined> {
    return trx.updateTable('task_offer').set({ status: 'superseded', superseded_at: at }).where('id', '=', id).where('status', '=', 'sent').returningAll().executeTakeFirst();
  },
  setStatus(trx: Transaction, id: string, expected: { revision: number; status: TaskOfferStatusValue }, input: { status: Extract<TaskOfferStatusValue, 'withdrawn' | 'accepted'>; withdrawn_reason: string | null }): Promise<TaskOfferRow | undefined> {
    return trx.updateTable('task_offer').set(input).where('id', '=', id).where('revision', '=', expected.revision).where('status', '=', expected.status).returningAll().executeTakeFirst();
  },
};

export interface TaskOfferPrivateColumns { floor_price_minor: string | null; floor_price_currency: string | null; offeror_notes: string | null }
export const taskOfferPrivate = {
  get(trx: Transaction, offerId: string): Promise<TaskOfferPrivateRow | undefined> {
    return trx.selectFrom('task_offer_private').selectAll().where('task_offer_id', '=', offerId).executeTakeFirst();
  },
  insert(trx: Transaction, row: TaskOfferPrivateColumns & { task_offer_id: string; offeror_person_id: string | null; offeror_company_id: string | null; updated_by_person_id: string }): Promise<TaskOfferPrivateRow> {
    return trx.insertInto('task_offer_private').values(row).returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, offerId: string, input: TaskOfferPrivateColumns & { updated_by_person_id: string }): Promise<TaskOfferPrivateRow | undefined> {
    return trx.updateTable('task_offer_private').set(input).where('task_offer_id', '=', offerId).returningAll().executeTakeFirst();
  },
};

/* ---------- Agreements of kind task (COM-002 tables) ---------- */

export const taskAgreements = {
  insert(trx: Transaction, row: {
    buyer_person_id: string; seller_person_id: string | null; seller_company_id: string | null; offer_ref_id: string; request_ref_id: string; offer_version: number; offer_digest: string;
    request_version: number; request_digest: string; accepted_terms_digest: string; created_by_person_id: string;
  }): Promise<AgreementRow> {
    return trx.insertInto('agreement').values({ ...row, terms_kind: 'task', buyer_company_id: null, rfq_id: null, quote_id: null, quote_version_id: null, rfq_version_id: null, status: 'accepted_by_buyer', supersedes_id: null })
      .returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('id', '=', id).where('terms_kind', '=', 'task').executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('id', '=', id).where('terms_kind', '=', 'task').forUpdate().executeTakeFirst();
  },
  /** Task agreements on the given offer versions, newest first. */
  listForOffers(trx: Transaction, offerIds: readonly string[]): Promise<AgreementRow[]> {
    if (offerIds.length === 0) return Promise.resolve([]);
    return trx.selectFrom('agreement').selectAll().where('terms_kind', '=', 'task').where('offer_ref_id', 'in', [...offerIds]).orderBy('created_at', 'desc').orderBy('id').execute();
  },
};

/* ---------- Assignments, records and reviews ---------- */

export const taskAssignments = {
  insert(trx: Transaction, row: {
    task_request_id: string; task_offer_id: string; agreement_id: string; agreement_digest: string; offer_version: number; offer_digest: string; request_version_id: string; request_version: number;
    request_digest: string; project_id: string; plan_id: string; plan_version_id: string; plan_item_key: string; owner_person_id: string; assignee_person_id: string | null;
    assignee_company_id: string | null; milestones: unknown; created_by_person_id: string;
  }): Promise<TaskAssignmentRow> {
    return trx.insertInto('task_assignment').values({ ...row, milestones: json(row.milestones) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<TaskAssignmentRow | undefined> {
    return trx.selectFrom('task_assignment').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<TaskAssignmentRow | undefined> {
    return trx.selectFrom('task_assignment').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  liveForRequest(trx: Transaction, taskRequestId: string): Promise<TaskAssignmentRow | undefined> {
    return trx.selectFrom('task_assignment').selectAll().where('task_request_id', '=', taskRequestId).where('status', '<>', 'cancelled').executeTakeFirst();
  },
  listForParties(trx: Transaction, scope: PartyScope): Promise<TaskAssignmentRow[]> {
    return trx.selectFrom('task_assignment').selectAll()
      .where((eb) => eb.or([eb('owner_person_id', '=', scope.personId), eb('assignee_person_id', '=', scope.personId), ...(scope.companyId ? [eb('assignee_company_id', '=', scope.companyId)] : [])]))
      .orderBy('created_at', 'desc').orderBy('id').limit(500).execute();
  },
  setStatus(trx: Transaction, id: string, expectedRevision: number, input: { status: TaskAssignmentStatusValue; completed_at: Date | null }): Promise<TaskAssignmentRow | undefined> {
    return trx.updateTable('task_assignment').set(input).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  /** The site of a live assignment for its two parties (owner-run read of the project location; nothing otherwise). */
  async site(trx: Transaction, id: string): Promise<{ region_code: string | null; address: unknown; site_contact: unknown; site_access_notes: string | null } | undefined> {
    const result = await sql<{ region_code: string | null; address: unknown; site_contact: unknown; site_access_notes: string | null }>`SELECT * FROM trustwork.task_assignment_site(${id}::uuid)`.execute(trx);
    return result.rows[0];
  },
};

export const taskRecords = {
  insert(trx: Transaction, row: {
    assignment_id: string; milestone_key: string; kind: TaskRecordKindValue; claim_id: string | null; evidence: unknown[]; note: string | null; by_person_id: string | null;
    by_company_id: string | null; recorded_by_person_id: string; via: TaskVia; mandate_id: string | null;
  }): Promise<TaskExecutionRecordRow> {
    return trx.insertInto('task_execution_record').values({ ...row, evidence: json(row.evidence) }).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, assignmentId: string): Promise<TaskExecutionRecordRow[]> {
    return trx.selectFrom('task_execution_record').selectAll().where('assignment_id', '=', assignmentId).orderBy('created_at').orderBy('id').execute();
  },
};

export const taskReviews = {
  insert(trx: Transaction, row: {
    assignment_id: string; author_side: 'owner' | 'assignee'; author_person_id: string | null; author_company_id: string | null; subject_person_id: string | null; subject_company_id: string | null;
    written_by_person_id: string; rating: number; text: string | null;
  }): Promise<TaskReviewRow> {
    return trx.insertInto('task_review').values(row).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, assignmentId: string): Promise<TaskReviewRow[]> {
    return trx.selectFrom('task_review').selectAll().where('assignment_id', '=', assignmentId).orderBy('created_at').orderBy('id').execute();
  },
};

/** Who owns a project (the owner side reads it; participants without a grant see nothing). */
export const taskProjects = {
  owner(trx: Transaction, projectId: string): Promise<{ owner_person_id: string | null; owner_company_id: string | null } | undefined> {
    return trx.selectFrom('project').select(['owner_person_id', 'owner_company_id']).where('id', '=', projectId).executeTakeFirst();
  },
};
