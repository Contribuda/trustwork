import { connectionMayInvoke, type AgentCapability, type AgentModuleManifest, type ExternalConnection } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import {
  AgentPolicyDocumentSchema, capabilityRefusal, engineDefaultPolicy, moduleCapabilities, REFUSAL_MESSAGE_KEYS,
  type AgentPolicyDraft, type AgentPrincipalKind, type CapabilityAvailability, type CapabilityPrincipal, type CapabilityRefusalReason, type ModuleRegistry,
} from './contracts.js';
import { agentAuthority, agentPolicies, type DispatchRefusal } from './deps.js';
import { loadRegistry, ENGINE_MANIFESTS, FreePlanEntitlements, NoExtensions, type EntitlementPort, type ExtensionCatalogPort } from './ports.js';

/** Who the agent acts for in one check. The surface (interface, agent runtime, MCP) is deliberately not an input. */
export interface AgentActor {
  personId: string;
  /** The active employer the person acts for, when they act for it. */
  onBehalfCompanyId: string | null;
  /** The company whose standing representative acts (AGT-001), if this is the representative. */
  representativeOf: string | null;
  /** The external connection carrying the call; kill switches for external agents and the connection apply. */
  connectionId: string | null;
}

export type RefusalReason = CapabilityRefusalReason | 'kill_switch';
export type AuthorityDecision =
  | { allowed: true; capabilityId: string; moduleKey: string }
  | { allowed: false; capabilityId: string; moduleKey: string; reason: RefusalReason; messageKey: string; blockedBy: DispatchRefusal | null };

export interface AuthorityOptions {
  /**
   * This deployment's hub, or a function read at every check (the environment's `TRUSTWORK_HUB_ID`); `null` applies the
   * engine default policy and every hub-scoped switch (fail-closed).
   */
  hubId: string | null | (() => string | null);
  extensions?: ExtensionCatalogPort;
  entitlements?: EntitlementPort;
  manifests?: readonly AgentModuleManifest[];
}

export function kindOf(actor: Pick<AgentActor, 'onBehalfCompanyId' | 'representativeOf'>): AgentPrincipalKind {
  return actor.representativeOf !== null ? 'company_representative' : actor.onBehalfCompanyId !== null ? 'company_member' : 'person';
}

/**
 * The shared authority check of ADR 010 decisions 23 and 25. The interface, the agent runtime and MCP all ask this one
 * object and receive the same answer for the same person, capability and hub state:
 *
 * 1. the hub's active agent policy (or the engine default) through `capabilityRefusal`: module enabled and serving,
 *    eligible for the participant type and company status, capability not switched off for the hub, the participant
 *    type or the plan (plan keys from the entitlement port, AGT-004);
 * 2. the kill switches and stop controls through the database (`agent_modules_dispatch_refusal`): node, hub, module,
 *    capability, verb, external agents, outbound messages, the person's stop, the company representative, the connection.
 *
 * Mandates are checked after this, by the AST-001 mandate store; this check never authorizes anything by itself.
 */
export class CapabilityAuthority {
  private readonly hub: string | null | (() => string | null);
  private readonly extensions: ExtensionCatalogPort;
  private readonly entitlements: EntitlementPort;
  private readonly manifests: readonly AgentModuleManifest[];

  constructor(options: AuthorityOptions) {
    this.hub = options.hubId;
    this.extensions = options.extensions ?? new NoExtensions();
    this.entitlements = options.entitlements ?? new FreePlanEntitlements();
    this.manifests = options.manifests ?? ENGINE_MANIFESTS;
  }

  get hubId(): string | null {
    return typeof this.hub === 'function' ? this.hub() : this.hub;
  }

  /** Bind a check to proven request/connection provenance, preserving the owning entitlement and extension ports. */
  forHub(hubId: string): CapabilityAuthority {
    return new CapabilityAuthority({ hubId, extensions: this.extensions, entitlements: this.entitlements, manifests: this.manifests });
  }

