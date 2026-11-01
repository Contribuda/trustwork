import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { defaultPolicyFetcher, defaultSummaryDrafter, type SourcePolicyFetcher, type SummaryDrafter } from './ports.js';
import { AdminSourcesController, PublicSourcesController } from './sources.controller.js';
import { SourcesService } from './sources.service.js';

export interface SourcesModuleOptions {
  /** robots.txt and RSL fetches; defaults to the synthetic fake (no crawler or live adapter exists yet). */
  policyFetcher?: SourcePolicyFetcher;
  /** Model-assisted summaries; defaults to the synthetic fake (no model route is wired here). */
  summaryDrafter?: SummaryDrafter;
}

/** Hub source registry: licence flags, legal basis, robots, terms and RSL checks, import review, takedown and the sponsored policy (SRC-001). */
@Module({})
export class SourcesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: SourcesModuleOptions = {}): DynamicModule {
    const service = new SourcesService(ctx, identity.principals, {
      policyFetcher: options.policyFetcher ?? defaultPolicyFetcher, summaryDrafter: options.summaryDrafter ?? defaultSummaryDrafter,
    });
    return {
      module: SourcesModule,
      controllers: [AdminSourcesController, PublicSourcesController],
      providers: [{ provide: SourcesService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [SourcesService],
    };
  }
}
