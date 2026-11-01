import { Module, type DynamicModule } from '@nestjs/common';
import type { BlobStore } from '../../../../../../packages/data/src/files/blob-store.js';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { AttestationService, type ConfiguredGateMode } from '../../jurisdiction/attestation/attestation.service.js';
import { EngineOperatorScreening, FakeOperatorScreening, type OperatorScreeningPort } from './operator-screening.js';
import { SetupController } from './setup.controller.js';
import { SetupService } from './setup.service.js';

export interface HubsSetupModuleOptions {
  /** The jurisdiction gate this process runs (SANC-001). */
  gateMode: ConfiguredGateMode;
  /** FILE-001's blob store for the object-storage install check, or null. */
  objectStore?: BlobStore | null;
  /** Operator screening; the engine baseline by default. */
  screening?: OperatorScreeningPort;
  /**
   * The process environment: `TRUSTWORK_SETUP_OPERATOR_SCREENING=fake` selects the labelled fake screening (tests and
   * demos; refused in production), anything else or unset the engine baseline.
   */
  env?: NodeJS.ProcessEnv;
  /** The last worker heartbeat, when the worker publishes one (operations follow-up); without it the check warns. */
  workerHeartbeat?: () => Promise<Date | null>;
}

/**
 * The setup wizard backend (HUB-004): `/v1/setup`. It reuses HUB-001's repository commands for the hub and its
 * configuration, SANC-009's attestation command and status (its own `AttestationService` over the same configured gate
 * mode, which is stateless), ADM-001's founding-administrator path through the setup commands and BE-004's second
 * factor. No other module imports it.
 */
@Module({})
export class HubsSetupModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: HubsSetupModuleOptions): DynamicModule {
    const fakeScreening = options.env?.TRUSTWORK_SETUP_OPERATOR_SCREENING === 'fake';
    if (fakeScreening && ctx.config.production) throw new Error('TRUSTWORK_SETUP_OPERATOR_SCREENING=fake is refused in production');
    const attestation = new AttestationService(ctx, identity.principals, () => ({ gateMode: options.gateMode }));
    const service = new SetupService(ctx, identity.principals, identity.auth, identity.secondFactors, attestation, {
      gateMode: options.gateMode,
      screening: options.screening ?? (fakeScreening ? new FakeOperatorScreening() : new EngineOperatorScreening()),
      checks: {
        publicOrigin: ctx.config.publicOrigin, production: ctx.config.production, objectStore: options.objectStore ?? null, secondFactorKey: ctx.secondFactorKey,
        ...(options.workerHeartbeat ? { workerHeartbeat: options.workerHeartbeat } : {}),
      },
    });
    return {
      module: HubsSetupModule,
      controllers: [SetupController],
      providers: [{ provide: SetupService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
    };
  }
}
