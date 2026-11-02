import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { AdminDatasetsController } from './datasets.controller.js';
import { DatasetsService } from './datasets.service.js';

/** Local data mining for the hub console: datasets, licences, records, do-not-collect and entity resolution (MINE-001). */
@Module({})
export class DatasetsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices): DynamicModule {
    const service = new DatasetsService(ctx, identity.principals);
    return {
      module: DatasetsModule,
      controllers: [AdminDatasetsController],
      providers: [{ provide: DatasetsService, useValue: service }, { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard],
      exports: [DatasetsService],
    };
  }
}
