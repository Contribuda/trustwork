import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { IdSchema } from '../../deps/contracts.js';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../common/request.js';
import { Body, Params } from '../../common/zod.js';
import {
  AddBookmarkCommandSchema, AddExperienceCommandSchema, ArchiveExperienceCommandSchema, FollowCommandSchema, GrantConsentCommandSchema, RecordMediaLicenceCommandSchema,
  RecordReadingProgressCommandSchema, RemovePortraitCommandSchema, RevokeMediaLicenceCommandSchema, SavePreferencesCommandSchema, SaveProfileCommandSchema, SetPortraitCommandSchema,
  SetProfileVisibilityCommandSchema, UpdateExperienceCommandSchema, WithdrawConsentCommandSchema,
} from './deps.js';
import { ProfilesService } from './profiles.service.js';

const IdParams = z.strictObject({ id: IdSchema });
/** Raw handle text: normalised and checked by the service, which answers not found for anything that is not a handle. */
const HandleParams = z.strictObject({ handle: z.string().min(1).max(200) });
const EmptyBody = z.strictObject({});
type P<T extends z.ZodType> = z.infer<T>;

/**
 * The person's own profile, consents, portraits, experience and private records (PPL-001) under `/v1/me`. Every route
 * needs a session; mutations carry the CSRF header and an `Idempotency-Key` and complete in their request transaction.
 */
@Controller('v1/me')
@Authenticated()
export class MyProfileController {
  constructor(@Inject(ProfilesService) private readonly profiles: ProfilesService) {}

  @Get('profile')
  get(@ReqState() state: RequestState) {
    return this.profiles.myProfile(state);
  }

  @Post('profile') @HttpCode(200) @Idempotent('profile.save')
  save(@Body(SaveProfileCommandSchema) body: P<typeof SaveProfileCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.saveProfile(body, state);
  }

  @Post('profile/visibility') @HttpCode(200) @Idempotent('profile.visibility')
  visibility(@Body(SetProfileVisibilityCommandSchema) body: P<typeof SetProfileVisibilityCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.setVisibility(body, state);
  }

  @Get('consents')
  consents(@ReqState() state: RequestState) {
    return this.profiles.listConsents(state);
  }

  @Post('consents') @HttpCode(201) @Idempotent('consent.grant')
  grant(@Body(GrantConsentCommandSchema) body: P<typeof GrantConsentCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.grantConsent(body, state);
  }

  @Post('consents/:id/withdraw') @HttpCode(200) @Idempotent('consent.withdraw', 'id')
  withdraw(@Params(IdParams) params: P<typeof IdParams>, @Body(WithdrawConsentCommandSchema) body: P<typeof WithdrawConsentCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.withdrawConsent(params.id, body.reason, state);
  }

  @Post('media-licences') @HttpCode(201) @Idempotent('media_licence.record')
  recordLicence(@Body(RecordMediaLicenceCommandSchema) body: P<typeof RecordMediaLicenceCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.recordLicence(body, state);
  }

  @Post('media-licences/:id/revoke') @HttpCode(200) @Idempotent('media_licence.revoke', 'id')
  revokeLicence(@Params(IdParams) params: P<typeof IdParams>, @Body(RevokeMediaLicenceCommandSchema) body: P<typeof RevokeMediaLicenceCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.revokeLicence(params.id, body.reason, state);
  }

  @Post('portrait') @HttpCode(201) @Idempotent('portrait.set')
  setPortrait(@Body(SetPortraitCommandSchema) body: P<typeof SetPortraitCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.setPortrait(body, state);
  }

  @Post('portraits/:id/remove') @HttpCode(200) @Idempotent('portrait.remove', 'id')
  removePortrait(@Params(IdParams) params: P<typeof IdParams>, @Body(RemovePortraitCommandSchema) body: P<typeof RemovePortraitCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.removePortrait(params.id, body, state);
  }

  @Get('experience')
  experience(@ReqState() state: RequestState) {
    return this.profiles.listExperience(state);
  }

