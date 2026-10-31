import { z } from 'zod';
import type { AgentCapability, AgentModuleManifest, ContractRef } from './agent-catalog.js';
import { IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { HandleSchema } from './directory.js';
import { PersonSchema } from './identity.js';

/**
 * Profiles, consent records, portraits and experience (PPL-001; ADR 010 decision 18; data model section 4).
 *
 * A person's public profile is theirs for life and built from what they choose to show. Three rules shape this file:
 *
 * - **No consent, no public link.** Every public appearance of a person (their own profile, a company listing, a mention
 *   in a publication, a portrait) needs a live, explicit, versioned consent record of the matching purpose. Withdrawing
 *   it unpublishes the dependent projection in the same transaction and leaves a tombstone so nothing resurrects it.
 * - **One allowlisted serializer per public layer.** `toPublicPersonProfile` is the only path from stored profile data
 *   to anything public; it copies listed fields only and drops everything the person did not choose to show.
 * - **Learning and attention stay private.** Bookmarks, reading progress, follows and preferences are owner-private:
 *   never visible to employers, colleagues, staff without a case grant, search, notifications or other hubs.
 *
 * Experience entries are self-declared and labelled so until a company confirmation is recorded (REP-001 owns the
 * confirmation requests); they belong to the person and survive every change of employer. Portfolio entries and
 * professional credentials belong to REP-001.
 */
export const PROFILES_CONTRACT_VERSION = 1;

/* ---------- Vocabulary ---------- */

/** Jurisdiction or place code (`jurisdiction.code`), for example `US-CA` or `US-CA:san-diego-county`. Restricted places are refused by the database. */
export const ProfileRegionCodeSchema = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$/, 'place code');
/** A topic code of the hub taxonomy (`taxonomy.topics.<code>` in the locale files). */
export const ProfileTopicSchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'topic code');
/** A BCP 47 language tag the person works in, for example `en`, `es-US`, `uz-Latn`. */
export const ProfileLanguageSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/, 'language tag');
const distinct = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;

/**
 * Optional parts of the public profile the person chooses to show. The display name, headline and expertise are the
 * identity module's public projection and appear whenever the profile is public; everything listed here appears only
 * when the person turned it on.
 */
export const PROFILE_PUBLIC_FIELDS = ['roleLine', 'region', 'topics', 'languages', 'experience', 'employer', 'portrait'] as const;
export const ProfilePublicFieldSchema = z.enum(PROFILE_PUBLIC_FIELDS);
export type ProfilePublicField = z.infer<typeof ProfilePublicFieldSchema>;

/* ---------- Consent records ---------- */

/** Purposes of the data model (`consent_record.purpose`). Every public mention of a person needs one. */
export const CONSENT_PURPOSES = [
  'profile_public', 'mentioned_in_publication', 'listed_by_company', 'portrait_display', 'speaker_profile_link', 'public_participant', 'marketing',
  'research_participation', 'cross_hub_syndication', 'data_sharing_with_organizer', 'sale_or_share_opt_in', 'project_knowledge_share', 'portfolio_display',
  'mentoring_listing', 'passport_publication',
] as const;
export const ConsentPurposeSchema = z.enum(CONSENT_PURPOSES);
export type ConsentPurpose = z.infer<typeof ConsentPurposeSchema>;

export const CONSENT_TARGET_KINDS = ['company', 'publication', 'event', 'project', 'hub', 'organizer'] as const;
export const ConsentTargetKindSchema = z.enum(CONSENT_TARGET_KINDS);
export type ConsentTargetKind = z.infer<typeof ConsentTargetKindSchema>;
export const ConsentTargetSchema = z.strictObject({ kind: ConsentTargetKindSchema, id: IdSchema });
export type ConsentTarget = z.infer<typeof ConsentTargetSchema>;

/**
 * Which target a purpose names: `null` means the consent concerns the person's own presentation (their profile, their
 * portraits, their passport); otherwise the record names exactly one object of that kind. Mirrored by a CHECK in
 * packages/data/migrations/profiles.
 */
export const CONSENT_TARGET_BY_PURPOSE: Readonly<Record<ConsentPurpose, ConsentTargetKind | null>> = {
  profile_public: null,
  mentioned_in_publication: 'publication',
  listed_by_company: 'company',
  portrait_display: null,
  speaker_profile_link: 'event',
  public_participant: 'project',
  marketing: null,
  research_participation: null,
  cross_hub_syndication: 'hub',
  data_sharing_with_organizer: 'organizer',
  sale_or_share_opt_in: null,
  project_knowledge_share: 'project',
  portfolio_display: 'project',
  mentoring_listing: null,
  passport_publication: null,
};

