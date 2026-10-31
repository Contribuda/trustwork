import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';
import type { GeneratedTimestamp } from './foundation.js';

/**
 * Files module (FILE-001, packages/data/migrations/files): the lifecycle around the kernel table `evidence_artifact`
 * (upload window and completion, scan verdict, copy/move lineage, deletion and erasure requests). The runtime role reads
 * it under the evidence policy and writes it only through the owner-run `files_*` commands; the worker role has no table
 * grant and uses the `files_*` entry points.
 */
export type FileOrigin = 'upload' | 'copy' | 'move';
export type FileDeletionMode = 'delete' | 'erase';
export type FileQuarantineReason = 'malware' | 'hash_mismatch' | 'size_mismatch' | 'type_mismatch' | 'missing_content' | 'location_metadata' | 'unreadable';

export interface FileArtifactStateTable {
  artifact_id: string;
  origin: FileOrigin;
  source_artifact_id: string | null;
  copy_from_key: string | null;
  upload_expires_at: Date | null;
  upload_completed_at: Date | null;
  scanned_at: Date | null;
  quarantine_reason: FileQuarantineReason | null;
  deletion_requested_at: Date | null;
  deletion_requested_by: string | null;
  deletion_mode: FileDeletionMode | null;
  privacy_request_id: string | null;
  erasure_approvers: string[] | null;
  created_at: GeneratedTimestamp;
  updated_at: Generated<Date>;
}
export type FileArtifactState = Selectable<FileArtifactStateTable>;

export interface FilesDatabase {
  file_artifact_state: FileArtifactStateTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends FilesDatabase {}
}

const columns = columnsOf<FilesDatabase>();
export const TABLE_COLUMNS: TableColumns<FilesDatabase> = {
  file_artifact_state: columns('file_artifact_state', [
    'artifact_id', 'origin', 'source_artifact_id', 'copy_from_key', 'upload_expires_at', 'upload_completed_at', 'scanned_at', 'quarantine_reason',
    'deletion_requested_at', 'deletion_requested_by', 'deletion_mode', 'privacy_request_id', 'erasure_approvers', 'created_at', 'updated_at',
  ]),
};
