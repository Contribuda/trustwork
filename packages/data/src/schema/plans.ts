import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Plans module (PLAN-001, packages/data/migrations/plans): one plan per project, frozen versions with their items and
 * dependencies, the execution state beside them, plan changes, per-item shares, the site location, permit records and
 * the diary. Every table is under FORCE RLS; invitees read only through `trustwork.plan_shared_view`.
 */
export type PlanStatus = 'drafting' | 'active' | 'closed';
export type PlanVia = 'person' | 'agent';
export type PlanVersionStatus = 'draft' | 'proposed' | 'approved' | 'superseded';
export type PlanItemKindValue = 'phase' | 'task' | 'milestone' | 'consultation' | 'purchase' | 'material' | 'permit' | 'inspection' | 'decision' | 'risk' | 'self';
export type PlanItemStatusValue = 'proposed' | 'accepted' | 'requested' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'skipped';
export type PlanShareAudienceValue = 'public' | 'invited' | 'after_acceptance';
/** jsonb: read as parsed JSON, written as a JSON string. */
export type Jsonb = ColumnType<unknown, string, string>;
/** bigint: node-postgres returns int8 as a string. */
export type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;
/** date: read as text (pg type parser is not configured for dates here), written as an ISO date. */
export type DateText = ColumnType<string | Date, string, string>;