/**
 * Versioned notice texts: the person consents to a specific notice, which the interface shows from its locale
 * dictionary (for example `me.public.notice.profilePublic`). A new version means a new text; consents to an older
 * version stay valid for what they covered, and the API accepts a grant only against the current version
 * (`validation.schema` with `details.reason = notice_outdated`).
 */
export const CONSENT_NOTICE_VERSIONS: Readonly<Record<ConsentPurpose, string>> = Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, `${p}.v1`])) as Record<ConsentPurpose, string>;
export const ConsentNoticeVersionSchema = z.string().regex(/^[a-z_]+\.v[1-9][0-9]{0,3}$/, 'notice version');
export function noticePurpose(version: string): string {
  return version.slice(0, version.lastIndexOf('.v'));
}

/** How the consent was given. Only the person's own first-party act counts; chat text and agents never consent. */
export const ConsentEvidenceSchema = z.strictObject({ method: z.literal('first_party_form'), requestId: IdSchema });
export type ConsentEvidence = z.infer<typeof ConsentEvidenceSchema>;

export const ConsentRecordSchema = z.strictObject({
  id: IdSchema,
  subjectPersonId: IdSchema,
  purpose: ConsentPurposeSchema,
  target: ConsentTargetSchema.nullable(),
  noticeVersion: ConsentNoticeVersionSchema,
  grantedAt: TimestampSchema,
  evidence: ConsentEvidenceSchema,
  /** The only change a record ever takes, once. */
  withdrawnAt: TimestampSchema.nullable(),
  withdrawnReason: ShortTextSchema.nullable(),
})
  .refine((r) => (CONSENT_TARGET_BY_PURPOSE[r.purpose] === null ? r.target === null : r.target?.kind === CONSENT_TARGET_BY_PURPOSE[r.purpose]), { message: 'the purpose fixes the target kind', path: ['target'] })
  .refine((r) => noticePurpose(r.noticeVersion) === r.purpose, { message: 'the notice belongs to the purpose', path: ['noticeVersion'] })
  .refine((r) => (r.withdrawnAt === null) === (r.withdrawnReason === null), { message: 'a withdrawal has a time and a reason', path: ['withdrawnReason'] });
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/** Live: granted and not withdrawn. Consent records do not expire on their own; the person withdraws them. */
export function consentLive(record: Pick<ConsentRecord, 'withdrawnAt'> | null | undefined): boolean {
  return record !== null && record !== undefined && record.withdrawnAt === null;
}
/** The live record covering a purpose and target among a person's records, if any. */
export function liveConsentFor(records: readonly ConsentRecord[], subjectPersonId: string, purpose: ConsentPurpose, target: ConsentTarget | null): ConsentRecord | null {
  return records.find((r) => r.subjectPersonId === subjectPersonId && r.purpose === purpose && consentLive(r)
    && (target === null ? r.target === null : r.target !== null && r.target.kind === target.kind && r.target.id === target.id)) ?? null;
}

/* ---------- Media licences and portraits ---------- */

