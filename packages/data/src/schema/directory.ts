import type { Generated, Insertable, Selectable } from 'kysely';
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

/** Append-only: every change of a company's trusted country, by whom and at which hub. Staff only, no runtime grant. */
export interface CompanyCountryCorrectionTable {
  id: Generated<string>;
  company_id: string;
  hub_id: string;
  from_country: string | null;
  to_country: string;
  corrected_by: string;
  corrected_at: GeneratedTimestamp;
}
export type CompanyCountryCorrection = Selectable<CompanyCountryCorrectionTable>;

export interface DirectoryDatabase {
  directory_handle: DirectoryHandleTable;
  company_country_correction: CompanyCountryCorrectionTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends DirectoryDatabase {}
}

const columns = columnsOf<DirectoryDatabase>();
export const TABLE_COLUMNS: TableColumns<DirectoryDatabase> = {
  directory_handle: columns('directory_handle', ['kind', 'handle', 'subject_id', 'assigned_by', 'assigned_at', 'retired_at']),
  company_country_correction: columns('company_country_correction', ['id', 'company_id', 'hub_id', 'from_country', 'to_country', 'corrected_by', 'corrected_at']),
};
