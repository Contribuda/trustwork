import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Attestation module (SANC-009, packages/data/migrations/attestation; ADR 014 decisions 3 to 5): the operator's
 * statement of where its legal entity and its hosting are, append-only and superseding. The runtime role reads the
 * rows only as node staff (`attestation_reader`) and writes them only through `attestation_attest`; everyone else reads
 * the current attestation without the attesting person through `attestation_current`.
 */
export type AttestedGateMode = 'ranges_file' | 'edge_header' | 'upstream_gate';

export interface DeploymentLocationAttestationTable {
  id: Generated<string>;
  node_id: string;
  operator_entity_country: string;
  operator_entity_region: string | null;
  hosting_country: string;
  hosting_region: string | null;
  gate_mode: AttestedGateMode;
  statement_version: 'deployment-location-1';
  statement_digest: string;
  attested_by: string;
  attester_role: string;
  permission: 'admin.node.hubs.manage' | 'admin.hub.jurisdiction.edit';
  session_elevation_id: string;
  breakglass: Generated<boolean>;
  attested_at: Generated<Date>;
  expires_at: Date;
  supersedes_id: string | null;
}
export type DeploymentLocationAttestationRow = Selectable<DeploymentLocationAttestationTable>;

/** What `attestation_current()` returns: the current attestation without the attesting person. */
export type DeploymentLocationAttestationSummaryRow = Omit<DeploymentLocationAttestationRow, 'statement_version' | 'attested_by' | 'attester_role' | 'permission' | 'session_elevation_id' | 'breakglass'>;

export interface AttestationDatabase {
  deployment_location_attestation: DeploymentLocationAttestationTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends AttestationDatabase {}
}

const columns = columnsOf<AttestationDatabase>();
export const TABLE_COLUMNS: TableColumns<AttestationDatabase> = {
  deployment_location_attestation: columns('deployment_location_attestation', [
    'id', 'node_id', 'operator_entity_country', 'operator_entity_region', 'hosting_country', 'hosting_region', 'gate_mode', 'statement_version', 'statement_digest',
    'attested_by', 'attester_role', 'permission', 'session_elevation_id', 'breakglass', 'attested_at', 'expires_at', 'supersedes_id',
  ]),
};
