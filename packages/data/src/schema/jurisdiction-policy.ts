import type { Generated, ColumnType } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';
interface EvidenceTable {
  id: Generated<string>; document: ColumnType<unknown, string, never>; digest: string; created_at: Generated<Date>;
}
export interface JurisdictionPolicyDatabase {
  jurisdiction_applicability_review: { id: Generated<string>; evidence_id: string; evidence_digest: string; previous_revision: number; proposer: unknown; created_at: Generated<Date> };
  jurisdiction_applicability_activation: { review_id: string; reviewer: unknown; activated_at: Generated<Date> };
  jurisdiction_consent_receipt: {
    id: Generated<string>; person_id: string; session_id: string; authz_epoch: number;
    notice_digest: string; notice: ColumnType<unknown, string, never>; locale: string; granted_at: Generated<Date>;
  };
  jurisdiction_consent_revocation: { receipt_id: string; person_id: string; session_id: string; revoked_at: Generated<Date> };
  jurisdiction_source: EvidenceTable;
  jurisdiction_source_current: { jurisdiction: string; source_id: string; revision: Generated<number> };
  jurisdiction_applicability: EvidenceTable;
  jurisdiction_applicability_current: { subject_kind: string; subject_id: string; applicability_id: string; revision: Generated<number> };
  jurisdiction_intent_binding: { intent_id: string; binding_digest: string; action_digest: string; created_at: Generated<Date> };
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module augmentation for the owned tables
  interface Database extends JurisdictionPolicyDatabase {}
}
const columns = columnsOf<JurisdictionPolicyDatabase>();
export const TABLE_COLUMNS = {
  jurisdiction_applicability_review: columns('jurisdiction_applicability_review', ['id', 'evidence_id', 'evidence_digest', 'previous_revision', 'proposer', 'created_at']),
  jurisdiction_applicability_activation: columns('jurisdiction_applicability_activation', ['review_id', 'reviewer', 'activated_at']),
  jurisdiction_consent_receipt: columns('jurisdiction_consent_receipt', ['id', 'person_id', 'session_id', 'authz_epoch', 'notice_digest', 'notice', 'locale', 'granted_at']),
  jurisdiction_consent_revocation: columns('jurisdiction_consent_revocation', ['receipt_id', 'person_id', 'session_id', 'revoked_at']),
  jurisdiction_source: columns('jurisdiction_source', ['id', 'document', 'digest', 'created_at']),
  jurisdiction_source_current: columns('jurisdiction_source_current', ['jurisdiction', 'source_id', 'revision']),
  jurisdiction_applicability: columns('jurisdiction_applicability', ['id', 'document', 'digest', 'created_at']),
  jurisdiction_applicability_current: columns('jurisdiction_applicability_current', ['subject_kind', 'subject_id', 'applicability_id', 'revision']),
  jurisdiction_intent_binding: columns('jurisdiction_intent_binding', ['intent_id', 'binding_digest', 'action_digest', 'created_at']),
} satisfies TableColumns<JurisdictionPolicyDatabase>;
