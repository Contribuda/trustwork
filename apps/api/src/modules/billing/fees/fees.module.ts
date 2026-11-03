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
import { ActivateFeeSchema, ActivateReferralSchema, ActivateSalePriceSchema, DraftFeeSchema, DraftReferralSchema, DraftSalePriceSchema, WithdrawReferralSchema } from './deps.js';
import { FeesService } from './fees.service.js';

@Controller('v1/pricing')
export class PublicPricingController {
  constructor(@Inject(FeesService) private readonly fees: FeesService) {}
  @Get() get() { return this.fees.publicPricing(); }
}
@Controller('v1/billing/fees/task-offers')
@Authenticated()
export class TaskFeeDisclosureController {
  constructor(@Inject(FeesService) private readonly fees: FeesService) {}
  @Post(':id/disclosures') @HttpCode(201) @Idempotent('billing.task_fee_disclose')
  disclose(@ReqState() state: RequestState, @Params(z.strictObject({ id: z.uuid() })) p: { id: string }, @Body(z.strictObject({})) _body: Record<string, never>) {
    void _body; // The strict empty schema rejects caller-selected authority.
    return this.fees.taskDisclosure(state, p.id);
  }
}
@Controller('v1/admin/billing/fees')
@Authenticated()
@UseGuards(ElevationGuard)
export class FeeCommandsController {
  constructor(@Inject(FeesService) private readonly fees: FeesService) {}
  @Get()
  list(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow) {
    return this.fees.staffFees(state, e.id);
  }
  @Post() @HttpCode(201) @Idempotent('billing.fee_draft')
  draft(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(DraftFeeSchema) body: z.infer<typeof DraftFeeSchema>) {
    return this.fees.draft(state, e.id, body);
  }
  @Post(':id/activate') @HttpCode(200) @Idempotent('billing.fee_activate')
  activate(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(z.strictObject({ id: z.uuid() })) p: { id: string }, @Body(ActivateFeeSchema) body: z.infer<typeof ActivateFeeSchema>) {
    return this.fees.activate(state, e.id, p.id, body);
  }
}
const IdParams = z.strictObject({ id: z.uuid() });
@Controller('v1/admin/billing/referrals')
@Authenticated()
@UseGuards(ElevationGuard)
export class ReferralCommandsController {
  constructor(@Inject(FeesService) private readonly fees: FeesService) {}
  @Get()
  list(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow) {
    return this.fees.staffReferrals(state, e.id);
  }
  @Post() @HttpCode(201) @Idempotent('billing.referral_draft')
  draft(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(DraftReferralSchema) body: z.infer<typeof DraftReferralSchema>) {
    return this.fees.draftReferral(state, e.id, body);
  }
  @Post(':id/activate') @HttpCode(200) @Idempotent('billing.referral_activate')
  activate(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(ActivateReferralSchema) body: z.infer<typeof ActivateReferralSchema>) {
    return this.fees.activateReferral(state, e.id, p.id, body);
  }
  @Post(':id/withdraw') @HttpCode(200) @Idempotent('billing.referral_withdraw')
  withdraw(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(WithdrawReferralSchema) body: z.infer<typeof WithdrawReferralSchema>) {
    return this.fees.withdrawReferral(state, e.id, p.id, body);
  }
}
@Controller('v1/admin/billing/sale-prices')
@Authenticated()
@UseGuards(ElevationGuard)
export class SalePriceCommandsController {
  constructor(@Inject(FeesService) private readonly fees: FeesService) {}
  @Get()
  list(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow) {
    return this.fees.staffSalePrices(state, e.id);
  }
  @Post() @HttpCode(201) @Idempotent('billing.sale_price_draft')
  draft(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(DraftSalePriceSchema) body: z.infer<typeof DraftSalePriceSchema>) {
    return this.fees.draftSalePrice(state, e.id, body);
  }
  @Post(':id/activate') @HttpCode(200) @Idempotent('billing.sale_price_activate')
  activate(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(ActivateSalePriceSchema) body: z.infer<typeof ActivateSalePriceSchema>) {
    return this.fees.activateSalePrice(state, e.id, p.id, body);
  }
}
@Module({})
export class FeesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, env: NodeJS.ProcessEnv = process.env): DynamicModule {
    return { module: FeesModule, controllers: [PublicPricingController, FeeCommandsController, ReferralCommandsController, SalePriceCommandsController, TaskFeeDisclosureController], providers: [
      { provide: FeesService, useValue: new FeesService(ctx, identity.principals, staffHubFromEnv(env)) },
      { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
    ] };
  }
}
