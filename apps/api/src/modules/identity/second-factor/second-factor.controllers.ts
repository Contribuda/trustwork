import { Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Authenticated, Idempotent, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import { ReqLocales } from '../mail.js';
import {
  RecoveryCodesRegenerateCommandSchema, SecondFactorLoginCommandSchema, SecondFactorRemoveCommandSchema, SecondFactorResetRequestCommandSchema, SessionElevateCommandSchema,
  TotpEnrolmentConfirmCommandSchema, type SessionElevationRow,
} from './deps.js';
import { Elevation, ElevationGuard } from './elevation.guard.js';
import { SecondFactorService } from './second-factor.service.js';

const UuidParams = z.strictObject({ id: z.uuid() });

/** The person's own second factor: status, TOTP enrolment, recovery codes, removal, cancelling a support reset. */
@Controller('v1/me/second-factor')
@Authenticated()
export class MeSecondFactorController {
  constructor(@Inject(SecondFactorService) private readonly secondFactors: SecondFactorService) {}

  @Get()
  status(@ReqState() state: RequestState) {
    return this.secondFactors.status(state);
  }

  @Post('totp') @HttpCode(201) @Authenticated('step_up')
  start(@ReqState() state: RequestState) {
    return this.secondFactors.startTotp(state);
  }

  @Post('totp/confirm') @HttpCode(200) @Authenticated('step_up')
  confirm(@Body(TotpEnrolmentConfirmCommandSchema) body: z.infer<typeof TotpEnrolmentConfirmCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.secondFactors.confirmTotp(body, state, locales);
  }

  @Post('recovery-codes') @HttpCode(200) @Authenticated('step_up')
  regenerate(@Body(RecoveryCodesRegenerateCommandSchema) body: z.infer<typeof RecoveryCodesRegenerateCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.secondFactors.regenerateRecoveryCodes(body.proof, state, locales);
  }

  @Post('remove') @HttpCode(200) @Authenticated('step_up')
  remove(@Body(SecondFactorRemoveCommandSchema) body: z.infer<typeof SecondFactorRemoveCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.secondFactors.removeFactor(body, state, locales);
  }

  @Post('resets/:id/cancel') @HttpCode(200) @Authenticated('step_up')
  cancelReset(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.secondFactors.cancelOwnReset(params.id, state, locales);
  }
}

/** Second step of sign-in (rate limited with the other `/v1/auth/*` routes). */
@Controller('v1/auth')
export class SecondFactorLoginController {
  constructor(@Inject(SecondFactorService) private readonly secondFactors: SecondFactorService) {}

  @Post('second-factor') @HttpCode(200)
  complete(@Body(SecondFactorLoginCommandSchema) body: z.infer<typeof SecondFactorLoginCommandSchema>, @ReqState() state: RequestState, @Req() request: TrustworkRequest, @Res({ passthrough: true }) reply: FastifyReply, @ReqLocales() locales: string[]) {
    return this.secondFactors.completeSignIn(body.proof, state, request, reply, locales);
  }
}

/** `admin.session.elevate` and the elevation of the acting session. */
@Controller('v1/admin/session')
@Authenticated()
export class AdminSessionController {
  constructor(@Inject(SecondFactorService) private readonly secondFactors: SecondFactorService) {}

  @Post('elevate') @HttpCode(200) @Authenticated('step_up')
  elevate(@Body(SessionElevateCommandSchema) body: z.infer<typeof SessionElevateCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.secondFactors.elevate(body.proof, state, locales);
  }

  /** A staff route: answers only for a live elevation of this session. */
  @Get() @UseGuards(ElevationGuard)
  current(@Elevation() elevation: SessionElevationRow, @ReqState() state: RequestState) {
    return this.secondFactors.currentElevation(elevation, state);
  }

  @Post('end') @HttpCode(200)
  end(@ReqState() state: RequestState) {
    return this.secondFactors.endElevation(state);
  }
}

/**
 * Support reset of another person's second factor (SUP-001 builds the console on these use cases): request with
 * evidence, approval by a different person, execution only after the 72-hour cooling-off; every step is a staff route
 * behind an elevated session and completes its idempotency record in its own transaction.
 */
@Controller('v1/admin/support/second-factor-resets')
@Authenticated()
@UseGuards(ElevationGuard)
export class SupportSecondFactorController {
  constructor(@Inject(SecondFactorService) private readonly secondFactors: SecondFactorService) {}

  @Post() @HttpCode(201) @Idempotent('support.second_factor_reset.request')
  request(@Body(SecondFactorResetRequestCommandSchema) body: z.infer<typeof SecondFactorResetRequestCommandSchema>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return this.secondFactors.requestReset(body, state, elevation.id);
  }

  @Get(':id')
  read(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState) {
    return this.secondFactors.readReset(params.id, state);
  }

  @Post(':id/approve') @HttpCode(200) @Idempotent('support.second_factor_reset.approve', 'id')
  approve(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return this.secondFactors.approveReset(params.id, state, elevation.id);
  }

  @Post(':id/cancel') @HttpCode(200) @Idempotent('support.second_factor_reset.cancel', 'id')
  cancel(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return this.secondFactors.cancelReset(params.id, state, elevation.id);
  }

  @Post(':id/execute') @HttpCode(200) @Idempotent('support.second_factor_reset.execute', 'id')
  execute(@Params(UuidParams) params: z.infer<typeof UuidParams>, @ReqState() state: RequestState, @Elevation() elevation: SessionElevationRow) {
    return this.secondFactors.executeReset(params.id, state, elevation.id);
  }
}
