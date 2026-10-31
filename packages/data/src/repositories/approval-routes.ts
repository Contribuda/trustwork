import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  ApprovalDecisionRow, ApprovalDelegationRow, ApprovalRequestRow, ApprovalRequestStepRow, ApprovalRouteVersionRow, ApprovalSubjectKindColumn,
} from '../schema/approval-routes.js';

/**
 * Approval routes repository (PRC-001, migration packages/data/migrations/approval-routes). Every write is one owner-run
 * `approval_*` command that repeats the rules in SQL: route managers draft and activate, members submit their company's
 * subjects, the request row lock serialises decisions (concurrent decisions on one step resolve once), the requester
 * never decides, delegations never exceed the delegator, and a decision needs the decider's own first-party session.
 * Reads go through row-level security (`approval_request_visible`).
 *
 * `now` is the API clock: due times, escalation and delegation validity are evaluated against it.
 */

export interface MoneyMinor { minorUnits: string; currency: string }

export interface SubmitApprovalInput {
  companyId: string;
  subjectKind: ApprovalSubjectKindColumn;
  subjectId: string;
  subjectVersionId: string;
  /** Hex value of the subject version's `trustwork-digest-1`. */
  subjectDigest: string;
  amount: MoneyMinor | null;
  projectId: string | null;
  /** Structured facts the conditions and segregation-of-duties rules read (validated by the module). */
  facts: Record<string, unknown>;
  /** The active route version the steps were resolved against (a concurrent activation refuses the submission). */
  routeVersionId: string;
  /** Keys of the active route's steps whose conditions hold for this subject. */
  stepKeys: readonly string[];
  now: Date;
}

export interface DecideApprovalInput {
  requestId: string;
  step: string;
  decision: 'approve' | 'reject' | 'return';
  subjectDigest: string;
  reason: string | null;
  expectedRevision: number;
  sessionId: string;
  stepUp: boolean;
  now: Date;
}

export interface ViewerOptionRow { step_key: string; may_decide: boolean; delegated_from_person_id: string | null; delegation_id: string | null; refusal: string | null }
export interface WaitingRow { request_id: string; step_key: string; delegated_from_person_id: string | null; due_at: Date | null }

const one = <T>(rows: T[]): T => {
  const row = rows[0];
  if (!row) throw new Error('approval command returned no row');
  return row;
};

export const approvalRoutes = {
  async draft(trx: Transaction, input: { companyId: string; subjectKind: ApprovalSubjectKindColumn; payload: unknown; digest: string; templateKey: string | null; templateVersion: number | null; secondPersonRequired: boolean }): Promise<ApprovalRouteVersionRow> {
    const { rows } = await sql<ApprovalRouteVersionRow>`SELECT * FROM trustwork.approval_draft_route(${input.companyId}::uuid, ${input.subjectKind}::text, ${JSON.stringify(input.payload)}::jsonb,
      ${input.digest}::text, ${input.templateKey}::text, ${input.templateVersion}::integer, ${input.secondPersonRequired}::boolean)`.execute(trx);
    return one(rows);
  },
  async activate(trx: Transaction, input: { routeId: string; digest: string; expectedRevision: number; sessionId: string }): Promise<ApprovalRouteVersionRow> {
    const { rows } = await sql<ApprovalRouteVersionRow>`SELECT * FROM trustwork.approval_activate_route(${input.routeId}::uuid, ${input.digest}::text, ${input.expectedRevision}::integer, ${input.sessionId}::uuid)`.execute(trx);
    return one(rows);
  },
  get(trx: Transaction, id: string): Promise<ApprovalRouteVersionRow | undefined> {
    return trx.selectFrom('approval_route_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction, companyId: string, subjectKind: ApprovalSubjectKindColumn | null): Promise<ApprovalRouteVersionRow[]> {
    let q = trx.selectFrom('approval_route_version').selectAll().where('owner_company_id', '=', companyId);
    if (subjectKind) q = q.where('subject_kind', '=', subjectKind);
    return q.orderBy('subject_kind').orderBy('version', 'desc').limit(200).execute();
  },
  active(trx: Transaction, companyId: string, subjectKind: ApprovalSubjectKindColumn): Promise<ApprovalRouteVersionRow | undefined> {
    return trx.selectFrom('approval_route_version').selectAll().where('owner_company_id', '=', companyId).where('subject_kind', '=', subjectKind).where('status', '=', 'active').executeTakeFirst();
  },
  async memberOf(trx: Transaction, companyId: string): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.approval_member_of(${companyId}::uuid) AS v`.execute(trx);
    return rows[0]?.v === true;
  },
  async holdsPermission(trx: Transaction, companyId: string, permission: string): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.approval_holds_permission(${companyId}::uuid, ${permission}::text) AS v`.execute(trx);
    return rows[0]?.v === true;
  },
};

