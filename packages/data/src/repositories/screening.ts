import { sql } from 'kysely';
import {
  QUEUED_MATCH_STATES, reviewDueAt, ScreeningMatchSchema, ScreeningQueueItemSchema, ScreeningStateSchema,
  type ScreeningEvidenceCategory, type ScreeningHoldReason, type ScreeningMatchState, type ScreeningMatchView, type ScreeningOutcome, type ScreeningQueueItem,
  type ScreeningSecondPersonAction, type ScreeningState, type ScreeningSubjectRef, type ScreeningTrigger,
} from '../../../contracts/src/sanctions.js';
import type { DataPool, Transaction } from '../pool.js';
import type { ScreeningDecisionRow, ScreeningMatchRow, ScreeningReportDraftRow, ScreeningSubjectStateRow } from '../schema/screening.js';
import type { CommandContext } from './admin.js';

/**
 * Screening repository (SANC-003, migration packages/data/migrations/screening; ADR 014 decisions 11 to 17).
 *
 * - **Worker ports** (`screeningWorker`, worker role, inside the job transaction): the subject's names, whether a
 *   trigger should screen now, the active list versions, candidate entries, recording a result (the database rechecks
 *   every match and refuses a `clear` that is not against the active baseline versions) and the nightly sweep.
 * - **Gate port** (`screeningStates.state`): the effective `screeningState(subject)` for SANC-004. Fails closed: a
 *   caller that cannot read it must refuse.
 * - **Subject ports** (`screeningSubjects`): the caller's own status words and the appeal (fresh step-up in the API).
 * - **Staff ports** (`screeningStaff`, compliance officer of the node with a `CommandContext` of a BE-004 elevation):
 *   the queue, matches with their decisions, report drafts, and the decisions themselves.
 */

const hash = (hex: string): Buffer => Buffer.from(hex, 'hex');
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const subjectOf = (row: { subject_person_id: string | null; subject_company_id: string | null }): ScreeningSubjectRef =>
  row.subject_person_id ? { kind: 'person', id: row.subject_person_id } : { kind: 'company', id: row.subject_company_id as string };

export interface CandidateRow {
  listCode: string;
  listVersionId: string;
  entryUid: string;
  entryType: 'individual' | 'entity' | 'vessel' | 'aircraft';
  primaryName: string;
  programs: string[];
  nameKeys: string[];
  entryDigest: string;
}

export interface RecordMatch {
  listCode: string;
  listVersionId: string;
  entryUid: string;
  matchedKey: string;
  screenedName: string;
  rule: 'engine' | 'fuzzy';
  score: number | null;
}

export interface RecordedResult {
  resultId: string;
  outcome: ScreeningOutcome;
  opened: number;
  stateId: string;
  moneyHeld: boolean;
}