export const LICENCE_KINDS = ['own_work', 'licensed', 'cc_by', 'cc_by_sa', 'public_domain'] as const;
export const LicenceKindSchema = z.enum(LICENCE_KINDS);
export const MediaLicenceSchema = z.strictObject({
  id: IdSchema,
  /** A file (`evidence_artifact`) owned by the person. */
  assetId: IdSchema,
  licensor: NameSchema,
  licenceKind: LicenceKindSchema,
  /** What the licence covers, for example "profile portrait on this hub". */
  scope: ShortTextSchema,
  validUntil: TimestampSchema.nullable(),
  recordedByPersonId: IdSchema,
  revokedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type MediaLicence = z.infer<typeof MediaLicenceSchema>;
export function licenceLive(licence: Pick<MediaLicence, 'validUntil' | 'revokedAt'> | null | undefined, now: Date): boolean {
  return !!licence && licence.revokedAt === null && (licence.validUntil === null || Date.parse(licence.validUntil) > now.getTime());
}

/**
 * `pending`: an image recorded with a licence that still waits for the person's consent (for example an editorial
 * photo); `shown`: the person's current portrait, with consent and licence; `withdrawn`: consent withdrawn, licence
 * revoked or replaced. At most one shown portrait per person.
 */
export const PORTRAIT_STATUSES = ['pending', 'shown', 'withdrawn'] as const;
export const PortraitStatusSchema = z.enum(PORTRAIT_STATUSES);
export const PortraitSchema = z.strictObject({
  id: IdSchema,
  personId: IdSchema,
  assetId: IdSchema,
  mediaLicenceId: IdSchema,
  consentRecordId: IdSchema.nullable(),
  status: PortraitStatusSchema,
  withdrawnAt: TimestampSchema.nullable(),
  withdrawnReason: z.enum(['consent_withdrawn', 'licence_revoked', 'replaced', 'removed']).nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
})
  .refine((p) => p.status !== 'shown' || p.consentRecordId !== null, { message: 'a shown portrait has a consent record', path: ['consentRecordId'] })
  .refine((p) => (p.status === 'withdrawn') === (p.withdrawnAt !== null), { message: 'withdrawn portraits record when', path: ['withdrawnAt'] });
export type Portrait = z.infer<typeof PortraitSchema>;

/** Whether a portrait may be shown publicly: shown, with a live consent of its own and a live licence on the same asset. */
export function portraitDisplayable(portrait: Portrait | null, consent: ConsentRecord | null, licence: MediaLicence | null, now: Date): boolean {
  if (!portrait || portrait.status !== 'shown' || !consent || !licence) return false;
  return consent.id === portrait.consentRecordId && consent.subjectPersonId === portrait.personId && consent.purpose === 'portrait_display' && consentLive(consent)
    && licence.id === portrait.mediaLicenceId && licence.assetId === portrait.assetId && licenceLive(licence, now);
}

/* ---------- Experience ---------- */

export const ExperienceDateSchema = z.iso.date();
/** `self_declared` until a company confirmation is recorded (REP-001 confirmation requests); never required. */
export const ExperienceConfirmationSchema = z.enum(['self_declared', 'company_confirmed']);
export type ExperienceConfirmation = z.infer<typeof ExperienceConfirmationSchema>;
export const ExperienceOrganisationSchema = z.strictObject({
  /** The company on this platform, when there is one; the name is always the person's own words. */
  companyId: IdSchema.nullable(),
  name: NameSchema,
});
const experienceShape = z.strictObject({
  organisation: ExperienceOrganisationSchema,
  role: NameSchema,
  summary: z.string().overwrite((s) => s.normalize('NFC')).max(2000).nullable(),
  from: ExperienceDateSchema,
  to: ExperienceDateSchema.nullable(),
  visibility: z.enum(['public', 'private']),
});
const experienceDates = <T extends z.ZodType<{ from: string; to: string | null }>>(schema: T) =>
  schema.refine((e) => e.to === null || e.from <= e.to, { message: 'from is not after to', path: ['to'] });
export const ExperienceEntrySchema = experienceDates(experienceShape.extend({
  id: IdSchema,
  personId: IdSchema,
  confirmation: ExperienceConfirmationSchema,
  confirmedAt: TimestampSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
})).refine((e) => (e.confirmation === 'company_confirmed') === (e.confirmedAt !== null), { message: 'a confirmation has a time', path: ['confirmedAt'] });
export type ExperienceEntry = z.infer<typeof ExperienceEntrySchema>;

/* ---------- Profile and preferences ---------- */

export const PersonProfileSchema = z.strictObject({
  personId: IdSchema,
  roleLine: NameSchema.nullable(),
  regionCode: ProfileRegionCodeSchema.nullable(),
  showEmployer: z.boolean(),
  topics: z.array(ProfileTopicSchema).max(20).refine(distinct, 'topics are distinct'),
  languages: z.array(ProfileLanguageSchema).max(10).refine(distinct, 'languages are distinct'),
  publicFields: z.array(ProfilePublicFieldSchema).max(PROFILE_PUBLIC_FIELDS.length).refine(distinct, 'fields are distinct'),
  revision: RevisionSchema,
  updatedAt: TimestampSchema,
});
export type PersonProfile = z.infer<typeof PersonProfileSchema>;

export const PREFERENCE_INTENTS = ['read', 'publish', 'buy', 'sell', 'find_work', 'host_events'] as const;
/** Confers no rights and no company access; shapes suggestions only (owner-private). */
export const PersonPreferenceSchema = z.strictObject({
  personId: IdSchema,
  intents: z.array(z.enum(PREFERENCE_INTENTS)).max(PREFERENCE_INTENTS.length).refine(distinct, 'intents are distinct'),
  topics: z.array(ProfileTopicSchema).max(20).refine(distinct, 'topics are distinct'),
  regions: z.array(ProfileRegionCodeSchema).max(20).refine(distinct, 'regions are distinct'),
  onboardingCompletedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
  updatedAt: TimestampSchema,
});
export type PersonPreference = z.infer<typeof PersonPreferenceSchema>;

/* ---------- Follows, bookmarks, reading progress (owner-private) ---------- */

export const FOLLOW_TARGET_KINDS = ['person', 'company', 'topic', 'region', 'hub', 'event_series'] as const;
export const FollowTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), id: IdSchema }),
  z.strictObject({ kind: z.literal('company'), id: IdSchema }),
  z.strictObject({ kind: z.literal('hub'), id: IdSchema }),
  z.strictObject({ kind: z.literal('event_series'), id: IdSchema }),
  z.strictObject({ kind: z.literal('topic'), code: ProfileTopicSchema }),
  z.strictObject({ kind: z.literal('region'), code: ProfileRegionCodeSchema }),
]);
export type FollowTarget = z.infer<typeof FollowTargetSchema>;
export const FollowSchema = z.strictObject({ id: IdSchema, target: FollowTargetSchema, createdAt: TimestampSchema, endedAt: TimestampSchema.nullable() });
export type Follow = z.infer<typeof FollowSchema>;

