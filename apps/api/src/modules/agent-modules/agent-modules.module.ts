import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { ElevationGuard } from '../identity/second-factor/elevation.guard.js';
import { SecondFactorService } from '../identity/second-factor/second-factor.service.js';
import { AdminAgentModulesController, AgentJobsController } from './agent-modules.controller.js';
import { CapabilityAuthority, type AuthorityOptions } from './authority.js';
import { AgentJobsService } from './jobs.service.js';
import { AgentPolicyService } from './policy.service.js';

export interface AgentModulesModuleOptions {
  /** The one shared authority check; app.module.ts passes the instance it also gives the agent runtime. */
  authority?: CapabilityAuthority;
  authorityOptions?: Partial<AuthorityOptions>;
}

/** Unbound until a real request, stored run or validated connection provides its hub. */
export function agentModulesAuthority(options: Partial<AuthorityOptions> = {}): CapabilityAuthority {
  return new CapabilityAuthority({ ...options, hubId: options.hubId ?? null });
}

/** Agent module registry, hub agent policy, job subscriptions and kill switches (AGT-003). */
@Module({})
export class AgentModulesModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: AgentModulesModuleOptions = {}): DynamicModule {
    const authority = options.authority ?? agentModulesAuthority(options.authorityOptions);
    const policies = new AgentPolicyService(ctx, identity.principals, authority);
    const jobs = new AgentJobsService(ctx, identity.principals, authority);
    return {
      module: AgentModulesModule,
      controllers: [AdminAgentModulesController, AgentJobsController],
      providers: [
        { provide: AgentPolicyService, useValue: policies }, { provide: AgentJobsService, useValue: jobs }, { provide: CapabilityAuthority, useValue: authority },
        { provide: SecondFactorService, useValue: identity.secondFactors }, ElevationGuard,
      ],
      exports: [AgentPolicyService, AgentJobsService, CapabilityAuthority],
    };
  }
}