export const approvalRequests = {
  /** The subject module's port: binds the frozen version and digest; supersedes a pending request of an earlier version. */
  async submit(trx: Transaction, input: SubmitApprovalInput): Promise<ApprovalRequestRow> {
    const { rows } = await sql<ApprovalRequestRow>`SELECT * FROM trustwork.approval_submit(${input.companyId}::uuid, ${input.subjectKind}::text, ${input.subjectId}::uuid,
      ${input.subjectVersionId}::uuid, ${input.subjectDigest}::text, ${input.amount?.minorUnits ?? null}::numeric, ${input.amount?.currency ?? null}::text, ${input.projectId}::uuid,
      ${JSON.stringify(input.facts)}::jsonb, ${input.routeVersionId}::uuid, ${[...input.stepKeys]}::text[], ${input.now}::timestamptz)`.execute(trx);
    return one(rows);
  },
  /** A new subject version without a new submission: pending requests of other versions become `superseded`. */
  async supersede(trx: Transaction, input: { subjectKind: ApprovalSubjectKindColumn; subjectId: string; newVersionId: string; now: Date }): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.approval_supersede(${input.subjectKind}::text, ${input.subjectId}::uuid, ${input.newVersionId}::uuid, ${input.now}::timestamptz) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
  async withdraw(trx: Transaction, input: { requestId: string; expectedRevision: number; now: Date }): Promise<ApprovalRequestRow> {
    const { rows } = await sql<ApprovalRequestRow>`SELECT * FROM trustwork.approval_withdraw(${input.requestId}::uuid, ${input.expectedRevision}::integer, ${input.now}::timestamptz)`.execute(trx);
    return one(rows);
  },
  async decide(trx: Transaction, input: DecideApprovalInput): Promise<ApprovalDecisionRow> {
    const { rows } = await sql<ApprovalDecisionRow>`SELECT * FROM trustwork.approval_decide(${input.requestId}::uuid, ${input.step}::text, ${input.decision}::text, ${input.subjectDigest}::text,
      ${input.reason}::text, ${input.expectedRevision}::integer, ${input.sessionId}::uuid, ${input.stepUp}::boolean, ${input.now}::timestamptz)`.execute(trx);
    return one(rows);
  },
  get(trx: Transaction, id: string): Promise<ApprovalRequestRow | undefined> {
    return trx.selectFrom('approval_request').selectAll().where('id', '=', id).executeTakeFirst();
  },
  steps(trx: Transaction, requestId: string): Promise<ApprovalRequestStepRow[]> {
    return trx.selectFrom('approval_request_step').selectAll().where('request_id', '=', requestId).orderBy('step_order').orderBy('step_key').execute();
  },
  decisions(trx: Transaction, requestId: string): Promise<ApprovalDecisionRow[]> {
    return trx.selectFrom('approval_decision').selectAll().where('approval_request_id', '=', requestId).orderBy('decided_at').orderBy('id').execute();
  },
  list(trx: Transaction, input: { companyId: string; status: ApprovalRequestRow['status'] | null; mineOnly: boolean; personId: string; limit: number }): Promise<ApprovalRequestRow[]> {
    let q = trx.selectFrom('approval_request').selectAll().where('owner_company_id', '=', input.companyId);
    if (input.status) q = q.where('status', '=', input.status);
    if (input.mineOnly) q = q.where('requested_by_person_id', '=', input.personId);
    return q.orderBy('submitted_at', 'desc').orderBy('id').limit(input.limit).execute();
  },
  async viewerOptions(trx: Transaction, requestId: string, now: Date): Promise<ViewerOptionRow[]> {
    const { rows } = await sql<ViewerOptionRow>`SELECT * FROM trustwork.approval_viewer_options(${requestId}::uuid, ${now}::timestamptz)`.execute(trx);
    return rows;
  },
  async waiting(trx: Transaction, now: Date, limit: number): Promise<WaitingRow[]> {
    const { rows } = await sql<WaitingRow>`SELECT * FROM trustwork.approval_decisions_waiting(${now}::timestamptz, ${limit}::integer)`.execute(trx);
    return rows;
  },
};

export const approvalDelegations = {
  async create(trx: Transaction, input: { delegatePersonId: string; subjectKinds: readonly ApprovalSubjectKindColumn[]; limit: MoneyMinor | null; validFrom: Date; validUntil: Date; now: Date }): Promise<ApprovalDelegationRow> {
    const { rows } = await sql<ApprovalDelegationRow>`SELECT * FROM trustwork.approval_delegate(${input.delegatePersonId}::uuid, ${[...input.subjectKinds]}::text[], ${input.limit?.minorUnits ?? null}::numeric,
      ${input.limit?.currency ?? null}::text, ${input.validFrom}::timestamptz, ${input.validUntil}::timestamptz, ${input.now}::timestamptz)`.execute(trx);
    return one(rows);
  },
  async revoke(trx: Transaction, input: { delegationId: string; reason: string; expectedRevision: number }): Promise<ApprovalDelegationRow> {
    const { rows } = await sql<ApprovalDelegationRow>`SELECT * FROM trustwork.approval_revoke_delegation(${input.delegationId}::uuid, ${input.reason}::text, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
  get(trx: Transaction, id: string): Promise<ApprovalDelegationRow | undefined> {
    return trx.selectFrom('approval_delegation').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Delegations the caller gave or received (and, for route managers, every delegation of the company). */
  list(trx: Transaction, companyId: string): Promise<ApprovalDelegationRow[]> {
    return trx.selectFrom('approval_delegation').selectAll().where('company_id', '=', companyId).orderBy('created_at', 'desc').orderBy('id').limit(200).execute();
  },
};

/** Worker port (trustwork_worker): escalates due steps, expires requests after the second timeout, ends lapsed delegations. */
export const approvalSweep = {
  async escalateDue(trx: Transaction, now: Date, limit = 100): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.approval_escalate_due(${now}::timestamptz, ${limit}::integer) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
};
