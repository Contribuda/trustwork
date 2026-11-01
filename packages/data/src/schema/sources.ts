import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Sources module (SRC-001, packages/data/migrations/sources; docs/engine/publishing.md "Hub sources", docs/data/model.md
 * section 24): the hub source registry with the console's licence flags, robots.txt checks as crawl policies, imported
 * batches and items (the human review queue), field-level provenance of sourced records, record link proposals,
 * takedowns with tombstones and the per-hub sponsored content policy. The runtime role reads under row-level security
 * (staff of the hub only) and writes only through the `sources_*` SECURITY DEFINER commands (repositories/sources.ts).
 */
export type AllowedUsesJson = Record<string, boolean>;
export type SourceStatus = 'proposed' | 'active' | 'paused' | 'rejected' | 'retired' | 'taken_down';
export type ImportBatchStatus = 'staged' | 'activated' | 'rejected' | 'taken_down';
export type SourceItemStatus = 'queued' | 'drafted' | 'discarded' | 'taken_down';
export type RslStatus = 'absent' | 'parsed' | 'failed' | 'no_matching_content';

export interface SourceTable {
  id: Generated<string>;
  hub_id: string;
  kind: string;
  name: string;
  url: string | null;
  reader_kind: string;
  purposes: string[];
  licence_kind: string;
  licence_name: string | null;
  licence_url: string | null;
  agreement_ref: string | null;
  allowed_uses: AllowedUsesJson;
  attribution_template: string;
  takedown_contact: string;
  owner_person_id: string;
  personal_data: Generated<boolean>;
  legal_basis: string | null;
  terms_checked_at: Date | null;
  terms_url: string | null;
  terms_digest: string | null;
  terms_automated_access: 'permitted' | 'forbidden' | 'unclear' | 'not_applicable' | null;
  terms_reviewed_by: string | null;
  terms_notes: Generated<string>;
  rsl_status: Generated<RslStatus>;
  rsl_digest: string | null;
  rsl_checked_at: Date | null;
  rsl_ceiling: AllowedUsesJson | null;
  rsl_suggested: AllowedUsesJson | null;
  proposed_by_kind: Generated<'person' | 'pipeline'>;
  proposed_by_person: string | null;
  proposed_by_pipeline: string | null;
  proposed_by_run: string | null;
  edited_by: string;
  status: Generated<SourceStatus>;
  activated_by: string | null;
  activated_at: Date | null;
  pause_reason: string | null;
  paused_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type SourceRow = Selectable<SourceTable>;

export interface CrawlPolicyTable {
  id: Generated<string>;
  source_id: string;
  hub_id: string;
  domain: string;
  robots_url: string;
  user_agent: string;
  robots_digest: string;
  allowed: boolean;
  status: 'allowed' | 'restricted' | 'forbidden';
  crawl_delay_s: number | null;
  allowed_paths: Generated<string[]>;
  disallowed_paths: Generated<string[]>;
  licence_urls: Generated<string[]>;
  recorded_by: string;
  fetched_at: Generated<Date>;
}
export type CrawlPolicyRow = Selectable<CrawlPolicyTable>;

export interface SponsoredContentPolicyTable {
  id: Generated<string>;
  hub_id: string;
  version: number;
  allowed: boolean;
  max_slots_per_page: number;
  require_verified_sponsor: boolean;
  set_by: string;
  approval_id: string | null;
  created_at: Generated<Date>;
}
export type SponsoredContentPolicyRow = Selectable<SponsoredContentPolicyTable>;

export interface ImportBatchTable {
  id: Generated<string>;
  source_id: string;
  hub_id: string;
  pipeline_run_id: string | null;
  staged_by: string;
  counts: { items: number; duplicates: number; fields: number; links: number };
  licence_snapshot: { licenceKind: string; licenceName: string | null; allowedUses: AllowedUsesJson };
  status: Generated<ImportBatchStatus>;
  decided_by: string | null;
  decided_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ImportBatchRow = Selectable<ImportBatchTable>;

export interface SourceItemTable {
  id: Generated<string>;
  hub_id: string;
  source_id: string;
  import_batch_id: string;
  external_id: string;
  url: string;
  title: string;
  summary: string | null;
  full_text: string | null;
  source_time: Date | null;
  observed_at: Generated<Date>;
  content_digest: string;
  licence_snapshot: { licenceKind: string; licenceName: string | null; allowedUses: AllowedUsesJson };
  sponsored: Generated<boolean>;
  sponsor_name: string | null;
  assisted_summary: string | null;
  assisted_language: string | null;
  assisted_at: Date | null;
  status: Generated<SourceItemStatus>;
  decided_by: string | null;
  decided_at: Date | null;
  publication_id: string | null;
  takedown_id: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type SourceItemRow = Selectable<SourceItemTable>;

export interface SourcedRecordFieldTable {
  id: Generated<string>;
  hub_id: string;
  record_kind: string;
  record_id: string;
  field: string;
  value: string;
  source_id: string;
  import_batch_id: string;
  source_item_id: string | null;
  observed_at: Generated<Date>;
  active: Generated<boolean>;
  deactivated_at: Date | null;
  takedown_id: string | null;
  created_at: Generated<Date>;
}
export type SourcedRecordFieldRow = Selectable<SourcedRecordFieldTable>;

export interface RecordLinkProposalTable {
  id: Generated<string>;
  hub_id: string;
  left_kind: 'company' | 'person' | 'sourced_record';
  left_id: string;
  right_local_id: string | null;
  right_global_id: string | null;
  evidence: 'identifier_match' | 'signed_statement' | 'person_confirmed';
  proposed_by: 'import' | 'peer' | 'person';
  proposed_by_person: string;
  import_batch_id: string | null;
  state: Generated<'proposed' | 'accepted' | 'rejected' | 'withdrawn'>;
  decided_by: string | null;
  decided_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type RecordLinkProposalRow = Selectable<RecordLinkProposalTable>;

export interface SourceTakedownTable {
  id: Generated<string>;
  hub_id: string;
  target_kind: 'source' | 'source_item';
  source_id: string;
  source_item_id: string | null;
  reason_category: string;
  note: string;
  items_taken_down: number;
  fields_deactivated: number;
  publication_ids: Generated<string[]>;
  executed_by: string;
  executed_at: Generated<Date>;
}
export type SourceTakedownRow = Selectable<SourceTakedownTable>;

export interface SourceTombstoneTable {
  id: Generated<string>;
  hub_id: string;
  takedown_id: string;
  channel: 'retrieval' | 'federation';
  target_kind: 'source' | 'source_item' | 'sourced_record';
  target_id: string;
  record_kind: string | null;
  reason: 'takedown' | 'licence_ended';
  issued_at: Generated<Date>;
  apply_by: Date | null;
}
export type SourceTombstoneRow = Selectable<SourceTombstoneTable>;

export interface SourcesDatabase {
  source: SourceTable;
  crawl_policy: CrawlPolicyTable;
  sponsored_content_policy: SponsoredContentPolicyTable;
  import_batch: ImportBatchTable;
  source_item: SourceItemTable;
  sourced_record_field: SourcedRecordFieldTable;
  record_link_proposal: RecordLinkProposalTable;
  source_takedown: SourceTakedownTable;
  source_tombstone: SourceTombstoneTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends SourcesDatabase {}
}

const columns = columnsOf<SourcesDatabase>();
export const TABLE_COLUMNS: TableColumns<SourcesDatabase> = {
  source: columns('source', [
    'id', 'hub_id', 'kind', 'name', 'url', 'reader_kind', 'purposes', 'licence_kind', 'licence_name', 'licence_url', 'agreement_ref', 'allowed_uses', 'attribution_template',
    'takedown_contact', 'owner_person_id', 'personal_data', 'legal_basis', 'terms_checked_at', 'terms_url', 'terms_digest', 'terms_automated_access', 'terms_reviewed_by',
    'terms_notes', 'rsl_status', 'rsl_digest', 'rsl_checked_at', 'rsl_ceiling', 'rsl_suggested', 'proposed_by_kind', 'proposed_by_person', 'proposed_by_pipeline',
    'proposed_by_run', 'edited_by', 'status', 'activated_by', 'activated_at', 'pause_reason', 'paused_at', 'revision', 'created_at', 'updated_at',
  ]),
  crawl_policy: columns('crawl_policy', [
    'id', 'source_id', 'hub_id', 'domain', 'robots_url', 'user_agent', 'robots_digest', 'allowed', 'status', 'crawl_delay_s', 'allowed_paths', 'disallowed_paths', 'licence_urls',
    'recorded_by', 'fetched_at',
  ]),
  sponsored_content_policy: columns('sponsored_content_policy', ['id', 'hub_id', 'version', 'allowed', 'max_slots_per_page', 'require_verified_sponsor', 'set_by', 'approval_id', 'created_at']),
  import_batch: columns('import_batch', [
    'id', 'source_id', 'hub_id', 'pipeline_run_id', 'staged_by', 'counts', 'licence_snapshot', 'status', 'decided_by', 'decided_at', 'revision', 'created_at', 'updated_at',
  ]),
  source_item: columns('source_item', [
    'id', 'hub_id', 'source_id', 'import_batch_id', 'external_id', 'url', 'title', 'summary', 'full_text', 'source_time', 'observed_at', 'content_digest', 'licence_snapshot',
    'sponsored', 'sponsor_name', 'assisted_summary', 'assisted_language', 'assisted_at', 'status', 'decided_by', 'decided_at', 'publication_id', 'takedown_id', 'revision',
    'created_at', 'updated_at',
  ]),
  sourced_record_field: columns('sourced_record_field', [
    'id', 'hub_id', 'record_kind', 'record_id', 'field', 'value', 'source_id', 'import_batch_id', 'source_item_id', 'observed_at', 'active', 'deactivated_at', 'takedown_id', 'created_at',
  ]),
  record_link_proposal: columns('record_link_proposal', [
    'id', 'hub_id', 'left_kind', 'left_id', 'right_local_id', 'right_global_id', 'evidence', 'proposed_by', 'proposed_by_person', 'import_batch_id', 'state', 'decided_by',
    'decided_at', 'revision', 'created_at', 'updated_at',
  ]),
  source_takedown: columns('source_takedown', [
    'id', 'hub_id', 'target_kind', 'source_id', 'source_item_id', 'reason_category', 'note', 'items_taken_down', 'fields_deactivated', 'publication_ids', 'executed_by', 'executed_at',
  ]),
  source_tombstone: columns('source_tombstone', ['id', 'hub_id', 'takedown_id', 'channel', 'target_kind', 'target_id', 'record_kind', 'reason', 'issued_at', 'apply_by']),
};