export const BOOKMARK_TARGET_KINDS = ['publication', 'event', 'course', 'project', 'person', 'company', 'offering', 'need'] as const;
export const BookmarkTargetSchema = z.strictObject({ kind: z.enum(BOOKMARK_TARGET_KINDS), id: IdSchema });
export const BookmarkSchema = z.strictObject({ id: IdSchema, target: BookmarkTargetSchema, createdAt: TimestampSchema, removedAt: TimestampSchema.nullable() });
export type Bookmark = z.infer<typeof BookmarkSchema>;

/** Exact decimal in [0, 1] with at most three fraction digits, kept as text. */
export const ReadingProgressValueSchema = z.string().regex(/^(0(\.[0-9]{1,3})?|1(\.0{1,3})?)$/, 'progress between 0 and 1');
export const ReadingProgressSchema = z.strictObject({ publicationVersionId: IdSchema, progress: ReadingProgressValueSchema, revision: RevisionSchema, updatedAt: TimestampSchema });
export type ReadingProgress = z.infer<typeof ReadingProgressSchema>;

/* ---------- The public projection (allowlisted) ---------- */

export const PublicExperienceEntrySchema = z.strictObject({
  id: IdSchema,
  organisation: ExperienceOrganisationSchema,
  role: NameSchema,
  summary: z.string().max(2000).nullable(),
  from: ExperienceDateSchema,
  to: ExperienceDateSchema.nullable(),
  /** Always shown: a self-declared entry is labelled as such (ADR 010 decision 18). */
  confirmation: ExperienceConfirmationSchema,
});
export type PublicExperienceEntry = z.infer<typeof PublicExperienceEntrySchema>;

export const PublicPersonProfileSchema = z.strictObject({
  projection: z.literal('public'),
  id: IdSchema,
  handle: HandleSchema.nullable(),
  displayName: PersonSchema.shape.displayName,
  headline: PersonSchema.shape.publicProfile.shape.headline,
  expertise: PersonSchema.shape.publicProfile.shape.expertise,
  roleLine: NameSchema.nullable(),
  regionCode: ProfileRegionCodeSchema.nullable(),
  topics: z.array(ProfileTopicSchema),
  languages: z.array(ProfileLanguageSchema),
  /** Present only when the person shows the employer and has an active membership. */
  employer: z.strictObject({ companyId: IdSchema, name: NameSchema }).nullable(),
  /** Present only with a shown portrait, a live consent, a live licence and a clean public file; otherwise initials. */
  portrait: z.strictObject({ portraitId: IdSchema, assetId: IdSchema }).nullable(),
  experience: z.array(PublicExperienceEntrySchema),
});
export type PublicPersonProfile = z.infer<typeof PublicPersonProfileSchema>;

/**
 * Keys that never appear in a public profile, a company listing or a mention, whatever the person chose:
 * identity secrets, preferences, learning and attention, consent evidence, licence terms, file internals.
 */
