import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Profiles module (PPL-001, packages/data/migrations/profiles): the person's profile and preferences, consent records,
 * media licences and portraits, experience entries, follows, bookmarks, reading progress and the tombstones that keep
 * withdrawn projections gone. Every table is under FORCE RLS and readable only by its person; public reads go through
 * `trustwork.profiles_public_profile`, `trustwork.profiles_company_people` and `trustwork.profiles_consented_mentions`.
 */
/** date: node-postgres parses `date` as local midnight; repositories normalise it to an ISO date. */
type DateColumn = ColumnType<string | Date, string, string>;

export interface PersonProfileTable {
  person_id: string;
  role_line: string | null;
  region_code: string | null;
  show_employer: Generated<boolean>;
  topics: Generated<string[]>;
  languages: Generated<string[]>;
  public_fields: Generated<string[]>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PersonPreferenceTable {
  person_id: string;
  intents: Generated<string[]>;
  topics: Generated<string[]>;
  regions: Generated<string[]>;
  onboarding_completed_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ConsentRecordTable {
  id: GeneratedUuid;
  subject_person_id: string;
  purpose: string;
  target_kind: string | null;
  target_id: string | null;
  notice_version: string;
  granted_at: GeneratedTimestamp;
  /** jsonb `{ method: 'first_party_form', requestId }`, written as a JSON string. */
  evidence: ColumnType<unknown, string, string>;
  withdrawn_at: Timestamp | null;
  withdrawn_reason: string | null;
  created_at: GeneratedTimestamp;
}

export interface MediaLicenceTable {
  id: GeneratedUuid;
  asset_id: string;
  owner_person_id: string;
  licensor: string;
  licence_kind: 'own_work' | 'licensed' | 'cc_by' | 'cc_by_sa' | 'public_domain';
  scope: string;
  valid_until: Timestamp | null;
  recorded_by_person_id: string;
  revoked_at: Timestamp | null;
  revoked_by_person_id: string | null;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PortraitTable {
  id: GeneratedUuid;
  person_id: string;
  asset_id: string;
  media_licence_id: string;
  consent_record_id: string | null;
  status: 'pending' | 'shown' | 'withdrawn';
  withdrawn_at: Timestamp | null;
  withdrawn_reason: 'consent_withdrawn' | 'licence_revoked' | 'replaced' | 'removed' | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ExperienceEntryTable {
  id: GeneratedUuid;
  person_id: string;
  organisation_company_id: string | null;
  organisation_name: string;
  role: string;
  summary: string | null;
  from_date: DateColumn;
  to_date: DateColumn | null;
  visibility: Generated<'public' | 'private'>;
  confirmed_by_company_at: Timestamp | null;
  confirmed_by_person_id: string | null;
  archived_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface FollowTable {
  id: GeneratedUuid;
  follower_person_id: string;
  target_kind: 'person' | 'company' | 'topic' | 'region' | 'hub' | 'event_series';
  target_id: string | null;
  target_code: string | null;
  created_at: GeneratedTimestamp;
  ended_at: Timestamp | null;
}

export interface BookmarkTable {
  id: GeneratedUuid;
  person_id: string;
  target_kind: 'publication' | 'event' | 'course' | 'project' | 'person' | 'company' | 'offering' | 'need';
  target_id: string;
  created_at: GeneratedTimestamp;
  removed_at: Timestamp | null;
}

export interface ReadingProgressTable {
  person_id: string;
  publication_version_id: string;
  progress: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ProfileTombstoneTable {
  id: GeneratedUuid;
  subject_person_id: string;
  projection: 'profile' | 'portrait' | 'company_listing' | 'publication_mention' | 'speaker_link' | 'project_participant' | 'consented_use';
  target_kind: string | null;
  target_id: string | null;
  consent_record_id: string | null;
  portrait_id: string | null;
  reason: 'consent_withdrawn' | 'licence_revoked' | 'portrait_replaced' | 'portrait_removed';
  created_at: GeneratedTimestamp;
}

export interface ProfilesDatabase {
  person_profile: PersonProfileTable;
  person_preference: PersonPreferenceTable;
  consent_record: ConsentRecordTable;
  media_licence: MediaLicenceTable;
  portrait: PortraitTable;
  experience_entry: ExperienceEntryTable;
  follow: FollowTable;
  bookmark: BookmarkTable;
  reading_progress: ReadingProgressTable;
  profile_tombstone: ProfileTombstoneTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the profiles tables into Database
  interface Database extends ProfilesDatabase {}
}

export type PersonProfileRow = Selectable<PersonProfileTable>;
export type PersonPreferenceRow = Selectable<PersonPreferenceTable>;
export type ConsentRecordRow = Selectable<ConsentRecordTable>;
export type MediaLicenceRow = Selectable<MediaLicenceTable>;
export type PortraitRow = Selectable<PortraitTable>;
export type ExperienceEntryRow = Selectable<ExperienceEntryTable>;
export type NewExperienceEntryRow = Insertable<ExperienceEntryTable>;
export type FollowRow = Selectable<FollowTable>;
export type BookmarkRow = Selectable<BookmarkTable>;
export type ReadingProgressRow = Selectable<ReadingProgressTable>;
export type ProfileTombstoneRow = Selectable<ProfileTombstoneTable>;

const columns = columnsOf<ProfilesDatabase>();
export const TABLE_COLUMNS: TableColumns<ProfilesDatabase> = {
  person_profile: columns('person_profile', ['person_id', 'role_line', 'region_code', 'show_employer', 'topics', 'languages', 'public_fields', 'revision', 'created_at', 'updated_at']),
  person_preference: columns('person_preference', ['person_id', 'intents', 'topics', 'regions', 'onboarding_completed_at', 'revision', 'created_at', 'updated_at']),
  consent_record: columns('consent_record', ['id', 'subject_person_id', 'purpose', 'target_kind', 'target_id', 'notice_version', 'granted_at', 'evidence', 'withdrawn_at', 'withdrawn_reason', 'created_at']),
  media_licence: columns('media_licence', [
    'id', 'asset_id', 'owner_person_id', 'licensor', 'licence_kind', 'scope', 'valid_until', 'recorded_by_person_id', 'revoked_at', 'revoked_by_person_id', 'revoked_reason', 'revision', 'created_at', 'updated_at',
  ]),
  portrait: columns('portrait', ['id', 'person_id', 'asset_id', 'media_licence_id', 'consent_record_id', 'status', 'withdrawn_at', 'withdrawn_reason', 'revision', 'created_at', 'updated_at']),
  experience_entry: columns('experience_entry', [
    'id', 'person_id', 'organisation_company_id', 'organisation_name', 'role', 'summary', 'from_date', 'to_date', 'visibility', 'confirmed_by_company_at', 'confirmed_by_person_id',
    'archived_at', 'revision', 'created_at', 'updated_at',
  ]),
  follow: columns('follow', ['id', 'follower_person_id', 'target_kind', 'target_id', 'target_code', 'created_at', 'ended_at']),
  bookmark: columns('bookmark', ['id', 'person_id', 'target_kind', 'target_id', 'created_at', 'removed_at']),
  reading_progress: columns('reading_progress', ['person_id', 'publication_version_id', 'progress', 'revision', 'created_at', 'updated_at']),
  profile_tombstone: columns('profile_tombstone', ['id', 'subject_person_id', 'projection', 'target_kind', 'target_id', 'consent_record_id', 'portrait_id', 'reason', 'created_at']),
};
