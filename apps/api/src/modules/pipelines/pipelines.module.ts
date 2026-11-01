import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { AdminPipelinesController } from './pipelines.controller.js';
import { PipelinesService } from './pipelines.service.js';

/** Pipeline engine and scheduler for the hub console: versions, schedules, runs, alerts and role caps (PIPE-001). */
@Module({})
export class PipelinesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    const service = new PipelinesService(ctx, identity.principals);
    return {
      module: PipelinesModule,
      controllers: [AdminPipelinesController],
      providers: [{ provide: PipelinesService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [PipelinesService],
    };
  }
}