export const PROFILE_PUBLIC_FORBIDDEN_KEYS = [
  'emailBindings', 'providerIdentities', 'sessions', 'tokenHash', 'passwordHash', 'preferences', 'intents', 'bookmarks', 'readingProgress', 'follows', 'followers',
  'consents', 'evidence', 'noticeVersion', 'withdrawnReason', 'licensor', 'licenceKind', 'mediaLicenceId', 'consentRecordId', 'storageKey', 'sha256', 'publicFields',
  'showEmployer', 'archivedAt', 'visibility', 'profileVisibility', 'authzEpoch', 'membership', 'permissions', 'onboardingCompletedAt',
] as const;

/** What the database's public profile function returns: public columns of a public, consented profile. */
export interface PublicProfileSource {
  id: string;
  handle: string | null;
  displayName: string | null;
  headline: string | null;
  expertise: readonly string[];
  roleLine: string | null;
  regionCode: string | null;
  topics: readonly string[];
  languages: readonly string[];
  publicFields: readonly string[];
  employer: { companyId: string; name: string } | null;
  portrait: { portraitId: string; assetId: string } | null;
  experience: readonly (Omit<PublicExperienceEntry, 'organisation'> & { organisation: { companyId: string | null; name: string }; visibility?: string; archivedAt?: string | null })[];
  /** Both must hold, or the profile is not found. */
  profileVisibility: 'private' | 'public';
  profileConsentLive: boolean;
}

/**
 * The public-profile serializer: the only path from stored profile data to the public layer. `null` means "not
 * found" for everyone: the profile is private or its `profile_public` consent is missing or withdrawn. Optional parts
 * appear only when listed in `publicFields`; private, archived experience never appears.
 */
export function toPublicPersonProfile(source: PublicProfileSource): PublicPersonProfile | null {
  if (source.profileVisibility !== 'public' || !source.profileConsentLive) return null;
  const shows = (field: ProfilePublicField) => source.publicFields.includes(field);
  return PublicPersonProfileSchema.parse({
    projection: 'public',
    id: source.id,
    handle: source.handle,
    displayName: source.displayName,
    headline: source.headline,
    expertise: [...source.expertise],
    roleLine: shows('roleLine') ? source.roleLine : null,
    regionCode: shows('region') ? source.regionCode : null,
    topics: shows('topics') ? [...source.topics] : [],
    languages: shows('languages') ? [...source.languages] : [],
    employer: shows('employer') ? source.employer : null,
    portrait: shows('portrait') ? source.portrait : null,
    experience: shows('experience')
      ? source.experience
        .filter((e) => (e.visibility === undefined || e.visibility === 'public') && (e.archivedAt === undefined || e.archivedAt === null))
        .map((e) => ({ id: e.id, organisation: { companyId: e.organisation.companyId, name: e.organisation.name }, role: e.role, summary: e.summary, from: e.from, to: e.to, confirmation: e.confirmation }))
      : [],
  });
}

/** A person a company lists on its page: only with their public profile and a live `listed_by_company` consent for that company. */
export const CompanyListedPersonSchema = z.strictObject({
  id: IdSchema,
  handle: HandleSchema.nullable(),
  displayName: PersonSchema.shape.displayName,
  headline: PersonSchema.shape.publicProfile.shape.headline,
});
export type CompanyListedPerson = z.infer<typeof CompanyListedPersonSchema>;
export const CompanyPeopleSchema = z.strictObject({ companyId: IdSchema, items: z.array(CompanyListedPersonSchema) });

/**
 * Mentions: of the people a publication names, those who may appear as a link (public profile and a live
 * `mentioned_in_publication` consent for that publication). Everyone else is shown as plain text without a link, or not
 * at all, by the content module.
 */
export function consentedMentions(personIds: readonly string[], consented: ReadonlySet<string>): string[] {
  return personIds.filter((id) => consented.has(id));
}

/* ---------- Owner-private view ---------- */

export const MyProfileViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  person: z.strictObject({
    id: IdSchema,
    displayName: PersonSchema.shape.displayName,
    profileVisibility: z.enum(['private', 'public']),
    headline: PersonSchema.shape.publicProfile.shape.headline,
    expertise: PersonSchema.shape.publicProfile.shape.expertise,
    revision: RevisionSchema,
  }),
  profile: PersonProfileSchema.nullable(),
  consents: z.array(ConsentRecordSchema),
  licences: z.array(MediaLicenceSchema),
  portraits: z.array(PortraitSchema),
  experience: z.array(ExperienceEntrySchema),
  /** Exactly what the public sees right now (`null` when not public): the live preview's source of truth. */
  publicPreview: PublicPersonProfileSchema.nullable(),
  /** Current notice versions the person consents to in the editor. */
  notices: z.record(ConsentPurposeSchema, ConsentNoticeVersionSchema),
});
export type MyProfileView = z.infer<typeof MyProfileViewSchema>;