export const screeningWorker = {
  /** The subject's current names and the digest of them (raises `screening.subject_not_found`). */
  async subjectNames(trx: Transaction, subject: ScreeningSubjectRef): Promise<{ names: string[]; namesDigest: string }> {
    const { rows } = await sql<{ names: string[] | null; names_digest: string }>`SELECT * FROM trustwork.screening_subject_names(${subject.kind}::text, ${subject.id}::uuid)`.execute(trx);
    const row = rows[0] as { names: string[] | null; names_digest: string };
    return { names: (row.names ?? []).filter((n) => typeof n === 'string'), namesDigest: row.names_digest };
  },
  /** False while a screening job of the subject waits; with `force` false, true only when names or list versions changed. */
  async shouldScreen(trx: Transaction, subject: ScreeningSubjectRef, force: boolean): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.screening_should_screen(${subject.kind}::text, ${subject.id}::uuid, ${force}::boolean) AS v`.execute(trx);
    return rows[0]?.v === true;
  },
  /** Active versions of the active lists and whether screening is available (every baseline list fresh). */
  async listsNow(trx: Transaction): Promise<{ available: boolean; versions: { listCode: string; baseline: boolean; versionId: string }[] }> {
    const { rows } = await sql<{ list_code: string; baseline: boolean; version_id: string; available: boolean }>`SELECT * FROM trustwork.screening_lists_now()`.execute(trx);
    let available = rows.length > 0 && rows.every((r) => r.available);
    if (rows.length === 0) {
      const { rows: a } = await sql<{ v: boolean }>`SELECT trustwork.screening_available() AS v`.execute(trx);
      available = a[0]?.v === true;
    }
    return { available, versions: rows.map((r) => ({ listCode: r.list_code, baseline: r.baseline, versionId: r.version_id })) };
  },
  /** Entries of the active versions of the given types that share a name-key token (or, for the fuzzy layer, an initial). */
  async candidates(trx: Transaction, input: { entryTypes: readonly string[]; tokens: readonly string[]; initials: readonly string[] }): Promise<CandidateRow[]> {
    const { rows } = await sql<{ list_code: string; list_version_id: string; entry_uid: string; entry_type: CandidateRow['entryType']; primary_name: string; programs: string[]; name_keys: string[]; entry_digest: string }>`
      SELECT * FROM trustwork.screening_candidates(${[...input.entryTypes]}::text[], ${[...input.tokens]}::text[], ${[...input.initials]}::text[])`.execute(trx);
    return rows.map((r) => ({ listCode: r.list_code, listVersionId: r.list_version_id, entryUid: r.entry_uid, entryType: r.entry_type, primaryName: r.primary_name, programs: r.programs, nameKeys: r.name_keys, entryDigest: r.entry_digest }));
  },
  async recordResult(trx: Transaction, input: {
    subject: ScreeningSubjectRef; trigger: ScreeningTrigger; namesDigest: string; listVersionIds: readonly string[]; outcome: ScreeningOutcome; matcherVersion: string;
    fuzzyThreshold: number | null; screenedNamesDigest: string; matches: readonly RecordMatch[];
  }): Promise<RecordedResult> {
    const { rows } = await sql<{ v: RecordedResult }>`SELECT trustwork.screening_record_result(${input.subject.kind}::text, ${input.subject.id}::uuid, ${input.trigger}::text, ${input.namesDigest}::text,
      ${[...input.listVersionIds]}::uuid[], ${input.outcome}::text, ${input.matcherVersion}::text, ${input.fuzzyThreshold}::numeric, ${input.screenedNamesDigest}::text,
      ${JSON.stringify(input.matches)}::jsonb) AS v`.execute(trx);
    return rows[0]?.v as RecordedResult;
  },
  /** Subjects never screened or renamed since, without a waiting screening job (the nightly safety net). */
  async sweepDue(trx: Transaction, limit: number): Promise<ScreeningSubjectRef[]> {
    const { rows } = await sql<{ kind: 'person' | 'company'; id: string }>`SELECT * FROM trustwork.screening_sweep_due(${limit}::integer)`.execute(trx);
    return rows.map((r) => ({ kind: r.kind, id: r.id }));
  },
};

interface EffectiveRow { money_held: boolean; suspended: boolean; reasons: string[]; last_outcome: ScreeningOutcome | null; last_screened_at: Date | null }
const stateOf = (subject: ScreeningSubjectRef, row: EffectiveRow, checkedAt: Date): ScreeningState => ScreeningStateSchema.parse({
  subject, moneyHeld: row.money_held, suspended: row.suspended, reasons: [...new Set(row.reasons as ScreeningHoldReason[])],
  lastOutcome: row.last_outcome, lastScreenedAt: iso(row.last_screened_at), checkedAt: checkedAt.toISOString(),
});

export const screeningStates = {
  /** The effective screening state of a subject (the gates' port). Raises when the subject does not exist. */
  async state(trx: Transaction, subject: ScreeningSubjectRef, now: Date = new Date()): Promise<ScreeningState> {
    const { rows } = await sql<EffectiveRow>`SELECT * FROM trustwork.screening_state(${subject.kind}::text, ${subject.id}::uuid)`.execute(trx);
    return stateOf(subject, rows[0] as EffectiveRow, now);
  },
  /** Inside the principal transaction of the person being signed in: is the caller suspended by a confirmed match? */
  async callerSuspended(trx: Transaction): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.screening_caller_suspended() AS v`.execute(trx);
    return rows[0]?.v === true;
  },
  /** Per request, on the pool: is the person of this live session suspended? */
  async sessionSuspended(pool: DataPool, tokenHashHex: string): Promise<boolean> {
    const { rows } = await pool.query<{ v: boolean }>('SELECT trustwork.screening_session_suspended($1) AS v', [hash(tokenHashHex)]);
    return rows[0]?.v === true;
  },
};

