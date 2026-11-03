import { Module, type DynamicModule } from '@nestjs/common';
import { FakeChannelAdapter } from '../../communications/channels.js';
import { communicationsSettingsFromEnv } from '../../communications/communications.module.js';
import { CommunicationsService } from '../../communications/communications.service.js';
import { NoCommsMandates } from '../../communications/mandates.js';
import type { AppContext } from '../../identity/context.js';
import type { IdentityServices } from '../../identity/identity.module.js';
import { ElevationGuard } from '../../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../../identity/second-factor/second-factor.service.js';
import { AdminClaimsController, CompanyBadgesController, OwnClaimsController } from './claims.controller.js';
import { ClaimsService } from './claims.service.js';

/**
 * Company claims and hand-over (CLM-001). Notices render through the communications settings of the served hub; only
 * `deliverPlanned` is used, so the channel adapter here never sends anything.
 */
@Module({})
export class ClaimsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, env: NodeJS.ProcessEnv = process.env): DynamicModule {
    const notices = new CommunicationsService(ctx, identity.principals, new NoCommsMandates(), new FakeChannelAdapter(), communicationsSettingsFromEnv(env));
    const service = new ClaimsService(ctx, identity.principals, notices, env);
    return {
      module: ClaimsModule,
      controllers: [AdminClaimsController, OwnClaimsController, CompanyBadgesController],
      providers: [{ provide: ClaimsService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [ClaimsService],
    };
  }
}
