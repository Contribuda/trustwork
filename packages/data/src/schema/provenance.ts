import type { ColumnType, Generated } from "kysely";
import { columnsOf, type TableColumns } from "./index.js";
export interface ProvenanceRecordTable {
  id: Generated<string>;
  publication_id: string;
  version_id: string;
  version_digest: string;
  version_revision: number;
  revision: number;
  responsible_person_id: string;
  kind: "none" | "ai_assisted" | "machine_translation" | "generated";
  roles: string[];
  evidence: "human_declaration";
  original_version_id: string | null;
  original_digest: string | null;
  reason: string;
  recorded_at: Generated<Date>;
}
export interface ProvenanceReviewTable {
  id: Generated<string>;
  provenance_id: string;
  reviewer_person_id: string;
  reason: string;
  reviewed_at: Generated<Date>;
}
export interface ProvenanceCreditConsentTable {
  id: Generated<string>;
  provenance_id: string;
  person_id: string;
  role: "responsible_editor" | "translation_reviewer";
  credit: string;
  channels: string[];
  notice_version: string;
  session_id: string;
  request_id: string;
  granted_at: Generated<Date>;
}
export interface ProvenanceCreditRevocationTable {
  consent_id: string;
  person_id: string;
  reason: string;
  revoked_at: Generated<Date>;
}
export interface ProvenanceImageAttachmentTable {
  id: Generated<string>;
  provenance_id: string;
  asset_id: string;
  asset_sha256: string;
  digital_source_type: string;
  attachment: ColumnType<unknown, string, string>;
  recorded_by: string;
  recorded_at: Generated<Date>;
}
declare module "./index.js" {
  interface Database {
    provenance_record: ProvenanceRecordTable;
    provenance_review: ProvenanceReviewTable;
    provenance_credit_consent: ProvenanceCreditConsentTable;
    provenance_credit_revocation: ProvenanceCreditRevocationTable;
    provenance_image_attachment: ProvenanceImageAttachmentTable;
  }
}
const columns =
  columnsOf<
    Pick<
      import("./index.js").Database,
      | "provenance_record"
      | "provenance_review"
      | "provenance_credit_consent"
      | "provenance_credit_revocation"
      | "provenance_image_attachment"
    >
  >();
export const TABLE_COLUMNS = {
  provenance_record: columns("provenance_record", [
    "id",
    "publication_id",
    "version_id",
    "version_digest",
    "version_revision",
    "revision",
    "responsible_person_id",
    "kind",
    "roles",
    "evidence",
    "original_version_id",
    "original_digest",
    "reason",
    "recorded_at",
  ]),
  provenance_review: columns("provenance_review", [
    "id",
    "provenance_id",
    "reviewer_person_id",
    "reason",
    "reviewed_at",
  ]),
  provenance_credit_consent: columns("provenance_credit_consent", [
    "id",
    "provenance_id",
    "person_id",
    "role",
    "credit",
    "channels",
    "notice_version",
    "session_id",
    "request_id",
    "granted_at",
  ]),
  provenance_credit_revocation: columns("provenance_credit_revocation", [
    "consent_id",
    "person_id",
    "reason",
    "revoked_at",
  ]),
  provenance_image_attachment: columns("provenance_image_attachment", [
    "id",
    "provenance_id",
    "asset_id",
    "asset_sha256",
    "digital_source_type",
    "attachment",
    "recorded_by",
    "recorded_at",
  ]),
} satisfies TableColumns<
  Pick<
    import("./index.js").Database,
    | "provenance_record"
    | "provenance_review"
    | "provenance_credit_consent"
    | "provenance_credit_revocation"
    | "provenance_image_attachment"
  >
>;
