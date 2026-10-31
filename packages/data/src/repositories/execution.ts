import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { AppealRow } from '../schema/admin.js';
import type {
  DefectSeverityValue, DisputeAppealDecisionValue, DisputeDecisionValue, DisputeTargetKindValue, ExecutionClaimKindValue, ExecutionClaimRow, ExecutionConfirmationRow,
  ExecutionDecisionValue, ExecutionDefectRow, ExecutionDisputeRow, ExecutionEvidenceKindValue, ExecutionEvidenceRow, ExecutionVia, PerformanceObservationRow, ReputationSnapshotRow,
  ReviewResponseRow, ReviewRow, ReviewSideValue,
} from '../schema/execution.js';
import type { AgreementRow, ObligationRow } from '../schema/transactions.js';

/**
 * Execution and trust repository (EXE-001). Thin typed access under `withPrincipal`: row security limits every read
 * and write to the two parties of the agreement (the subject for snapshots), and the guards in
 * packages/data/migrations/execution check who may claim, confirm, report, dispute and review, serialize claims and
 * decisions per obligation, and keep every record append-only. Observations are written only by
 * `trustwork.execution_observe`; staff decisions only by the owner-run dispute commands (DATA-002 elevation and audit).
 * Nothing here reads a billing table.
 */
const json = (value: unknown): string => JSON.stringify(value);
type PartyColumns = { person: string | null; company: string | null };
/** DATA-002 staff command context (elevation, request id, reason). */
export interface StaffCommandContext { elevationId: string; requestId: string; reasonCode: string; reasonText: string; clientFingerprintHash?: string }

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}
const subjectIs = (party: PartyColumns) => (party.person
  ? sql<boolean>`subject_person_id = ${party.person}::uuid`
  : sql<boolean>`subject_company_id = ${party.company}::uuid`);

/* ---------- Agreements as execution contexts ---------- */

