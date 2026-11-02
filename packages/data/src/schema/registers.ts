import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Registers module (REG-001, packages/data/migrations/registers; contract packages/contracts/src/sourced-facts.ts):
 * register adapters bound to a hub's official-register sources, append-only sourced facts with the licence snapshot of
 * their observation, reviewed links for registers without identifiers, and expiry reminders. The runtime role reads
 * under row-level security (staff of the hub with a sources or claims permission) and writes only through the
 * `registers_*` SECURITY DEFINER commands (repositories/registers.ts).
 */
export type RegisterAdapterMode = 'fake' | 'live';
export type RegisterHolderKind = 'organisation' | 'natural_person' | 'unknown';
export type AllowedUsesJson = Record<string, boolean>;

export interface RegisterAdapterTable {
  id: Generated<string>;
  hub_id: string;
  adapter: string;
  source_id: string;
  mode: Generated<RegisterAdapterMode>;
  credential_ref_id: string | null;
  approval_id: string | null;
  refresh_days: number;
  status: Generated<'active' | 'retired'>;
  last_run_at: Date | null;
  revision: Generated<number>;
  created_by: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type RegisterAdapterRow = Selectable<RegisterAdapterTable>;

export interface RegisterFactTable {
  id: Generated<string>;
  hub_id: string;
  adapter_id: string;
  source_id: string;
  mode: RegisterAdapterMode;
  method: 'register_api' | 'structured_feed' | 'manual';
  kind: string;
  identifier_kind: string | null;
  identifier_value: string | null;
  identifier_norm: Generated<string | null>;
  holder_kind: RegisterHolderKind;
  value: Record<string, unknown>;
  record_ref: string;
  link: string;
  licence_snapshot: AllowedUsesJson;
  observed_at: Date;
  valid_until: Date | null;
  /** The staff member who ran a fake adapter; null for the worker. */
  recorded_by: string | null;
  superseded_at: Date | null;
  superseded_by: string | null;
  created_at: Generated<Date>;
}
export type RegisterFactRow = Selectable<RegisterFactTable>;

export interface RegisterFactLinkTable {
  id: Generated<string>;
  hub_id: string;
  adapter_id: string;
  record_ref: string;
  company_id: string;
  reason: string;
  linked_by: string;
  linked_at: Generated<Date>;
  ended_at: Date | null;
  ended_by: string | null;
}
export type RegisterFactLinkRow = Selectable<RegisterFactLinkTable>;

export interface RegisterReminderTable {
  id: Generated<string>;
  hub_id: string;
  company_id: string;
  fact_id: string;
  adapter_id: string;
  kind: string;
  record_ref: string;
  valid_until: Date;
  days_before: number;
  created_at: Generated<Date>;
}
export type RegisterReminderRow = Selectable<RegisterReminderTable>;

export interface RegistersDatabase {
  register_adapter: RegisterAdapterTable;
  register_fact: RegisterFactTable;
  register_fact_link: RegisterFactLinkTable;
  register_reminder: RegisterReminderTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends RegistersDatabase {}
}

const columns = columnsOf<RegistersDatabase>();
export const TABLE_COLUMNS: TableColumns<RegistersDatabase> = {
  register_adapter: columns('register_adapter', [
    'id', 'hub_id', 'adapter', 'source_id', 'mode', 'credential_ref_id', 'approval_id', 'refresh_days', 'status', 'last_run_at', 'revision', 'created_by', 'created_at', 'updated_at',
  ]),
  register_fact: columns('register_fact', [
    'id', 'hub_id', 'adapter_id', 'source_id', 'mode', 'method', 'kind', 'identifier_kind', 'identifier_value', 'identifier_norm', 'holder_kind', 'value', 'record_ref', 'link',
    'licence_snapshot', 'observed_at', 'valid_until', 'recorded_by', 'superseded_at', 'superseded_by', 'created_at',
  ]),
  register_fact_link: columns('register_fact_link', ['id', 'hub_id', 'adapter_id', 'record_ref', 'company_id', 'reason', 'linked_by', 'linked_at', 'ended_at', 'ended_by']),
  register_reminder: columns('register_reminder', ['id', 'hub_id', 'company_id', 'fact_id', 'adapter_id', 'kind', 'record_ref', 'valid_until', 'days_before', 'created_at']),
};
