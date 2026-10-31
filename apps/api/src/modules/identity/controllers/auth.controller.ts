import { Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  LoginCommandSchema, passwordSchema, ProviderLinkStartCommandSchema, ProviderSchema, RecoveryCompleteCommandSchema, RecoveryRequestCommandSchema, SignupCommandSchema, VerifyEmailCommandSchema,
} from '../../../deps/contracts.js';
import { Authenticated, CsrfExempt, Req, ReqState, type RequestState, type TrustworkRequest } from '../../../common/request.js';
import { Body, Params, Query } from '../../../common/zod.js';
import { ApiError, LocalApiError } from '../../../common/errors.js';
import { AuthService } from '../auth.service.js';
import { ReqLocales } from '../mail.js';
import { APP_CONTEXT, type AppContext } from '../context.js';
import { FakeOidcProvider } from '../ports.js';
import { ProviderService } from '../providers/provider.service.js';

/** Local command shapes not yet in the frozen contracts (requested from FND-002 in the result). */
export const StepUpCommandSchema = z.strictObject({ password: z.string().min(1).max(256) });
export const ChangePasswordCommandSchema = z.strictObject({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema() });
const ProviderParams = z.strictObject({ provider: ProviderSchema });
const CallbackQuery = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(512) }).loose();
const FakeIdentityCommand = z.strictObject({ subject: z.string().min(1).max(255), email: z.email().nullable(), emailVerified: z.boolean(), name: z.string().max(200).nullable() });

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(ProviderService) private readonly providers: ProviderService, @Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Post('signup') @HttpCode(202)
  signup(@Body(SignupCommandSchema) body: z.infer<typeof SignupCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.auth.signup(body, state.requestId, locales);
  }

  @Post('verify-email') @HttpCode(200)
  verify(@Body(VerifyEmailCommandSchema) body: z.infer<typeof VerifyEmailCommandSchema>, @ReqState() state: RequestState, @Req() request: TrustworkRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.verifyEmail(body.token, state, request, reply);
  }

  @Post('login') @HttpCode(200)
  login(@Body(LoginCommandSchema) body: z.infer<typeof LoginCommandSchema>, @ReqState() state: RequestState, @Req() request: TrustworkRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.login(body, state, request, reply);
  }

  @Post('logout') @HttpCode(204)
  async logout(@ReqState() state: RequestState, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(state, reply);
  }

  @Post('recovery') @HttpCode(202)
  recovery(@Body(RecoveryRequestCommandSchema) body: z.infer<typeof RecoveryRequestCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.auth.requestRecovery(body.email, state.requestId, locales);
  }

  @Post('recovery/complete') @HttpCode(200)
  recoveryComplete(@Body(RecoveryCompleteCommandSchema) body: z.infer<typeof RecoveryCompleteCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    return this.auth.completeRecovery(body, state.requestId, locales);
  }

  @Post('step-up') @HttpCode(200) @Authenticated()
  stepUp(@Body(StepUpCommandSchema) body: z.infer<typeof StepUpCommandSchema>, @ReqState() state: RequestState) {
    return this.auth.stepUp(body.password, state);
  }

  @Post('link/start') @HttpCode(200) @Authenticated('step_up')
  linkStart(@Body(ProviderLinkStartCommandSchema) body: z.infer<typeof ProviderLinkStartCommandSchema>, @ReqState() state: RequestState, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.providers.start(body.provider, 'link', state, reply);
  }

  @Post('unlink') @HttpCode(204) @Authenticated('step_up')
  async unlink(@Body(ProviderLinkStartCommandSchema) body: z.infer<typeof ProviderLinkStartCommandSchema>, @ReqState() state: RequestState, @ReqLocales() locales: string[]) {
    await this.providers.unlink(body.provider, state, locales);
  }

  @Post(':provider/start') @HttpCode(200)
  providerStart(@Params(ProviderParams) params: z.infer<typeof ProviderParams>, @ReqState() state: RequestState, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.providers.start(params.provider, 'login', state, reply);
  }

  /** Top-level navigation from the provider; protected by `state` + the signed flow cookie, not by the CSRF header. */
  @Get(':provider/callback') @CsrfExempt()
  async callback(@Params(ProviderParams) params: z.infer<typeof ProviderParams>, @Query(CallbackQuery) query: z.infer<typeof CallbackQuery>, @ReqState() state: RequestState, @Req() request: TrustworkRequest, @Res() reply: FastifyReply, @ReqLocales() locales: string[]) {
    let outcome: string;
    try {
      outcome = await this.providers.callback(params.provider, query, state, request, reply, locales);
    } catch (error) {
      // A held person (SANC-001) comes back to the sign-in page with the reason, not an error envelope.
      if (!(error instanceof LocalApiError && error.code === 'auth.jurisdiction_hold')) throw error;
      outcome = 'jurisdiction_hold';
    }
    const target = new URL(this.ctx.config.authReturnPath, this.ctx.config.publicOrigin);
    target.searchParams.set('auth', outcome);
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').redirect(target.toString(), 303);
  }

  /** Fake provider mode only, never in production, loopback callers only: scripts the identity the next callback returns. */
  @Post(':provider/fake-identity') @HttpCode(202)
  fakeIdentity(@Params(ProviderParams) params: z.infer<typeof ProviderParams>, @Body(FakeIdentityCommand) body: z.infer<typeof FakeIdentityCommand>, @Req() request: TrustworkRequest) {
    const port = this.ctx.providers[params.provider];
    const loopback = request.ip === '127.0.0.1' || request.ip === '::1' || request.ip === '::ffff:127.0.0.1';
    if (this.ctx.config.providers.mode !== 'fake' || this.ctx.config.production || !loopback || !(port instanceof FakeOidcProvider)) throw new ApiError('access.not_found');
    port.enqueue(body);
    return { status: 'scripted' };
  }
}
