import { Controller, Get, Inject, Module, Optional, type DynamicModule } from '@nestjs/common';
import { health } from './deps/contracts.js';
import type { ApiConfig } from './config.js';
export const API_CONFIG = Symbol('trustwork.api-config');
import type { AppContext } from './modules/identity/context.js';
import { IdentityModule, type IdentityServices } from './modules/identity/identity.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { DirectoryModule } from './modules/directory/directory.module.js';
import { PlansModule } from './modules/plans/plans.module.js';
import { CatalogueModule } from './modules/catalogue/catalogue.module.js';
import { ProcurementModule } from './modules/procurement/procurement.module.js';
import { FilesModule, type FilesModuleOptions } from './modules/files/files.module.js';

@Controller()
export class HealthController {
  constructor(@Optional() @Inject(API_CONFIG) private readonly config: ApiConfig | null) {}
  /** Process liveness only; `externalProviders` reports the configured provider mode truthfully (disabled | fake | live). */
  @Get('health') getHealth() { return { ...health, externalProviders: this.config?.providers.mode ?? 'disabled' }; }
}

/**
 * Composition root: health always; identity, projects, directory, plans, catalogue and procurement only when a database
 * is configured; files (FILE-001) additionally only with a configured blob store.
 */
@Module({})
export class AppModule {
  static forRoot(ctx: AppContext | null, identity: IdentityServices | null, config: ApiConfig, files: FilesModuleOptions = { store: null }): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: API_CONFIG, useValue: config }],
      imports: ctx && identity ? [IdentityModule.forRoot(ctx, identity), ProjectsModule.forRoot(ctx, identity), DirectoryModule.forRoot(ctx, identity), PlansModule.forRoot(ctx, identity), CatalogueModule.forRoot(ctx, identity), ProcurementModule.forRoot(ctx, identity), FilesModule.forRoot(ctx, identity, files)] : [],
    };
  }
}
