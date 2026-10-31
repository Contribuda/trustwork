import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { AppealRow } from '../schema/admin.js';
import type {
  AutomatedLimitationRow, ConfirmationContextKindValue, ConfirmationDecisionValue, ConfirmationRequestRow, ConfirmationResponseRow, ContributionRecordRow, CredentialCheckOutcomeValue,
  CredentialCheckRow, CredentialKindValue, PortfolioEntryRow, ProfessionalCredentialRow, RelationDeclarationRow, RelationKindValue, ReputationVisibilityValue, StatementKindValue,
  TimelinessObservationRow,
} from '../schema/reputation.js';

/**
 * Reputation builder repository (REP-001). Thin typed access under `withPrincipal`: row security limits every read
 * and write to the holder or subject (both sides for confirmation requests and responses), and the guards in
 * packages/data/migrations/reputation decide relationships, conflicts, the one-request and one-reminder rules and
 * deadlines. Contribution and timeliness records are written only by `trustwork.reputation_derive`, automated
 * limitations only by `trustwork.reputation_appeal_limitation`. Nothing here reads a billing table.
 */
export type PartyColumns = { person: string | null; company: string | null };

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}
const party = (prefix: 'holder' | 'subject' | 'requester' | 'addressed', p: PartyColumns) => (p.person
  ? sql<boolean>`${sql.ref(`${prefix}_person_id`)} = ${p.person}::uuid`
  : sql<boolean>`${sql.ref(`${prefix}_company_id`)} = ${p.company}::uuid`);

/* ---------- Credentials ---------- */

