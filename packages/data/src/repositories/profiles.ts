import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  BookmarkRow, ConsentRecordRow, ExperienceEntryRow, FollowRow, MediaLicenceRow, NewExperienceEntryRow, PersonPreferenceRow, PersonProfileRow, PortraitRow, ProfileTombstoneRow,
  ReadingProgressRow,
} from '../schema/profiles.js';

/**
 * Profiles repository (PPL-001). Thin typed access under `withPrincipal`: RLS limits every table to the principal's own
 * rows, and the guards in packages/data/migrations/profiles keep consent records and licences immutable except for
 * their one withdrawal or revocation, require consent and licence for a shown portrait, and unpublish dependent
 * projections with tombstones in the same transaction. Public reads call the owner-run allowlisted functions.
 */

/** node-postgres parses `date` as local midnight; local getters give back the calendar date in every time zone. */
export function isoDay(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export interface PersonPublicRow {
  id: string;
  display_name: string | null;
  profile_visibility: 'private' | 'public';
  public_headline: string | null;
  public_expertise: string[];
  revision: number;
}

export const profileIdentity = {
  get(trx: Transaction, personId: string): Promise<PersonPublicRow | undefined> {
    return trx.selectFrom('person').select(['id', 'display_name', 'profile_visibility', 'public_headline', 'public_expertise', 'revision']).where('id', '=', personId).executeTakeFirst();
  },
  /** Serializes concurrent edits of one person's profile (identity columns and the profile row). */
  lock(trx: Transaction, personId: string): Promise<PersonPublicRow | undefined> {
    return trx.selectFrom('person').select(['id', 'display_name', 'profile_visibility', 'public_headline', 'public_expertise', 'revision']).where('id', '=', personId).forUpdate().executeTakeFirst();
  },
  async setPublicText(trx: Transaction, personId: string, values: { headline: string | null; expertise: string[] }): Promise<void> {
    await trx.updateTable('person').set({ public_headline: values.headline, public_expertise: values.expertise }).where('id', '=', personId).execute();
  },
  /** Going public needs a live profile_public consent (database trigger); going private needs nothing. */
  async setVisibility(trx: Transaction, personId: string, visibility: 'private' | 'public'): Promise<void> {
    await trx.updateTable('person').set({ profile_visibility: visibility }).where('id', '=', personId).execute();
  },
};

export const personProfiles = {
  get(trx: Transaction, personId: string): Promise<PersonProfileRow | undefined> {
    return trx.selectFrom('person_profile').selectAll().where('person_id', '=', personId).executeTakeFirst();
  },
  insert(trx: Transaction, row: { person_id: string; role_line: string | null; region_code: string | null; show_employer: boolean; topics: string[]; languages: string[]; public_fields: string[] }): Promise<PersonProfileRow> {
    return trx.insertInto('person_profile').values(row).returningAll().executeTakeFirstOrThrow();
  },
  /** `undefined` when the revision moved (a concurrent editor won). */
  update(trx: Transaction, personId: string, expectedRevision: number, values: { role_line: string | null; region_code: string | null; show_employer: boolean; topics: string[]; languages: string[]; public_fields: string[] }): Promise<PersonProfileRow | undefined> {
    return trx.updateTable('person_profile').set(values).where('person_id', '=', personId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const personPreferences = {
  get(trx: Transaction, personId: string): Promise<PersonPreferenceRow | undefined> {
    return trx.selectFrom('person_preference').selectAll().where('person_id', '=', personId).executeTakeFirst();
  },
  insert(trx: Transaction, row: { person_id: string; intents: string[]; topics: string[]; regions: string[]; onboarding_completed_at: Date | null }): Promise<PersonPreferenceRow> {
    return trx.insertInto('person_preference').values(row).returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, personId: string, expectedRevision: number, values: { intents: string[]; topics: string[]; regions: string[]; onboarding_completed_at: Date | null }): Promise<PersonPreferenceRow | undefined> {
    return trx.updateTable('person_preference').set(values).where('person_id', '=', personId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const consentRecords = {
  listForSubject(trx: Transaction, personId: string): Promise<ConsentRecordRow[]> {
    return trx.selectFrom('consent_record').selectAll().where('subject_person_id', '=', personId).orderBy('granted_at', 'desc').orderBy('id').execute();
  },
  get(trx: Transaction, id: string): Promise<ConsentRecordRow | undefined> {
    return trx.selectFrom('consent_record').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<ConsentRecordRow | undefined> {
    return trx.selectFrom('consent_record').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  live(trx: Transaction, personId: string, purpose: string, target: { kind: string; id: string } | null): Promise<ConsentRecordRow | undefined> {
    let q = trx.selectFrom('consent_record').selectAll().where('subject_person_id', '=', personId).where('purpose', '=', purpose).where('withdrawn_at', 'is', null);
    q = target === null ? q.where('target_kind', 'is', null) : q.where('target_kind', '=', target.kind).where('target_id', '=', target.id);
    return q.executeTakeFirst();
  },
  insert(trx: Transaction, row: { subject_person_id: string; purpose: string; target_kind: string | null; target_id: string | null; notice_version: string; evidence: unknown }): Promise<ConsentRecordRow> {
    return trx.insertInto('consent_record').values({ ...row, evidence: JSON.stringify(row.evidence) }).returningAll().executeTakeFirstOrThrow();
  },
  /** Sets the withdrawal; the database trigger unpublishes the dependent projection and writes the tombstone. */
  withdraw(trx: Transaction, id: string, reason: string): Promise<ConsentRecordRow | undefined> {
    return trx.updateTable('consent_record').set({ withdrawn_at: new Date(), withdrawn_reason: reason }).where('id', '=', id).where('withdrawn_at', 'is', null).returningAll().executeTakeFirst();
  },
};

export const mediaLicences = {
  listForOwner(trx: Transaction, personId: string): Promise<MediaLicenceRow[]> {
    return trx.selectFrom('media_licence').selectAll().where('owner_person_id', '=', personId).orderBy('created_at', 'desc').orderBy('id').execute();
  },
  get(trx: Transaction, id: string): Promise<MediaLicenceRow | undefined> {
    return trx.selectFrom('media_licence').selectAll().where('id', '=', id).executeTakeFirst();
  },
  insert(trx: Transaction, row: { asset_id: string; owner_person_id: string; licensor: string; licence_kind: MediaLicenceRow['licence_kind']; scope: string; valid_until: string | null; recorded_by_person_id: string }): Promise<MediaLicenceRow> {
    return trx.insertInto('media_licence').values(row).returningAll().executeTakeFirstOrThrow();
  },
  revoke(trx: Transaction, id: string, personId: string, reason: string): Promise<MediaLicenceRow | undefined> {
    return trx.updateTable('media_licence').set({ revoked_at: new Date(), revoked_by_person_id: personId, revoked_reason: reason }).where('id', '=', id).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
  },
};

export const portraits = {
  listForPerson(trx: Transaction, personId: string): Promise<PortraitRow[]> {
    return trx.selectFrom('portrait').selectAll().where('person_id', '=', personId).orderBy('created_at', 'desc').orderBy('id').execute();
  },
  /** The shown portrait, row-locked so two concurrent replacements serialize. */
  lockShown(trx: Transaction, personId: string): Promise<PortraitRow | undefined> {
    return trx.selectFrom('portrait').selectAll().where('person_id', '=', personId).where('status', '=', 'shown').forUpdate().executeTakeFirst();
  },
  insertShown(trx: Transaction, row: { person_id: string; asset_id: string; media_licence_id: string; consent_record_id: string }): Promise<PortraitRow> {
    return trx.insertInto('portrait').values({ ...row, status: 'shown' }).returningAll().executeTakeFirstOrThrow();
  },
  withdraw(trx: Transaction, id: string, reason: 'replaced' | 'removed', expectedRevision?: number): Promise<PortraitRow | undefined> {
    let q = trx.updateTable('portrait').set({ status: 'withdrawn', withdrawn_at: new Date(), withdrawn_reason: reason }).where('id', '=', id).where('status', '<>', 'withdrawn');
    if (expectedRevision !== undefined) q = q.where('revision', '=', expectedRevision);
    return q.returningAll().executeTakeFirst();
  },
};

export const experienceEntries = {
  listForPerson(trx: Transaction, personId: string, includeArchived = false): Promise<ExperienceEntryRow[]> {
    let q = trx.selectFrom('experience_entry').selectAll().where('person_id', '=', personId);
    if (!includeArchived) q = q.where('archived_at', 'is', null);
    return q.orderBy('from_date', 'desc').orderBy('id').execute();
  },
  get(trx: Transaction, id: string): Promise<ExperienceEntryRow | undefined> {
    return trx.selectFrom('experience_entry').selectAll().where('id', '=', id).executeTakeFirst();
  },
  insert(trx: Transaction, row: NewExperienceEntryRow): Promise<ExperienceEntryRow> {
    return trx.insertInto('experience_entry').values(row).returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, id: string, expectedRevision: number, values: Pick<NewExperienceEntryRow, 'organisation_company_id' | 'organisation_name' | 'role' | 'summary' | 'from_date' | 'to_date' | 'visibility'>): Promise<ExperienceEntryRow | undefined> {
    return trx.updateTable('experience_entry').set(values).where('id', '=', id).where('revision', '=', expectedRevision).where('archived_at', 'is', null).returningAll().executeTakeFirst();
  },
  archive(trx: Transaction, id: string, expectedRevision: number): Promise<ExperienceEntryRow | undefined> {
    return trx.updateTable('experience_entry').set({ archived_at: new Date() }).where('id', '=', id).where('revision', '=', expectedRevision).where('archived_at', 'is', null).returningAll().executeTakeFirst();
  },
};

export const follows = {
  listForPerson(trx: Transaction, personId: string): Promise<FollowRow[]> {
    return trx.selectFrom('follow').selectAll().where('follower_person_id', '=', personId).where('ended_at', 'is', null).orderBy('created_at', 'desc').orderBy('id').execute();
  },
  insert(trx: Transaction, row: { follower_person_id: string; target_kind: FollowRow['target_kind']; target_id: string | null; target_code: string | null }): Promise<FollowRow> {
    return trx.insertInto('follow').values(row).returningAll().executeTakeFirstOrThrow();
  },
  end(trx: Transaction, id: string): Promise<FollowRow | undefined> {
    return trx.updateTable('follow').set({ ended_at: new Date() }).where('id', '=', id).where('ended_at', 'is', null).returningAll().executeTakeFirst();
  },
};

export const bookmarks = {
  listForPerson(trx: Transaction, personId: string): Promise<BookmarkRow[]> {
    return trx.selectFrom('bookmark').selectAll().where('person_id', '=', personId).where('removed_at', 'is', null).orderBy('created_at', 'desc').orderBy('id').execute();
  },
  insert(trx: Transaction, row: { person_id: string; target_kind: BookmarkRow['target_kind']; target_id: string }): Promise<BookmarkRow> {
    return trx.insertInto('bookmark').values(row).returningAll().executeTakeFirstOrThrow();
  },
  remove(trx: Transaction, id: string): Promise<BookmarkRow | undefined> {
    return trx.updateTable('bookmark').set({ removed_at: new Date() }).where('id', '=', id).where('removed_at', 'is', null).returningAll().executeTakeFirst();
  },
};

export const readingProgress = {
  listForPerson(trx: Transaction, personId: string): Promise<ReadingProgressRow[]> {
    return trx.selectFrom('reading_progress').selectAll().where('person_id', '=', personId).orderBy('updated_at', 'desc').orderBy('publication_version_id').execute();
  },
  /** Last write wins; the row is the person's own. */
  upsert(trx: Transaction, row: { person_id: string; publication_version_id: string; progress: string }): Promise<ReadingProgressRow> {
    return trx.insertInto('reading_progress').values(row)
      .onConflict((oc) => oc.columns(['person_id', 'publication_version_id']).doUpdateSet({ progress: (eb) => eb.ref('excluded.progress') }))
      .returningAll().executeTakeFirstOrThrow();
  },
};

export const profileTombstones = {
  listForSubject(trx: Transaction, personId: string): Promise<ProfileTombstoneRow[]> {
    return trx.selectFrom('profile_tombstone').selectAll().where('subject_person_id', '=', personId).orderBy('created_at').orderBy('id').execute();
  },
};

/** Shape returned by `trustwork.profiles_public_profile` (public columns of a public, consented profile). */
export interface PublicProfileJson {
  id: string;
  handle: string | null;
  displayName: string | null;
  headline: string | null;
  expertise: string[];
  roleLine: string | null;
  regionCode: string | null;
  topics: string[];
  languages: string[];
  publicFields: string[];
  employer: { companyId: string; name: string } | null;
  portrait: { portraitId: string; assetId: string } | null;
  experience: { id: string; organisation: { companyId: string | null; name: string }; role: string; summary: string | null; from: string; to: string | null; confirmation: 'self_declared' | 'company_confirmed' }[];
}
export interface CompanyPersonRow { id: string; display_name: string | null; public_headline: string | null; handle: string | null }

export const publicProfiles = {
  /** `undefined` unless the profile is public and its profile_public consent is live. Identical for every caller. */
  async profile(trx: Transaction, personId: string): Promise<PublicProfileJson | undefined> {
    const { rows } = await sql<{ profile: PublicProfileJson | null }>`SELECT trustwork.profiles_public_profile(${personId}::uuid) AS profile`.execute(trx);
    return rows[0]?.profile ?? undefined;
  },
  async companyPeople(trx: Transaction, companyId: string): Promise<CompanyPersonRow[]> {
    const { rows } = await sql<CompanyPersonRow>`SELECT id, display_name, public_headline, handle FROM trustwork.profiles_company_people(${companyId}::uuid)`.execute(trx);
    return rows;
  },
  async consentedMentions(trx: Transaction, publicationId: string, personIds: readonly string[]): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`SELECT m AS id FROM trustwork.profiles_consented_mentions(${publicationId}::uuid, ${[...personIds]}::uuid[]) AS m`.execute(trx);
    return rows.map((r) => r.id);
  },
};
