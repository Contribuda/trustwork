import type { ProfilesService } from '../profiles/profiles.service.js';
import type { ServiceCapabilityBinding, ServiceCapabilityBindings } from './service-bindings.js';

const operation = (suffix: string): ServiceCapabilityBinding => ({ capabilityId: `profile_keeper.${suffix}` });
const control = (reason: string): ServiceCapabilityBinding => ({ boundary: 'first_party_control', reason });
const publicProjection: ServiceCapabilityBinding = { boundary: 'public_projection', reason: 'PPL-001 consented public projections are identical for anonymous and authenticated readers; a plan never hides them.' };

/** Private attention records share profile maintenance authority; consent and onboarding retain their owning controls. */
export const PROFILE_SERVICE_BINDINGS = {
  myProfile: operation('get_my_profile'), saveProfile: operation('apply_profile_edit'),
  listExperience: operation('get_my_profile'), addExperience: operation('add_experience'),
  updateExperience: operation('update_experience'), archiveExperience: operation('update_experience'),
  listBookmarks: operation('list_bookmarks'), addBookmark: operation('apply_profile_edit'), removeBookmark: operation('apply_profile_edit'),
  listReadingProgress: operation('list_reading_progress'), recordReadingProgress: operation('apply_profile_edit'),
  listFollows: operation('get_my_profile'), follow: operation('apply_profile_edit'), unfollow: operation('apply_profile_edit'),
  getPreferences: control('Identity onboarding preferences and their removal remain available without a module subscription.'),
  savePreferences: control('Identity onboarding preferences confer no role or entitlement and remain available to the person.'),
  listConsents: control('The person must be able to inspect consent before withdrawing it.'),
  grantConsent: control('First-party consent is not purchasable capacity.'), withdrawConsent: control('Consent withdrawal cannot be disabled.'),
  setVisibility: control('The person controls publication consent and withdrawal regardless of plan.'),
  recordLicence: control('The person records the legal basis for their own media, never an automated publication grant.'),
  revokeLicence: control('The person may withdraw media authority regardless of plan.'),
  setPortrait: control('Portrait publication requires the owning first-party consent and licence checks.'),
  removePortrait: control('The person may remove their portrait regardless of plan.'),
  publicProfile: publicProjection, publicProfileByHandle: publicProjection, companyPeople: publicProjection,
} satisfies ServiceCapabilityBindings<ProfilesService>;