export interface CredentialInsert {
  holder_person_id: string | null; holder_company_id: string | null; kind: CredentialKindValue; jurisdiction: string; credential_type: string; issuer: string; number: string | null;
  classification: string | null; coverage_minor: string | null; coverage_currency: string | null; valid_from: string | null; valid_until: string | null; visibility: ReputationVisibilityValue;
  supersedes_id: string | null; recorded_by_person_id: string;
}
export const credentials = {
  insert(trx: Transaction, row: CredentialInsert): Promise<ProfessionalCredentialRow> {
    return trx.insertInto('professional_credential').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ProfessionalCredentialRow | undefined> {
    return trx.selectFrom('professional_credential').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, holder: PartyColumns): Promise<ProfessionalCredentialRow[]> {
    return trx.selectFrom('professional_credential').selectAll().where(party('holder', holder)).orderBy('created_at').orderBy('id').execute();
  },
  insertCheck(trx: Transaction, row: { credential_id: string; hub_id: string; register_code: string; outcome: CredentialCheckOutcomeValue; register_valid_until: string | null; source_ref: string | null; requested_by_person_id: string }): Promise<CredentialCheckRow> {
    return trx.insertInto('credential_check').values(row).returningAll().executeTakeFirstOrThrow();
  },
  async checks(trx: Transaction, credentialIds: readonly string[]): Promise<CredentialCheckRow[]> {
    if (!credentialIds.length) return [];
    return trx.selectFrom('credential_check').selectAll().where('credential_id', 'in', credentialIds).orderBy('checked_at').orderBy('id').execute();
  },
};

/* ---------- Portfolio ---------- */

export interface PortfolioInsert {
  holder_person_id: string | null; holder_company_id: string | null; context_kind: ConfirmationContextKindValue | null; context_id: string | null; external_description: string | null;
  title: string; role: string; period_from: string | null; period_to: string | null; scope_summary: string | null; visibility: ReputationVisibilityValue; supersedes_id: string | null;
  recorded_by_person_id: string;
}
export const portfolio = {
  insert(trx: Transaction, row: PortfolioInsert): Promise<PortfolioEntryRow> {
    return trx.insertInto('portfolio_entry').values(row).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, holder: PartyColumns): Promise<PortfolioEntryRow[]> {
    return trx.selectFrom('portfolio_entry').selectAll().where(party('holder', holder)).orderBy('created_at').orderBy('id').execute();
  },
};

/* ---------- Declared relationships ---------- */

export const relations = {
  insert(trx: Transaction, row: { declarer_person_id: string; other_person_id: string; kind: RelationKindValue }): Promise<RelationDeclarationRow> {
    return trx.insertInto('relation_declaration').values(row).returningAll().executeTakeFirstOrThrow();
  },
  listMine(trx: Transaction, personId: string): Promise<RelationDeclarationRow[]> {
    return trx.selectFrom('relation_declaration').selectAll().where('declarer_person_id', '=', personId).orderBy('declared_at').orderBy('id').execute();
  },
};

/* ---------- Confirmation requests and responses ---------- */

export interface RequestInsert {
  requester_person_id: string | null; requester_company_id: string | null; addressed_person_id: string | null; addressed_company_id: string | null;
  context_kind: ConfirmationContextKindValue; context_id: string; portfolio_entry_id: string | null; statement_kind: StatementKindValue; statement: string; no_incentive: boolean;
  no_conflict: boolean; requested_by_person_id: string;
}
export const confirmationRequests = {
  /** The guard sets the clock, the 30-day deadline and refuses what the rules forbid. */
  insert(trx: Transaction, row: RequestInsert): Promise<ConfirmationRequestRow> {
    return trx.insertInto('confirmation_request').values({ ...row, due_at: new Date(Date.now() + 86_400_000) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ConfirmationRequestRow | undefined> {
    return trx.selectFrom('confirmation_request').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listSent(trx: Transaction, requester: PartyColumns): Promise<ConfirmationRequestRow[]> {
    return trx.selectFrom('confirmation_request').selectAll().where(party('requester', requester)).orderBy('requested_at').orderBy('id').execute();
  },
  listAddressed(trx: Transaction, addressed: PartyColumns): Promise<ConfirmationRequestRow[]> {
    return trx.selectFrom('confirmation_request').selectAll().where(party('addressed', addressed)).orderBy('requested_at').orderBy('id').execute();
  },
  /** The single reminder (the guard stamps the time, refuses a second one, an early one or a closed request). */
  remind(trx: Transaction, id: string): Promise<ConfirmationRequestRow | undefined> {
    return trx.updateTable('confirmation_request').set({ reminder_sent_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirst();
  },
  withdraw(trx: Transaction, id: string): Promise<ConfirmationRequestRow | undefined> {
    return trx.updateTable('confirmation_request').set({ withdrawn_at: new Date() }).where('id', '=', id).returningAll().executeTakeFirst();
  },
};
export const confirmationResponses = {
  insert(trx: Transaction, row: {
    confirmation_request_id: string; responder_person_id: string; on_behalf_person_id: string | null; on_behalf_company_id: string | null; decision: ConfirmationDecisionValue;
    comment: string | null; consent_to_show: boolean; no_conflict: boolean;
  }): Promise<ConfirmationResponseRow> {
    return trx.insertInto('confirmation_response').values(row).returningAll().executeTakeFirstOrThrow();
  },
  async forRequests(trx: Transaction, requestIds: readonly string[]): Promise<ConfirmationResponseRow[]> {
    if (!requestIds.length) return [];
    return trx.selectFrom('confirmation_response').selectAll().where('confirmation_request_id', 'in', requestIds).execute();
  },
};

/* ---------- Derived records and limitations ---------- */

export const derivedRecords = {
  /** Materializes contribution and timeliness records of the subject from canonical records; idempotent. */
  async derive(trx: Transaction, subject: PartyColumns): Promise<number> {
    const row = await one(sql<{ n: number }>`SELECT trustwork.reputation_derive(${subject.person}::uuid, ${subject.company}::uuid) AS n`, trx, 'reputation_derive');
    return row.n;
  },
  contributions(trx: Transaction, holder: PartyColumns): Promise<ContributionRecordRow[]> {
    return trx.selectFrom('contribution_record').selectAll().where(party('holder', holder)).orderBy('occurred_at').orderBy('id').execute();
  },
  timeliness(trx: Transaction, subject: PartyColumns): Promise<TimelinessObservationRow[]> {
    return trx.selectFrom('timeliness_observation').selectAll().where(party('subject', subject)).orderBy('created_at').orderBy('id').execute();
  },
  limitations(trx: Transaction, subject: PartyColumns): Promise<AutomatedLimitationRow[]> {
    return trx.selectFrom('automated_limitation').selectAll().where(party('subject', subject)).orderBy('created_at').orderBy('id').execute();
  },
};

/* ---------- Appeals (DATA-002 queue) ---------- */

export interface LimitationAppealInput {
  hubId: string; reasonCode: string; scope: 'confirmation_request' | 'confirmation_response'; requester: PartyColumns | null; addressed: PartyColumns | null;
  contextKind: string | null; contextId: string | null; statementKind: string | null; requestId: string | null; reason: string;
}
export const reputationAppeals = {
  /** The requester appeals a counterparty's response (decided later by a different person). */
  file(trx: Transaction, input: { hubId: string; subjectKind: 'confirmation_response'; subjectId: string; reason: string }): Promise<AppealRow> {
    return one(sql<AppealRow>`SELECT * FROM trustwork.reputation_file_appeal(${input.hubId}::uuid, ${input.subjectKind}, ${input.subjectId}::uuid, ${input.reason})`, trx, 'reputation_file_appeal');
  },
  /** Re-evaluates a refusal, records the automated limitation and files its appeal. */
  appealLimitation(trx: Transaction, i: LimitationAppealInput): Promise<AppealRow> {
    return one(sql<AppealRow>`SELECT * FROM trustwork.reputation_appeal_limitation(${i.hubId}::uuid, ${i.reasonCode}, ${i.scope}, ${i.requester?.person ?? null}::uuid,
      ${i.requester?.company ?? null}::uuid, ${i.addressed?.person ?? null}::uuid, ${i.addressed?.company ?? null}::uuid, ${i.contextKind}, ${i.contextId}::uuid, ${i.statementKind},
      ${i.requestId}::uuid, ${i.reason})`, trx, 'reputation_appeal_limitation');
  },
  async states(trx: Transaction, kind: 'confirmation_response' | 'automated_limitation', ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const { rows } = await sql<{ subject_id: string; status: string }>`SELECT * FROM trustwork.reputation_appeal_states(${kind}, ${sql.val(ids)}::uuid[])`.execute(trx);
    return new Map(rows.map((r) => [r.subject_id, r.status]));
  },
};

/* ---------- Public reads ---------- */

export interface PublicCredentialRow {
  id: string; kind: CredentialKindValue; jurisdiction: string; credential_type: string; issuer: string; valid_until: Date | null; check_outcome: CredentialCheckOutcomeValue | null;
  checked_at: Date | null; check_hub_id: string | null; register_valid_until: Date | null;
}
export interface PublicPortfolioRow {
  id: string; title: string; role: string; period_from: Date | null; period_to: Date | null; scope_summary: string | null; external: boolean; confirmation: 'self_reported' | 'client_confirmed';
  confirmed_at: Date | null;
}
export const reputationPublic = {
  async credentials(trx: Transaction, p: PartyColumns): Promise<PublicCredentialRow[]> {
    const { rows } = await sql<PublicCredentialRow>`SELECT * FROM trustwork.reputation_public_credentials(${p.person}::uuid, ${p.company}::uuid)`.execute(trx);
    return rows;
  },
  async portfolio(trx: Transaction, p: PartyColumns): Promise<PublicPortfolioRow[]> {
    const { rows } = await sql<PublicPortfolioRow>`SELECT * FROM trustwork.reputation_public_portfolio(${p.person}::uuid, ${p.company}::uuid)`.execute(trx);
    return rows;
  },
};
