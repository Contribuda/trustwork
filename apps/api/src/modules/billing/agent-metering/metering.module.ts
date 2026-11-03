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
import { ActivateMeteredPriceSchema, CancelMeteredPriceSchema, DraftMeteredPriceSchema, RecordMeteredCostSchema } from './deps.js';
import { MeteredPricesService } from './prices.service.js';

const IdParams = z.strictObject({ id: z.uuid() });

@Controller('v1/admin/billing/metered')
@Authenticated()
@UseGuards(ElevationGuard)
export class MeteredPricesController {
  constructor(@Inject(MeteredPricesService) private readonly prices: MeteredPricesService) {}
  @Get('prices')
  list(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow) {
    return this.prices.list(state, e.id);
  }
  @Post('costs') @HttpCode(201) @Idempotent('billing.metered_cost_record')
  recordCost(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(RecordMeteredCostSchema) body: z.infer<typeof RecordMeteredCostSchema>) {
    return this.prices.recordCost(state, e.id, body);
  }
  @Post('prices') @HttpCode(201) @Idempotent('billing.metered_price_draft')
  draft(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(DraftMeteredPriceSchema) body: z.infer<typeof DraftMeteredPriceSchema>) {
    return this.prices.draft(state, e.id, body);
  }
  @Post('prices/:id/activate') @HttpCode(200) @Idempotent('billing.metered_price_activate')
  activate(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(ActivateMeteredPriceSchema) body: z.infer<typeof ActivateMeteredPriceSchema>) {
    return this.prices.activate(state, e.id, p.id, body);
  }
  @Post('prices/:id/cancel') @HttpCode(200) @Idempotent('billing.metered_price_cancel')
  cancel(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(CancelMeteredPriceSchema) body: z.infer<typeof CancelMeteredPriceSchema>) {
    return this.prices.cancel(state, e.id, p.id, body);
  }
}

/** Agent usage prices (AGT-004). `env` carries the serving hub, as for the fee commands. */
@Module({})
export class AgentMeteringModule {
  static forRoot(_ctx: AppContext, identity: IdentityServices, env: NodeJS.ProcessEnv = process.env): DynamicModule {
    return {
      module: AgentMeteringModule,
      controllers: [MeteredPricesController],
      providers: [
        { provide: MeteredPricesService, useValue: new MeteredPricesService(identity.principals, staffHubFromEnv(env)) },
        { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
      ],
    };
  }
}