/* ---------- Commands ---------- */

const headlineSchema = z.string().overwrite((s) => s.normalize('NFC').trim()).max(500).nullable();
export const SaveProfileCommandSchema = z.strictObject({
  /** `null` when the person has no profile row yet. */
  expectedRevision: RevisionSchema.nullable(),
  headline: headlineSchema,
  expertise: z.array(z.string().min(1).max(100)).max(20).refine(distinct, 'expertise is distinct'),
  roleLine: NameSchema.nullable(),
  regionCode: ProfileRegionCodeSchema.nullable(),
  showEmployer: z.boolean(),
  topics: PersonProfileSchema.shape.topics,
  languages: PersonProfileSchema.shape.languages,
  publicFields: PersonProfileSchema.shape.publicFields,
});
export type SaveProfileCommand = z.infer<typeof SaveProfileCommandSchema>;

/** Making the profile public is a consent (`profile_public`, current notice); hiding it withdraws that consent. */
export const SetProfileVisibilityCommandSchema = z.discriminatedUnion('visibility', [
  z.strictObject({ visibility: z.literal('public'), noticeVersion: ConsentNoticeVersionSchema }),
  z.strictObject({ visibility: z.literal('private'), reason: ShortTextSchema.optional() }),
]);
export type SetProfileVisibilityCommand = z.infer<typeof SetProfileVisibilityCommandSchema>;

export const GrantConsentCommandSchema = z.strictObject({ purpose: ConsentPurposeSchema, target: ConsentTargetSchema.nullable(), noticeVersion: ConsentNoticeVersionSchema })
  .refine((c) => (CONSENT_TARGET_BY_PURPOSE[c.purpose] === null ? c.target === null : c.target?.kind === CONSENT_TARGET_BY_PURPOSE[c.purpose]), { message: 'the purpose fixes the target kind', path: ['target'] })
  .refine((c) => noticePurpose(c.noticeVersion) === c.purpose, { message: 'the notice belongs to the purpose', path: ['noticeVersion'] });
export type GrantConsentCommand = z.infer<typeof GrantConsentCommandSchema>;
export const WithdrawConsentCommandSchema = z.strictObject({ reason: ShortTextSchema });

export const RecordMediaLicenceCommandSchema = MediaLicenceSchema.pick({ assetId: true, licensor: true, licenceKind: true, scope: true, validUntil: true });
export const RevokeMediaLicenceCommandSchema = z.strictObject({ reason: ShortTextSchema });
/** Sets the person's shown portrait; a previous shown portrait is withdrawn (`replaced`) in the same transaction. */
export const SetPortraitCommandSchema = z.strictObject({ assetId: IdSchema, mediaLicenceId: IdSchema, consentRecordId: IdSchema });
export const RemovePortraitCommandSchema = z.strictObject({ expectedRevision: RevisionSchema });

export const AddExperienceCommandSchema = experienceDates(experienceShape);
export const UpdateExperienceCommandSchema = experienceDates(experienceShape.extend({ expectedRevision: RevisionSchema }));
export const ArchiveExperienceCommandSchema = z.strictObject({ expectedRevision: RevisionSchema });

export const SavePreferencesCommandSchema = PersonPreferenceSchema.pick({ intents: true, topics: true, regions: true }).extend({
  onboardingCompleted: z.boolean(),
  expectedRevision: RevisionSchema.nullable(),
});
export const FollowCommandSchema = z.strictObject({ target: FollowTargetSchema });
export const AddBookmarkCommandSchema = z.strictObject({ target: BookmarkTargetSchema });
export const RecordReadingProgressCommandSchema = z.strictObject({ publicationVersionId: IdSchema, progress: ReadingProgressValueSchema });

export const ConsentListSchema = z.strictObject({ items: z.array(ConsentRecordSchema) });
export const ExperienceListSchema = z.strictObject({ items: z.array(ExperienceEntrySchema) });
export const FollowListSchema = z.strictObject({ items: z.array(FollowSchema) });
export const BookmarkListSchema = z.strictObject({ items: z.array(BookmarkSchema) });
export const ReadingProgressListSchema = z.strictObject({ items: z.array(ReadingProgressSchema) });
export const GetMyProfileQuerySchema = z.strictObject({});
export const GetPublicProfileQuerySchema = z.strictObject({ personId: IdSchema });

