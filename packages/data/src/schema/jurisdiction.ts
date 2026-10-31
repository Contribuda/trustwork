import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Jurisdiction module (SANC-001, packages/data/migrations/jurisdiction; ADR 014): holds of people seen in a restricted
 * place and per-day refusal counters. No column stores a network address. The runtime role reads both tables only as
 * a compliance officer or auditor of the node and writes them only through the owner-run `jurisdiction_*` commands.
 */
export type JurisdictionHoldSource = 'geolocation' | 'edge_header' | 'self_declared' | 'payout_country' | 'staff_report';
export type JurisdictionHoldEvidence = 'document' | 'call' | 'travel_record' | 'other';

export interface JurisdictionHoldTable {
  id: Generated<string>;
  person_id: string;
  place: string;
  source: JurisdictionHoldSource;
  dataset: string;
  placed_at: Generated<Date>;
  cleared_at: Date | null;
  cleared_by: string | null;
  clear_reason: string | null;
  clear_evidence: JurisdictionHoldEvidence | null;
}
export type JurisdictionHoldRow = Selectable<JurisdictionHoldTable>;

export interface JurisdictionRefusalCountTable {
  day: Date;
  place: string;
  door: 'web' | 'api';
  refusals: Generated<number>;
  holds: Generated<number>;
}
export type JurisdictionRefusalCountRow = Selectable<JurisdictionRefusalCountTable>;

export interface JurisdictionDatabase {
  jurisdiction_hold: JurisdictionHoldTable;
  jurisdiction_refusal_count: JurisdictionRefusalCountTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends JurisdictionDatabase {}
}

const columns = columnsOf<JurisdictionDatabase>();
export const TABLE_COLUMNS: TableColumns<JurisdictionDatabase> = {
  jurisdiction_hold: columns('jurisdiction_hold', ['id', 'person_id', 'place', 'source', 'dataset', 'placed_at', 'cleared_at', 'cleared_by', 'clear_reason', 'clear_evidence']),
  jurisdiction_refusal_count: columns('jurisdiction_refusal_count', ['day', 'place', 'door', 'refusals', 'holds']),
};
