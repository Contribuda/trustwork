import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { SupportParticipantController, SupportStaffController } from './support.controller.js';
import { UnavailableEntitlements, type SupportEntitlementsPort } from './ports.js';
import { SupportService } from './support.service.js';

/**
 * Support workspace (SUP-001): staff routes behind an elevated session and the person's own support path. It reaches
 * identity (sessions, elevation, the policy evaluator) and the data slices of DATA-002 and its own migration; it never
 * imports platform-admin. Mounted by the composition root.
 */
export interface SupportModuleOptions {
  /** Billing's read of a person's entitlements for the account card; defaults to "not available" until billing offers one. */
  entitlements?: SupportEntitlementsPort;
}

@Module({})
export class SupportModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: SupportModuleOptions = {}): DynamicModule {
    return {
      module: SupportModule,
      controllers: [SupportStaffController, SupportParticipantController],
      providers: [
        { provide: SupportService, useValue: new SupportService(ctx, identity.principals, options.entitlements ?? new UnavailableEntitlements()) },
        { provide: SecondFactorService, useValue: identity.secondFactors },
        ElevationGuard,
      ],
    };
  }
}