/* ---------- Tombstones and egress ---------- */

/** Projections a withdrawal or revocation unpublishes; each leaves a tombstone. */
export const PROFILE_PROJECTIONS = ['profile', 'portrait', 'company_listing', 'publication_mention', 'speaker_link', 'project_participant', 'consented_use'] as const;
export const ProfileProjectionSchema = z.enum(PROFILE_PROJECTIONS);
export const PROJECTION_BY_PURPOSE: Readonly<Record<ConsentPurpose, (typeof PROFILE_PROJECTIONS)[number]>> = {
  profile_public: 'profile', portrait_display: 'portrait', listed_by_company: 'company_listing', mentioned_in_publication: 'publication_mention',
  speaker_profile_link: 'speaker_link', public_participant: 'project_participant', marketing: 'consented_use', research_participation: 'consented_use',
  cross_hub_syndication: 'consented_use', data_sharing_with_organizer: 'consented_use', sale_or_share_opt_in: 'consented_use', project_knowledge_share: 'consented_use',
  portfolio_display: 'consented_use', mentoring_listing: 'consented_use', passport_publication: 'consented_use',
};
/**
 * What must stay gone: minimal metadata, no content (`tombstone` retention class). Search, retrieval, federation and
 * caches consume `profile.projection_withdrawn` events and replay tombstones after a restore before serving traffic.
 */
export const ProfileTombstoneSchema = z.strictObject({
  id: IdSchema,
  subjectPersonId: IdSchema,
  projection: ProfileProjectionSchema,
  target: z.strictObject({ kind: z.string().min(1).max(40), id: IdSchema }).nullable(),
  reason: z.enum(['consent_withdrawn', 'licence_revoked', 'portrait_replaced', 'portrait_removed']),
  createdAt: TimestampSchema,
});
export type ProfileTombstone = z.infer<typeof ProfileTombstoneSchema>;

/**
 * Owner-private records never leave the owner: preferences, follows, bookmarks and reading progress are not indexed,
 * not federated, not exported to anyone but the person, never shown to employers or colleagues. The public profile is
 * public only while its consent is live; derived copies are rebuilt from the allowlisted projection.
 */
export const PROFILE_EGRESS = {
  ownerPrivate: { records: ['person_preference', 'follow', 'bookmark', 'reading_progress', 'consent_record', 'media_licence'], search: false, retrieval: false, federation: false, employerVisible: false },
  publicProfile: { serializer: 'toPublicPersonProfile', requiresConsent: 'profile_public', tombstoneOnWithdrawal: true },
  notificationPayload: 'identifiers_only',
} as const;
/** Keys an outbox payload of a profile event may contain. */
export const PROFILE_EVENT_PAYLOAD_KEYS = ['personId', 'consentId', 'purpose', 'targetKind', 'targetId', 'portraitId', 'tombstoneId', 'projection', 'entryId', 'reason'] as const;

/* ---------- Capability registry: the profile keeper module (ADR 010 decision 23) ---------- */

const ref = (schema: string, contract = 'profiles'): ContractRef => ({ contract, schema, version: 1 });
const MODULE = { key: 'profile_keeper', version: '1.0.0' } as const;
type CapabilityInput = Omit<AgentCapability, 'version' | 'status' | 'source' | 'surfaces' | 'contextKinds' | 'budgetKind' | 'acceptsUntrustedText' | 'meters'> & Partial<Pick<AgentCapability, 'surfaces' | 'contextKinds' | 'acceptsUntrustedText' | 'meters'>>;
const capability = (c: CapabilityInput): AgentCapability => ({
  version: 1, status: 'live', source: { kind: 'module', moduleKey: MODULE.key, moduleVersion: MODULE.version }, budgetKind: null,
  surfaces: ['ui', 'agent', 'mcp'], contextKinds: ['profile'], acceptsUntrustedText: false, meters: [], ...c,
});

/**
 * Every profile operation is reachable from the interface and from the person's agent: reads, profile edits under a
 * `maintain_profile` mandate, and consent on the first-party form only (an agent prepares it, the person gives it).
 * Bookmarks, follows and reading progress are the person's own private records.
 */