  registry(): Promise<ModuleRegistry> {
    return loadRegistry(this.extensions, this.manifests);
  }

  /** The hub's active policy document, or the engine default (nothing switched off) when none is active. */
  async policy(trx: Transaction, registry?: ModuleRegistry): Promise<{ document: AgentPolicyDraft; versionId: string | null }> {
    const reg = registry ?? await this.registry();
    const hubId = this.hubId;
    if (hubId === null) return { document: engineDefaultPolicy('engine-default', reg), versionId: null };
    const row = await agentPolicies.current(trx, hubId);
    if (!row) return { document: engineDefaultPolicy(hubId, reg), versionId: null };
    return { document: AgentPolicyDocumentSchema.parse(row.document), versionId: row.config_version_id };
  }

  async principalOf(trx: Transaction, actor: AgentActor): Promise<CapabilityPrincipal> {
    const company = actor.representativeOf ?? actor.onBehalfCompanyId;
    return {
      kind: kindOf(actor),
      planKey: await this.entitlements.planKey(trx, { personId: actor.personId, companyId: company }),
      companyVerified: company !== null && await agentAuthority.companyVerified(trx, company),
    };
  }

  async check(trx: Transaction, actor: AgentActor, capabilityId: string, action: string | null = null): Promise<AuthorityDecision> {
    const registry = await this.registry();
    const moduleKey = capabilityId.split('.')[0] ?? '';
    const { document } = await this.policy(trx, registry);
    const policyReason = capabilityRefusal(document, registry, capabilityId, await this.principalOf(trx, actor));
    if (policyReason !== null) return { allowed: false, capabilityId, moduleKey, reason: policyReason, messageKey: REFUSAL_MESSAGE_KEYS[policyReason], blockedBy: null };
    const enabled = document.policy.enabledModules.find((m) => m.moduleKey === moduleKey);
    const capability = enabled ? moduleCapabilities(registry, moduleKey, enabled.moduleVersion, document.policy.activeExtensionVersionIds).find((c) => c.id === capabilityId) : undefined;
    if (capability && action !== null && action !== capability.mandateAction) {
      return { allowed: false, capabilityId, moduleKey, reason: 'capability.unknown', messageKey: REFUSAL_MESSAGE_KEYS['capability.unknown'], blockedBy: null };
    }
    const blocked = await agentAuthority.dispatchRefusal(trx, {
      hubId: this.hubId, moduleKey, capabilityId, action: action ?? capability?.mandateAction ?? null, personId: actor.personId, connectionId: actor.connectionId, representativeOf: actor.representativeOf,
    });
    if (blocked) return { allowed: false, capabilityId, moduleKey, reason: 'kill_switch', messageKey: REFUSAL_MESSAGE_KEYS.kill_switch, blockedBy: blocked };
    return { allowed: true, capabilityId, moduleKey };
  }

  /** Every governed capability with its availability for this person (the interface hides what is unavailable). */
  async availability(trx: Transaction, actor: AgentActor): Promise<CapabilityAvailability[]> {
    const registry = await this.registry();
    const { document } = await this.policy(trx, registry);
    const out: CapabilityAvailability[] = [];
    const capabilities: AgentCapability[] = [
      ...registry.manifests.flatMap((m) => {
        const enabled = document.policy.enabledModules.find((e) => e.moduleKey === m.key);
        return enabled ? moduleCapabilities(registry, m.key, enabled.moduleVersion, document.policy.activeExtensionVersionIds) : m.capabilities;
      }),
    ];
    const seen = new Set<string>();
    for (const c of capabilities) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const d = await this.check(trx, actor, c.id, c.mandateAction);
      out.push({ capabilityId: c.id, moduleKey: c.id.split('.')[0] as string, labelKey: c.labelKey, available: d.allowed, reason: d.allowed ? null : d.messageKey });
    }
    return out;
  }
}

/**
 * Protection limits of the hub's active agent policy for AGT-001's agent-to-agent work (identical across plans, never
 * purchasable); `null` while no policy is active, so the engine settings apply.
 */
