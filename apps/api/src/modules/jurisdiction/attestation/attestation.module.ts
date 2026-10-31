import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { AttestationController } from './attestation.controller.js';
import { AttestationService, type ConfiguredGateMode } from './attestation.service.js';
import type { DeploymentConfiguration } from './deps.js';

export interface AttestationModuleOptions {
  /** The jurisdiction gate this process runs (SANC-001); an attestation naming another mode is contradicted. */
  gateMode: ConfiguredGateMode;
  /** Location facts stated by other configuration (setup wizard, residency); omitted facts never contradict. */
  configuration?: () => Omit<DeploymentConfiguration, 'gateMode'>;
}

/** Deployment-location attestation (SANC-009). `AttestationService` is exported for the launch gate and the manifest. */
@Module({})
export class AttestationModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: AttestationModuleOptions): DynamicModule {
    const service = new AttestationService(ctx, identity.principals, () => ({ ...(options.configuration?.() ?? {}), gateMode: options.gateMode }));
    return {
      module: AttestationModule,
      controllers: [AttestationController],
      providers: [{ provide: AttestationService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [AttestationService],
    };
  }
}
