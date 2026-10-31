import type { Insertable, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type TableColumns, type Timestamp } from './index.js';

/**
 * Directory module (BE-003, packages/data/migrations/directory): permanent public handles for people, companies and
 * projects. One row per (kind, handle) for ever; at most one current row per subject; rows are never deleted or
 * re-pointed (trigger), so a retired handle redirects to its subject and is never reused for another one.
 */
export type HandleKind = 'person' | 'company' | 'project';

export interface DirectoryHandleTable {
  kind: HandleKind;
  handle: string;
  subject_id: string;
  assigned_by: string;
  assigned_at: GeneratedTimestamp;
  retired_at: Timestamp | null;
}
export type DirectoryHandle = Selectable<DirectoryHandleTable>;
export type NewDirectoryHandle = Insertable<DirectoryHandleTable>;

export interface DirectoryDatabase {
  directory_handle: DirectoryHandleTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends DirectoryDatabase {}
}

const columns = columnsOf<DirectoryDatabase>();
export const TABLE_COLUMNS: TableColumns<DirectoryDatabase> = {
  directory_handle: columns('directory_handle', ['kind', 'handle', 'subject_id', 'assigned_by', 'assigned_at', 'retired_at']),
};
