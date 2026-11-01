import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import type { BlobStore } from '../../../../../../packages/data/src/files/blob-store.js';
import { PrivacyController, PrivacyStaffController } from './privacy.controller.js';
import type { PrivacyExportPort } from './ports.js';
import { PrivacyService } from './privacy.service.js';

@Module({})
export class PrivacyModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, store: BlobStore | null, exports: PrivacyExportPort): DynamicModule {
    return { module: PrivacyModule, controllers: [PrivacyController, PrivacyStaffController], providers: [
      { provide: PrivacyService, useValue: new PrivacyService(ctx, identity, store, exports) },
      { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
    ] };
  }
}
