import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { ReputationController, TrustController } from './trust.controller.js';
import { TrustService } from './trust.service.js';

export interface TrustModuleOptions {
  /** The hub this API serves; defaults to TRUSTWORK_HUB_ID (appeals need it). */
  hubId?: string | null;
}

@Module({})
export class TrustModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: TrustModuleOptions = {}): DynamicModule {
    const hubId = options.hubId !== undefined ? options.hubId : staffHubFromEnv(process.env);
    const service = new TrustService(ctx, identity.principals, { hubId });
    return { module: TrustModule, controllers: [TrustController, ReputationController], providers: [{ provide: TrustService, useValue: service }], exports: [TrustService] };
  }
}
