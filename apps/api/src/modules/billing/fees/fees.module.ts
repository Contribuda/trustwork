import { Controller, Get, HttpCode, Inject, Module, Post, UseGuards, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { staffHubFromEnv } from '../../identity/staff-roles.js';
import { ActivateFeeSchema, DraftFeeSchema } from './deps.js';
import { FeesService } from './fees.service.js';

@Controller('v1/pricing')
export class PublicPricingController {
  constructor(@Inject(FeesService) private readonly fees: FeesService) {}
  @Get() get() { return this.fees.publicPricing(); }
}
@Controller('v1/admin/billing/fees')
@Authenticated()
@UseGuards(ElevationGuard)
export class FeeCommandsController {
  constructor(@Inject(FeesService) private readonly fees: FeesService) {}
  @Post() @HttpCode(201) @Idempotent('billing.fee_draft')
  draft(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(DraftFeeSchema) body: z.infer<typeof DraftFeeSchema>) {
    return this.fees.draft(state, e.id, body);
  }
  @Post(':id/activate') @HttpCode(200) @Idempotent('billing.fee_activate')
  activate(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(z.strictObject({ id: z.uuid() })) p: { id: string }, @Body(ActivateFeeSchema) body: z.infer<typeof ActivateFeeSchema>) {
    return this.fees.activate(state, e.id, p.id, body);
  }
}
@Module({})
export class FeesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, env: NodeJS.ProcessEnv = process.env): DynamicModule {
    return { module: FeesModule, controllers: [PublicPricingController, FeeCommandsController], providers: [
      { provide: FeesService, useValue: new FeesService(ctx, identity.principals, staffHubFromEnv(env)) },
      { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
    ] };
  }
}
