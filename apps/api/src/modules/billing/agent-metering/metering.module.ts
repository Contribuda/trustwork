import { Controller, Get, HttpCode, Inject, Module, Post, Query, UseGuards, type DynamicModule } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, Idempotent, ReqState, type RequestState } from '../../../common/request.js';
import { Body, Params } from '../../../common/zod.js';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { Elevation, ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import type { SessionElevationRow } from '../../identity/second-factor/deps.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { staffHubFromEnv } from '../../identity/staff-roles.js';
import {
  AcceptMeteredPriceSchema, ActivateMeteredPriceSchema, ActivateVersionSchema, CancelMeteredPriceSchema, DraftAgentPlanSchema, DraftCreditPackSchema, DraftMeteredPriceSchema, MeteredEstimateQuerySchema,
  RecordMeteredCostSchema, ReconcileMeteredStepSchema,
} from './deps.js';
import { MeteredPricesService } from './prices.service.js';
import { AgentPlansService, AgentUsageService } from './usage.service.js';

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

@Controller('v1/admin/billing/metered')
@Authenticated()
@UseGuards(ElevationGuard)
export class AgentPlansController {
  constructor(@Inject(AgentPlansService) private readonly plans: AgentPlansService) {}
  @Post('plans') @HttpCode(201) @Idempotent('billing.plan_draft')
  draftPlan(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(DraftAgentPlanSchema) body: z.infer<typeof DraftAgentPlanSchema>) {
    return this.plans.draftPlan(state, e.id, body);
  }
  @Post('plans/:id/activate') @HttpCode(200) @Idempotent('billing.plan_activate')
  activatePlan(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(ActivateVersionSchema) body: z.infer<typeof ActivateVersionSchema>) {
    return this.plans.activatePlan(state, e.id, p.id, body);
  }
  @Post('credit-packs') @HttpCode(201) @Idempotent('billing.credit_pack_draft')
  draftPack(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Body(DraftCreditPackSchema) body: z.infer<typeof DraftCreditPackSchema>) {
    return this.plans.draftPack(state, e.id, body);
  }
  @Post('credit-packs/:id/activate') @HttpCode(200) @Idempotent('billing.credit_pack_activate')
  activatePack(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(ActivateVersionSchema) body: z.infer<typeof ActivateVersionSchema>) {
    return this.plans.activatePack(state, e.id, p.id, body);
  }
  @Post('steps/:id/reconcile') @HttpCode(200) @Idempotent('billing.metered_step_reconcile')
  reconcile(@ReqState() state: RequestState, @Elevation() e: SessionElevationRow, @Params(IdParams) p: { id: string }, @Body(ReconcileMeteredStepSchema) body: z.infer<typeof ReconcileMeteredStepSchema>) {
    return this.plans.reconcile(state, e.id, p.id, body);
  }
}

/** The participant's own view. These are first-party session routes: no agent, connection or chat text reaches them. */
@Controller('v1/billing')
@Authenticated()
export class AgentUsageController {
  constructor(@Inject(AgentUsageService) private readonly usage: AgentUsageService) {}
  @Get('agent-usage')
  view(@ReqState() state: RequestState, @Query('forCompany') forCompany?: string) {
    return this.usage.view(state, forCompany === 'true');
  }
  @Get('agent-usage/estimate')
  estimate(@ReqState() state: RequestState, @Query() query: unknown) {
    return this.usage.estimate(state, MeteredEstimateQuerySchema.parse(query));
  }
  @Post('prices/:id/accept') @HttpCode(201) @Idempotent('billing.price_accept')
  accept(@ReqState() state: RequestState, @Params(IdParams) p: { id: string }, @Body(AcceptMeteredPriceSchema) body: z.infer<typeof AcceptMeteredPriceSchema>) {
    return this.usage.accept(state, p.id, body);
  }
}

/** Agent usage prices (AGT-004). `env` carries the serving hub, as for the fee commands. */
@Module({})
export class AgentMeteringModule {
  static forRoot(_ctx: AppContext, identity: IdentityServices, env: NodeJS.ProcessEnv = process.env): DynamicModule {
    return {
      module: AgentMeteringModule,
      controllers: [MeteredPricesController, AgentPlansController, AgentUsageController],
      providers: [
        { provide: MeteredPricesService, useValue: new MeteredPricesService(identity.principals, staffHubFromEnv(env)) },
        { provide: AgentPlansService, useValue: new AgentPlansService(identity.principals, staffHubFromEnv(env)) },
        { provide: AgentUsageService, useValue: new AgentUsageService(identity.principals, staffHubFromEnv(env)) },
        { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
      ],
    };
  }
}
