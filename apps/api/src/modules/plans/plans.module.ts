import type { CapabilityAuthority } from '../agent-modules/authority.js';
import { bindServiceCapabilities } from '../agent-modules/service-bindings.js';
import { PLAN_SERVICE_BINDINGS } from '../agent-modules/plan-bindings.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { FileLicensingFacets, type LicensingFacetSource } from './facets.js';
import { NoPlanMandates, type PlanMandatePort } from './mandates.js';
import { PlansController, ProjectRecordsController } from './plans.controller.js';
import { PlansService } from './plans.service.js';

export interface PlansModuleOptions {
  /** Shared configured entitlement/extension ports; the serving hub is resolved per invocation. */
  capabilities?: CapabilityAuthority;
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: PlanMandatePort;
  /** Licensing facets source; defaults to the shipped taxonomy and country-pack files. */
  facets?: LicensingFacetSource;
}

@Module({})
export class PlansModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: PlansModuleOptions = {}): DynamicModule {
    const service = bindServiceCapabilities(ctx, identity.principals, PLAN_SERVICE_BINDINGS, principals =>
      new PlansService(ctx, principals, identity.participations, options.mandates ?? new NoPlanMandates(), options.facets ?? new FileLicensingFacets()), options.capabilities);
    return { module: PlansModule, controllers: [PlansController, ProjectRecordsController], providers: [{ provide: PlansService, useValue: service }], exports: [PlansService] };
  }
}
