import type { ColumnType, Generated } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Publications, corrections and curated issues (CNT-001, packages/data/migrations/content). Every table is under FORCE
 * RLS and the runtime role holds SELECT only: writes go through the `content_*` SECURITY DEFINER commands, public reads
 * through the `content_public_*` projections.
 */
export type PublicationFormatValue = 'news' | 'article' | 'magazine_piece' | 'company_post' | 'personal_post';
export type ArticleFormatValue = 'analysis' | 'practice' | 'overview' | 'experience' | 'interview' | 'project_story';
export type PublicationOwnerKind = 'person' | 'company' | 'editorial';
export type PublicationStatusValue = 'draft' | 'in_review' | 'scheduled' | 'published' | 'corrected' | 'retracted';
export type PublicationLicenceValue = 'all_rights' | 'cc_by';
export type ModerationStateValue = 'none' | 'held' | 'removed';
export type VersionTreatmentValue = 'headline_link' | 'summary' | 'rewrite' | 'translation' | 'original_reporting';
export type EditorRightsValue = 'edit' | 'publish';
export type IssueStatusValue = 'draft' | 'curated' | 'review' | 'released' | 'corrected';
export type RenderStatusValue = 'queued' | 'rendered' | 'failed';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
/** date: read as text or Date (no pg type parser for dates), written as an ISO date. */
type DateText = ColumnType<string | Date, string, string>;

