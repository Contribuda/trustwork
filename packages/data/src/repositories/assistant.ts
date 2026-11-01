import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  ActionAttemptRow, ActionIntentRow, ActionOutcomeRow, ApprovalRow, AssistantNoteRow, BacklogStatusValue, ConversationRoleValue, ConversationTurnRow, MandateContextRow, MandateProposalRow,
  MandateRevisionRow, MandateRow, ParticipantStopRow, ProposalOriginKindValue, ReconciliationRow, RunRow, RunStateValue, RunStepKindValue, RunStepRow, RunStepStateValue, ServiceBacklogItemRow,
} from '../schema/assistant.js';

/**
 * Assistant repository (AST-001). Principal-run access works inside `withPrincipal` (RLS scopes every row to its
 * principal); state changes call the owner-run commands of packages/data/migrations/assistant, which repeat the
 * authority, revision, limit and transition rules. Worker access (`assistantWorker`) runs as trustwork_worker and only
 * reaches the worker entry points.
 */
const json = (value: unknown): string => JSON.stringify(value);
async function first<T>(promise: Promise<{ rows: T[] }>, what: string): Promise<T> {
  const { rows } = await promise;
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

/* ---------- Mandates ---------- */

export interface ConfirmMandateInput {
  snapshot: unknown;
  contexts: unknown[];
  digest: string;
  expectedRevision: number | null;
  stepUp: boolean;
  proposalId: string | null;
}
export interface MandateFacts {
  /** Sum of non-voided amounts under the mandate (cumulative ceiling), in the ceiling currency, as a decimal string. */
  committedMinor: string;
  committedCurrency: string | null;
  actionsInWindow: number;
  approvalsAtRevision: number;
}

export const mandates = {
  confirm(trx: Transaction, input: ConfirmMandateInput): Promise<MandateRow> {
    return first(sql<MandateRow>`SELECT * FROM trustwork.assistant_confirm_mandate(${json(input.snapshot)}::jsonb, ${json(input.contexts)}::jsonb, ${input.digest}, ${input.expectedRevision}::integer,
      ${input.stepUp}, ${input.proposalId}::uuid)`.execute(trx), 'assistant_confirm_mandate');
  },
  narrow(trx: Transaction, id: string, expectedRevision: number | null, status: 'suspended' | 'revoked', reason: string): Promise<MandateRow> {
    return first(sql<MandateRow>`SELECT * FROM trustwork.assistant_narrow_mandate(${id}::uuid, ${expectedRevision}::integer, ${status}, ${reason})`.execute(trx), 'assistant_narrow_mandate');
  },
  /** System narrowing after a lost authority basis; needs no principal and only ever narrows. Returns the count. */
  async revokeForBasis(trx: Transaction, personId: string, companyId: string | null, reason: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.assistant_revoke_for_basis(${personId}::uuid, ${companyId}::uuid, ${reason}) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
  get(trx: Transaction, id: string): Promise<MandateRow | undefined> {
    return trx.selectFrom('mandate').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction, personId: string): Promise<MandateRow[]> {
    return trx.selectFrom('mandate').selectAll().where('principal_person_id', '=', personId).orderBy('updated_at', 'desc').orderBy('id').limit(200).execute();
  },
  contexts(trx: Transaction, id: string): Promise<MandateContextRow[]> {
    return trx.selectFrom('mandate_context').selectAll().where('mandate_id', '=', id).orderBy('id').execute();
  },
  revisions(trx: Transaction, id: string): Promise<MandateRevisionRow[]> {
    return trx.selectFrom('mandate_revision').selectAll().where('mandate_id', '=', id).orderBy('revision').execute();
  },
  /** Facts the pure policy needs (`committedUnderMandate`, `actionsInWindow`, `approvalsAtRevision`); the commands repeat them under a lock. */
  async facts(trx: Transaction, mandate: Pick<MandateRow, 'id' | 'revision'>, ceilingCurrency: string | null, windowHours: number | null): Promise<MandateFacts> {
    const { rows } = await sql<{ committed: string | null; in_window: number; approvals: number }>`
      SELECT (SELECT coalesce(sum(amount_minor), 0)::text FROM trustwork.mandate_use WHERE mandate_id = ${mandate.id}::uuid AND voided_at IS NULL AND currency IS NOT DISTINCT FROM ${ceilingCurrency}) AS committed,
             (SELECT count(*)::int FROM trustwork.mandate_use WHERE mandate_id = ${mandate.id}::uuid AND voided_at IS NULL
                AND ${windowHours}::integer IS NOT NULL AND used_at > clock_timestamp() - make_interval(hours => ${windowHours}::integer)) AS in_window,
             (SELECT count(*)::int FROM trustwork.mandate_use WHERE mandate_id = ${mandate.id}::uuid AND mandate_revision = ${mandate.revision}::integer AND approved AND voided_at IS NULL) AS approvals`.execute(trx);
    const row = rows[0];
    return { committedMinor: row?.committed ?? '0', committedCurrency: ceilingCurrency, actionsInWindow: row?.in_window ?? 0, approvalsAtRevision: row?.approvals ?? 0 };
  },
};

/* ---------- Proposals ---------- */

export const mandateProposals = {
  insert(trx: Transaction, row: { principal_person_id: string; mandate_id: string | null; basis_revision: number | null; origin_kind: ProposalOriginKindValue; origin: unknown; proposed: unknown; digest: string }): Promise<MandateProposalRow> {
    return trx.insertInto('mandate_proposal').values({ ...row, origin: json(row.origin), proposed: json(row.proposed) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<MandateProposalRow | undefined> {
    return trx.selectFrom('mandate_proposal').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listPending(trx: Transaction, personId: string): Promise<MandateProposalRow[]> {
    return trx.selectFrom('mandate_proposal').selectAll().where('principal_person_id', '=', personId).where('status', '=', 'pending').orderBy('created_at', 'desc').limit(100).execute();
  },
  decline(trx: Transaction, id: string, personId: string): Promise<MandateProposalRow | undefined> {
    return trx.updateTable('mandate_proposal').set({ status: 'declined', decided_at: new Date(), decided_by_person_id: personId })
      .where('id', '=', id).where('status', '=', 'pending').returningAll().executeTakeFirst();
  },
};

/* ---------- Stop control and kill switches ---------- */

export const stops = {
  async engage(trx: Transaction): Promise<{ stopId: string; engagedAt: string; suspendedMandates: number; revokedActions: number }> {
    const { rows } = await sql<{ r: { stopId: string; engagedAt: string; suspendedMandates: number; revokedActions: number } }>`SELECT trustwork.assistant_engage_stop() AS r`.execute(trx);
    return rows[0]!.r;
  },
  async release(trx: Transaction): Promise<{ released: boolean }> {
    const { rows } = await sql<{ r: { released: boolean } }>`SELECT trustwork.assistant_release_stop() AS r`.execute(trx);
    return rows[0]!.r;
  },
  current(trx: Transaction, personId: string): Promise<ParticipantStopRow | undefined> {
    return trx.selectFrom('participant_stop').selectAll().where('person_id', '=', personId).where('state', '=', 'engaged').executeTakeFirst();
  },
  /** First engaged hub kill switch or participant stop that blocks this dispatch, or null (`agentDispatchBlocked`). */
  async blockedBy(trx: Transaction, target: { hubId: string | null; moduleKey: string; action: string; personId: string; connectionId: string | null }): Promise<string | null> {
    const { rows } = await sql<{ id: string | null }>`SELECT trustwork.assistant_dispatch_blocked(${target.hubId}::uuid, ${target.moduleKey}, ${target.action}, ${target.personId}::uuid, ${target.connectionId}::uuid) AS id`.execute(trx);
    return rows[0]?.id ?? null;
  },
};

/* ---------- Runs and steps ---------- */

export const runs = {
  start(trx: Transaction, row: { principal_person_id: string; kind: string; mandate_id?: string | null; goal_id?: string | null; checkpoint?: unknown }): Promise<RunRow> {
    return trx.insertInto('run').values({ principal_person_id: row.principal_person_id, kind: row.kind, mandate_id: row.mandate_id ?? null, goal_id: row.goal_id ?? null, checkpoint: json(row.checkpoint ?? {}) })
      .returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<RunRow | undefined> {
    return trx.selectFrom('run').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction, personId: string): Promise<RunRow[]> {
    return trx.selectFrom('run').selectAll().where('principal_person_id', '=', personId).orderBy('created_at', 'desc').orderBy('id').limit(100).execute();
  },
  setState(trx: Transaction, id: string, state: Exclude<RunStateValue, 'cancelled'>, checkpoint?: unknown): Promise<RunRow | undefined> {
    const terminal = state === 'completed' || state === 'failed';
    return trx.updateTable('run').set({ state, ...(checkpoint !== undefined ? { checkpoint: json(checkpoint) } : {}), ...(terminal ? { ended_at: new Date(), ended_reason: state } : {}) })
      .where('id', '=', id).returningAll().executeTakeFirst();
  },
  cancel(trx: Transaction, id: string, reason: string): Promise<RunRow> {
    return first(sql<RunRow>`SELECT * FROM trustwork.assistant_cancel_run(${id}::uuid, ${reason})`.execute(trx), 'assistant_cancel_run');
  },
};

export const runSteps = {
  append(trx: Transaction, row: { run_id: string; kind: RunStepKindValue; tool?: string | null; input_digest?: string | null; output_ref?: unknown; state: RunStepStateValue }): Promise<RunStepRow> {
    return trx.insertInto('run_step').values({
      run_id: row.run_id, kind: row.kind, tool: row.tool ?? null, input_digest: row.input_digest ?? null, output_ref: row.output_ref === undefined ? null : json(row.output_ref), state: row.state, finished_at: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, runId: string): Promise<RunStepRow[]> {
    return trx.selectFrom('run_step').selectAll().where('run_id', '=', runId).orderBy('seq').limit(500).execute();
  },
};

/* ---------- Action intents ---------- */

export interface RecordIntentInput {
  runId: string | null;
  mandateId: string;
  mandateRevision: number;
  capabilityId: string;
  moduleKey: string;
  action: string;
  context: { kind: string; id: string };
  resolvedFromSelector: boolean;
  amount: { minorUnits: string; currency: string } | null;
  digest: string;
  effect: { provider: string; operation: string; payload: unknown } | null;
  decision: 'allow' | 'ask';
  askReasons: readonly string[];
}

export const actionIntents = {
  /** `allowed` (module check consumed a mandate use, no intent row), `authorized` or `proposed`. */
  async record(trx: Transaction, input: RecordIntentInput): Promise<{ intentId: string | null; state: 'allowed' | 'authorized' | 'proposed' }> {
    const { rows } = await sql<{ intent_id: string | null; state: 'allowed' | 'authorized' | 'proposed' }>`
      SELECT * FROM trustwork.assistant_record_intent(${input.runId}::uuid, ${input.mandateId}::uuid, ${input.mandateRevision}::integer, ${input.capabilityId}, ${input.moduleKey}, ${input.action},
        ${input.context.kind}, ${input.context.id}, ${input.resolvedFromSelector}, ${input.amount?.minorUnits ?? null}::bigint, ${input.amount?.currency ?? null}, ${input.digest},
        ${input.effect === null ? null : json(input.effect)}::jsonb, ${input.decision}, ${[...input.askReasons]}::text[])`.execute(trx);
    const row = rows[0]!;
    return { intentId: row.intent_id, state: row.state };
  },
  approve(trx: Transaction, id: string, digest: string, ttlSeconds: number, stepUp: boolean): Promise<ActionIntentRow> {
    return first(sql<ActionIntentRow>`SELECT * FROM trustwork.assistant_approve_intent(${id}::uuid, ${digest}, ${ttlSeconds}::integer, ${stepUp})`.execute(trx), 'assistant_approve_intent');
  },
  decline(trx: Transaction, id: string, reason: string): Promise<ActionIntentRow> {
    return first(sql<ActionIntentRow>`SELECT * FROM trustwork.assistant_decline_intent(${id}::uuid, ${reason})`.execute(trx), 'assistant_decline_intent');
  },
  /** Reserves the budget (BILL-001) when the action spends money and queues the dispatch job, in the caller's transaction. */
  queue(trx: Transaction, id: string, ttlSeconds: number, projectId: string | null): Promise<ActionIntentRow> {
    return first(sql<ActionIntentRow>`SELECT * FROM trustwork.assistant_queue_intent(${id}::uuid, ${ttlSeconds}::integer, ${projectId}::uuid)`.execute(trx), 'assistant_queue_intent');
  },
  get(trx: Transaction, id: string): Promise<ActionIntentRow | undefined> {
    return trx.selectFrom('action_intent').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listForRun(trx: Transaction, runId: string): Promise<ActionIntentRow[]> {
    return trx.selectFrom('action_intent').selectAll().where('run_id', '=', runId).orderBy('created_at').orderBy('id').execute();
  },
  /** Decisions waiting for the person (`decision.kicker`). */
  listWaiting(trx: Transaction, personId: string): Promise<ActionIntentRow[]> {
    return trx.selectFrom('action_intent').selectAll().where('principal_person_id', '=', personId).where('state', '=', 'proposed').orderBy('created_at', 'desc').limit(100).execute();
  },
  outcomes(trx: Transaction, id: string): Promise<ActionOutcomeRow[]> {
    return trx.selectFrom('action_outcome').selectAll().where('action_intent_id', '=', id).orderBy('observed_at').orderBy('id').execute();
  },
  attempts(trx: Transaction, id: string): Promise<ActionAttemptRow[]> {
    return trx.selectFrom('action_attempt').selectAll().where('action_intent_id', '=', id).orderBy('attempt_no').execute();
  },
  approvals(trx: Transaction, id: string): Promise<ApprovalRow[]> {
    return trx.selectFrom('approval').selectAll().where('action_intent_id', '=', id).orderBy('approved_at').execute();
  },
  reconciliations(trx: Transaction, id: string): Promise<ReconciliationRow[]> {
    return trx.selectFrom('reconciliation').selectAll().where('action_intent_id', '=', id).orderBy('reconciled_at').execute();
  },
};

/* ---------- Conversation, notes and backlog ---------- */

export const conversationTurns = {
  append(trx: Transaction, row: { person_id: string; role: ConversationRoleValue; content: string; run_id?: string | null }): Promise<ConversationTurnRow> {
    return trx.insertInto('conversation_turn').values({ person_id: row.person_id, role: row.role, content: row.content, run_id: row.run_id ?? null }).returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, personId: string, limit = 100): Promise<ConversationTurnRow[]> {
    return trx.selectFrom('conversation_turn').selectAll().where('person_id', '=', personId).where('expires_at', '>', new Date()).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  },
};

export const assistantNotes = {
  retain(trx: Transaction, row: { person_id: string; text: string; source_dependencies: unknown[] }): Promise<AssistantNoteRow> {
    return trx.insertInto('assistant_note').values({ person_id: row.person_id, text: row.text, source_dependencies: json(row.source_dependencies) }).returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, personId: string): Promise<AssistantNoteRow[]> {
    return trx.selectFrom('assistant_note').selectAll().where('person_id', '=', personId).orderBy('retained_at', 'desc').limit(200).execute();
  },
};

export const serviceBacklog = {
  propose(trx: Transaction, row: { person_id: string; company_id?: string | null; title: string; proposal: unknown; source_run_id?: string | null }): Promise<ServiceBacklogItemRow> {
    return trx.insertInto('service_backlog_item').values({ person_id: row.person_id, company_id: row.company_id ?? null, title: row.title, proposal: json(row.proposal), source_run_id: row.source_run_id ?? null })
      .returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, personId: string): Promise<ServiceBacklogItemRow[]> {
    return trx.selectFrom('service_backlog_item').selectAll().where('person_id', '=', personId).orderBy('created_at', 'desc').limit(200).execute();
  },
  setStatus(trx: Transaction, id: string, status: Exclude<BacklogStatusValue, 'proposed'>, expectedRevision: number): Promise<ServiceBacklogItemRow | undefined> {
    return trx.updateTable('service_backlog_item').set({ status }).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

/* ---------- Worker entry points (trustwork_worker) ---------- */

export type DispatchTarget =
  | { status: 'dispatch'; attemptId: string; attemptNo: number; operationId: string; correlationKey: string; provider: string; operation: string; payload: unknown; amount: { minorUnits: string; currency: string } | null }
  | { status: 'skip'; state: string }
  | { status: 'refused'; reason: string };
export type ReconciliationTarget =
  | { status: 'reconcile'; attemptId: string; operationId: string; correlationKey: string; provider: string; operation: string }
  | { status: 'skip'; state: string };
export interface ObservedOutcome {
  kind: 'unknown' | 'acknowledged' | 'final';
  result?: 'succeeded' | 'failed' | null;
  reason?: 'timeout' | 'crash' | 'lease_expired' | 'ambiguous_response' | null;
  providerReference?: string | null;
  evidence?: string | null;
}

export const assistantWorker = {
  async beginAttempt(trx: Transaction, intentId: string, jobId: string, hubId: string | null, fencingToken: string | number): Promise<DispatchTarget> {
    const { rows } = await sql<{ r: DispatchTarget }>`SELECT trustwork.assistant_begin_attempt(${intentId}::uuid, ${jobId}::uuid, ${hubId}::uuid, ${fencingToken}::bigint) AS r`.execute(trx);
    return rows[0]!.r;
  },
  async recordOutcome(trx: Transaction, attemptId: string, outcome: ObservedOutcome): Promise<string> {
    const { rows } = await sql<{ r: string }>`SELECT trustwork.assistant_record_outcome(${attemptId}::uuid, ${outcome.kind}, ${outcome.result ?? null}, ${outcome.reason ?? null},
      ${outcome.providerReference ?? null}, ${outcome.evidence ?? null}) AS r`.execute(trx);
    return rows[0]!.r;
  },
  async parkStale(trx: Transaction, limit = 100): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.assistant_park_stale_attempts(${limit}::integer) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
  async beginReconciliation(trx: Transaction, intentId: string): Promise<ReconciliationTarget> {
    const { rows } = await sql<{ r: ReconciliationTarget }>`SELECT trustwork.assistant_begin_reconciliation(${intentId}::uuid) AS r`.execute(trx);
    return rows[0]!.r;
  },
  async recordReconciliation(trx: Transaction, intentId: string, lookupReference: string, outcome: ObservedOutcome): Promise<string> {
    const { rows } = await sql<{ r: string }>`SELECT trustwork.assistant_record_reconciliation(${intentId}::uuid, ${lookupReference}, ${outcome.kind}, ${outcome.result ?? null},
      ${outcome.providerReference ?? null}, ${outcome.evidence ?? null}) AS r`.execute(trx);
    return rows[0]!.r;
  },
  async recordReceipt(trx: Transaction, receipt: { provider: string; account: string; eventId: string; correlationKey: string } & ObservedOutcome): Promise<string> {
    const { rows } = await sql<{ r: string }>`SELECT trustwork.assistant_record_receipt(${receipt.provider}, ${receipt.account}, ${receipt.eventId}, ${receipt.correlationKey}, ${receipt.kind},
      ${receipt.result ?? null}, ${receipt.providerReference ?? null}, ${receipt.evidence ?? null}) AS r`.execute(trx);
    return rows[0]!.r;
  },
};
