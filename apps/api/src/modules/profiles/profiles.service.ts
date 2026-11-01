import type { z } from 'zod';
import { HandleSchema, type Principal } from '../../deps/contracts.js';
import { auditEvents, companies, outbox, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { requirePublicServingContext } from '../agent-modules/serving-hub.js';
import type { PublicServiceBoundary } from '../agent-modules/service-bindings.js';
import {
  bookmarks, consentRecords, CONSENT_NOTICE_VERSIONS, CONSENT_PURPOSES, directory, experienceEntries, follows, mediaLicences, MyProfileViewSchema, personPreferences, personProfiles, portraits,
  profileIdentity, publicProfiles, readingProgress, CompanyPeopleSchema, ConsentListSchema, ExperienceListSchema, FollowListSchema, BookmarkListSchema, ReadingProgressListSchema,
  PublicPersonProfileSchema,
  type AddBookmarkCommandSchema, type AddExperienceCommandSchema, type ArchiveExperienceCommandSchema, type Bookmark, type ConsentPurpose, type ConsentRecord, type ExperienceEntry, type Follow,
  type FollowCommandSchema, type GrantConsentCommand, type MediaLicence, type MyProfileView, type PersonPreference, type Portrait, type PublicPersonProfile, type ReadingProgress,
  type RecordMediaLicenceCommandSchema, type RecordReadingProgressCommandSchema, type RemovePortraitCommandSchema, type SavePreferencesCommandSchema, type SaveProfileCommand,
  type SetPortraitCommandSchema, type SetProfileVisibilityCommand, type UpdateExperienceCommandSchema,
} from './deps.js';
import type { ProfileMandatePort } from './mandates.js';
import {
  publicProfileFromJson, toBookmark, toCompanyListedPerson, toConsent, toExperience, toFollow, toLicence, toPortrait, toPreference, toProfile, toReadingProgress,
} from './serializers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Items<T> = { items: T[] };

/** Database hints of the profiles guards, mapped to frozen contract codes with a `details.reason`. */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'profiles.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'profiles.consent_required': { code: 'validation.schema', reason: 'consent_required' },
  'profiles.licence_missing': { code: 'validation.schema', reason: 'licence_missing' },
  'profiles.asset_not_owned': { code: 'validation.schema', reason: 'asset_not_owned' },
  'profiles.restricted_place': { code: 'validation.schema', reason: 'restricted_place' },
  'profiles.consent_immutable': { code: 'validation.revision_conflict', reason: 'consent_immutable' },
  'profiles.licence_immutable': { code: 'validation.revision_conflict', reason: 'licence_immutable' },
  'profiles.portrait_immutable': { code: 'validation.revision_conflict', reason: 'portrait_immutable' },
  'profiles.immutable': { code: 'validation.revision_conflict', reason: 'immutable' },
};
function mapDatabaseError(error: unknown): never {
  const pg = error as { code?: string; hint?: string; constraint?: string };
  if (pg && typeof pg.code === 'string') {
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
    if (pg.code === '23503') throw new ApiError('validation.schema', 'a referenced record does not exist', { reason: 'unknown_reference' });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting live record already exists', { reason: 'already_exists', constraint: pg.constraint ?? null });
    if (pg.code === '23514') throw new ApiError('validation.schema', 'the record breaks a profile rule', { reason: 'invalid', constraint: pg.constraint ?? null });
  }
  throw error;
}
const conflict = () => new ApiError('validation.revision_conflict', 'the record changed; reload and retry', { reason: 'revision_conflict' });

/**
 * Profiles, consent, portraits and experience (PPL-001). Every write is the principal's own act in one
 * `withPrincipal` transaction with its audit row and an identifiers-only outbox event; the database guards repeat each
 * rule (own rows only, consent before publicity, licence and consent before a portrait, withdrawal unpublishes with a
 * tombstone). Public reads use the owner-run allowlisted functions and the contract serializer, identical for every
 * caller. Bookmarks, follows, reading progress and preferences are the person's private attention records: they are
 * neither audited nor announced, so no behaviour log exists for anyone to read.
 */
