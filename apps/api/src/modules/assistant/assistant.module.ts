import { Module, type DynamicModule } from '@nestjs/common';
import type { MandateActionV2 } from '../../deps/contracts.js';
import type { AppContext } from '../identity/context.js';
import type { IdentityServices } from '../identity/identity.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService, DEFAULT_RUNTIME_SETTINGS, type AssistantRuntimeSettings } from './assistant.service.js';
import { AssistantMandateStore } from './mandate-store.js';
import { restrictedPlacesFromPacks, type PolicySettings } from './policy.js';
import { UnavailableModel, UnavailableRetrieval, type ModelPort, type RetrievalPort } from './ports.js';

export interface AssistantModuleOptions {
  /** Model port; default: no model (nothing leaves the process). Live providers arrive with LLM-001 behind egress policy. */
  model?: ModelPort;
  /** Retrieval port; default: unavailable until RAG-301. */
  retrieval?: RetrievalPort;
  policy?: Partial<PolicySettings>;
  runtime?: Partial<AssistantRuntimeSettings>;
}

/** Hub id of this deployment for kill-switch scoping (`TRUSTWORK_HUB_ID`); null applies every hub-scoped switch. */
export function hubIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TRUSTWORK_HUB_ID?.trim();
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

/** Engine default until the hub agent policy (HUB-002) is stored: commitments and payments are never pre-authorized. */
export const DEFAULT_FORBIDDEN_PRE_AUTHORIZATION: readonly MandateActionV2[] = ['release_payment'];

export function assistantPolicySettings(overrides: Partial<PolicySettings> = {}): PolicySettings {
  return {
    hubId: overrides.hubId !== undefined ? overrides.hubId : hubIdFromEnv(),
    forbiddenPreAuthorization: overrides.forbiddenPreAuthorization ?? DEFAULT_FORBIDDEN_PRE_AUTHORIZATION,
    isRestricted: overrides.isRestricted ?? restrictedPlacesFromPacks(),
  };
}

/** The one mandate store behind every module's agent check (wired in app.module.ts). */
export function assistantMandateStore(ctx: AppContext, overrides: Partial<PolicySettings> = {}): AssistantMandateStore {
  return new AssistantMandateStore(ctx.pool, assistantPolicySettings(overrides), ctx.clock);
}

@Module({})
export class AssistantModule {
  static forRoot(ctx: AppContext, identity: IdentityServices, options: AssistantModuleOptions = {}): DynamicModule {
    const service = new AssistantService(
      ctx, identity.principals, assistantPolicySettings(options.policy), { ...DEFAULT_RUNTIME_SETTINGS, ...options.runtime },
      options.model ?? new UnavailableModel(), options.retrieval ?? new UnavailableRetrieval(),
    );
    return {
      module: AssistantModule,
      controllers: [AssistantController],
      providers: [{ provide: AssistantService, useValue: service }],
      exports: [AssistantService],
    };
  }
}