export const executionAgreements = {
  get(trx: Transaction, id: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('id', '=', id).executeTakeFirst();
  },
  async side(trx: Transaction, id: string): Promise<'buyer' | 'seller' | null> {
    const { rows } = await sql<{ side: 'buyer' | 'seller' | null }>`SELECT trustwork.agreement_side(${id}::uuid) AS side`.execute(trx);
    return rows[0]?.side ?? null;
  },
  obligations(trx: Transaction, agreementId: string): Promise<ObligationRow[]> {
    return trx.selectFrom('obligation').selectAll().where('agreement_id', '=', agreementId).orderBy('position').execute();
  },
  /** Live deliver and perform obligations the party owes (for "missing data", never counted as failure). */
  owedBy(trx: Transaction, party: PartyColumns): Promise<ObligationRow[]> {
    let q = trx.selectFrom('obligation').selectAll().where('status', '<>', 'waived');
    q = party.person ? q.where('obligor_person_id', '=', party.person) : q.where('obligor_company_id', '=', party.company);
    return q.orderBy('created_at').orderBy('id').limit(2000).execute();
  },
  async completed(trx: Transaction, agreementId: string): Promise<boolean> {
    const { rows } = await sql<{ done: boolean }>`SELECT trustwork.execution_agreement_completed(${agreementId}::uuid) AS done`.execute(trx);
    return rows[0]?.done === true;
  },
  /** Materializes the agreement's observations (idempotent); returns the number of new rows. */
  async observe(trx: Transaction, agreementId: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.execution_observe(${agreementId}::uuid) AS n`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  },
  async timingFacts(trx: Transaction, agreementId: string): Promise<{ change_id: string; cause: string; accountable_person_id: string | null; accountable_company_id: string | null; schedule_impact_days: number | null; decided_at: Date }[]> {
    const { rows } = await sql<{ change_id: string; cause: string; accountable_person_id: string | null; accountable_company_id: string | null; schedule_impact_days: number | null; decided_at: Date }>`
      SELECT * FROM trustwork.execution_timing_facts(${agreementId}::uuid)`.execute(trx);
    return rows;
  },
  async artifactDigest(trx: Transaction, artifactId: string, agreementId: string): Promise<string | null> {
    const { rows } = await sql<{ sha: string | null }>`SELECT trustwork.execution_artifact_digest(${artifactId}::uuid, ${agreementId}::uuid) AS sha`.execute(trx);
    return rows[0]?.sha ?? null;
  },
};

/* ---------- Claims, evidence, confirmations, defects ---------- */

export interface ClaimInsert {
  agreement_id: string; obligation_id: string | null; defect_id: string | null; kind: ExecutionClaimKindValue; claimant_person_id: string | null; claimant_company_id: string | null;
  lines: unknown[]; period_from: string | null; period_to: string | null; performed_at: Date; statement: string | null; supersedes_claim_id: string | null;
  recorded_by_person_id: string; via: ExecutionVia; mandate_id: string | null;
}
export const executionClaims = {
  insert(trx: Transaction, row: ClaimInsert): Promise<ExecutionClaimRow> {
    return trx.insertInto('execution_claim').values({ ...row, lines: json(row.lines) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ExecutionClaimRow | undefined> {
    return trx.selectFrom('execution_claim').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ExecutionClaimRow[]> {
    return trx.selectFrom('execution_claim').selectAll().where('agreement_id', '=', agreementId).orderBy('created_at').orderBy('id').execute();
  },
};

export interface EvidenceInsert {
  agreement_id: string; claim_id: string | null; defect_id: string | null; artifact_id: string; artifact_sha256: string; kind: ExecutionEvidenceKindValue; observed_at: Date | null;
  note: string | null; attached_by_person_id: string; via: ExecutionVia; mandate_id: string | null;
}
export const executionEvidence = {
  insert(trx: Transaction, row: EvidenceInsert): Promise<ExecutionEvidenceRow> {
    return trx.insertInto('execution_evidence').values(row).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ExecutionEvidenceRow[]> {
    return trx.selectFrom('execution_evidence').selectAll().where('agreement_id', '=', agreementId).orderBy('created_at').orderBy('id').execute();
  },
};

export interface ConfirmationInsert {
  claim_id: string; agreement_id: string; decision: ExecutionDecisionValue; lines: unknown[]; note: string | null; stage_code: string | null; decided_by_person_id: string;
  on_behalf_person_id: string | null; on_behalf_company_id: string | null;
}
export const executionConfirmations = {
  insert(trx: Transaction, row: ConfirmationInsert): Promise<ExecutionConfirmationRow> {
    return trx.insertInto('execution_confirmation').values({ ...row, lines: json(row.lines) }).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ExecutionConfirmationRow[]> {
    return trx.selectFrom('execution_confirmation').selectAll().where('agreement_id', '=', agreementId).orderBy('decided_at').orderBy('id').execute();
  },
};

export interface DefectInsert {
  agreement_id: string; obligation_id: string | null; claim_id: string | null; reporter_person_id: string | null; reporter_company_id: string | null; reported_by_person_id: string;
  via: ExecutionVia; mandate_id: string | null; severity: DefectSeverityValue; location: string | null; description: string; observed_at: Date;
}
export const executionDefects = {
  insert(trx: Transaction, row: DefectInsert): Promise<ExecutionDefectRow> {
    return trx.insertInto('execution_defect').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ExecutionDefectRow | undefined> {
    return trx.selectFrom('execution_defect').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ExecutionDefectRow[]> {
    return trx.selectFrom('execution_defect').selectAll().where('agreement_id', '=', agreementId).orderBy('created_at').orderBy('id').execute();
  },
  listAbout(trx: Transaction, party: PartyColumns): Promise<ExecutionDefectRow[]> {
    return trx.selectFrom('execution_defect').selectAll().where(subjectIs(party)).orderBy('created_at').orderBy('id').limit(5000).execute();
  },
  /** Remediation claims of the given defects with their decisions (resolution is an accepted remediation). */
  async remediations(trx: Transaction, defectIds: readonly string[]): Promise<{ defect_id: string; claim_id: string; decision: ExecutionDecisionValue | null; superseded: boolean }[]> {
    if (!defectIds.length) return [];
    const { rows } = await sql<{ defect_id: string; claim_id: string; decision: ExecutionDecisionValue | null; superseded: boolean }>`
      SELECT c.defect_id, c.id AS claim_id, f.decision, EXISTS (SELECT 1 FROM trustwork.execution_claim s WHERE s.supersedes_claim_id = c.id) AS superseded
      FROM trustwork.execution_claim c LEFT JOIN trustwork.execution_confirmation f ON f.claim_id = c.id
      WHERE c.defect_id = ANY (${sql.val(defectIds)}::uuid[])`.execute(trx);
    return rows;
  },
};

/* ---------- Disputes ---------- */

export interface DisputeInsert {
  agreement_id: string; hub_id: string; target_kind: DisputeTargetKindValue; target_id: string; opened_by_person_id: string; opener_person_id: string | null; opener_company_id: string | null; reason: string;
}
export const executionDisputes = {
  insert(trx: Transaction, row: DisputeInsert): Promise<ExecutionDisputeRow> {
    return trx.insertInto('execution_dispute').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ExecutionDisputeRow | undefined> {
    return trx.selectFrom('execution_dispute').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ExecutionDisputeRow[]> {
    return trx.selectFrom('execution_dispute').selectAll().where('agreement_id', '=', agreementId).orderBy('created_at').orderBy('id').execute();
  },
  /** Disputes on the given targets (confirmations or defects) the caller may read. */
  listForTargets(trx: Transaction, kind: DisputeTargetKindValue, ids: readonly string[]): Promise<ExecutionDisputeRow[]> {
    if (!ids.length) return Promise.resolve([]);
    return trx.selectFrom('execution_dispute').selectAll().where('target_kind', '=', kind).where('target_id', 'in', [...ids]).execute();
  },
  /** A party appeals the decision once (expected revision). */
  appeal(trx: Transaction, id: string, expectedRevision: number, input: { personId: string; reason: string; at: Date }): Promise<ExecutionDisputeRow | undefined> {
    return trx.updateTable('execution_dispute').set({ status: 'appealed', appealed_by_person_id: input.personId, appeal_reason: input.reason, appealed_at: input.at })
      .where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  /** Staff (admin.trust.evidence.decide at the dispute's hub, no conflict of interest), audited by DATA-002. */
  decide(trx: Transaction, ctx: StaffCommandContext, id: string, decision: DisputeDecisionValue): Promise<ExecutionDisputeRow> {
    return one(sql<ExecutionDisputeRow>`SELECT * FROM trustwork.execution_decide_dispute(${json(ctx)}::jsonb, ${id}::uuid, ${decision})`, trx, 'execution_decide_dispute');
  },
  /** Staff (admin.trust.appeals.decide), never the original decider. */
  decideAppeal(trx: Transaction, ctx: StaffCommandContext, id: string, decision: DisputeAppealDecisionValue): Promise<ExecutionDisputeRow> {
    return one(sql<ExecutionDisputeRow>`SELECT * FROM trustwork.execution_decide_dispute_appeal(${json(ctx)}::jsonb, ${id}::uuid, ${decision})`, trx, 'execution_decide_dispute_appeal');
  },
};

/* ---------- Observations ---------- */

export const performanceObservations = {
  listFor(trx: Transaction, agreementId: string): Promise<PerformanceObservationRow[]> {
    return trx.selectFrom('performance_observation').selectAll().where('agreement_id', '=', agreementId).orderBy('created_at').orderBy('id').execute();
  },
  listAbout(trx: Transaction, party: PartyColumns): Promise<PerformanceObservationRow[]> {
    return trx.selectFrom('performance_observation').selectAll().where(subjectIs(party)).orderBy('created_at').orderBy('id').limit(10000).execute();
  },
  get(trx: Transaction, id: string): Promise<PerformanceObservationRow | undefined> {
    return trx.selectFrom('performance_observation').selectAll().where('id', '=', id).executeTakeFirst();
  },
};

/* ---------- Reviews ---------- */

export interface ReviewInsert {
  agreement_id: string; author_side: ReviewSideValue; author_person_id: string | null; author_company_id: string | null; subject_person_id: string | null; subject_company_id: string | null;
  written_by_person_id: string; ratings: Record<string, number>; text: string | null; language: string | null; corrects_review_id: string | null;
}
export const reviews = {
  insert(trx: Transaction, row: ReviewInsert): Promise<ReviewRow> {
    return trx.insertInto('review').values({ ...row, ratings: json(row.ratings) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ReviewRow | undefined> {
    return trx.selectFrom('review').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ReviewRow[]> {
    return trx.selectFrom('review').selectAll().where('agreement_id', '=', agreementId).orderBy('created_at').orderBy('id').execute();
  },
  listAbout(trx: Transaction, party: PartyColumns): Promise<ReviewRow[]> {
    return trx.selectFrom('review').selectAll().where(subjectIs(party)).orderBy('created_at').orderBy('id').limit(5000).execute();
  },
  /** TASK-001 reviews about the party (tied to completed tasks), read alongside to avoid counting a side twice. */
  async taskReviewsAbout(trx: Transaction, party: PartyColumns): Promise<{ id: string; agreement_id: string; author_side: 'owner' | 'assignee'; rating: number; created_at: Date }[]> {
    const where = party.person ? sql`tr.subject_person_id = ${party.person}::uuid` : sql`tr.subject_company_id = ${party.company}::uuid`;
    const { rows } = await sql<{ id: string; agreement_id: string; author_side: 'owner' | 'assignee'; rating: number; created_at: Date }>`
      SELECT tr.id, t.agreement_id, tr.author_side, tr.rating, tr.created_at FROM trustwork.task_review tr JOIN trustwork.task_assignment t ON t.id = tr.assignment_id
      WHERE ${where} ORDER BY tr.created_at, tr.id LIMIT 5000`.execute(trx);
    return rows;
  },
};

export const reviewResponses = {
  insert(trx: Transaction, row: { review_id: string; agreement_id: string; responder_person_id: string | null; responder_company_id: string | null; written_by_person_id: string; text: string }): Promise<ReviewResponseRow> {
    return trx.insertInto('review_response').values(row).returningAll().executeTakeFirstOrThrow();
  },
  listFor(trx: Transaction, agreementId: string): Promise<ReviewResponseRow[]> {
    return trx.selectFrom('review_response').selectAll().where('agreement_id', '=', agreementId).orderBy('created_at').execute();
  },
};

/* ---------- Appeals (DATA-002 `appeal`) ---------- */

export const trustAppeals = {
  /** The reviewed or observed party appeals; decided later by admin_decide_appeal (a different person). */
  file(trx: Transaction, input: { hubId: string; subjectKind: 'review' | 'performance_observation'; subjectId: string; reason: string }): Promise<AppealRow> {
    return one(sql<AppealRow>`SELECT * FROM trustwork.trust_file_appeal(${input.hubId}::uuid, ${input.subjectKind}, ${input.subjectId}::uuid, ${input.reason})`, trx, 'trust_file_appeal');
  },
  async states(trx: Transaction, kind: 'review' | 'performance_observation', ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const { rows } = await sql<{ subject_id: string; status: string }>`SELECT * FROM trustwork.trust_appeal_states(${kind}, ${sql.val(ids)}::uuid[])`.execute(trx);
    return new Map(rows.map((r) => [r.subject_id, r.status]));
  },
};

/* ---------- Snapshots ---------- */

export interface SnapshotInsert {
  subject_person_id: string | null; subject_company_id: string | null; method_version: string; method_digest: string; summary: unknown; public_summary: unknown; explanation: unknown;
  inputs_digest: string; computed_by_person_id: string;
}
export interface PublicSnapshotRow { id: string; method_version: string; method_digest: string; public_summary: unknown; computed_at: Date; newer_evidence: boolean }
export const reputationSnapshots = {
  insert(trx: Transaction, row: SnapshotInsert): Promise<ReputationSnapshotRow> {
    return trx.insertInto('reputation_snapshot').values({ ...row, summary: json(row.summary), public_summary: json(row.public_summary), explanation: json(row.explanation) })
      .returningAll().executeTakeFirstOrThrow();
  },
  latestOwn(trx: Transaction, party: PartyColumns): Promise<ReputationSnapshotRow | undefined> {
    return trx.selectFrom('reputation_snapshot').selectAll().where(subjectIs(party)).orderBy('computed_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  },
  /** Anyone: the masked public summary of the latest snapshot. */
  async latestPublic(trx: Transaction, party: PartyColumns): Promise<PublicSnapshotRow | undefined> {
    const { rows } = await sql<PublicSnapshotRow>`SELECT * FROM trustwork.trust_public_snapshot(${party.person}::uuid, ${party.company}::uuid)`.execute(trx);
    return rows[0];
  },
};
