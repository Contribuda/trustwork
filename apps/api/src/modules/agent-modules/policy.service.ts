import type { z } from 'zod';
import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION, type ConsoleCommandResult, type Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { hubsRefusal } from '../hubs/errors.js';
import { HubsService, type Elevated } from '../hubs/hubs.service.js';
import type { CapabilityAuthority } from './authority.js';
import {
  AgentPolicyDocumentSchema, diffPolicies, policyDocumentViolations,
  type ActivateAgentPolicyCommand, type AgentPolicyDocument, type AgentPolicyDraft, type DraftAgentPolicyCommand, type EngageAgentKillSwitchCommand, type ModuleRegistry, type PolicyPreview,
  type ReleaseAgentKillSwitchCommandSchema,
} from './contracts.js';
import { adminDigests, agentKillSwitches, agentPolicies, approvals, configActivationDigestInput, hubConfig, type AgentPolicyVersionRow, type CommandContext, type KillSwitchRow } from './deps.js';

type Body<S extends z.ZodType> = z.infer<S>;
interface Cmd { idempotencyKey: string; reason: string }

/** Database refusals of this module (SQLSTATE plus hint) as contract codes; the hint travels in `details.reason`. */
const HINTS: Readonly<Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }>> = {
  'agents.attribution_unavailable': { code: 'access.forbidden', reason: 'attribution_unavailable' },
  'agents.hub_mismatch': { code: 'access.forbidden', reason: 'hub_mismatch' },
  'agents.preview_stale': { code: 'validation.revision_conflict', reason: 'preview_stale' },
  'agents.policy_unvalidated': { code: 'validation.schema', reason: 'policy_unvalidated' },
  'agents.policy_invalid': { code: 'validation.schema', reason: 'policy_invalid' },
  'agents.guard_rail': { code: 'validation.schema', reason: 'guard_rail' },
};
export function agentModulesRefusal(error: unknown): ApiError | null {
  const pg = error as { code?: string; hint?: string; detail?: string } | null;
  if (pg && typeof pg.hint === 'string' && HINTS[pg.hint]) {
    const m = HINTS[pg.hint] as { code: ConstructorParameters<typeof ApiError>[0]; reason: string };
    return new ApiError(m.code, m.reason, { reason: m.reason, ...(pg.detail ? { items: pg.detail.split(',').filter(Boolean) } : {}) });
  }
  return hubsRefusal(error);
}

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

export function killSwitchView(row: KillSwitchRow) {
  return {
    id: row.id, scopeKind: row.scope_kind, hubId: row.hub_id, nodeId: row.node_id, moduleKey: row.module_key, capabilityId: row.capability_id, action: row.action, state: row.state,
    engagedAt: iso(row.engaged_at), reason: row.reason, releasedAt: iso(row.released_at), revision: row.revision,
  };
}

/**
 * The administrator's agent-functionality controls (ADR 010 decision 25, AGT-003): the module registry, the hub agent
 * policy as the `agents` configuration domain with a stored preview and second-person activation, and the agent kill
 * switches. Staff manage policy for everyone: nothing here takes, reads or returns one participant's agent, mandates,
 * settings, goals, job subscriptions or connections; previews are cohort counts.
 */
