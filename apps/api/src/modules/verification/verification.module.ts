import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { AdminVerificationController, OwnVerificationController } from './verification.controller.js';
import { VerificationService } from './verification.service.js';

/** Counterparty verification for the hub console: providers, recipes, check results and standing (HUB-003). */
@Module({})
export class VerificationModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    const service = new VerificationService(ctx, identity.principals);
    return {
      module: VerificationModule,
      controllers: [AdminVerificationController, OwnVerificationController],
      providers: [{ provide: VerificationService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [VerificationService],
    };
  }
}
