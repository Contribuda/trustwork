import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { ReputationBuilderController } from './reputation.controller.js';
import { ReputationService } from './reputation.service.js';
import { FakeCredentialRegister, type CredentialRegisterPort } from './register.js';

export interface ReputationModuleOptions {
  /** The hub this API serves; defaults to TRUSTWORK_HUB_ID (credential checks and appeals need it). */
  hubId?: string | null;
  /** Credential register adapter; defaults to the synthetic fake (no live register adapter exists yet). */
  register?: CredentialRegisterPort;
}

@Module({})
export class ReputationModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ReputationModuleOptions = {}): DynamicModule {
    // Read at request time, so a hub configured after start (setup wizard, tests) is picked up.
    const hubId = options.hubId !== undefined ? options.hubId : () => staffHubFromEnv(process.env);
    const service = new ReputationService(ctx, identity.principals, { hubId, register: options.register ?? new FakeCredentialRegister() });
    return { module: ReputationModule, controllers: [ReputationBuilderController], providers: [{ provide: ReputationService, useValue: service }], exports: [ReputationService] };
  }
}