export class AgentPolicyService {
  private readonly hubs: HubsService;
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly authority: CapabilityAuthority) {
    this.hubs = new HubsService(ctx, principals);
  }

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw agentModulesRefusal(error) ?? error;
    });
  }
  private async requireReader(trx: Transaction, hubId: string): Promise<void> {
    if (!(await agentPolicies.staffReader(trx, hubId))) throw new ApiError('access.not_found', 'access.not_found');
  }
  private async result(trx: Transaction, cmd: CommandContext, outcome: 'applied' | 'pending_second_person', objectId: string, revision: number, approvalRequestId: string | null, auditObjectId = objectId): Promise<ConsoleCommandResult> {
    const row = await trx.selectFrom('admin_audit_event').select('id').where('request_id', '=', cmd.requestId).where('object_id', '=', auditObjectId).orderBy('sequence', 'desc').limit(1).executeTakeFirst();
    if (!row) throw new Error('the command wrote no audit row');
    return { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, outcome, objectId, revision, approvalRequestId, auditEventId: row.id };
  }

  /* ---------- Registry ---------- */

  /** Module manifests shipped with the engine and activated extension versions (AGT-023): what a hub can enable. */
  registryView(state: RequestState, hubId: string) {
    return this.run(state, async (trx) => {
      await this.requireReader(trx, hubId);
      return this.registryOf();
    });
  }
  private async registryOf() {
    const registry = await this.authority.registry();
    return {
      modules: registry.manifests.map((m) => ({
        key: m.key, version: m.version, family: m.family, status: m.status, actions: m.actions, meters: m.meters, suits: m.suits, freeFloor: m.freeFloor,
        capabilities: m.capabilities.map((c) => ({ id: c.id, kind: c.kind, mandateAction: c.mandateAction, confirmation: c.confirmation, privateDataClasses: c.privateDataClasses, surfaces: c.surfaces, labelKey: c.labelKey })),
      })),
      extensions: registry.extensions.map((e) => ({ extensionVersionId: e.extensionVersionId, moduleKey: e.moduleKey, capabilityIds: e.capabilities.map((c) => c.id) })),
    };
  }

  /* ---------- Policy ---------- */

  /** What activating `draft` would change, computed on current data (cohort counts only). Nothing is stored. */
  private async computePreview(trx: Transaction, hubId: string, draft: AgentPolicyDraft, registry: ModuleRegistry): Promise<PolicyPreview> {
    const current = await agentPolicies.current(trx, hubId);
    const before = current ? AgentPolicyDocumentSchema.parse(current.document) : null;
    const diff = diffPolicies(before, draft, registry);
    const snapshot = await agentPolicies.previewSnapshot(trx, hubId, diff.narrowedModuleKeys);
    return {
      computedAt: this.ctx.clock.now().toISOString(), baseVersionId: current?.config_version_id ?? null, ...diff,
      registeredModuleKeys: [...new Set([...registry.manifests.map((m) => m.key), ...registry.extensions.map((e) => e.moduleKey)])].sort(),
      ...snapshot,
    };
  }

  private validate(hubId: string, draft: AgentPolicyDraft, registry: ModuleRegistry): void {
    if (draft.policy.hubId !== hubId) throw new ApiError('validation.schema', 'the policy names another hub', { reason: 'policy_invalid', items: ['policy.hubId'] });
    const problems = policyDocumentViolations(draft, registry);
    if (problems.length) {
      const guard = problems.some((p) => p.startsWith('guard rail'));
      throw new ApiError('validation.schema', 'the agent policy is refused', { reason: guard ? 'guard_rail' : problems.some((p) => p.startsWith('widening')) ? 'widening' : 'policy_invalid', items: problems.slice(0, 30) });
    }
  }

  current(state: RequestState, hubId: string) {
    return this.run(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const registry = await this.authority.registry();
      const row = await agentPolicies.current(trx, hubId);
      const versions = await agentPolicies.versions(trx, hubId);
      const config = new Map((await hubConfig.list(trx, hubId, 'agents')).map((v) => [v.id, v]));
      return {
        current: row ? { versionId: row.config_version_id, activatedAt: iso(row.activated_at), document: row.document } : null,
        engineDefault: row ? null : (await this.authority.policy(trx, registry)).document,
        versions: versions.map((v) => this.versionView(v, config.get(v.config_version_id) ?? null)),
      };
    });
  }

  private versionView(v: AgentPolicyVersionRow, config: { id: string; version: number; status: string; revision: number; drafted_at: Date; activated_at: Date | null; payload_digest: string; hub_id: string } | null) {
    const doc = v.document as AgentPolicyDocument;
    return {
      versionId: v.config_version_id, hubId: v.hub_id, version: config?.version ?? null, status: config?.status ?? null, revision: config?.revision ?? null,
      draftedAt: iso(config?.drafted_at ?? v.created_at), activatedAt: iso(config?.activated_at ?? null), payloadDigest: v.payload_digest, baseVersionId: v.base_version_id,
      preview: doc.preview, document: doc,
      /** What the second person approves: the payload digest, which covers the preview shown here. */
      activation: config ? {
        secondPersonAction: 'agents.enable_commitment_module',
        actionDigest: computeDigest(configActivationDigestInput({ id: config.id, hubId: config.hub_id, domain: 'agents', version: config.version, payloadDigest: config.payload_digest })).value,
      } : null,
    };
  }

  version(state: RequestState, hubId: string, versionId: string) {
    return this.run(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const v = await agentPolicies.version(trx, versionId);
      const config = await hubConfig.get(trx, versionId);
      if (!v || v.hub_id !== hubId || !config) throw new ApiError('access.not_found', 'access.not_found');
      return this.versionView(v, config);
    });
  }

  preview(state: RequestState, hubId: string, draft: AgentPolicyDraft) {
    return this.run(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const registry = await this.authority.registry();
      this.validate(hubId, draft, registry);
      return { preview: await this.computePreview(trx, hubId, draft, registry) };
    });
  }

  /**
   * Drafts an `agents` version: the document is validated against the registry (no widening beyond a manifest, guard
   * rails, defaults within maximums), the preview is computed and stored inside the payload, and the database records
   * AGT-003's validation in the same transaction (recomputing the counts).
   */
  async draft(e: Elevated, hubId: string, body: DraftAgentPolicyCommand) {
    const registry = await this.authority.registry();
    this.validate(hubId, body.document, registry);
    const cmd = this.commandContext(e, body);
    return this.run(e.state, async (trx) => {
      const preview = await this.computePreview(trx, hubId, body.document, registry);
      const document: AgentPolicyDocument = AgentPolicyDocumentSchema.parse({ ...body.document, preview });
      const v = await hubConfig.draft(trx, cmd, hubId, 'agents', document as unknown as Record<string, unknown>);
      const recorded = await agentPolicies.recordDraft(trx, cmd, hubId, v.id, document);
      return { result: await this.result(trx, cmd, 'applied', v.id, v.revision, null), version: this.versionView(recorded, v) };
    });
  }

  /**
   * Activation is HUB-001's (the `agents` domain is sensitive: a second person approves the digest of the payload, which
   * carries the preview). The database hook refuses a version AGT-003 did not validate and a stale preview.
   */
  activate(e: Elevated, hubId: string, versionId: string, body: ActivateAgentPolicyCommand) {
    return this.hubs.activate(e, hubId, versionId, { contractVersion: body.contractVersion, idempotencyKey: body.idempotencyKey, reason: body.reason, expectedRevision: body.expectedRevision, approvalId: body.approvalId })
      .catch((error: unknown) => {
        throw agentModulesRefusal(error) ?? error;
      });
  }

  /* ---------- Kill switches ---------- */

  killSwitches(state: RequestState, hubId: string) {
    return this.run(state, async (trx) => {
      await this.requireReader(trx, hubId);
      return { killSwitches: (await agentKillSwitches.engaged(trx, hubId)).map(killSwitchView) };
    });
  }

  /** Engaging is immediate and needs one person (admin.agents.kill); executing actions in scope go to reconciliation. */
  engage(e: Elevated, hubId: string, body: EngageAgentKillSwitchCommand) {
    const cmd = this.commandContext(e, body);
    const { kind, ...target } = body.scope;
    return this.run(e.state, async (trx) => {
      const row = await agentKillSwitches.engage(trx, cmd, hubId, kind, target);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), killSwitch: killSwitchView(row) };
    });
  }

  /** Releasing needs a second person and an incident note; it reactivates nothing that the switch stopped. */
  release(e: Elevated, hubId: string, killSwitchId: string, body: Body<typeof ReleaseAgentKillSwitchCommandSchema>) {
    const cmd = this.commandContext(e, body);
    return this.run(e.state, async (trx) => {
      const before = await agentKillSwitches.get(trx, killSwitchId);
      if (!before || before.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      if (body.approvalId === null) {
        if (before.state !== 'engaged') throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'invalid_transition' });
        const request = await approvals.request(trx, cmd, { action: 'kill_switch.release', scope: { kind: 'hub', hubId }, actionDigest: adminDigests.killSwitchRelease(killSwitchId, body.incidentNote) });
        return { result: await this.result(trx, cmd, 'pending_second_person', killSwitchId, before.revision, request.id, request.id), killSwitch: killSwitchView(before) };
      }
      const row = await agentKillSwitches.release(trx, cmd, killSwitchId, body.approvalId, body.incidentNote);
      return { result: await this.result(trx, cmd, 'applied', row.id, row.revision, null), killSwitch: killSwitchView(row) };
    });
  }
}
