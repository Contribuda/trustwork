import {
  BookmarkSchema, CompanyListedPersonSchema, ConsentRecordSchema, ExperienceEntrySchema, FollowSchema, isoDay, MediaLicenceSchema, PersonPreferenceSchema, PersonProfileSchema, PortraitSchema,
  ReadingProgressSchema, toPublicPersonProfile,
  type Bookmark, type BookmarkRow, type CompanyListedPerson, type CompanyPersonRow, type ConsentRecord, type ConsentRecordRow, type ExperienceEntry, type ExperienceEntryRow, type Follow, type FollowRow,
  type MediaLicence, type MediaLicenceRow, type PersonPreference, type PersonPreferenceRow, type PersonProfile, type PersonProfileRow, type Portrait, type PortraitRow, type PublicPersonProfile,
  type PublicProfileJson, type ReadingProgress, type ReadingProgressRow,
} from './deps.js';

/** Row -> contract serializers of the profiles slice; every output is re-validated by its strict schema. */
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const isoOrNull = (value: Date | string | null): string | null => (value === null ? null : iso(value));

export function toProfile(row: PersonProfileRow): PersonProfile {
  return PersonProfileSchema.parse({
    personId: row.person_id, roleLine: row.role_line, regionCode: row.region_code, showEmployer: row.show_employer, topics: row.topics, languages: row.languages,
    publicFields: row.public_fields, revision: row.revision, updatedAt: iso(row.updated_at),
  });
}

export function toPreference(row: PersonPreferenceRow): PersonPreference {
  return PersonPreferenceSchema.parse({
    personId: row.person_id, intents: row.intents, topics: row.topics, regions: row.regions, onboardingCompletedAt: isoOrNull(row.onboarding_completed_at), revision: row.revision, updatedAt: iso(row.updated_at),
  });
}

export function toConsent(row: ConsentRecordRow): ConsentRecord {
  return ConsentRecordSchema.parse({
    id: row.id, subjectPersonId: row.subject_person_id, purpose: row.purpose, target: row.target_kind && row.target_id ? { kind: row.target_kind, id: row.target_id } : null,
    noticeVersion: row.notice_version, grantedAt: iso(row.granted_at), evidence: row.evidence, withdrawnAt: isoOrNull(row.withdrawn_at), withdrawnReason: row.withdrawn_reason,
  });
}

export function toLicence(row: MediaLicenceRow): MediaLicence {
  return MediaLicenceSchema.parse({
    id: row.id, assetId: row.asset_id, licensor: row.licensor, licenceKind: row.licence_kind, scope: row.scope, validUntil: isoOrNull(row.valid_until),
    recordedByPersonId: row.recorded_by_person_id, revokedAt: isoOrNull(row.revoked_at), createdAt: iso(row.created_at),
  });
}

export function toPortrait(row: PortraitRow): Portrait {
  return PortraitSchema.parse({
    id: row.id, personId: row.person_id, assetId: row.asset_id, mediaLicenceId: row.media_licence_id, consentRecordId: row.consent_record_id, status: row.status,
    withdrawnAt: isoOrNull(row.withdrawn_at), withdrawnReason: row.withdrawn_reason, revision: row.revision, createdAt: iso(row.created_at),
  });
}

export function toExperience(row: ExperienceEntryRow): ExperienceEntry {
  return ExperienceEntrySchema.parse({
    id: row.id, personId: row.person_id, organisation: { companyId: row.organisation_company_id, name: row.organisation_name }, role: row.role, summary: row.summary,
    from: isoDay(row.from_date), to: isoDay(row.to_date), visibility: row.visibility,
    confirmation: row.confirmed_by_company_at ? 'company_confirmed' : 'self_declared', confirmedAt: isoOrNull(row.confirmed_by_company_at),
    archivedAt: isoOrNull(row.archived_at), revision: row.revision, createdAt: iso(row.created_at),
  });
}

export function toFollow(row: FollowRow): Follow {
  const target = row.target_kind === 'topic' || row.target_kind === 'region' ? { kind: row.target_kind, code: row.target_code } : { kind: row.target_kind, id: row.target_id };
  return FollowSchema.parse({ id: row.id, target, createdAt: iso(row.created_at), endedAt: isoOrNull(row.ended_at) });
}

export function toBookmark(row: BookmarkRow): Bookmark {
  return BookmarkSchema.parse({ id: row.id, target: { kind: row.target_kind, id: row.target_id }, createdAt: iso(row.created_at), removedAt: isoOrNull(row.removed_at) });
}

export function toReadingProgress(row: ReadingProgressRow): ReadingProgress {
  return ReadingProgressSchema.parse({ publicationVersionId: row.publication_version_id, progress: row.progress, revision: row.revision, updatedAt: iso(row.updated_at) });
}

/**
 * Database public projection -> the allowlisted public serializer. The database function returns a row only for a
 * public profile with a live profile_public consent, so both preconditions hold when a row exists.
 */
export function publicProfileFromJson(json: PublicProfileJson | undefined): PublicPersonProfile | null {
  if (!json) return null;
  return toPublicPersonProfile({ ...json, profileVisibility: 'public', profileConsentLive: true });
}

export function toCompanyListedPerson(row: CompanyPersonRow): CompanyListedPerson {
  return CompanyListedPersonSchema.parse({ id: row.id, handle: row.handle, displayName: row.display_name, headline: row.public_headline });
}
