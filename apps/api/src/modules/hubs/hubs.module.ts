import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { AdminHubsController, HubsParticipantController, PublicLegalController } from './hubs.controller.js';
import { JurisdictionApplicabilityController } from './jurisdiction/applicability.controller.js';
import { JurisdictionApplicabilityService } from './jurisdiction/applicability.service.js';
import { JurisdictionConsentController } from './jurisdiction/consent.controller.js';
import { JurisdictionConsentService } from './jurisdiction/consent.service.js';
import { HubsService } from './hubs.service.js';

/** Hubs, territories, versioned hub configuration, launch gates and the lifecycle (HUB-001). `HubsService` is exported for the setup wizard and the runtime loader. */
@Module({})
export class HubsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    const service = new HubsService(ctx, identity.principals);
    return {
      module: HubsModule,
      controllers: [AdminHubsController, HubsParticipantController, JurisdictionApplicabilityController, JurisdictionConsentController, PublicLegalController],
      providers: [{ provide: JurisdictionApplicabilityService, useValue: new JurisdictionApplicabilityService(identity.principals) }, { provide: JurisdictionConsentService, useValue: new JurisdictionConsentService(identity.principals) }, { provide: HubsService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [HubsService],
    };
  }
}
