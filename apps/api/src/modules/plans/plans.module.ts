import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { FileLicensingFacets, type LicensingFacetSource } from './facets.js';
import { NoPlanMandates, type PlanMandatePort } from './mandates.js';
import { PlansController, ProjectRecordsController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

export interface PlansModuleOptions {
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: PlanMandatePort;
  /** Licensing facets source; defaults to the shipped taxonomy and country-pack files. */
  facets?: LicensingFacetSource;
}

@Module({})
export class PlansModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: PlansModuleOptions = {}): DynamicModule {
    const service = new PlansService(ctx, identity.principals, identity.participations, options.mandates ?? new NoPlanMandates(), options.facets ?? new FileLicensingFacets());
    return { module: PlansModule, controllers: [PlansController, ProjectRecordsController], providers: [{ provide: PlansService, useValue: service }], exports: [PlansService] };
  }
}
