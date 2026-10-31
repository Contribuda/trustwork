import { Controller, Get, Inject, Module, Optional, type DynamicModule } from '@nestjs/common';
import { health } from './deps/contracts.js';
import type { ApiConfig } from './config.js';
export const API_CONFIG = Symbol('trustwork.api-config');
import type { AppContext } from './modules/identity/context.js';
import { IdentityModule, type IdentityServices } from './modules/identity/identity.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { DirectoryModule } from './modules/directory/directory.module.js';

@Controller()
export class HealthController {
  constructor(@Optional() @Inject(API_CONFIG) private readonly config: ApiConfig | null) {}
  /** Process liveness only; `externalProviders` reports the configured provider mode truthfully (disabled | fake | live). */
  @Get('health') getHealth() { return { ...health, externalProviders: this.config?.providers.mode ?? 'disabled' }; }
}

/** Composition root: health always; identity, projects and directory only when a database is configured. */
@Module({})
export class AppModule {
  static forRoot(ctx: AppContext | null, identity: IdentityServices | null, config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: API_CONFIG, useValue: config }],
      imports: ctx && identity ? [IdentityModule.forRoot(ctx, identity), ProjectsModule.forRoot(ctx, identity), DirectoryModule.forRoot(ctx, identity)] : [],
    };
  }
}
