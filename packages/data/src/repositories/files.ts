import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { EvidenceArtifact, EvidenceClassification, EvidenceParentKind } from '../schema/kernel.js';
import type { FileArtifactState, FileDeletionMode, FileQuarantineReason } from '../schema/files.js';
import { evidenceArtifacts, type NewEvidenceInput } from './kernel.js';

/**
 * Files repository (FILE-001, migration packages/data/migrations/files). Two halves:
 *
 * - **Runtime ports** (`files`), used under `withPrincipal` by the API role: the pending artifact is inserted through the
 *   kernel insert policy (uploader, owner party, attach right and pending scan state checked by the database), and every
 *   other write goes through an owner-run `files_*` command that repeats those checks. Reads return only what the
 *   evidence policy lets the caller see, joined with the lifecycle state.
 * - **Worker ports** (`fileWorker`), used by the worker role, which has no table grant: scan targets and verdicts,
 *   deletion and erasure, tombstone replay and abandoned uploads, all through owner-run entry points.
 */

export type FileRow = EvidenceArtifact & { state: FileArtifactState | null };

async function withState(trx: Transaction, rows: EvidenceArtifact[]): Promise<FileRow[]> {
  if (rows.length === 0) return [];
  const states = await trx.selectFrom('file_artifact_state').selectAll().where('artifact_id', 'in', rows.map((r) => r.id)).execute();
  const byId = new Map(states.map((s) => [s.artifact_id, s]));
  return rows.map((row) => ({ ...row, state: byId.get(row.id) ?? null }));
}

const scalar = async <T>(trx: Transaction, query: ReturnType<typeof sql<{ v: T }>>): Promise<T> => {
  const { rows } = await query.execute(trx);
  return rows[0]?.v as T;
};

export const files = {
  /** Inserts the pending artifact under the kernel insert policy, then opens its upload window (bounded by the database). */
  async startUpload(trx: Transaction, input: NewEvidenceInput, ttlSeconds: number): Promise<{ id: string; uploadExpiresAt: Date }> {
    const { id } = await evidenceArtifacts.create(trx, input);
    const uploadExpiresAt = await scalar<Date>(trx, sql<{ v: Date }>`SELECT trustwork.files_register_upload(${id}::uuid, ${ttlSeconds}::integer) AS v`);
    return { id, uploadExpiresAt };
  },
  /** True the first time the uploader reports the bytes as sent. */
  completeUpload(trx: Transaction, id: string): Promise<boolean> {
    return scalar<boolean>(trx, sql<{ v: boolean }>`SELECT trustwork.files_complete_upload(${id}::uuid) AS v`);
  },
  /** True the first time; the artifact disappears for every runtime reader in this transaction's commit. */
  requestDeletion(trx: Transaction, id: string): Promise<boolean> {
    return scalar<boolean>(trx, sql<{ v: boolean }>`SELECT trustwork.files_request_deletion(${id}::uuid) AS v`);
  },
  copy(trx: Transaction, sourceId: string, parent: { kind: EvidenceParentKind; id: string }, storageKey: string): Promise<string> {
    return scalar<string>(trx, sql<{ v: string }>`SELECT trustwork.files_copy(${sourceId}::uuid, ${parent.kind}::text, ${parent.id}::uuid, ${storageKey}::text) AS v`);
  },
  move(trx: Transaction, sourceId: string, parent: { kind: EvidenceParentKind; id: string }): Promise<string> {
    return scalar<string>(trx, sql<{ v: string }>`SELECT trustwork.files_move(${sourceId}::uuid, ${parent.kind}::text, ${parent.id}::uuid) AS v`);
  },
  async get(trx: Transaction, id: string): Promise<FileRow | undefined> {
    const row = await evidenceArtifacts.get(trx, id);
    return row ? (await withState(trx, [row]))[0] : undefined;
  },
  async forParent(trx: Transaction, kind: EvidenceParentKind, id: string, limit = 500): Promise<FileRow[]> {
    const rows = await trx.selectFrom('evidence_artifact').selectAll().where('parent_kind', '=', kind).where('parent_id', '=', id)
      .orderBy('created_at').orderBy('id').limit(limit).execute();
    return withState(trx, rows);
  },
};

export interface ScanTarget {
  storage_key: string;
  sha256: string;
  bytes: string;
  media_type: string;
  classification: EvidenceClassification;
  scan_state: 'pending' | 'clean' | 'quarantined';
  copy_from_key: string | null;
  upload_completed: boolean | null;
  hidden: boolean | null;
}
export interface DeletionTarget { storage_key: string; legal_hold: boolean; deletion_mode: FileDeletionMode; privacy_request_id: string | null }

export const fileWorker = {
  async scanTarget(trx: Transaction, id: string): Promise<ScanTarget | undefined> {
    const { rows } = await sql<ScanTarget>`SELECT * FROM trustwork.files_scan_target(${id}::uuid)`.execute(trx);
    return rows[0];
  },
  /** False when the artifact is no longer pending (a duplicate job or a verdict already recorded). */
  recordScan(trx: Transaction, id: string, verdict: { state: 'clean' } | { state: 'quarantined'; reason: FileQuarantineReason }): Promise<boolean> {
    const reason = verdict.state === 'quarantined' ? verdict.reason : null;
    return scalar<boolean>(trx, sql<{ v: boolean }>`SELECT trustwork.files_record_scan(${id}::uuid, ${verdict.state}::text, ${reason}::text) AS v`);
  },
  async deletionTarget(trx: Transaction, id: string): Promise<DeletionTarget | undefined> {
    const { rows } = await sql<DeletionTarget>`SELECT * FROM trustwork.files_deletion_target(${id}::uuid)`.execute(trx);
    return rows[0];
  },
  requestErasure(trx: Transaction, id: string, input: { privacyRequestId: string; executedBy: string; secondApprover: string }): Promise<boolean> {
    return scalar<boolean>(trx, sql<{ v: boolean }>`SELECT trustwork.files_request_erasure(${id}::uuid, ${input.privacyRequestId}::text, ${input.executedBy}::uuid, ${input.secondApprover}::uuid) AS v`);
  },
  finishDeletion(trx: Transaction, id: string): Promise<boolean> {
    return scalar<boolean>(trx, sql<{ v: boolean }>`SELECT trustwork.files_finish_deletion(${id}::uuid) AS v`);
  },
  applyTombstone(trx: Transaction, id: string, storageKey: string): Promise<number> {
    return scalar<number>(trx, sql<{ v: number }>`SELECT trustwork.files_apply_tombstone(${id}::uuid, ${storageKey}::text) AS v`);
  },
  async expiredUploads(trx: Transaction, limit: number): Promise<{ artifact_id: string; storage_key: string }[]> {
    const { rows } = await sql<{ artifact_id: string; storage_key: string }>`SELECT * FROM trustwork.files_expired_uploads(${limit}::integer)`.execute(trx);
    return rows;
  },
  discardUpload(trx: Transaction, id: string): Promise<boolean> {
    return scalar<boolean>(trx, sql<{ v: boolean }>`SELECT trustwork.files_discard_upload(${id}::uuid) AS v`);
  },
};
