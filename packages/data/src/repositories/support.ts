import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { AccountServiceActionColumn, AccountServiceActionRow, SupportDiagnosticSnapshotRow } from '../schema/support.js';
import type { CommandContext } from './admin.js';

/**
 * Support workspace persistence (SUP-001, packages/data/migrations/support). Staff calls run under `withPrincipal` as
 * the staff member with a DATA-002 `CommandContext` (a live BE-004 elevation, a request id and the staff reason); the
 * database checks the permission at the case's hub, the case, conflicts of interest, evidence, the second person and
 * the cooling-off, and writes the admin_audit_event row in the same transaction. Participant calls (the subject
 * cancelling a change of their own sign-in factors, a requester sharing diagnostics, the subject's own access records)
 * run under `withPrincipal` without elevation. Nothing here creates a session or acts as another person.
 */

/** Every column the runtime role may select (`new_email_normalized` is not granted; see `maskedEmail`). */
export const ACCOUNT_SERVICE_ACTION_COLUMNS = [
  'id', 'hub_id', 'support_case_id', 'subject_person_id', 'action', 'requested_by', 'requested_at', 'reason', 'evidence_refs', 'request_digest', 'approval_id', 'approved_by',
  'approved_at', 'effective_at', 'subject_notified', 'state', 'guided_task', 'second_factor_reset_id', 'cancelled_by', 'cancelled_at', 'executed_by', 'executed_at', 'revision',
  'updated_at',
] as const;
const ACTION_SQL = sql.raw(ACCOUNT_SERVICE_ACTION_COLUMNS.map((c) => `r.${c}`).join(', '));

const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const seconds = (value: number): string => `${Math.round(value)} seconds`;

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export type LookupKind = 'email' | 'person_id' | 'company_id' | 'legal_identifier' | 'name' | 'company_name';
export interface LookupRow { kind: 'person' | 'company'; id: string; display_name: string | null }
/** The jsonb account card exactly as `support_account_card` builds it (timestamps as PostgreSQL text). */
export type AccountCardJson = Record<string, unknown>;
export interface ExplainInputsJson {
  emailVerified: boolean;
  authzEpoch: number;
  membership: { companyId: string; membershipId: string; role: 'member' | 'administrator'; permissions: string[]; companyAuthzEpoch: number } | null;
  endedCompanies: string[];
  owner: { kind: 'person' | 'company'; id: string } | null;
  rows: Array<Record<string, unknown>>;
}
export type AddressPurpose = 'verified' | 'verification' | 'new_email';

export const supportAccess = {
  async exportOwn(trx: Transaction): Promise<Array<{ id: string; at: Date; kind: string; support_case_id: string | null }>> {
    const { rows } = await sql<{ id: string; at: Date; kind: string; support_case_id: string | null }>`SELECT * FROM trustwork.support_privacy_access_records()`.execute(trx);
    return rows;
  },
  /** admin.support.account.read: exact e-mail, ids, legal identifier, or a name prefix inside a case; recorded. */
  async lookup(trx: Transaction, ctx: CommandContext, input: { hubId: string; caseId: string | null; kind: LookupKind; value: string }): Promise<LookupRow[]> {
    const { rows } = await sql<LookupRow>`SELECT * FROM trustwork.support_lookup(${ctxJson(ctx)}::jsonb, ${input.hubId}::uuid, ${input.caseId}::uuid, ${input.kind}, ${input.value})`.execute(trx);
    return rows;
  },
  /** admin.support.account.read: the allowlisted account card of a party of the case; recorded. */
  async accountCard(trx: Transaction, ctx: CommandContext, caseId: string, personId: string, lockout: { threshold: number; windowSeconds: number }): Promise<AccountCardJson> {
    const row = await one(sql<{ card: AccountCardJson }>`SELECT trustwork.support_account_card(${ctxJson(ctx)}::jsonb, ${caseId}::uuid, ${personId}::uuid, ${lockout.threshold},
      ${seconds(lockout.windowSeconds)}::interval) AS card`, trx, 'support_account_card');
    return row.card;
  },
  /** admin.support.explain: the subject's policy facts on one resource; recorded. Never returned to a client as is. */
  async explainInputs(trx: Transaction, ctx: CommandContext, caseId: string, personId: string, resource: { kind: string; id: string }): Promise<ExplainInputsJson> {
    const row = await one(sql<{ inputs: ExplainInputsJson }>`SELECT trustwork.support_explain_inputs(${ctxJson(ctx)}::jsonb, ${caseId}::uuid, ${personId}::uuid, ${resource.kind},
      ${resource.id}::uuid) AS inputs`, trx, 'support_explain_inputs');
    return row.inputs;
  },
  /** The caller's own records: when support looked and for which case (never who). */
  async own(trx: Transaction): Promise<Array<{ id: string; at: Date; kind: string; support_case_id: string | null }>> {
    const { rows } = await sql<{ id: string; at: Date; kind: string; support_case_id: string | null }>`SELECT * FROM trustwork.support_own_access_records()`.execute(trx);
    return rows;
  },
};

