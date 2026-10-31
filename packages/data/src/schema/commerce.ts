import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Commerce slice 1 (COM-001, packages/data/migrations/commerce): the catalogue (offerings, versions, bundle components,
 * private commercial knowledge), needs with append-only line sets, RFQs, their immutable versions, the buyer-private
 * constraint and invitations pinned to the exact version. Every table is under FORCE RLS.
 */
export type OfferingKindValue = 'goods' | 'works' | 'services' | 'bundle';
export type OfferingStatusValue = 'draft' | 'active' | 'archived';
export type VersionStatusValue = 'draft' | 'published' | 'superseded';
export type LineKindValue = 'goods' | 'works' | 'services';
export type CommerceVia = 'person' | 'agent';
export type NeedSourceValue = 'manual' | 'file' | 'email' | 'assistant';
export type NeedStatusValue = 'draft' | 'clarifying' | 'ready' | 'converted';
export type RfqStatusValue = 'draft' | 'published' | 'closed' | 'cancelled' | 'expired';
export type InvitationStatusValue = 'sent' | 'viewed' | 'declined' | 'responded' | 'withdrawn';
export type StaleReasonValue = 'rfq_amended' | 'rfq_closed';
export type InvitationChannelValue = 'platform' | 'email' | 'assistant';
/** jsonb: read as parsed JSON, written as a JSON string. */
export type Jsonb = ColumnType<unknown, string, string>;
/** bigint: node-postgres returns int8 as a string. */
export type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;
/** date: read as a Date or text, written as an ISO date. */
export type DateText = ColumnType<string | Date, string, string>;

