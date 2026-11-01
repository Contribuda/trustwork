import type { Generated, ColumnType } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';
type Json = ColumnType<unknown, string, never>;
interface IssuerVersion { id: Generated<string>; issuer_id: string; hub_id: string; version: number; document: Json; digest: string; proposer: Json; created_at: Generated<Date> }
interface ProofRecord { id: Generated<string>; issuer_version_id: string; issuer_id: string; record_id: string; record_revision: number; document: Json; digest: string; signature: string; created_at: Generated<Date> }
interface JurisdictionSourceDatabase {
  jurisdiction_issuer_version: IssuerVersion;
  jurisdiction_issuer_activation: { version_id: string; reviewer: Json; created_at: Generated<Date> };
  jurisdiction_issuer_current: { issuer_id: string; version_id: string; epoch: number };
  jurisdiction_issuer_revocation: { version_id: string; authority: Json; created_at: Generated<Date> };
  jurisdiction_proof_record: ProofRecord;
  jurisdiction_proof_current: { issuer_id: string; record_id: string; source_id: string; revision: number };
  jurisdiction_proof_revocation: { source_id: string; authority: Json; created_at: Generated<Date> };
  jurisdiction_applicability_origin: { evidence_id: string; source_id: string };
  jurisdiction_scoped_head: { hub_id: string; subject_kind: string; subject_id: string; action: string; context_kind: string; context_id: string; applicability_id: string; revision: number };
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation for owned source records
  interface Database extends JurisdictionSourceDatabase {}
}
const columns = columnsOf<JurisdictionSourceDatabase>();
export const TABLE_COLUMNS = {
  jurisdiction_issuer_version: columns('jurisdiction_issuer_version', ['id', 'issuer_id', 'hub_id', 'version', 'document', 'digest', 'proposer', 'created_at']),
  jurisdiction_issuer_activation: columns('jurisdiction_issuer_activation', ['version_id', 'reviewer', 'created_at']),
  jurisdiction_issuer_current: columns('jurisdiction_issuer_current', ['issuer_id', 'version_id', 'epoch']),
  jurisdiction_issuer_revocation: columns('jurisdiction_issuer_revocation', ['version_id', 'authority', 'created_at']),
  jurisdiction_proof_record: columns('jurisdiction_proof_record', ['id', 'issuer_version_id', 'issuer_id', 'record_id', 'record_revision', 'document', 'digest', 'signature', 'created_at']),
  jurisdiction_proof_current: columns('jurisdiction_proof_current', ['issuer_id', 'record_id', 'source_id', 'revision']),
  jurisdiction_proof_revocation: columns('jurisdiction_proof_revocation', ['source_id', 'authority', 'created_at']),
  jurisdiction_applicability_origin: columns('jurisdiction_applicability_origin', ['evidence_id', 'source_id']),
  jurisdiction_scoped_head: columns('jurisdiction_scoped_head', ['hub_id', 'subject_kind', 'subject_id', 'action', 'context_kind', 'context_id', 'applicability_id', 'revision']),
} satisfies TableColumns<JurisdictionSourceDatabase>;