export const PROFILE_KEEPER_CAPABILITIES: readonly AgentCapability[] = [
  capability({ id: 'profile_keeper.get_my_profile', kind: 'read', input: ref('GetMyProfileQuerySchema'), output: ref('MyProfileViewSchema'), mandateAction: null, confirmation: 'none', reads: ['owner_private', 'public'], privateDataClasses: [], sideEffects: ['none'], labelKey: 'profiles.capability.getMyProfile' }),
  capability({ id: 'profile_keeper.get_public_profile', kind: 'read', input: ref('GetPublicProfileQuerySchema'), output: ref('PublicPersonProfileSchema'), mandateAction: null, confirmation: 'none', reads: ['public'], privateDataClasses: [], sideEffects: ['none'], labelKey: 'profiles.capability.getPublicProfile' }),
  capability({ id: 'profile_keeper.apply_profile_edit', kind: 'commit', input: ref('SaveProfileCommandSchema'), output: ref('MyProfileViewSchema'), mandateAction: 'maintain_profile', confirmation: 'mandate', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change', 'publication'], meters: ['agent_actions'], labelKey: 'profiles.capability.applyProfileEdit' }),
  capability({ id: 'profile_keeper.add_experience', kind: 'commit', input: ref('AddExperienceCommandSchema'), output: ref('ExperienceEntrySchema'), mandateAction: 'maintain_profile', confirmation: 'mandate', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], meters: ['agent_actions'], labelKey: 'profiles.capability.addExperience' }),
  capability({ id: 'profile_keeper.update_experience', kind: 'commit', input: ref('UpdateExperienceCommandSchema'), output: ref('ExperienceEntrySchema'), mandateAction: 'maintain_profile', confirmation: 'mandate', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], meters: ['agent_actions'], labelKey: 'profiles.capability.updateExperience' }),
  capability({ id: 'profile_keeper.set_visibility', kind: 'govern', input: ref('SetProfileVisibilityCommandSchema'), output: ref('MyProfileViewSchema'), mandateAction: null, confirmation: 'first_party_form', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], surfaces: ['ui', 'agent'], labelKey: 'profiles.capability.setVisibility' }),
  capability({ id: 'profile_keeper.grant_consent', kind: 'govern', input: ref('GrantConsentCommandSchema'), output: ref('ConsentRecordSchema'), mandateAction: null, confirmation: 'first_party_form', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], surfaces: ['ui', 'agent'], labelKey: 'profiles.capability.grantConsent' }),
  capability({ id: 'profile_keeper.withdraw_consent', kind: 'govern', input: ref('WithdrawConsentCommandSchema'), output: ref('ConsentRecordSchema'), mandateAction: null, confirmation: 'first_party_form', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], surfaces: ['ui', 'agent'], labelKey: 'profiles.capability.withdrawConsent' }),
  capability({ id: 'profile_keeper.set_portrait', kind: 'govern', input: ref('SetPortraitCommandSchema'), output: ref('PortraitSchema'), mandateAction: null, confirmation: 'first_party_form', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], surfaces: ['ui', 'agent'], labelKey: 'profiles.capability.setPortrait' }),
  capability({ id: 'profile_keeper.list_bookmarks', kind: 'read', input: ref('GetMyProfileQuerySchema'), output: ref('BookmarkListSchema'), mandateAction: null, confirmation: 'none', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['none'], surfaces: ['ui', 'agent'], labelKey: 'profiles.capability.listBookmarks' }),
  capability({ id: 'profile_keeper.list_reading_progress', kind: 'read', input: ref('GetMyProfileQuerySchema'), output: ref('ReadingProgressListSchema'), mandateAction: null, confirmation: 'none', reads: ['owner_private'], privateDataClasses: [], sideEffects: ['none'], surfaces: ['ui', 'agent'], labelKey: 'profiles.capability.listReadingProgress' }),
];

/** Validated by `AgentModuleManifestSchema` in tests/contracts/profiles.test.ts (no parse at import: this file is in the client entry). */
export const PROFILE_KEEPER_MANIFEST: AgentModuleManifest = {
  key: MODULE.key,
  version: MODULE.version,
  family: 'presence',
  status: 'live',
  actions: ['maintain_profile'],
  capabilities: [...PROFILE_KEEPER_CAPABILITIES],
  meters: ['agent_actions'],
  suits: ['individual_professional', 'job_seeker', 'small_contractor', 'subcontractor', 'editor_author_expert', 'course_author', 'event_organizer', 'homeowner'],
  freeFloor: [{ meter: 'agent_actions', units: '50', window: 'month' }],
  safetySuite: 'tests/profiles',
};
