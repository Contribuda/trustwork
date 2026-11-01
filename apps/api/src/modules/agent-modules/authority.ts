import { sql } from 'kysely';
import { connectionMayInvoke, type AgentCapability, type AgentModuleManifest, type ExternalConnection } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import {
  AgentPolicyDocumentSchema, capabilityRefusal, engineDefaultPolicy, moduleCapabilities, REFUSAL_MESSAGE_KEYS,
  type AgentPolicyDraft, type AgentPrincipalKind, type CapabilityAvailability, type CapabilityPrincipal, type CapabilityRefusalReason, type ModuleRegistry,
} from './contracts.js';
import { agentAuthority, agentPolicies, type DispatchRefusal } from './deps.js';
import { loadRegistry, ENGINE_MANIFESTS, FreePlanEntitlements, NoExtensions, type EntitlementPort, type ExtensionCatalogPort } from './ports.js';
import { NON_PURCHASABLE_CAPABILITIES } from './authority-boundaries.js';

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
   * Trusted serving, persisted operation or validated connection hub. An unbound check is unavailable;
   * process configuration, locale and payload are not execution authority.
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
    const moduleKey = capabilityId.split('.')[0] ?? '';
    if (this.hubId === null) return { allowed: false, capabilityId, moduleKey, reason: 'capability.unknown', messageKey: REFUSAL_MESSAGE_KEYS['capability.unknown'], blockedBy: null };
    await agentAuthority.lockCurrent(trx, this.hubId, actor.representativeOf ?? actor.onBehalfCompanyId, actor.connectionId);
    const registry = await this.registry();
    if (NON_PURCHASABLE_CAPABILITIES.has(capabilityId)) {
      const canonical = registry.manifests.flatMap(m => m.capabilities).find(c => c.id === capabilityId);
      if (canonical && (action === null || action === canonical.mandateAction)) return { allowed: true, capabilityId, moduleKey };
    }
    const { document } = await this.policy(trx, registry);
    const policyReason = capabilityRefusal(document, registry, capabilityId, await this.principalOf(trx, actor));
    if (policyReason !== null) return { allowed: false, capabilityId, moduleKey, reason: policyReason, messageKey: REFUSAL_MESSAGE_KEYS[policyReason], blockedBy: null };
    const enabled = document.policy.enabledModules.find((m) => m.moduleKey === moduleKey);
    const capability = enabled ? moduleCapabilities(registry, moduleKey, enabled.moduleVersion, document.policy.activeExtensionVersionIds).find((c) => c.id === capabilityId) : undefined;
    if (!capability || (action !== null && action !== capability.mandateAction)) {
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
  hubId: string;
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
    const scoped = authority.forHub(input.hubId);
    const d = await scoped.check(trx, actor, input.capabilityId, input.action);
    return d.allowed ? null : { reason: d.reason, messageKey: d.messageKey };
  };
}

export type McpDecision =
  | { decision: 'execute' | 'propose_only' | 'execute_under_mandate' }
  | { decision: 'deny'; reason: RefusalReason | 'connection.scope'; messageKey: string };
/** Supplied by the authenticating transport after token/proof validation, never parsed from tool arguments. */
export interface McpTokenAuthority { audience: string; accessTokenHash: Buffer; dpopJkt: string | null }
/**
 * MCP surface (wired by MCP-001/MCP-003 when the transport lands): the connection's scopes first (`connectionMayInvoke`,
 * AGT-002), then the same authority check as everywhere else, as the connection's person.
 */