export const screeningSubjects = {
  /** The caller's own effective state (or a company they administer) and whether a confirmed decision can be appealed. */
  async own(trx: Transaction, companyId: string | null, now: Date = new Date()): Promise<{ state: ScreeningState; appealable: boolean }> {
    const { rows } = await sql<EffectiveRow & { subject_kind: 'person' | 'company'; subject_id: string; appealable: boolean }>`SELECT * FROM trustwork.screening_own_status(${companyId}::uuid)`.execute(trx);
    const row = rows[0] as EffectiveRow & { subject_kind: 'person' | 'company'; subject_id: string; appealable: boolean };
    return { state: stateOf({ kind: row.subject_kind, id: row.subject_id }, row, now), appealable: row.appealable };
  },
  /** Appeals every confirmed decision of the caller's account (or a company they administer); returns how many. */
  async appeal(trx: Transaction, input: { companyId: string | null; reason: string }): Promise<number> {
    const { rows } = await sql<{ v: number }>`SELECT trustwork.screening_file_appeal(${input.companyId}::uuid, ${input.reason}::text) AS v`.execute(trx);
    return Number(rows[0]?.v ?? 0);
  },
};

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** The staff view of a match with its open second-person request (read from the decision trail, readable by reviewers). */
export function matchView(row: ScreeningMatchRow, decisions: readonly ScreeningDecisionRow[]): ScreeningMatchView {
  const proposal = [...decisions].filter((d) => d.match_id === row.id && (d.kind === 'propose_not_same_person' || d.kind === 'propose_reversal')).sort((a, b) => Number(b.seq) - Number(a.seq))[0];
  const pending = (row.state === 'pending_second' || row.state === 'pending_reversal') && proposal && proposal.second_person_approval_id && proposal.approval_digest
    ? {
      id: proposal.second_person_approval_id, action: (proposal.kind === 'propose_reversal' ? 'screening.reverse_confirmation' : 'screening.clear_match') as ScreeningSecondPersonAction,
      actionDigest: proposal.approval_digest, requestedBy: proposal.decided_by, requestExpiresAt: new Date(proposal.decided_at.getTime() + 7 * 86_400_000).toISOString(),
    }
    : null;
  return ScreeningMatchSchema.parse({
    id: row.id, subject: subjectOf(row), listCode: row.list_code, listVersionId: row.list_version_id, entryUid: row.entry_uid, entryType: row.entry_type, entryName: row.entry_name,
    programs: row.programs, matchedKey: row.matched_key, screenedName: row.screened_name, rule: row.rule, score: num(row.score), state: row.state,
    openedAt: row.opened_at.toISOString(), decidedAt: iso(row.decided_at), revision: row.revision, pendingApproval: pending,
  });
}