export const serviceActions = {
  exportForSubject(trx: Transaction, personId: string): Promise<AccountServiceActionRow[]> {
    return trx.selectFrom('account_service_action').select(ACCOUNT_SERVICE_ACTION_COLUMNS).where('subject_person_id', '=', personId).orderBy('requested_at').orderBy('id').execute();
  },
  async request(trx: Transaction, ctx: CommandContext, input: {
    caseId: string; subjectPersonId: string; action: AccountServiceActionColumn; evidenceRefs: string[]; params: Record<string, unknown>;
  }): Promise<AccountServiceActionRow> {
    return one(sql<AccountServiceActionRow>`SELECT ${ACTION_SQL} FROM trustwork.support_request_action(${ctxJson(ctx)}::jsonb, ${input.caseId}::uuid, ${input.subjectPersonId}::uuid,
      ${input.action}, ${input.evidenceRefs}::uuid[], ${JSON.stringify(input.params)}::jsonb) r`, trx, 'support_request_action');
  },
  /** The requester consumes the approval: the cooling-off starts (at least 72 hours on the database clock). */
  async activate(trx: Transaction, ctx: CommandContext, actionId: string): Promise<AccountServiceActionRow> {
    return one(sql<AccountServiceActionRow>`SELECT ${ACTION_SQL} FROM trustwork.support_activate_action(${ctxJson(ctx)}::jsonb, ${actionId}::uuid) r`, trx, 'support_activate_action');
  },
  /** After the cooling-off, by the requester or the approver; a rebind needs the SHA-256 of the proof token it mails. */
  async execute(trx: Transaction, ctx: CommandContext, actionId: string, proof: { tokenHashHex: string; validForSeconds: number } | null): Promise<AccountServiceActionRow> {
    return one(sql<AccountServiceActionRow>`SELECT ${ACTION_SQL} FROM trustwork.support_execute_action(${ctxJson(ctx)}::jsonb, ${actionId}::uuid, ${proof?.tokenHashHex ?? null},
      ${proof ? seconds(proof.validForSeconds) : null}::interval) r`, trx, 'support_execute_action');
  },
  async cancel(trx: Transaction, ctx: CommandContext, actionId: string): Promise<AccountServiceActionRow> {
    return one(sql<AccountServiceActionRow>`SELECT ${ACTION_SQL} FROM trustwork.support_cancel_action(${ctxJson(ctx)}::jsonb, ${actionId}::uuid) r`, trx, 'support_cancel_action');
  },
  /** The subject cancels a change of their own sign-in factors. */
  async cancelOwn(trx: Transaction, actionId: string): Promise<AccountServiceActionRow> {
    return one(sql<AccountServiceActionRow>`SELECT ${ACTION_SQL} FROM trustwork.support_cancel_own_action(${actionId}::uuid) r`, trx, 'support_cancel_own_action');
  },
  async get(trx: Transaction, actionId: string): Promise<AccountServiceActionRow | undefined> {
    return trx.selectFrom('account_service_action').select(ACCOUNT_SERVICE_ACTION_COLUMNS).where('id', '=', actionId).executeTakeFirst();
  },
  async forCase(trx: Transaction, caseId: string): Promise<AccountServiceActionRow[]> {
    return trx.selectFrom('account_service_action').select(ACCOUNT_SERVICE_ACTION_COLUMNS).where('support_case_id', '=', caseId).orderBy('requested_at').orderBy('id').execute();
  },
  async forSubject(trx: Transaction, personId: string): Promise<AccountServiceActionRow[]> {
    return trx.selectFrom('account_service_action').select(ACCOUNT_SERVICE_ACTION_COLUMNS).where('subject_person_id', '=', personId).orderBy('requested_at', 'desc').limit(200).execute();
  },
  /** Addresses for the notices of an action (only its subject, requester and approver may ask). */
  async addresses(trx: Transaction, actionId: string, purpose: AddressPurpose): Promise<string[]> {
    const { rows } = await sql<{ address: string }>`SELECT a AS address FROM trustwork.support_action_addresses(${actionId}::uuid, ${purpose}) a`.execute(trx);
    return rows.map((r) => r.address);
  },
  /** The masked new address of a rebind (`sy***@example.org`), or null. */
  async maskedEmail(trx: Transaction, actionId: string): Promise<string | null> {
    const { rows } = await sql<{ masked: string | null }>`SELECT trustwork.support_action_masked_email(${actionId}::uuid) AS masked`.execute(trx);
    return rows[0]?.masked ?? null;
  },
};

export const diagnosticSnapshots = {
  /** The requester shares diagnostics into their own open case; objects must be ones they take part in. */
  async share(trx: Transaction, input: {
    caseId: string; pageId: string; appVersion: string; locale: string | null; featureFlags: string[]; errorCodes: string[]; requestIds: string[]; objects: Array<{ type: string; id: string }>;
  }): Promise<SupportDiagnosticSnapshotRow> {
    return one(sql<SupportDiagnosticSnapshotRow>`SELECT * FROM trustwork.support_share_diagnostics(${input.caseId}::uuid, ${input.pageId}, ${input.appVersion}, ${input.locale},
      ${input.featureFlags}::text[], ${input.errorCodes}::text[], ${input.requestIds}::text[], ${JSON.stringify(input.objects)}::jsonb)`, trx, 'support_share_diagnostics');
  },
  async forCase(trx: Transaction, caseId: string): Promise<SupportDiagnosticSnapshotRow[]> {
    return trx.selectFrom('support_diagnostic_snapshot').selectAll().where('support_case_id', '=', caseId).orderBy('created_at').orderBy('id').execute();
  },
};
