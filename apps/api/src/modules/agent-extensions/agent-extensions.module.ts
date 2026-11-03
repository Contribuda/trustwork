import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { AdminAgentExtensionsController } from './agent-extensions.controller.js';
import { AgentExtensionsService } from './agent-extensions.service.js';

/** The governed extension registry (AGT-023). */
@Module({})
export class AgentExtensionsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    return {
      module: AgentExtensionsModule,
      controllers: [AdminAgentExtensionsController],
      providers: [
        { provide: AgentExtensionsService, useValue: new AgentExtensionsService(ctx, identity.principals) }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
      ],
      exports: [AgentExtensionsService],
    };
  }
}
