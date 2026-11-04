import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { PrivacyController, PrivacyPreparationController, PrivacyStaffController, PrivacyPublicController } from './privacy.controller.js';
import type { PrivacyExportPort } from './ports.js';
import { PrivacyService } from './privacy.service.js';

@Module({})
export class PrivacyModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, exports: PrivacyExportPort): DynamicModule {
    return { module: PrivacyModule, controllers: [PrivacyController, PrivacyPreparationController, PrivacyStaffController, PrivacyPublicController], providers: [
      { provide: PrivacyService, useValue: new PrivacyService(ctx, identity, exports) },
      { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
    ] };
  }
}
