/**
 * Relative re-exports of the profiles slice (PPL-001). The module imports its own contract and repository files
 * directly so the shared package entries (`packages/contracts/src/index.ts`, `packages/data/src/index.ts`) stay
 * untouched; adding them to those barrels is integrator bookkeeping.
 */
export * from '../../../../../packages/contracts/src/profiles.js';
export {
  bookmarks, consentRecords, experienceEntries, follows, isoDay, mediaLicences, personPreferences, personProfiles, portraits, profileIdentity, profileTombstones, publicProfiles,
  readingProgress, type CompanyPersonRow, type PersonPublicRow, type PublicProfileJson,
} from '../../../../../packages/data/src/repositories/profiles.js';
export type {
  BookmarkRow, ConsentRecordRow, ExperienceEntryRow, FollowRow, MediaLicenceRow, PersonPreferenceRow, PersonProfileRow, PortraitRow, ProfileTombstoneRow, ReadingProgressRow,
} from '../../../../../packages/data/src/schema/profiles.js';
export { directory } from '../../../../../packages/data/src/repositories/directory.js';