export interface OfferingTable {
  id: GeneratedUuid;
  owner_person_id: string | null;
  owner_company_id: string | null;
  created_by_person_id: string;
  kind: OfferingKindValue;
  status: Generated<OfferingStatusValue>;
  current_version: number | null;
  current_version_id: string | null;
  archived_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OfferingVersionTable {
  id: GeneratedUuid;
  offering_id: string;
  version: number;
  status: Generated<VersionStatusValue>;
  payload: Jsonb;
  public_fields: string[];
  digest: string | null;
  drafted_by_person_id: string;
  published_at: Timestamp | null;
  published_by_person_id: string | null;
  published_via: CommerceVia | null;
  published_mandate_id: string | null;
  superseded_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface BundleComponentTable {
  offering_version_id: string;
  /** Set by the guard from the version. */
  offering_id: ColumnType<string, string | undefined, never>;
  position: number;
  component_offering_id: string;
  component_version: number;
  /** Set by the guard: the pinned published component version. */
  component_version_id: ColumnType<string, string | undefined, never>;
  quantity_value: string;
  quantity_unit: string;
  created_at: GeneratedTimestamp;
}

export interface OfferingVersionPrivateTable {
  offering_version_id: string;
  offering_id: string;
  cost_basis_minor: Int8 | null;
  cost_basis_currency: string | null;
  margin_target: string | null;
  notes: string | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NeedTable {
  id: GeneratedUuid;
  owner_person_id: string | null;
  owner_company_id: string | null;
  project_id: string | null;
  created_by_person_id: string;
  source: NeedSourceValue;
  status: Generated<NeedStatusValue>;
  title: string;
  description: string | null;
  region: string | null;
  window_from: DateText | null;
  window_to: DateText | null;
  window_time_zone: string | null;
  window_to_time_zone: string | null;
  acceptance_criteria: string | null;
  missing_fields: string[];
  rfq_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NeedLineTable {
  id: GeneratedUuid;
  need_id: string;
  need_revision: number;
  position: number;
  kind: LineKindValue | null;
  description: string;
  quantity_value: string | null;
  quantity_unit: string | null;
  specification: Jsonb;
  alternatives_allowed: boolean;
  evidence: Jsonb | null;
  created_at: GeneratedTimestamp;
}

export interface RfqTable {
  id: GeneratedUuid;
  owner_person_id: string | null;
  owner_company_id: string | null;
  project_id: string | null;
  creator_person_id: string;
  need_id: string | null;
  plan_project_id: string | null;
  plan_item_key: string | null;
  status: Generated<RfqStatusValue>;
  current_version: number | null;
  current_version_id: string | null;
  public_projection_enabled: boolean;
  public_projection_fields: string[];
  category: string | null;
  closed_at: Timestamp | null;
  closed_by_person_id: string | null;
  closed_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RfqVersionTable {
  id: GeneratedUuid;
  rfq_id: string;
  version: number;
  status: Generated<VersionStatusValue>;
  payload: Jsonb;
  digest: string | null;
  drafted_by_person_id: string;
  published_at: Timestamp | null;
  published_by_person_id: string | null;
  published_via: CommerceVia | null;
  published_mandate_id: string | null;
  superseded_by: number | null;
  superseded_at: Timestamp | null;
  amendment_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RfqPrivateConstraintTable {
  rfq_id: string;
  owner_person_id: string | null;
  owner_company_id: string | null;
  budget_ceiling_minor: Int8 | null;
  budget_ceiling_currency: string | null;
  evaluation_weights: Jsonb;
  internal_notes: string;
  shortlist: Jsonb;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RfqInvitationTable {
  id: GeneratedUuid;
  rfq_id: string;
  rfq_version_id: string;
  party_person_id: string | null;
  party_company_id: string | null;
  channel: InvitationChannelValue;
  status: Generated<InvitationStatusValue>;
  stale_reason: StaleReasonValue | null;
  stale_at: Timestamp | null;
  sent_at: GeneratedTimestamp;
  sent_by_person_id: string;
  sent_via: CommerceVia;
  sent_by_mandate_id: string | null;
  revalidates_invitation_id: string | null;
  withdrawn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type OfferingRow = Selectable<OfferingTable>;
export type OfferingVersionRow = Selectable<OfferingVersionTable>;
export type BundleComponentRow = Selectable<BundleComponentTable>;
export type OfferingVersionPrivateRow = Selectable<OfferingVersionPrivateTable>;
export type NeedRow = Selectable<NeedTable>;
export type NeedLineRow = Selectable<NeedLineTable>;
export type NewNeedLineRow = Insertable<NeedLineTable>;
export type RfqRow = Selectable<RfqTable>;
export type RfqVersionRow = Selectable<RfqVersionTable>;
export type RfqPrivateConstraintRow = Selectable<RfqPrivateConstraintTable>;
export type RfqInvitationRow = Selectable<RfqInvitationTable>;

export interface CommerceDatabase {
  offering: OfferingTable;
  offering_version: OfferingVersionTable;
  bundle_component: BundleComponentTable;
  offering_version_private: OfferingVersionPrivateTable;
  need: NeedTable;
  need_line: NeedLineTable;
  rfq: RfqTable;
  rfq_version: RfqVersionTable;
  rfq_private_constraint: RfqPrivateConstraintTable;
  rfq_invitation: RfqInvitationTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends CommerceDatabase {}
}

const columns = columnsOf<CommerceDatabase>();
export const TABLE_COLUMNS: TableColumns<CommerceDatabase> = {
  offering: columns('offering', ['id', 'owner_person_id', 'owner_company_id', 'created_by_person_id', 'kind', 'status', 'current_version', 'current_version_id', 'archived_reason', 'revision', 'created_at', 'updated_at']),
  offering_version: columns('offering_version', [
    'id', 'offering_id', 'version', 'status', 'payload', 'public_fields', 'digest', 'drafted_by_person_id', 'published_at', 'published_by_person_id', 'published_via', 'published_mandate_id',
    'superseded_at', 'revision', 'created_at', 'updated_at',
  ]),
  bundle_component: columns('bundle_component', ['offering_version_id', 'offering_id', 'position', 'component_offering_id', 'component_version', 'component_version_id', 'quantity_value', 'quantity_unit', 'created_at']),
  offering_version_private: columns('offering_version_private', ['offering_version_id', 'offering_id', 'cost_basis_minor', 'cost_basis_currency', 'margin_target', 'notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at']),
  need: columns('need', [
    'id', 'owner_person_id', 'owner_company_id', 'project_id', 'created_by_person_id', 'source', 'status', 'title', 'description', 'region', 'window_from', 'window_to', 'window_time_zone',
    'window_to_time_zone', 'acceptance_criteria', 'missing_fields', 'rfq_id', 'revision', 'created_at', 'updated_at',
  ]),
  need_line: columns('need_line', ['id', 'need_id', 'need_revision', 'position', 'kind', 'description', 'quantity_value', 'quantity_unit', 'specification', 'alternatives_allowed', 'evidence', 'created_at']),
  rfq: columns('rfq', [
    'id', 'owner_person_id', 'owner_company_id', 'project_id', 'creator_person_id', 'need_id', 'plan_project_id', 'plan_item_key', 'status', 'current_version', 'current_version_id',
    'public_projection_enabled', 'public_projection_fields', 'category', 'closed_at', 'closed_by_person_id', 'closed_reason', 'revision', 'created_at', 'updated_at',
  ]),
  rfq_version: columns('rfq_version', [
    'id', 'rfq_id', 'version', 'status', 'payload', 'digest', 'drafted_by_person_id', 'published_at', 'published_by_person_id', 'published_via', 'published_mandate_id', 'superseded_by',
    'superseded_at', 'amendment_reason', 'revision', 'created_at', 'updated_at',
  ]),
  rfq_private_constraint: columns('rfq_private_constraint', [
    'rfq_id', 'owner_person_id', 'owner_company_id', 'budget_ceiling_minor', 'budget_ceiling_currency', 'evaluation_weights', 'internal_notes', 'shortlist', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  rfq_invitation: columns('rfq_invitation', [
    'id', 'rfq_id', 'rfq_version_id', 'party_person_id', 'party_company_id', 'channel', 'status', 'stale_reason', 'stale_at', 'sent_at', 'sent_by_person_id', 'sent_via', 'sent_by_mandate_id',
    'revalidates_invitation_id', 'withdrawn_reason', 'revision', 'created_at', 'updated_at',
  ]),
};
