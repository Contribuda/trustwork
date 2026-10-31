import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { ChangeEmailCommandSchema, RevokeSessionCommandSchema } from '../../../deps/contracts.js';
import { Authenticated, ReqState, type RequestState } from '../../../common/request.js';
import { Body } from '../../../common/zod.js';
import { AuthService } from '../auth.service.js';
import { ChangePasswordCommandSchema } from './auth.controller.js';

@Controller('v1/me')
@Authenticated()
export class MeController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get()
  me(@ReqState() state: RequestState) {
    return this.auth.me(state);
  }

  @Get('sessions')
  sessions(@ReqState() state: RequestState) {
    return this.auth.listSessions(state);
  }

  @Post('sessions/revoke') @HttpCode(204)
  async revoke(@Body(RevokeSessionCommandSchema) body: z.infer<typeof RevokeSessionCommandSchema>, @ReqState() state: RequestState) {
    await this.auth.revokeSession(body.sessionId, state);
  }

  @Post('sessions/revoke-others') @HttpCode(200) @Authenticated('step_up')
  revokeOthers(@ReqState() state: RequestState) {
    return this.auth.revokeOtherSessions(state);
  }

  @Post('password') @HttpCode(204) @Authenticated('step_up')
  async password(@Body(ChangePasswordCommandSchema) body: z.infer<typeof ChangePasswordCommandSchema>, @ReqState() state: RequestState) {
    await this.auth.changePassword(body, state);
  }

  @Post('email') @HttpCode(202) @Authenticated('step_up')
  email(@Body(ChangeEmailCommandSchema) body: z.infer<typeof ChangeEmailCommandSchema>, @ReqState() state: RequestState) {
    return this.auth.changeEmail(body.newEmail, state);
  }
}