export class ProfilesService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly mandates: ProfileMandatePort,
    private readonly publicBoundary: PublicServiceBoundary = trx => requirePublicServingContext(trx, ctx.config.publicOrigin)) {}

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapDatabaseError);
  }

  /**
   * Commits (profile text, experience, private records): the person, or their agent under a `maintain_profile`
   * mandate. Governance (consent, visibility, portraits, licences): the person on the first-party form only.
   */
  private async authority(principal: Principal, kind: 'commit' | 'govern'): Promise<void> {
    if (!principal.delegation) return;
    if (kind === 'govern') throw new ApiError('access.mandate_scope', 'consent and publicity are given by the person on the first-party form');
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: principal.delegation.mandateId, action: 'maintain_profile', at: this.ctx.clock.now() });
    if (!ok) throw new ApiError('access.mandate_scope', 'the agent needs a maintain_profile mandate');
  }

  private async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }
  /** Identifiers only (PROFILE_EVENT_PAYLOAD_KEYS): notifications and indexers read projections under their own authority. */
  private async event(trx: Transaction, personId: string, revision: number, type: string, payload: Record<string, string | null>): Promise<void> {
    await outbox.append(trx, { aggregate_kind: 'person', aggregate_id: personId, revision, type, payload: { personId, ...payload } });
  }

  // ---- Owner view --------------------------------------------------------------------------------------------------

  private async ownerView(trx: Transaction, personId: string): Promise<MyProfileView> {
    const person = await profileIdentity.get(trx, personId);
    if (!person) throw new ApiError('access.not_found');
    const [profile, consents, licences, portraitRows, experience, publicJson] = await Promise.all([
      personProfiles.get(trx, personId), consentRecords.listForSubject(trx, personId), mediaLicences.listForOwner(trx, personId), portraits.listForPerson(trx, personId),
      experienceEntries.listForPerson(trx, personId), publicProfiles.profile(trx, personId),
    ]);
    return MyProfileViewSchema.parse({
      projection: 'owner_private',
      person: { id: person.id, displayName: person.display_name, profileVisibility: person.profile_visibility, headline: person.public_headline, expertise: person.public_expertise, revision: person.revision },
      profile: profile ? toProfile(profile) : null,
      consents: consents.map(toConsent),
      licences: licences.map(toLicence),
      portraits: portraitRows.map(toPortrait),
      experience: experience.map(toExperience),
      publicPreview: publicProfileFromJson(publicJson),
      notices: CONSENT_NOTICE_VERSIONS,
    });
  }

  myProfile(state: RequestState): Promise<MyProfileView> {
    return this.run(state, (trx, principal) => this.ownerView(trx, principal.personId));
  }

  async saveProfile(input: SaveProfileCommand, state: RequestState): Promise<MyProfileView> {
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      const person = await profileIdentity.lock(trx, principal.personId);
      if (!person) throw new ApiError('access.not_found');
      const existing = await personProfiles.get(trx, principal.personId);
      const values = {
        role_line: input.roleLine, region_code: input.regionCode, show_employer: input.showEmployer, topics: [...input.topics], languages: [...input.languages], public_fields: [...input.publicFields],
      };
      let revision: number;
      if (!existing) {
        if (input.expectedRevision !== null) throw conflict();
        revision = (await personProfiles.insert(trx, { person_id: principal.personId, ...values })).revision;
      } else {
        if (input.expectedRevision !== existing.revision) throw conflict();
        const updated = await personProfiles.update(trx, principal.personId, existing.revision, values);
        if (!updated) throw conflict();
        revision = updated.revision;
      }
      await profileIdentity.setPublicText(trx, principal.personId, { headline: input.headline === '' ? null : input.headline, expertise: [...input.expertise] });
      await this.audit(trx, principal, state, 'profile.saved', 'person', principal.personId, { revision, publicFields: input.publicFields });
      await this.event(trx, principal.personId, revision, 'profile.updated', {});
      return this.ownerView(trx, principal.personId);
    });
  }

  /** Public = a `profile_public` consent to the current notice plus the switch; private = withdrawal of that consent. */
  async setVisibility(input: SetProfileVisibilityCommand, state: RequestState): Promise<MyProfileView> {
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'govern');
      const person = await profileIdentity.lock(trx, principal.personId);
      if (!person) throw new ApiError('access.not_found');
      const live = await consentRecords.live(trx, principal.personId, 'profile_public', null);
      if (input.visibility === 'public') {
        if (input.noticeVersion !== CONSENT_NOTICE_VERSIONS.profile_public) throw new ApiError('validation.schema', 'consent is given to the current notice', { reason: 'notice_outdated', current: CONSENT_NOTICE_VERSIONS.profile_public });
        if (live && person.profile_visibility === 'public') return this.ownerView(trx, principal.personId);
        const consent = live ?? await consentRecords.insert(trx, {
          subject_person_id: principal.personId, purpose: 'profile_public', target_kind: null, target_id: null, notice_version: input.noticeVersion,
          evidence: { method: 'first_party_form', requestId: state.requestId },
        });
        await profileIdentity.setVisibility(trx, principal.personId, 'public');
        await this.audit(trx, principal, state, 'profile.published', 'person', principal.personId, { consentId: consent.id, noticeVersion: input.noticeVersion });
        await this.event(trx, principal.personId, person.revision + 1, 'profile.published', { consentId: consent.id });
      } else {
        if (live) {
          await consentRecords.withdraw(trx, live.id, input.reason ?? 'profile hidden by the person');
          await this.audit(trx, principal, state, 'consent.withdrawn', 'consent_record', live.id, { purpose: 'profile_public' });
        }
        // A profile made public without a consent (synthetic seed data) is hidden as well.
        await profileIdentity.setVisibility(trx, principal.personId, 'private');
      }
      return this.ownerView(trx, principal.personId);
    });
  }

  // ---- Consent ------------------------------------------------------------------------------------------------------

  listConsents(state: RequestState): Promise<Items<ConsentRecord>> {
    return this.run(state, async (trx, principal) => ConsentListSchema.parse({ items: (await consentRecords.listForSubject(trx, principal.personId)).map(toConsent) }));
  }

  async grantConsent(input: GrantConsentCommand, state: RequestState): Promise<ConsentRecord> {
    if (input.noticeVersion !== CONSENT_NOTICE_VERSIONS[input.purpose]) {
      throw new ApiError('validation.schema', 'consent is given to the current notice', { reason: 'notice_outdated', current: CONSENT_NOTICE_VERSIONS[input.purpose] });
    }
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'govern');
      // A purpose with a public effect of its own goes through its command (visibility, portrait).
      if (input.purpose === 'profile_public') throw new ApiError('validation.schema', 'make the profile public through the visibility command', { reason: 'use_visibility' });
      const row = await consentRecords.insert(trx, {
        subject_person_id: principal.personId, purpose: input.purpose, target_kind: input.target?.kind ?? null, target_id: input.target?.id ?? null,
        notice_version: input.noticeVersion, evidence: { method: 'first_party_form', requestId: state.requestId },
      });
      await this.audit(trx, principal, state, 'consent.granted', 'consent_record', row.id, { purpose: row.purpose, targetKind: row.target_kind, targetId: row.target_id, noticeVersion: row.notice_version });
      await this.event(trx, principal.personId, 1, 'consent.granted', { consentId: row.id, purpose: row.purpose, targetKind: row.target_kind, targetId: row.target_id });
      return toConsent(row);
    });
  }

  /** The database trigger unpublishes the dependent projection and writes the tombstone in this transaction. */
  async withdrawConsent(consentId: string, reason: string, state: RequestState): Promise<ConsentRecord> {
    if (!UUID.test(consentId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'govern');
      const existing = await consentRecords.lock(trx, consentId);
      if (!existing) throw new ApiError('access.not_found');
      if (existing.withdrawn_at !== null) throw new ApiError('validation.revision_conflict', 'this consent is already withdrawn', { reason: 'consent_immutable' });
      const row = await consentRecords.withdraw(trx, consentId, reason);
      if (!row) throw conflict();
      await this.audit(trx, principal, state, 'consent.withdrawn', 'consent_record', row.id, { purpose: row.purpose, targetKind: row.target_kind, targetId: row.target_id });
      await this.event(trx, principal.personId, 2, 'consent.withdrawn', { consentId: row.id, purpose: row.purpose, targetKind: row.target_kind, targetId: row.target_id });
      return toConsent(row);
    });
  }

  // ---- Licences and portraits -----------------------------------------------------------------------------------------

  async recordLicence(input: z.infer<typeof RecordMediaLicenceCommandSchema>, state: RequestState): Promise<MediaLicence> {
    if (!UUID.test(input.assetId)) throw new ApiError('validation.schema', 'the licensed file is not the person\'s own', { reason: 'asset_not_owned' });
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'govern');
      const row = await mediaLicences.insert(trx, {
        asset_id: input.assetId, owner_person_id: principal.personId, licensor: input.licensor, licence_kind: input.licenceKind, scope: input.scope, valid_until: input.validUntil, recorded_by_person_id: principal.personId,
      });
      await this.audit(trx, principal, state, 'media_licence.recorded', 'media_licence', row.id, { assetId: row.asset_id, licenceKind: row.licence_kind });
      return toLicence(row);
    });
  }

  async revokeLicence(licenceId: string, reason: string, state: RequestState): Promise<MediaLicence> {
    if (!UUID.test(licenceId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'govern');
      const existing = await mediaLicences.get(trx, licenceId);
      if (!existing) throw new ApiError('access.not_found');
      const row = await mediaLicences.revoke(trx, licenceId, principal.personId, reason);
      if (!row) throw new ApiError('validation.revision_conflict', 'this licence is already revoked', { reason: 'licence_immutable' });
      await this.audit(trx, principal, state, 'media_licence.revoked', 'media_licence', row.id, { assetId: row.asset_id });
      return toLicence(row);
    });
  }

  /** Shows a portrait; the previous shown portrait is withdrawn (`replaced`, with a tombstone) in the same transaction. */
  async setPortrait(input: z.infer<typeof SetPortraitCommandSchema>, state: RequestState): Promise<Portrait> {
    for (const id of [input.assetId, input.mediaLicenceId, input.consentRecordId]) if (!UUID.test(id)) throw new ApiError('validation.schema', 'unknown reference', { reason: 'unknown_reference' });
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'govern');
      await profileIdentity.lock(trx, principal.personId);
      const previous = await portraits.lockShown(trx, principal.personId);
      if (previous) await portraits.withdraw(trx, previous.id, 'replaced');
      const row = await portraits.insertShown(trx, { person_id: principal.personId, asset_id: input.assetId, media_licence_id: input.mediaLicenceId, consent_record_id: input.consentRecordId });
      await this.audit(trx, principal, state, 'portrait.set', 'portrait', row.id, { assetId: row.asset_id, replaced: previous?.id ?? null });
      await this.event(trx, principal.personId, row.revision, 'portrait.shown', { portraitId: row.id });
      return toPortrait(row);
    });
  }

  async removePortrait(portraitId: string, input: z.infer<typeof RemovePortraitCommandSchema>, state: RequestState): Promise<Portrait> {
    if (!UUID.test(portraitId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'govern');
      const existing = (await portraits.listForPerson(trx, principal.personId)).find((p) => p.id === portraitId);
      if (!existing) throw new ApiError('access.not_found');
      if (existing.revision !== input.expectedRevision) throw conflict();
      const row = await portraits.withdraw(trx, portraitId, 'removed', input.expectedRevision);
      if (!row) throw conflict();
      await this.audit(trx, principal, state, 'portrait.removed', 'portrait', row.id, {});
      return toPortrait(row);
    });
  }

  // ---- Experience -----------------------------------------------------------------------------------------------------

  listExperience(state: RequestState): Promise<Items<ExperienceEntry>> {
    return this.run(state, async (trx, principal) => ExperienceListSchema.parse({ items: (await experienceEntries.listForPerson(trx, principal.personId)).map(toExperience) }));
  }

  private async requireCompany(trx: Transaction, companyId: string | null): Promise<void> {
    if (companyId === null) return;
    if (!UUID.test(companyId) || !(await companies.getById(trx, companyId))) throw new ApiError('validation.schema', 'unknown company', { reason: 'unknown_reference', field: 'organisation.companyId' });
  }

  async addExperience(input: z.infer<typeof AddExperienceCommandSchema>, state: RequestState): Promise<ExperienceEntry> {
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      await this.requireCompany(trx, input.organisation.companyId);
      const row = await experienceEntries.insert(trx, {
        person_id: principal.personId, organisation_company_id: input.organisation.companyId, organisation_name: input.organisation.name, role: input.role, summary: input.summary,
        from_date: input.from, to_date: input.to, visibility: input.visibility,
      });
      await this.audit(trx, principal, state, 'experience.added', 'experience_entry', row.id, { visibility: row.visibility });
      await this.event(trx, principal.personId, row.revision, 'experience.added', { entryId: row.id });
      return toExperience(row);
    });
  }

  async updateExperience(entryId: string, input: z.infer<typeof UpdateExperienceCommandSchema>, state: RequestState): Promise<ExperienceEntry> {
    if (!UUID.test(entryId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      const existing = await experienceEntries.get(trx, entryId);
      if (!existing || existing.archived_at !== null) throw new ApiError('access.not_found');
      await this.requireCompany(trx, input.organisation.companyId);
      const row = await experienceEntries.update(trx, entryId, input.expectedRevision, {
        organisation_company_id: input.organisation.companyId, organisation_name: input.organisation.name, role: input.role, summary: input.summary, from_date: input.from, to_date: input.to, visibility: input.visibility,
      });
      if (!row) throw conflict();
      await this.audit(trx, principal, state, 'experience.updated', 'experience_entry', row.id, { visibility: row.visibility, revision: row.revision });
      await this.event(trx, principal.personId, row.revision, 'experience.updated', { entryId: row.id });
      return toExperience(row);
    });
  }

  async archiveExperience(entryId: string, input: z.infer<typeof ArchiveExperienceCommandSchema>, state: RequestState): Promise<ExperienceEntry> {
    if (!UUID.test(entryId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      const existing = await experienceEntries.get(trx, entryId);
      if (!existing || existing.archived_at !== null) throw new ApiError('access.not_found');
      const row = await experienceEntries.archive(trx, entryId, input.expectedRevision);
      if (!row) throw conflict();
      await this.audit(trx, principal, state, 'experience.archived', 'experience_entry', row.id, {});
      await this.event(trx, principal.personId, row.revision, 'experience.archived', { entryId: row.id });
      return toExperience(row);
    });
  }

  // ---- Private attention records (never audited, never announced) ---------------------------------------------------------

  getPreferences(state: RequestState): Promise<PersonPreference | null> {
    return this.run(state, async (trx, principal) => {
      const row = await personPreferences.get(trx, principal.personId);
      return row ? toPreference(row) : null;
    });
  }

  async savePreferences(input: z.infer<typeof SavePreferencesCommandSchema>, state: RequestState): Promise<PersonPreference> {
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      const existing = await personPreferences.get(trx, principal.personId);
      const completedAt = input.onboardingCompleted ? (existing?.onboarding_completed_at ?? this.ctx.clock.now()) : null;
      const values = { intents: [...input.intents], topics: [...input.topics], regions: [...input.regions], onboarding_completed_at: completedAt };
      if (!existing) {
        if (input.expectedRevision !== null) throw conflict();
        return toPreference(await personPreferences.insert(trx, { person_id: principal.personId, ...values }));
      }
      if (input.expectedRevision !== existing.revision) throw conflict();
      const row = await personPreferences.update(trx, principal.personId, existing.revision, values);
      if (!row) throw conflict();
      return toPreference(row);
    });
  }

  listFollows(state: RequestState): Promise<Items<Follow>> {
    return this.run(state, async (trx, principal) => FollowListSchema.parse({ items: (await follows.listForPerson(trx, principal.personId)).map(toFollow) }));
  }

  /** People must have a public, consented profile and companies must exist; following never tells anyone anything. */
  async follow(input: z.infer<typeof FollowCommandSchema>, state: RequestState): Promise<Follow> {
    const target = input.target;
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      if (target.kind === 'person') {
        if (target.id === principal.personId) throw new ApiError('validation.schema', 'a person does not follow themselves', { reason: 'self_follow' });
        if (!UUID.test(target.id) || !(await publicProfiles.profile(trx, target.id))) throw new ApiError('access.not_found');
      }
      if (target.kind === 'company' && (!UUID.test(target.id) || !(await companies.getById(trx, target.id)))) throw new ApiError('access.not_found');
      if ((target.kind === 'hub' || target.kind === 'event_series') && !UUID.test(target.id)) throw new ApiError('access.not_found');
      const row = await follows.insert(trx, {
        follower_person_id: principal.personId, target_kind: target.kind,
        target_id: 'id' in target ? target.id : null, target_code: 'code' in target ? target.code : null,
      });
      return toFollow(row);
    });
  }

  async unfollow(followId: string, state: RequestState): Promise<Follow> {
    if (!UUID.test(followId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      const row = await follows.end(trx, followId);
      if (!row) throw new ApiError('access.not_found');
      return toFollow(row);
    });
  }

  listBookmarks(state: RequestState): Promise<Items<Bookmark>> {
    return this.run(state, async (trx, principal) => BookmarkListSchema.parse({ items: (await bookmarks.listForPerson(trx, principal.personId)).map(toBookmark) }));
  }

  async addBookmark(input: z.infer<typeof AddBookmarkCommandSchema>, state: RequestState): Promise<Bookmark> {
    if (!UUID.test(input.target.id)) throw new ApiError('validation.schema', 'unknown reference', { reason: 'unknown_reference' });
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      return toBookmark(await bookmarks.insert(trx, { person_id: principal.personId, target_kind: input.target.kind, target_id: input.target.id }));
    });
  }

  async removeBookmark(bookmarkId: string, state: RequestState): Promise<Bookmark> {
    if (!UUID.test(bookmarkId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      const row = await bookmarks.remove(trx, bookmarkId);
      if (!row) throw new ApiError('access.not_found');
      return toBookmark(row);
    });
  }

  listReadingProgress(state: RequestState): Promise<Items<ReadingProgress>> {
    return this.run(state, async (trx, principal) => ReadingProgressListSchema.parse({ items: (await readingProgress.listForPerson(trx, principal.personId)).map(toReadingProgress) }));
  }

  async recordReadingProgress(input: z.infer<typeof RecordReadingProgressCommandSchema>, state: RequestState): Promise<ReadingProgress> {
    if (!UUID.test(input.publicationVersionId)) throw new ApiError('validation.schema', 'unknown reference', { reason: 'unknown_reference' });
    return this.run(state, async (trx, principal) => {
      await this.authority(principal, 'commit');
      return toReadingProgress(await readingProgress.upsert(trx, { person_id: principal.personId, publication_version_id: input.publicationVersionId, progress: input.progress }));
    });
  }

  // ---- Public reads (identical for every caller) ----------------------------------------------------------------------------

  private publicRead<T>(fn: (trx: Transaction) => Promise<T>): Promise<T> {
    return withoutPrincipal(this.ctx.pool, async trx => { await this.publicBoundary(trx); return fn(trx); });
  }

  async publicProfile(personId: string): Promise<PublicPersonProfile> {
    if (!UUID.test(personId)) throw new ApiError('access.not_found');
    const profile = publicProfileFromJson(await this.publicRead((trx) => publicProfiles.profile(trx, personId)));
    if (!profile) throw new ApiError('access.not_found');
    return profile;
  }

  async publicProfileByHandle(requested: string): Promise<{ item: PublicPersonProfile; redirect: boolean }> {
    const parsed = HandleSchema.safeParse(requested);
    if (!parsed.success) throw new ApiError('access.not_found');
    const handle = parsed.data;
    const found = await this.publicRead(async (trx) => {
      const resolved = await directory.publicResolve(trx, 'person', handle);
      return resolved ? { resolved, json: await publicProfiles.profile(trx, resolved.subject_id) } : null;
    });
    const item = found ? publicProfileFromJson(found.json) : null;
    if (!found || !item) throw new ApiError('access.not_found');
    return { item: PublicPersonProfileSchema.parse(item), redirect: found.resolved.current_handle !== handle };
  }

  async companyPeople(companyId: string): Promise<z.infer<typeof CompanyPeopleSchema>> {
    if (!UUID.test(companyId)) throw new ApiError('access.not_found');
    return this.publicRead(async (trx) => {
      if (!(await companies.getById(trx, companyId))) throw new ApiError('access.not_found');
      return CompanyPeopleSchema.parse({ companyId, items: (await publicProfiles.companyPeople(trx, companyId)).map(toCompanyListedPerson) });
    });
  }
}

/** Every consent purpose the API accepts (all of them; profile_public goes through the visibility command). */
export const GRANTABLE_PURPOSES: readonly ConsentPurpose[] = CONSENT_PURPOSES.filter((p) => p !== 'profile_public');