export function agentProtectionLimits(authority: CapabilityAuthority): (trx: Transaction) => Promise<{ maxNegotiationRounds: number; envelopesPerCounterpartyPerDay: number } | null> {
  return async (trx) => {
    const { document, versionId } = await authority.policy(trx);
    if (versionId === null) return null;
    const limits = document.policy.protectionLimits;
    return { maxNegotiationRounds: limits.maxNegotiationRounds, envelopesPerCounterpartyPerDay: limits.envelopesPerCounterpartyPerDay };
  };
}

/* ---------- Surface adapters: one decision, three surfaces ---------- */

/** The error every surface reports for a refusal (the interface renders `messageKey` from its locale files). */
export function refusalError(d: Extract<AuthorityDecision, { allowed: false }>): ApiError {
  return new ApiError('access.forbidden', 'capability unavailable', {
    reason: d.reason, messageKey: d.messageKey, capabilityId: d.capabilityId, ...(d.blockedBy ? { blockedBy: d.blockedBy.kind } : {}),
  });
}

/** Interface surface: a route refuses a disabled capability before doing anything. */
export async function requireCapability(authority: CapabilityAuthority, trx: Transaction, actor: AgentActor, capabilityId: string, action: string | null = null): Promise<void> {
  const d = await authority.check(trx, actor, capabilityId, action);
  if (!d.allowed) throw refusalError(d);
}

/** What the agent runtime knows about an action it is about to record (from the acting mandate). */
export interface RuntimeActionInput {
  personId: string;
  mandate: { onBehalfCompanyId: string | null; granteeKind: 'own_agent' | 'colleague_agent' | 'company_representative'; granteeCompanyId: string | null };
  capabilityId: string;
  action: string;
}
/** Agent runtime surface (AST-001 `AssistantService.proposeAction`): `null` to proceed, or the refusal recorded as a denied run step. */
export type CapabilityGate = (trx: Transaction, input: RuntimeActionInput) => Promise<{ reason: RefusalReason; messageKey: string } | null>;
export function agentRuntimeGate(authority: CapabilityAuthority): CapabilityGate {
  return async (trx, input) => {
    const actor: AgentActor = {
      personId: input.personId,
      onBehalfCompanyId: input.mandate.onBehalfCompanyId,
      representativeOf: input.mandate.granteeKind === 'company_representative' ? input.mandate.granteeCompanyId : null,
      connectionId: null,
    };
    const d = await authority.check(trx, actor, input.capabilityId, input.action);
    return d.allowed ? null : { reason: d.reason, messageKey: d.messageKey };
  };
}

export type McpDecision =
  | { decision: 'execute' | 'propose_only' | 'execute_under_mandate' }
  | { decision: 'deny'; reason: RefusalReason | 'connection.scope'; messageKey: string };
/**
 * MCP surface (wired by MCP-001/MCP-003 when the transport lands): the connection's scopes first (`connectionMayInvoke`,
 * AGT-002), then the same authority check as everywhere else, as the connection's person.
 */
export async function mcpGate(authority: CapabilityAuthority, trx: Transaction, connection: ExternalConnection, capability: AgentCapability, onBehalfCompanyId: string | null = null): Promise<McpDecision> {
  const scoped = connectionMayInvoke(capability, connection);
  if (scoped === 'deny') return { decision: 'deny', reason: 'connection.scope', messageKey: 'agentModules.refusal.connectionScope' };
  const personId = connection.owner.kind === 'person' ? connection.owner.personId : connection.consent.personId;
  const actor: AgentActor = {
    personId, onBehalfCompanyId: connection.owner.kind === 'company_representative' ? null : onBehalfCompanyId,
    representativeOf: connection.owner.kind === 'company_representative' ? connection.owner.companyId : null, connectionId: connection.id,
  };
  const d = await authority.check(trx, actor, capability.id, capability.mandateAction);
  if (!d.allowed) return { decision: 'deny', reason: d.reason, messageKey: d.messageKey };
  return { decision: scoped };
}