  @Post('experience') @HttpCode(201) @Idempotent('experience.add')
  addExperience(@Body(AddExperienceCommandSchema) body: P<typeof AddExperienceCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.addExperience(body, state);
  }

  @Post('experience/:id') @HttpCode(200) @Idempotent('experience.update', 'id')
  updateExperience(@Params(IdParams) params: P<typeof IdParams>, @Body(UpdateExperienceCommandSchema) body: P<typeof UpdateExperienceCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.updateExperience(params.id, body, state);
  }

  @Post('experience/:id/archive') @HttpCode(200) @Idempotent('experience.archive', 'id')
  archiveExperience(@Params(IdParams) params: P<typeof IdParams>, @Body(ArchiveExperienceCommandSchema) body: P<typeof ArchiveExperienceCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.archiveExperience(params.id, body, state);
  }

  @Get('preferences')
  async preferences(@ReqState() state: RequestState) {
    return { preferences: await this.profiles.getPreferences(state) };
  }

  @Post('preferences') @HttpCode(200) @Idempotent('preferences.save')
  savePreferences(@Body(SavePreferencesCommandSchema) body: P<typeof SavePreferencesCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.savePreferences(body, state);
  }

  @Get('follows')
  follows(@ReqState() state: RequestState) {
    return this.profiles.listFollows(state);
  }

  @Post('follows') @HttpCode(201) @Idempotent('follow.add')
  follow(@Body(FollowCommandSchema) body: P<typeof FollowCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.follow(body, state);
  }

  @Post('follows/:id/end') @HttpCode(200) @Idempotent('follow.end', 'id')
  unfollow(@Params(IdParams) params: P<typeof IdParams>, @Body(EmptyBody) _body: P<typeof EmptyBody>, @ReqState() state: RequestState) {
    return this.profiles.unfollow(params.id, state);
  }

  @Get('bookmarks')
  bookmarks(@ReqState() state: RequestState) {
    return this.profiles.listBookmarks(state);
  }

  @Post('bookmarks') @HttpCode(201) @Idempotent('bookmark.add')
  addBookmark(@Body(AddBookmarkCommandSchema) body: P<typeof AddBookmarkCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.addBookmark(body, state);
  }

  @Post('bookmarks/:id/remove') @HttpCode(200) @Idempotent('bookmark.remove', 'id')
  removeBookmark(@Params(IdParams) params: P<typeof IdParams>, @Body(EmptyBody) _body: P<typeof EmptyBody>, @ReqState() state: RequestState) {
    return this.profiles.removeBookmark(params.id, state);
  }

  @Get('reading-progress')
  readingProgress(@ReqState() state: RequestState) {
    return this.profiles.listReadingProgress(state);
  }

  @Post('reading-progress') @HttpCode(200) @Idempotent('reading_progress.record')
  recordReadingProgress(@Body(RecordReadingProgressCommandSchema) body: P<typeof RecordReadingProgressCommandSchema>, @ReqState() state: RequestState) {
    return this.profiles.recordReadingProgress(body, state);
  }
}

/** Public profiles: the allowlisted projection of public, consented profiles; identical for every caller. */
@Controller('v1/people')
export class PublicProfilesController {
  constructor(@Inject(ProfilesService) private readonly profiles: ProfilesService) {}

  @Get('by-handle/:handle/profile')
  byHandle(@Params(HandleParams) params: P<typeof HandleParams>) {
    return this.profiles.publicProfileByHandle(params.handle);
  }

  @Get(':id/profile')
  byId(@Params(IdParams) params: P<typeof IdParams>) {
    return this.profiles.publicProfile(params.id);
  }
}

/** People a company lists on its page: only members who consented to that listing and keep a public profile. */
@Controller('v1/companies')
export class CompanyPeopleController {
  constructor(@Inject(ProfilesService) private readonly profiles: ProfilesService) {}

  @Get(':id/people')
  people(@Params(IdParams) params: P<typeof IdParams>) {
    return this.profiles.companyPeople(params.id);
  }
}
