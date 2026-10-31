import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { ExecutionController } from './execution.controller.js';
import { ExecutionService } from './execution.service.js';
import { NoExecutionMandates, type ExecutionMandatePort } from './mandates.js';

export interface ExecutionModuleOptions {
  /** Agent mandate check; defaults to "no mandate store", which refuses every agent request. */
  mandates?: ExecutionMandatePort;
  /** The hub this API serves; defaults to TRUSTWORK_HUB_ID (disputes need it). */
  hubId?: string | null;
}

@Module({})
export class ExecutionModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: ExecutionModuleOptions = {}): DynamicModule {
    const hubId = options.hubId !== undefined ? options.hubId : staffHubFromEnv(process.env);
    const service = new ExecutionService(ctx, identity.principals, options.mandates ?? new NoExecutionMandates(), { hubId });
    return { module: ExecutionModule, controllers: [ExecutionController], providers: [{ provide: ExecutionService, useValue: service }], exports: [ExecutionService] };
  }
}
