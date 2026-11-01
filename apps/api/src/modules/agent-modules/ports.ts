import { AgentModuleManifestSchema, type AgentCapability, type AgentModuleManifest } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { CORE_AGENT_MANIFEST, NEGOTIATION_MANIFEST, REPRESENTATIVE_MANIFEST } from '../../../../../packages/contracts/src/agents.js';
import {
  CONSULTATION_MANIFEST, DEFAULT_PLAN_KEY, EXECUTION_EVIDENCE_MANIFEST, PROFILE_KEEPER_MANIFEST, PROJECT_PLANNER_MANIFEST, REPUTATION_BUILDER_MANIFEST, TASK_MARKETPLACE_MANIFEST, type ModuleRegistry,
} from './contracts.js';

/**
 * Module manifests shipped with the engine (ADR 010 decision 23: every module registers its capabilities). A manifest is
 * code-shipped and versioned; a hub enables a version and may only narrow it. Parsed here so a broken manifest stops the
 * process at start, not at the first authority check.
 */
export const ENGINE_MANIFESTS: readonly AgentModuleManifest[] = [
  CONSULTATION_MANIFEST, CORE_AGENT_MANIFEST, EXECUTION_EVIDENCE_MANIFEST, NEGOTIATION_MANIFEST, PROFILE_KEEPER_MANIFEST, PROJECT_PLANNER_MANIFEST, REPRESENTATIVE_MANIFEST, REPUTATION_BUILDER_MANIFEST, TASK_MARKETPLACE_MANIFEST,
].map((m) => AgentModuleManifestSchema.parse(m));

/**
 * Activated extension versions of the governed extension registry (AGT-023). AGT-003 only reads them: an extension adds
 * capabilities to a module and is enabled through the hub agent policy's `activeExtensionVersionIds`; it can never
 * bypass mandates, budgets, kill switches or privacy rules (capabilityViolations applies to it like to a built-in one).
 */
export interface ExtensionCatalogPort {
  activatedExtensions(): Promise<ModuleRegistry['extensions']>;
}
/** Default until AGT-023: no extension is activated anywhere. */
export class NoExtensions implements ExtensionCatalogPort {
  async activatedExtensions(): Promise<ModuleRegistry['extensions']> {
    return [];
  }
}
/** Test fake: a fixed list of activated extension versions. */
export class FixedExtensions implements ExtensionCatalogPort {
  constructor(private readonly items: { extensionVersionId: string; moduleKey: string; capabilities: readonly AgentCapability[] }[]) {}
  async activatedExtensions(): Promise<ModuleRegistry['extensions']> {
    return this.items;
  }
}

/**
 * Plan keys come from an entitlement port that AGT-004 implements (agent plans and quotas). The plan only decides which
 * capabilities are available; protection limits, ranking, matching and reputation never depend on it.
 */
export interface EntitlementPort {
  planKey(trx: Transaction, actor: { personId: string; companyId: string | null }): Promise<string>;
}
/** Default until AGT-004: everyone is on the free plan. */
export class FreePlanEntitlements implements EntitlementPort {
  async planKey(): Promise<string> {
    return DEFAULT_PLAN_KEY;
  }
}
/** Test fake: plan keys by person (anyone else is on the free plan). */
export class FixedEntitlements implements EntitlementPort {
  constructor(private readonly byPerson: Map<string, string>) {}
  async planKey(_trx: Transaction, actor: { personId: string }): Promise<string> {
    return this.byPerson.get(actor.personId) ?? DEFAULT_PLAN_KEY;
  }
}

export async function loadRegistry(extensions: ExtensionCatalogPort, manifests: readonly AgentModuleManifest[] = ENGINE_MANIFESTS): Promise<ModuleRegistry> {
  const items = await extensions.activatedExtensions();
  for (const e of items) for (const c of e.capabilities) if (c.source.kind !== 'extension') throw new Error(`extension capability ${c.id} carries a module source`);
  return { manifests, extensions: items };
}