export async function mcpGate(authority: CapabilityAuthority, trx: Transaction, connection: ExternalConnection, capability: AgentCapability, onBehalfCompanyId: string | null = null, token: McpTokenAuthority | null = null): Promise<McpDecision> {
  const deny = (): McpDecision => ({ decision: 'deny', reason: 'connection.scope', messageKey: 'agentModules.refusal.connectionScope' });
  // The transport supplies an already validated token audience. Payload hub/scopes/owner are never authority.
  if (!token || !Buffer.isBuffer(token.accessTokenHash) || token.accessTokenHash.length !== 32 || connection.owner.kind !== 'person') return deny();
  const validatedAudience = token.audience;
  let stored = await trx.selectFrom('connection').selectAll().where('id', '=', connection.id).executeTakeFirst();
  if (!stored?.hub_id || stored.person_id !== connection.owner.personId || stored.hub_id !== connection.hubId || stored.resource !== validatedAudience
    || stored.client_id !== connection.clientId || stored.protocol !== connection.protocol || stored.surface !== 'participant') return deny();
  await agentAuthority.lockCurrent(trx, stored.hub_id, onBehalfCompanyId, stored.id);
  stored = await trx.selectFrom('connection').selectAll().where('id', '=', connection.id).executeTakeFirst();
  if (!stored?.hub_id || stored.status !== 'active' || stored.revision !== connection.revision || stored.resource !== validatedAudience) return deny();
  const locked = await sql<{ valid: boolean }>`SELECT trustwork.agent_modules_lock_connection_consent(${stored.id}::uuid) AS valid`.execute(trx);
  if (!locked.rows[0]?.valid) return deny();
  const scope = await sql<{ scopes: string[] | null }>`SELECT trustwork.agent_modules_mcp_token_scopes(
    ${stored.id}::uuid,${token.accessTokenHash}::bytea,${validatedAudience},${token.dpopJkt}) AS scopes`.execute(trx);
  const tokenScopes = scope.rows[0]?.scopes;
  if (!tokenScopes || connection.scopes.some(s => !tokenScopes.includes(s))) return deny();
  const consent = await trx.selectFrom('connection_consent').selectAll().where('id', '=', stored.consent_id)
    .where('withdrawn_at', 'is', null).where('expires_at', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
  if (!consent || consent.person_id !== stored.person_id || !consent.step_up
    || connection.scopes.some(s => !consent.scopes.includes(s)) || connection.privateDataClasses.some(c => !consent.private_data_classes.includes(c))) return deny();
  for (const binding of connection.mandateBindings) {
    if (!consent.mandate_bindings.some(b => b.mandateId === binding.mandateId && b.revision === binding.revision)) return deny();
    const mandate = await trx.selectFrom('mandate').select('id').where('id', '=', binding.mandateId).where('revision', '=', binding.revision)
      .where('principal_person_id', '=', stored.person_id).where('status', '=', 'active').where('valid_until', '>', sql<Date>`clock_timestamp()`).executeTakeFirst();
    if (!mandate) return deny();
  }
  const scopedAuthority = authority.forHub(stored.hub_id);
  const registry = await scopedAuthority.registry();
  const { document } = await scopedAuthority.policy(trx, registry);
  const entry = document.policy.enabledModules.find(m => m.moduleKey === capability.id.split('.')[0]);
  const canonical = NON_PURCHASABLE_CAPABILITIES.has(capability.id)
    ? registry.manifests.flatMap(m => m.capabilities).find(c => c.id === capability.id)
    : entry ? moduleCapabilities(registry, entry.moduleKey, entry.moduleVersion, document.policy.activeExtensionVersionIds).find(c => c.id === capability.id) : undefined;
  // Check the shared policy first, preserving identical refusal reasons for disabled modules/capabilities.
  const actor: AgentActor = { personId: stored.person_id, onBehalfCompanyId, representativeOf: null, connectionId: stored.id };
  const d = await scopedAuthority.check(trx, actor, capability.id, capability.mandateAction);
  if (!d.allowed) return { decision: 'deny', reason: d.reason, messageKey: d.messageKey };
  if (!canonical || canonical.version !== capability.version) return deny();
  // The declared representative reads require a strict MCP summary projector. The first-party page includes
  // accountability history and company mandates and cannot serve that contract. Keep these reads unavailable.
  if (['representative.get', 'representative.list_my_company_mandates', 'representative.list_company_mandates'].includes(canonical.id)) return deny();
  const decision = connectionMayInvoke(canonical, connection);
  if (decision === 'execute_under_mandate') {
    let covered = false;
    for (const binding of connection.mandateBindings) {
      const mandate = await trx.selectFrom('mandate').selectAll().where('id', '=', binding.mandateId).executeTakeFirst();
      if (mandate?.grantee_kind === 'own_agent' && mandate.on_behalf_company_id === onBehalfCompanyId
        && mandate.module_keys.includes(canonical.id.split('.')[0]!) && canonical.mandateAction !== null && mandate.actions.includes(canonical.mandateAction)) covered = true;
    }
    if (!covered) return deny();
  }
  return decision === 'deny' ? deny() : { decision };
}
