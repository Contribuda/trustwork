import type { CapabilityAuthority } from '../agent-modules/authority.js';
import { Module, type DynamicModule } from '@nestjs/common';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { CORE_SERVICE_BINDINGS } from '../agent-modules/core-bindings.js';
import { bindServiceCapabilities } from '../agent-modules/service-bindings.js';
import { assistantPolicySettings } from '../assistant/assistant.module.js';
import type { PolicySettings } from '../assistant/policy.js';
import { AgentsController, CompanyRepresentativeController } from './agents.controller.js';
import { agentsSettingsFromEnv, type AgentsSettings } from './common.js';
import { EnvelopesService, type ProtectionLimitsSource } from './envelopes.service.js';
import { GoalsService } from './goals.service.js';
import { RepresentativeService } from './representative.service.js';

export interface AgentsModuleOptions {
  /** Shared configured entitlement/extension ports; the serving hub is resolved per invocation. */
  capabilities?: CapabilityAuthority;
  policy?: Partial<PolicySettings>;
  settings?: Partial<AgentsSettings>;
  /** The hub agent policy's protection limits (AGT-003); app.module.ts passes the agent-modules source. */
  protectionLimits?: ProtectionLimitsSource;
}

/** Goals, envelopes, negotiation sessions, the company representative and company mandates (AGT-001). */
@Module({})
export class AgentsModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: AgentsModuleOptions = {}): DynamicModule {
    const policy = assistantPolicySettings(options.policy);
    const settings = { ...agentsSettingsFromEnv(process.env, policy.hubId), ...options.settings };
    const goals = bindServiceCapabilities(ctx, identity.principals, CORE_SERVICE_BINDINGS, principals => new GoalsService(ctx, principals), options.capabilities);
    const envelopes = new EnvelopesService(ctx, identity.principals, policy, settings, options.protectionLimits ?? null);
    const representatives = new RepresentativeService(ctx, identity.principals, policy);
    return {
      module: AgentsModule,
      controllers: [AgentsController, CompanyRepresentativeController],
      providers: [{ provide: GoalsService, useValue: goals }, { provide: EnvelopesService, useValue: envelopes }, { provide: RepresentativeService, useValue: representatives }],
      exports: [GoalsService, EnvelopesService, RepresentativeService],
    };
  }
}