export const screeningStaff = {
  /** Exact lookup in the existing staff-only state table, with no participant/profile join or bypass of RLS. */
  subjectStateFor(trx: Transaction, subject: ScreeningSubjectRef): Promise<ScreeningSubjectStateRow | undefined> {
    return trx.selectFrom('screening_subject_state').selectAll()
      .where(subject.kind === 'person' ? 'subject_person_id' : 'subject_company_id', '=', subject.id).executeTakeFirst();
  },
  /** One queue item per subject with matches waiting for a reviewer, oldest first; late after the service level. */
  async queue(trx: Transaction, input: { serviceLevelDays: number; now: Date; limit?: number }): Promise<ScreeningQueueItem[]> {
    const rows = await trx.selectFrom('screening_match as m')
      .innerJoin('screening_subject_state as s', (join) => join.on((eb) => eb.or([eb('s.subject_person_id', '=', eb.ref('m.subject_person_id')), eb('s.subject_company_id', '=', eb.ref('m.subject_company_id'))])))
      .select(['s.id as state_id', 's.subject_person_id', 's.subject_company_id', 'm.state', 'm.opened_at'])
      .where('m.state', 'in', [...QUEUED_MATCH_STATES])
      .orderBy('m.opened_at').limit(input.limit ?? 2000).execute();
    const items = new Map<string, { subject: ScreeningSubjectRef; openedAt: Date; waiting: number; states: Set<ScreeningMatchState> }>();
    for (const r of rows) {
      const item = items.get(r.state_id) ?? { subject: subjectOf(r), openedAt: r.opened_at, waiting: 0, states: new Set<ScreeningMatchState>() };
      if (r.opened_at < item.openedAt) item.openedAt = r.opened_at;
      item.waiting += 1;
      item.states.add(r.state);
      items.set(r.state_id, item);
    }
    return [...items.entries()].map(([stateId, item]) => {
      const due = reviewDueAt(item.openedAt, input.serviceLevelDays);
      return ScreeningQueueItemSchema.parse({
        subjectStateId: stateId, subject: item.subject, openedAt: item.openedAt.toISOString(), dueAt: due.toISOString(), late: input.now.getTime() > due.getTime(),
        waiting: item.waiting, states: [...item.states].sort(),
      });
    }).sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1));
  },
  /** The subject state row (compliance staff only). */
  subjectState(trx: Transaction, stateId: string): Promise<ScreeningSubjectStateRow | undefined> {
    return trx.selectFrom('screening_subject_state').selectAll().where('id', '=', stateId).executeTakeFirst();
  },
  async matchesOf(trx: Transaction, subject: ScreeningSubjectRef): Promise<ScreeningMatchView[]> {
    const column = subject.kind === 'person' ? 'subject_person_id' : 'subject_company_id';
    const rows = await trx.selectFrom('screening_match').selectAll().where(column, '=', subject.id).orderBy('opened_at').orderBy('id').execute();
    const decisions = rows.length ? await trx.selectFrom('screening_decision').selectAll().where('match_id', 'in', rows.map((r) => r.id)).orderBy('seq').execute() : [];
    return rows.map((r) => matchView(r, decisions));
  },
  async match(trx: Transaction, matchId: string): Promise<ScreeningMatchView | null> {
    const row = await trx.selectFrom('screening_match').selectAll().where('id', '=', matchId).executeTakeFirst();
    if (!row) return null;
    return matchView(row, await this.decisions(trx, matchId));
  },
  decisions(trx: Transaction, matchId: string): Promise<ScreeningDecisionRow[]> {
    return trx.selectFrom('screening_decision').selectAll().where('match_id', '=', matchId).orderBy('seq').execute();
  },
  reportDrafts(trx: Transaction, limit = 200): Promise<ScreeningReportDraftRow[]> {
    return trx.selectFrom('screening_report_draft').selectAll().orderBy('prepared_at', 'desc').limit(limit).execute();
  },
  async confirm(trx: Transaction, ctx: CommandContext, input: { matchId: string; reason: string; evidence: ScreeningEvidenceCategory }): Promise<ScreeningMatchRow> {
    const { rows } = await sql<ScreeningMatchRow>`SELECT * FROM trustwork.screening_confirm_match(${JSON.stringify(ctx)}::jsonb, ${input.matchId}::uuid, ${input.reason}::text, ${input.evidence}::text)`.execute(trx);
    return rows[0] as ScreeningMatchRow;
  },
  async proposeNotSamePerson(trx: Transaction, ctx: CommandContext, input: { matchId: string; reason: string; evidence: ScreeningEvidenceCategory }): Promise<ScreeningMatchRow> {
    const { rows } = await sql<ScreeningMatchRow>`SELECT * FROM trustwork.screening_propose_not_same_person(${JSON.stringify(ctx)}::jsonb, ${input.matchId}::uuid, ${input.reason}::text, ${input.evidence}::text)`.execute(trx);
    return rows[0] as ScreeningMatchRow;
  },
  async decideProposal(trx: Transaction, ctx: CommandContext, input: { matchId: string; decision: 'approve' | 'reject'; actionDigest: string; reason: string }): Promise<ScreeningMatchRow> {
    const { rows } = await sql<ScreeningMatchRow>`SELECT * FROM trustwork.screening_decide_proposal(${JSON.stringify(ctx)}::jsonb, ${input.matchId}::uuid, ${input.decision}::text, ${input.actionDigest}::text, ${input.reason}::text)`.execute(trx);
    return rows[0] as ScreeningMatchRow;
  },
  async decideAppeal(trx: Transaction, ctx: CommandContext, input: { matchId: string; decision: 'uphold' | 'propose_reversal'; reason: string; evidence: ScreeningEvidenceCategory }): Promise<ScreeningMatchRow> {
    const { rows } = await sql<ScreeningMatchRow>`SELECT * FROM trustwork.screening_decide_appeal(${JSON.stringify(ctx)}::jsonb, ${input.matchId}::uuid, ${input.decision}::text, ${input.reason}::text, ${input.evidence}::text)`.execute(trx);
    return rows[0] as ScreeningMatchRow;
  },
};
