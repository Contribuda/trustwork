import { Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import { ReqLocales } from '../../identity/mail.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { FinishSetupSchema, FirstAdminAccountSchema, FirstAdminAnswerSchema, SavedSetupStepSchema, SETUP_ANSWER_SCHEMAS, SETUP_TOKEN_HEADER, SetupTokenSchema } from './deps.js';
import { notFound } from './errors.js';
import { SetupService } from './setup.service.js';

const StepParams = z.strictObject({ step: SavedSetupStepSchema });

/** The setup token from its header; a missing or malformed token is "not found" like an unknown one. */
function tokenOf(request: TrustworkRequest): string {
  const raw = request.headers[SETUP_TOKEN_HEADER.toLowerCase()];
  const parsed = SetupTokenSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/**
 * Setup wizard routes (HUB-004). Every route carries the one-time token in `X-Trustwork-Setup-Token` (never in the path
 * or query) and answers `404 access.not_found` for an unknown, expired or used token and after setup finished. Steps
 * 1 to 4 and the account of the founding administrator need only the token; binding the founding administrator needs
 * their session; finishing needs their session and a live elevation (BE-004). Mutations carry the CSRF header like
 * every mutation. They are not `@Idempotent`: each is a state transition that a retry repeats harmlessly (a step
 * answer replaces itself; binding is idempotent for the same person) or refuses (a finished setup is not found).
 */
@Controller('v1/setup')
export class SetupController {
  constructor(@Inject(SetupService) private readonly setup: SetupService) {}

  @Get()
  get(@ReqState() state: RequestState, @Req() request: TrustworkRequest) {
    return this.setup.get(state, tokenOf(request));
  }

  @Post('steps/:step') @HttpCode(200)
  save(@Params(StepParams) params: z.infer<typeof StepParams>, @ReqState() state: RequestState, @Req() request: TrustworkRequest) {
    const token = tokenOf(request);
    const answer = SETUP_ANSWER_SCHEMAS[params.step].parse(request.body ?? {}) as Record<string, unknown>;
    return this.setup.save(state, token, params.step, answer);
  }

  @Post('first-admin/account') @HttpCode(202)
  account(@Body(FirstAdminAccountSchema) body: z.infer<typeof FirstAdminAccountSchema>, @ReqState() state: RequestState, @Req() request: TrustworkRequest, @ReqLocales() locales: string[]) {
    return this.setup.createAdminAccount(state, tokenOf(request), body, locales);
  }

  @Post('first-admin') @HttpCode(200) @Authenticated()
  firstAdmin(@Body(FirstAdminAnswerSchema) body: z.infer<typeof FirstAdminAnswerSchema>, @ReqState() state: RequestState, @Req() request: TrustworkRequest) {
    return this.setup.confirmFirstAdmin(state, tokenOf(request), body);
  }

  @Post('finish') @HttpCode(200) @Authenticated() @UseGuards(ElevationGuard)
  finish(@Body(FinishSetupSchema) _body: z.infer<typeof FinishSetupSchema>, @ReqState() state: RequestState, @Req() request: TrustworkRequest, @Elevation() elevation: SessionElevationRow) {
    return this.setup.finish(state, elevation.id, tokenOf(request));
  }
}
