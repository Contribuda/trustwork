import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  AgentEnvelopeReceiptRow, AgentEnvelopeRow, AgentEnvelopeSenderRow, AgentEscalationRow, AgentReportRow, CompanyMandateRow, CompanyRepresentativeRow, GoalProgressRow, GoalRow,
  JobSubscriptionRow, NegotiationSessionRow, RepresentativeAccountabilityRow,
} from '../schema/agents.js';

/**
 * Agents repository (AGT-001). Principal-run access works inside `withPrincipal`: RLS scopes goals, progress, job
 * subscriptions and reports to their principal, envelopes and sessions to the two parties, receipts and escalations to
 * their own party. State changes call the owner-run commands of packages/data/migrations/agents, which repeat every
 * authority, transition and privacy rule. Nothing here reads an envelope note to decide anything.
 */
const json = (value: unknown): string => JSON.stringify(value);
async function first<T>(promise: Promise<{ rows: T[] }>, what: string): Promise<T> {
  const { rows } = await promise;
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

/* ---------- Goals ---------- */

export interface InsertGoalInput {
  principal_person_id: string;
  on_behalf_company_id: string | null;
  text: string;
  success_criteria: unknown[];
  allowed_actions: string[];
  needs: unknown[];
  budget_range: unknown | null;
  horizon: Date;
  report_cadence: 'none' | 'daily' | 'weekly' | 'monthly';
  proposed_by: 'principal' | 'agent' | 'connection';
  covered: unknown[];
  proposal_ids: string[];
  confirmation_digest: string;
}

export const goals = {
  /** `id` lets the caller name the goal in its proposals' origin before the goal row exists. */
  insert(trx: Transaction, row: InsertGoalInput, id?: string): Promise<GoalRow> {
    return trx.insertInto('goal').values({
      ...(id ? { id } : {}), ...row, success_criteria: json(row.success_criteria), needs: json(row.needs), budget_range: row.budget_range === null ? null : json(row.budget_range), covered: json(row.covered),
    }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<GoalRow | undefined> {
    return trx.selectFrom('goal').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction, personId: string): Promise<GoalRow[]> {
    return trx.selectFrom('goal').selectAll().where('principal_person_id', '=', personId).orderBy('created_at', 'desc').orderBy('id').limit(200).execute();
  },
  confirm(trx: Transaction, id: string, digest: string, stepUp: boolean): Promise<GoalRow> {
    return first(sql<GoalRow>`SELECT * FROM trustwork.agents_confirm_goal(${id}::uuid, ${digest}, ${stepUp})`.execute(trx), 'agents_confirm_goal');
  },
  setStatus(trx: Transaction, id: string, expectedRevision: number, status: 'active' | 'paused' | 'closed', outcome: string | null): Promise<GoalRow> {
    return first(sql<GoalRow>`SELECT * FROM trustwork.agents_set_goal_status(${id}::uuid, ${expectedRevision}::integer, ${status}, ${outcome})`.execute(trx), 'agents_set_goal_status');
  },
};

export const goalProgress = {
  /** Narrow source lookup; the same goal-owner RLS as the progress list applies. */
  get(trx: Transaction, id: string): Promise<GoalProgressRow | undefined> {
    return trx.selectFrom('goal_progress').selectAll().where('id', '=', id).executeTakeFirst();
  },
  append(trx: Transaction, row: { goal_id: string; event_kind: string; evidence_refs?: unknown[]; detail?: unknown; recorded_by_person_id: string }): Promise<GoalProgressRow> {
    return trx.insertInto('goal_progress').values({
      goal_id: row.goal_id, event_kind: row.event_kind, evidence_refs: json(row.evidence_refs ?? []), detail: json(row.detail ?? {}), recorded_by_person_id: row.recorded_by_person_id,
    }).returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, goalId: string): Promise<GoalProgressRow[]> {
    return trx.selectFrom('goal_progress').selectAll().where('goal_id', '=', goalId).orderBy('at').orderBy('id').limit(500).execute();
  },
};

export const jobSubscriptions = {
  /** Own subscription only; staff receive no additional read grant. */
  get(trx: Transaction, id: string): Promise<JobSubscriptionRow | undefined> {
    return trx.selectFrom('job_subscription').selectAll().where('id', '=', id).executeTakeFirst();
  },
  insert(trx: Transaction, row: { principal_person_id: string; on_behalf_company_id: string | null; module_key: string; job_template_key: string; trigger: unknown; goal_id: string | null; mandate_id: string | null }): Promise<JobSubscriptionRow> {
    return trx.insertInto('job_subscription').values({ ...row, trigger: json(row.trigger) }).returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, personId: string): Promise<JobSubscriptionRow[]> {
    return trx.selectFrom('job_subscription').selectAll().where('principal_person_id', '=', personId).orderBy('created_at', 'desc').limit(200).execute();
  },
  setStatus(trx: Transaction, id: string, status: 'active' | 'paused' | 'ended', expectedRevision: number): Promise<JobSubscriptionRow | undefined> {
    return trx.updateTable('job_subscription').set({ status }).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const agentReports = {
  insert(trx: Transaction, row: { author_person_id: string; principal_company_id: string | null; goal_id: string | null; run_id: string | null; period_from: Date; period_to: Date; sections: unknown[] }): Promise<AgentReportRow> {
    return trx.insertInto('agent_report').values({ ...row, sections: json(row.sections) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<AgentReportRow | undefined> {
    return trx.selectFrom('agent_report').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction): Promise<AgentReportRow[]> {
    return trx.selectFrom('agent_report').selectAll().orderBy('created_at', 'desc').limit(100).execute();
  },
  share(trx: Transaction, id: string, personIds: string[]): Promise<AgentReportRow> {
    return first(sql<AgentReportRow>`SELECT * FROM trustwork.agents_share_report(${id}::uuid, ${personIds}::uuid[])`.execute(trx), 'agents_share_report');
  },
};

/* ---------- The company representative and company mandates ---------- */

export const representatives = {
  get(trx: Transaction, companyId: string): Promise<CompanyRepresentativeRow | undefined> {
    return trx.selectFrom('company_representative').selectAll().where('company_id', '=', companyId).executeTakeFirst();
  },
  accountability(trx: Transaction, representativeId: string): Promise<RepresentativeAccountabilityRow[]> {
    return trx.selectFrom('representative_accountability').selectAll().where('representative_id', '=', representativeId).orderBy('from_at').orderBy('id').execute();
  },
  configure(trx: Transaction, companyId: string, accountablePersonId: string, expectedRevision: number | null): Promise<CompanyRepresentativeRow> {
    return first(sql<CompanyRepresentativeRow>`SELECT * FROM trustwork.agents_configure_representative(${companyId}::uuid, ${accountablePersonId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'agents_configure_representative');
  },
  accept(trx: Transaction, companyId: string): Promise<CompanyRepresentativeRow> {
    return first(sql<CompanyRepresentativeRow>`SELECT * FROM trustwork.agents_accept_representative(${companyId}::uuid)`.execute(trx), 'agents_accept_representative');
  },
  suspend(trx: Transaction, companyId: string): Promise<CompanyRepresentativeRow> {
    return first(sql<CompanyRepresentativeRow>`SELECT * FROM trustwork.agents_suspend_representative(${companyId}::uuid)`.execute(trx), 'agents_suspend_representative');
  },
  resume(trx: Transaction, companyId: string, expectedRevision: number): Promise<CompanyRepresentativeRow> {
    return first(sql<CompanyRepresentativeRow>`SELECT * FROM trustwork.agents_resume_representative(${companyId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'agents_resume_representative');
  },
  disable(trx: Transaction, companyId: string): Promise<CompanyRepresentativeRow> {
    return first(sql<CompanyRepresentativeRow>`SELECT * FROM trustwork.agents_disable_representative(${companyId}::uuid)`.execute(trx), 'agents_disable_representative');
  },
};

export const companyMandates = {
  get(trx: Transaction, id: string): Promise<CompanyMandateRow | undefined> {
    return trx.selectFrom('company_mandate').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listForCompany(trx: Transaction, companyId: string): Promise<CompanyMandateRow[]> {
    return trx.selectFrom('company_mandate').selectAll().where('company_id', '=', companyId).orderBy('created_at', 'desc').orderBy('id').limit(200).execute();
  },
  listForExecutor(trx: Transaction, personId: string): Promise<CompanyMandateRow[]> {
    return trx.selectFrom('company_mandate').selectAll().where('executor_person_id', '=', personId).orderBy('created_at', 'desc').limit(200).execute();
  },
  grant(trx: Transaction, mandateId: string, terms: unknown, termsDigest: string): Promise<CompanyMandateRow> {
    return first(sql<CompanyMandateRow>`SELECT * FROM trustwork.agents_grant_company_mandate(${mandateId}::uuid, ${json(terms)}::jsonb, ${termsDigest})`.execute(trx), 'agents_grant_company_mandate');
  },
  reconfirm(trx: Transaction, id: string, newMandateId: string, termsDigest: string): Promise<CompanyMandateRow> {
    return first(sql<CompanyMandateRow>`SELECT * FROM trustwork.agents_reconfirm_company_mandate(${id}::uuid, ${newMandateId}::uuid, ${termsDigest})`.execute(trx), 'agents_reconfirm_company_mandate');
  },
  revoke(trx: Transaction, id: string, expectedRevision: number): Promise<CompanyMandateRow> {
    return first(sql<CompanyMandateRow>`SELECT * FROM trustwork.agents_revoke_company_mandate(${id}::uuid, ${expectedRevision}::integer)`.execute(trx), 'agents_revoke_company_mandate');
  },
};

/* ---------- Envelopes, sessions, receipts and escalations ---------- */

export interface DeliveryResult { envelope_id: string | null; session_id: string | null; outcome: 'delivered' | 'escalated' | 'not_delivered'; reason: string | null }

export const envelopes = {
  deliver(trx: Transaction, actor: unknown, envelope: unknown, settings: unknown): Promise<DeliveryResult> {
    return first(sql<DeliveryResult>`SELECT * FROM trustwork.agents_deliver_envelope(${json(actor)}::jsonb, ${json(envelope)}::jsonb, ${json(settings)}::jsonb)`.execute(trx), 'agents_deliver_envelope');
  },
  get(trx: Transaction, id: string): Promise<AgentEnvelopeRow | undefined> {
    return trx.selectFrom('agent_envelope').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Envelopes of the parties the principal acts for (RLS), newest first. */
  list(trx: Transaction, limit = 100): Promise<AgentEnvelopeRow[]> {
    return trx.selectFrom('agent_envelope').selectAll().orderBy('created_at', 'desc').orderBy('id').limit(limit).execute();
  },
  listForSession(trx: Transaction, sessionId: string): Promise<AgentEnvelopeRow[]> {
    return trx.selectFrom('agent_envelope').selectAll().where('session_id', '=', sessionId).orderBy('created_at').orderBy('id').execute();
  },
  sender(trx: Transaction, envelopeId: string): Promise<AgentEnvelopeSenderRow | undefined> {
    return trx.selectFrom('agent_envelope_sender').selectAll().where('envelope_id', '=', envelopeId).executeTakeFirst();
  },
  receipt(trx: Transaction, envelopeId: string): Promise<AgentEnvelopeReceiptRow | undefined> {
    return trx.selectFrom('agent_envelope_receipt').selectAll().where('envelope_id', '=', envelopeId).executeTakeFirst();
  },
};

export const negotiationSessions = {
  get(trx: Transaction, id: string): Promise<NegotiationSessionRow | undefined> {
    return trx.selectFrom('negotiation_session').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction): Promise<NegotiationSessionRow[]> {
    return trx.selectFrom('negotiation_session').selectAll().orderBy('updated_at', 'desc').orderBy('id').limit(100).execute();
  },
};

export const escalations = {
  list(trx: Transaction, status: 'open' | 'all' = 'open'): Promise<AgentEscalationRow[]> {
    let query = trx.selectFrom('agent_escalation').selectAll();
    if (status === 'open') query = query.where('status', '=', 'open');
    return query.orderBy('created_at', 'desc').orderBy('id').limit(200).execute();
  },
  resolve(trx: Transaction, id: string, status: 'resolved' | 'dismissed'): Promise<AgentEscalationRow> {
    return first(sql<AgentEscalationRow>`SELECT * FROM trustwork.agents_resolve_escalation(${id}::uuid, ${status})`.execute(trx), 'agents_resolve_escalation');
  },
};

/** Worker entry points (trustwork_worker): idempotent sweeps that only narrow. */
export const agentsWorker = {
  async expireSessions(trx: Transaction, limit = 100): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.agents_expire_sessions(${limit}::integer) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
  async lapseReconfirmations(trx: Transaction, limit = 100): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.agents_lapse_reconfirmations(${limit}::integer) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
};
