import type { Generated, ColumnType } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';
interface EvidenceTable {
  id: Generated<string>; document: ColumnType<unknown, string, never>; digest: string; created_at: Generated<Date>;
}
export interface JurisdictionPolicyDatabase {
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
  jurisdiction_source: columns('jurisdiction_source', ['id', 'document', 'digest', 'created_at']),
  jurisdiction_source_current: columns('jurisdiction_source_current', ['jurisdiction', 'source_id', 'revision']),
  jurisdiction_applicability: columns('jurisdiction_applicability', ['id', 'document', 'digest', 'created_at']),
  jurisdiction_applicability_current: columns('jurisdiction_applicability_current', ['subject_kind', 'subject_id', 'applicability_id', 'revision']),
  jurisdiction_intent_binding: columns('jurisdiction_intent_binding', ['intent_id', 'binding_digest', 'action_digest', 'created_at']),
} satisfies TableColumns<JurisdictionPolicyDatabase>;