export interface PublicationTable {
  id: GeneratedUuid;
  hub_id: string;
  format: PublicationFormatValue;
  article_format: ArticleFormatValue | null;
  owner_kind: PublicationOwnerKind;
  owner_person_id: string | null;
  owner_company_id: string | null;
  status: Generated<PublicationStatusValue>;
  original_language: string;
  licence: Generated<PublicationLicenceValue>;
  requires_review: boolean;
  current_version: number | null;
  current_version_id: string | null;
  scheduled_for: Timestamp | null;
  first_published_at: Timestamp | null;
  moderation_state: Generated<ModerationStateValue>;
  held_by_case_id: string | null;
  retraction_note: string | null;
  retracted_at: Timestamp | null;
  retracted_by: string | null;
  created_by: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface PublicationVersionTable {
  id: GeneratedUuid;
  publication_id: string;
  version: number;
  status: Generated<'draft' | 'published'>;
  title: string;
  body: string;
  language: string;
  source_refs: Jsonb;
  treatment: Generated<VersionTreatmentValue>;
  event_time: Timestamp | null;
  assistant_assisted: Generated<boolean>;
  correction_of: number | null;
  correction_note: string | null;
  content_digest: string | null;
  drafted_by: string;
  published_at: Timestamp | null;
  published_by: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface PublicationAuthorshipTable {
  publication_id: string;
  position: number;
  author_kind: PublicationOwnerKind;
  author_person_id: string | null;
  author_company_id: string | null;
  credit: string;
  assistant_assisted: Generated<boolean>;
  created_at: GeneratedTimestamp;
}
export interface PublicationEditorTable {
  id: GeneratedUuid;
  publication_id: string;
  person_id: string;
  rights: EditorRightsValue;
  granted_by: string;
  granted_at: GeneratedTimestamp;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
}
export interface CorrectionTable {
  id: GeneratedUuid;
  hub_id: string;
  subject_kind: 'publication' | 'issue';
  publication_id: string | null;
  issue_id: string | null;
  from_version: number;
  to_version: number;
  reason: string;
  corrected_by: string;
  corrected_at: GeneratedTimestamp;
}
export interface PublicationTopicTable {
  id: GeneratedUuid;
  publication_id: string;
  term_id: string;
  added_by: string;
  created_at: GeneratedTimestamp;
  removed_at: Timestamp | null;
  removed_by: string | null;
}
export interface EntityLinkTable {
  id: GeneratedUuid;
  publication_id: string;
  target_person_id: string | null;
  target_company_id: string | null;
  relation: string;
  added_by: string;
  created_at: GeneratedTimestamp;
  removed_at: Timestamp | null;
  removed_by: string | null;
}
export interface EditionLinkTable {
  id: GeneratedUuid;
  original_publication_id: string;
  translation_publication_id: string;
  language: string;
  translator_person_id: string | null;
  machine_assisted: boolean;
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  created_by: string;
  created_at: GeneratedTimestamp;
}
export interface WallReferenceTable {
  id: GeneratedUuid;
  wall_kind: 'person' | 'company';
  wall_person_id: string | null;
  wall_company_id: string | null;
  publication_id: string;
  publication_version_id: string | null;
  position: number;
  pinned: Generated<boolean>;
  added_by: string;
  created_at: GeneratedTimestamp;
  removed_at: Timestamp | null;
  removed_by: string | null;
}
export interface PublicationCommentTable {
  id: GeneratedUuid;
  publication_id: string;
  author_person_id: string;
  parent_id: string | null;
  body: string;
  status: Generated<'visible' | 'held' | 'removed'>;
  moderation_case_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface IssueTable {
  id: GeneratedUuid;
  hub_id: string;
  number: number;
  issue_date: DateText;
  theme: string | null;
  cover_asset_id: string | null;
  editor_letter_publication_id: string | null;
  status: Generated<IssueStatusValue>;
  current_edition: number | null;
  created_by: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface IssueRevisionTable {
  id: GeneratedUuid;
  issue_id: string;
  edition: number;
  status: Generated<'draft' | 'released'>;
  digest: string | null;
  correction_note: string | null;
  released_at: Timestamp | null;
  released_by: string | null;
  created_by: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface IssueItemTable {
  issue_revision_id: string;
  position: number;
  section: string;
  publication_id: string;
  publication_version_id: string;
  created_at: GeneratedTimestamp;
}
export interface RenderArtifactTable {
  id: GeneratedUuid;
  issue_revision_id: string;
  format: 'web' | 'pdf';
  status: Generated<RenderStatusValue>;
  artifact_id: string | null;
  sha256: string | null;
  renderer_version: string | null;
  failure_reason: string | null;
  requested_by: string;
  requested_at: GeneratedTimestamp;
  completed_at: Timestamp | null;
  revision: Generated<number>;
  updated_at: GeneratedTimestamp;
}
export interface MagazineDigestTable {
  id: GeneratedUuid;
  hub_id: string;
  title: string;
  period: string;
  status: Generated<'draft' | 'released'>;
  released_at: Timestamp | null;
  released_by: string | null;
  created_by: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface MagazineDigestItemTable {
  digest_id: string;
  position: number;
  home_node: string;
  global_id: string;
  version: number;
  licence: PublicationLicenceValue;
  display: 'full' | 'headline_link';
  title: string;
  local_publication_id: string | null;
  local_version_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface ContentDatabase {
  publication: PublicationTable;
  publication_version: PublicationVersionTable;
  publication_authorship: PublicationAuthorshipTable;
  publication_editor: PublicationEditorTable;
  correction: CorrectionTable;
  publication_topic: PublicationTopicTable;
  entity_link: EntityLinkTable;
  edition_link: EditionLinkTable;
  wall_reference: WallReferenceTable;
  publication_comment: PublicationCommentTable;
  issue: IssueTable;
  issue_revision: IssueRevisionTable;
  issue_item: IssueItemTable;
  render_artifact: RenderArtifactTable;
  magazine_digest: MagazineDigestTable;
  magazine_digest_item: MagazineDigestItemTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ContentDatabase {}
}

const columns = columnsOf<ContentDatabase>();
export const TABLE_COLUMNS: TableColumns<ContentDatabase> = {
  publication: columns('publication', [
    'id', 'hub_id', 'format', 'article_format', 'owner_kind', 'owner_person_id', 'owner_company_id', 'status', 'original_language', 'licence', 'requires_review', 'current_version',
    'current_version_id', 'scheduled_for', 'first_published_at', 'moderation_state', 'held_by_case_id', 'retraction_note', 'retracted_at', 'retracted_by', 'created_by', 'revision',
    'created_at', 'updated_at',
  ]),
  publication_version: columns('publication_version', [
    'id', 'publication_id', 'version', 'status', 'title', 'body', 'language', 'source_refs', 'treatment', 'event_time', 'assistant_assisted', 'correction_of', 'correction_note',
    'content_digest', 'drafted_by', 'published_at', 'published_by', 'revision', 'created_at', 'updated_at',
  ]),
  publication_authorship: columns('publication_authorship', ['publication_id', 'position', 'author_kind', 'author_person_id', 'author_company_id', 'credit', 'assistant_assisted', 'created_at']),
  publication_editor: columns('publication_editor', ['id', 'publication_id', 'person_id', 'rights', 'granted_by', 'granted_at', 'revoked_at', 'revoked_by']),
  correction: columns('correction', ['id', 'hub_id', 'subject_kind', 'publication_id', 'issue_id', 'from_version', 'to_version', 'reason', 'corrected_by', 'corrected_at']),
  publication_topic: columns('publication_topic', ['id', 'publication_id', 'term_id', 'added_by', 'created_at', 'removed_at', 'removed_by']),
  entity_link: columns('entity_link', ['id', 'publication_id', 'target_person_id', 'target_company_id', 'relation', 'added_by', 'created_at', 'removed_at', 'removed_by']),
  edition_link: columns('edition_link', [
    'id', 'original_publication_id', 'translation_publication_id', 'language', 'translator_person_id', 'machine_assisted', 'reviewed_by', 'reviewed_at', 'created_by', 'created_at',
  ]),
  wall_reference: columns('wall_reference', [
    'id', 'wall_kind', 'wall_person_id', 'wall_company_id', 'publication_id', 'publication_version_id', 'position', 'pinned', 'added_by', 'created_at', 'removed_at', 'removed_by',
  ]),
  publication_comment: columns('publication_comment', ['id', 'publication_id', 'author_person_id', 'parent_id', 'body', 'status', 'moderation_case_id', 'revision', 'created_at', 'updated_at']),
  issue: columns('issue', [
    'id', 'hub_id', 'number', 'issue_date', 'theme', 'cover_asset_id', 'editor_letter_publication_id', 'status', 'current_edition', 'created_by', 'revision', 'created_at', 'updated_at',
  ]),
  issue_revision: columns('issue_revision', [
    'id', 'issue_id', 'edition', 'status', 'digest', 'correction_note', 'released_at', 'released_by', 'created_by', 'revision', 'created_at', 'updated_at',
  ]),
  issue_item: columns('issue_item', ['issue_revision_id', 'position', 'section', 'publication_id', 'publication_version_id', 'created_at']),
  render_artifact: columns('render_artifact', [
    'id', 'issue_revision_id', 'format', 'status', 'artifact_id', 'sha256', 'renderer_version', 'failure_reason', 'requested_by', 'requested_at', 'completed_at', 'revision', 'updated_at',
  ]),
  magazine_digest: columns('magazine_digest', ['id', 'hub_id', 'title', 'period', 'status', 'released_at', 'released_by', 'created_by', 'revision', 'created_at', 'updated_at']),
  magazine_digest_item: columns('magazine_digest_item', [
    'digest_id', 'position', 'home_node', 'global_id', 'version', 'licence', 'display', 'title', 'local_publication_id', 'local_version_id', 'created_at',
  ]),
};