export interface PlanTable {
  id: GeneratedUuid;
  project_id: string;
  status: Generated<PlanStatus>;
  current_version_id: string | null;
  time_zone: string;
  created_by_person_id: string;
  drafted_via: PlanVia;
  drafted_mandate_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PlanVersionTable {
  id: GeneratedUuid;
  plan_id: string;
  project_id: string;
  version: number;
  status: Generated<PlanVersionStatus>;
  content: Jsonb;
  digest: string | null;
  based_on_version_id: string | null;
  drafted_by_person_id: string;
  drafted_via: PlanVia;
  drafted_mandate_id: string | null;
  proposed_by_person_id: string | null;
  proposed_via: PlanVia | null;
  proposed_mandate_id: string | null;
  proposed_at: Timestamp | null;
  approved_by_person_id: string | null;
  approved_at: Timestamp | null;
  superseded_at: Timestamp | null;
  superseded_by_version_id: string | null;
  superseded_reason: 'returned' | 'replaced' | null;
  change_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PlanItemTable {
  id: GeneratedUuid;
  plan_version_id: string;
  /** Set by the insert trigger from the version. */
  plan_id: ColumnType<string, string | undefined, never>;
  project_id: ColumnType<string, string | undefined, never>;
  item_key: string;
  parent_key: string | null;
  position: number;
  kind: PlanItemKindValue;
  title: string;
  description: string | null;
  step_terms: string[];
  required_skills: string[];
  quantity_value: string | null;
  quantity_unit: string | null;
  estimate_low: Int8 | null;
  estimate_high: Int8 | null;
  estimate_currency: string | null;
  estimate_basis: string | null;
  estimate_basis_ref: string | null;
  estimate_as_of: DateText | null;
  duration_low_days: number | null;
  duration_high_days: number | null;
  window_start: DateText | null;
  window_finish: DateText | null;
  risk_level: 'low' | 'medium' | 'high' | null;
  decision_question: string | null;
  sources: Jsonb;
  attachments: Jsonb;
  private_notes: string | null;
  created_at: GeneratedTimestamp;
}

export interface PlanDependencyTable {
  plan_version_id: string;
  plan_id: ColumnType<string, string | undefined, never>;
  project_id: ColumnType<string, string | undefined, never>;
  predecessor_key: string;
  successor_key: string;
  type: 'fs' | 'ss' | 'ff' | 'sf';
  lag_days: Generated<number>;
  created_at: GeneratedTimestamp;
}

export interface PlanItemStateTable {
  plan_id: string;
  project_id: string;
  item_key: string;
  status: PlanItemStatusValue;
  path: 'task' | 'rfq' | 'requisition' | 'consultation' | 'self' | null;
  link_kind: 'task_request' | 'rfq' | 'requisition' | 'consultation_request' | 'permit_record' | 'course' | 'event' | null;
  link_id: string | null;
  blocked_from: 'requested' | 'in_progress' | null;
  actual_start: DateText | null;
  actual_end: DateText | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PlanChangeTable {
  id: GeneratedUuid;
  plan_id: string;
  project_id: string;
  from_version_id: string;
  to_version_id: string;
  reason: string;
  cause: 'owner_request' | 'counterparty' | 'site_condition' | 'regulatory' | 'external' | 'unknown';
  requested_by_person_id: string | null;
  requested_by_company_id: string | null;
  accountable_person_id: string | null;
  accountable_company_id: string | null;
  agreement_id: string | null;
  schedule_impact_days: number | null;
  status: Generated<'proposed' | 'approved' | 'rejected' | 'withdrawn'>;
  created_by_person_id: string;
  decided_by_person_id: string | null;
  decided_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PlanShareTable {
  id: GeneratedUuid;
  plan_id: string;
  project_id: string;
  item_key: string;
  audience: PlanShareAudienceValue;
  invitee_person_id: string | null;
  invitee_company_id: string | null;
  fields: string[];
  acceptance_kind: 'consultation_booking' | 'task_assignment' | null;
  acceptance_id: string | null;
  preview_digest: string;
  confirmed_by_person_id: string;
  confirmed_at: GeneratedTimestamp;
  valid_until: Timestamp | null;
  revoked_at: Timestamp | null;
  revoked_by_person_id: string | null;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ProjectLocationTable {
  project_id: string;
  address: Jsonb | null;
  region_code: string | null;
  cadastral_ref: string | null;
  site_contact: Jsonb | null;
  site_access_notes: string | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PermitRecordTable {
  id: GeneratedUuid;
  project_id: string;
  plan_item_key: string | null;
  jurisdiction: string;
  permit_type: string;
  authority: string;
  number: string | null;
  applied_at: DateText | null;
  issued_at: DateText | null;
  expires_at: DateText | null;
  inspection_results: Jsonb;
  evidence: Jsonb;
  status: 'planned' | 'applied' | 'issued' | 'rejected' | 'expired' | 'closed';
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ProjectDiaryEntryTable {
  id: GeneratedUuid;
  project_id: string;
  author_person_id: string;
  entry_date: DateText;
  body: string;
  evidence: Jsonb;
  plan_item_key: string | null;
  visibility: Generated<'owner_private' | 'participants'>;
  created_at: GeneratedTimestamp;
}

export type PlanRow = Selectable<PlanTable>;
export type PlanVersionRow = Selectable<PlanVersionTable>;
export type PlanItemRow = Selectable<PlanItemTable>;
export type NewPlanItemRow = Insertable<PlanItemTable>;
export type PlanDependencyRow = Selectable<PlanDependencyTable>;
export type PlanItemStateRow = Selectable<PlanItemStateTable>;
export type PlanChangeRow = Selectable<PlanChangeTable>;
export type PlanShareRow = Selectable<PlanShareTable>;
export type ProjectLocationRow = Selectable<ProjectLocationTable>;
export type PermitRecordRow = Selectable<PermitRecordTable>;
export type ProjectDiaryEntryRow = Selectable<ProjectDiaryEntryTable>;

export interface PlansDatabase {
  plan: PlanTable;
  plan_version: PlanVersionTable;
  plan_item: PlanItemTable;
  plan_dependency: PlanDependencyTable;
  plan_item_state: PlanItemStateTable;
  plan_change: PlanChangeTable;
  plan_share: PlanShareTable;
  project_location: ProjectLocationTable;
  permit_record: PermitRecordTable;
  project_diary_entry: ProjectDiaryEntryTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends PlansDatabase {}
}

const columns = columnsOf<PlansDatabase>();
export const TABLE_COLUMNS: TableColumns<PlansDatabase> = {
  plan: columns('plan', ['id', 'project_id', 'status', 'current_version_id', 'time_zone', 'created_by_person_id', 'drafted_via', 'drafted_mandate_id', 'revision', 'created_at', 'updated_at']),
  plan_version: columns('plan_version', [
    'id', 'plan_id', 'project_id', 'version', 'status', 'content', 'digest', 'based_on_version_id', 'drafted_by_person_id', 'drafted_via', 'drafted_mandate_id',
    'proposed_by_person_id', 'proposed_via', 'proposed_mandate_id', 'proposed_at', 'approved_by_person_id', 'approved_at', 'superseded_at', 'superseded_by_version_id',
    'superseded_reason', 'change_id', 'revision', 'created_at', 'updated_at',
  ]),
  plan_item: columns('plan_item', [
    'id', 'plan_version_id', 'plan_id', 'project_id', 'item_key', 'parent_key', 'position', 'kind', 'title', 'description', 'step_terms', 'required_skills',
    'quantity_value', 'quantity_unit', 'estimate_low', 'estimate_high', 'estimate_currency', 'estimate_basis', 'estimate_basis_ref', 'estimate_as_of',
    'duration_low_days', 'duration_high_days', 'window_start', 'window_finish', 'risk_level', 'decision_question', 'sources', 'attachments', 'private_notes', 'created_at',
  ]),
  plan_dependency: columns('plan_dependency', ['plan_version_id', 'plan_id', 'project_id', 'predecessor_key', 'successor_key', 'type', 'lag_days', 'created_at']),
  plan_item_state: columns('plan_item_state', [
    'plan_id', 'project_id', 'item_key', 'status', 'path', 'link_kind', 'link_id', 'blocked_from', 'actual_start', 'actual_end', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  plan_change: columns('plan_change', [
    'id', 'plan_id', 'project_id', 'from_version_id', 'to_version_id', 'reason', 'cause', 'requested_by_person_id', 'requested_by_company_id', 'accountable_person_id',
    'accountable_company_id', 'agreement_id', 'schedule_impact_days', 'status', 'created_by_person_id', 'decided_by_person_id', 'decided_at', 'revision', 'created_at', 'updated_at',
  ]),
  plan_share: columns('plan_share', [
    'id', 'plan_id', 'project_id', 'item_key', 'audience', 'invitee_person_id', 'invitee_company_id', 'fields', 'acceptance_kind', 'acceptance_id', 'preview_digest',
    'confirmed_by_person_id', 'confirmed_at', 'valid_until', 'revoked_at', 'revoked_by_person_id', 'revoked_reason', 'revision', 'created_at', 'updated_at',
  ]),
  project_location: columns('project_location', ['project_id', 'address', 'region_code', 'cadastral_ref', 'site_contact', 'site_access_notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at']),
  permit_record: columns('permit_record', [
    'id', 'project_id', 'plan_item_key', 'jurisdiction', 'permit_type', 'authority', 'number', 'applied_at', 'issued_at', 'expires_at', 'inspection_results', 'evidence', 'status',
    'created_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  project_diary_entry: columns('project_diary_entry', ['id', 'project_id', 'author_person_id', 'entry_date', 'body', 'evidence', 'plan_item_key', 'visibility', 'created_at']),
};
