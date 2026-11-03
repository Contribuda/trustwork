import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION, type ConsoleCommandResult, type Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import { ENGINE_MANIFESTS } from '../agent-modules/ports.js';
import { restrictedPlacesFromPacks } from '../assistant/policy.js';
import { hubsRefusal } from '../hubs/errors.js';
import { HubsService, type Elevated } from '../hubs/hubs.service.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  extensionVersionRef, manifestRefusals,
  type ActivateExtensionsCommand, type AgentExtensionManifest, type DraftExtensionActivationCommand, type DraftExtensionVersionCommand, type ExtensionSafetyRunView, type ExtensionVersionView, type ExtensionView,
  type ManifestFacts, type RequestSafetyRunCommand, type RetireExtensionVersionCommand, type SuspendExtensionVersionCommand,
} from './contracts.js';
import { agentExtensions, configActivationDigestInput, type AgentExtensionSafetyRunRow, type AgentExtensionVersionRow, type CommandContext, type HubConfigVersionRow } from './deps.js';

interface Cmd { idempotencyKey: string; reason: string }
const iso = (v: Date | string): string => new Date(v).toISOString();

function runView(r: AgentExtensionSafetyRunRow): ExtensionSafetyRunView {
  return {
    id: r.id, versionId: r.version_id, state: r.state, engineVersion: r.engine_version, manifestDigest: r.manifest_digest, reportDigest: r.report_digest, scenarioCount: r.scenario_count,
    failedCount: r.failed_count, requestedAt: iso(r.requested_at), completedAt: r.completed_at === null ? null : iso(r.completed_at),
  };
}
function versionView(v: AgentExtensionVersionRow, runs: readonly AgentExtensionSafetyRunRow[]): ExtensionVersionView {
  const own = runs.filter((r) => r.version_id === v.id);
  const passing = own.find((r) => r.id === v.passing_run_id);
  const latest = own[0] ?? null;
  const shown = passing ?? (latest?.state === 'failed' ? latest : null);
  const manifest = v.manifest as AgentExtensionManifest;
  return {
    ref: extensionVersionRef({
      id: v.id, extensionId: v.extension_id, hubId: v.hub_id, version: v.version, manifest, manifestDigest: v.manifest_digest, status: v.status, draftedBy: v.drafted_by, approvedBy: v.approved_by,
      approvalId: v.approval_id, activatedConfigVersionId: v.config_version_id,
      safetySuite: shown ? { runId: shown.id, onFakeAdapter: true, passed: shown.state === 'passed', engineVersion: shown.engine_version as string, at: iso(shown.completed_at as Date) } : null,
    }),
    manifest, revision: v.revision, statusReason: v.status_reason, latestRun: latest ? runView(latest) : null,
  };
}
function activationView(c: HubConfigVersionRow) {
  return {
    configVersionId: c.id, hubId: c.hub_id, version: c.version, status: c.status, revision: c.revision, payload: c.payload, payloadDigest: c.payload_digest,
    /** What the second person approves. */
    activation: {
      secondPersonAction: 'agents.activate_extension',
      actionDigest: computeDigest(configActivationDigestInput({ id: c.id, hubId: c.hub_id, domain: 'agent_extensions', version: c.version, payloadDigest: c.payload_digest })).value,
    },
  };
}

/**
 * The governed extension registry for staff (AGT-023, ADR 010 decisions 22 and 25). Staff draft a manifest, ask for a safety
 * run, propose an activation and suspend or retire a version; they never state that a suite passed (the worker does), and
 * activation is HUB-001's, under the `agents.activate_extension` second-person approval. Staff manage extensions for
 * everyone: nothing here takes, reads or returns one participant's agent, mandates or settings.
 */
export class AgentExtensionsService {
  private readonly hubs: HubsService;
  private readonly facts: ManifestFacts;

  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, options: { isRestricted?: (code: string) => boolean } = {}) {
    this.hubs = new HubsService(ctx, principals);
    this.facts = {
      builtIn: ENGINE_MANIFESTS.flatMap((m) => m.capabilities), engineModuleKeys: ENGINE_MANIFESTS.map((m) => m.key), isRestricted: options.isRestricted ?? restrictedPlacesFromPacks(),
    };
  }

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw hubsRefusal(error) ?? error;
    });
  }
  private async requireReader(trx: Transaction, hubId: string): Promise<void> {
    if (!(await agentExtensions.staffReader(trx, hubId))) throw new ApiError('access.not_found', 'access.not_found');
  }
  private async versionOf(trx: Transaction, hubId: string, versionId: string): Promise<AgentExtensionVersionRow> {
    const v = await agentExtensions.version(trx, versionId);
    if (!v || v.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return v;
  }
  private async result(trx: Transaction, cmd: CommandContext, objectId: string, revision: number): Promise<ConsoleCommandResult> {
    const row = await trx.selectFrom('admin_audit_event').select('id').where('request_id', '=', cmd.requestId).where('object_id', '=', objectId).orderBy('sequence', 'desc').limit(1).executeTakeFirst();
    if (!row) throw new Error('the command wrote no audit row');
    return { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, outcome: 'applied', objectId, revision, approvalRequestId: null, auditEventId: row.id };
  }

  /* ---------- Reads ---------- */

  list(state: RequestState, hubId: string): Promise<{ extensions: ExtensionView[] }> {
    return this.run(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const [extensions, versions, runs] = [await agentExtensions.list(trx, hubId), await agentExtensions.versions(trx, hubId), await agentExtensions.runs(trx, hubId)];
      return { extensions: extensions.map((x) => ({ id: x.id, hubId: x.hub_id, key: x.key, versions: versions.filter((v) => v.extension_id === x.id).map((v) => versionView(v, runs)) })) };
    });
  }

  version(state: RequestState, hubId: string, versionId: string) {
    return this.run(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const v = await this.versionOf(trx, hubId, versionId);
      const transitions = await agentExtensions.transitions(trx, v.id);
      return {
        version: versionView(v, await agentExtensions.runs(trx, hubId)),
        // A person acted, or the engine did: never who else was affected.
        transitions: transitions.map((t) => ({ from: t.from_status, to: t.to_status, reason: t.reason, by: t.actor_person_id === null ? 'engine' : 'staff', at: iso(t.at) })),
      };
    });
  }

  /* ---------- Commands ---------- */

  /**
   * Stores a draft version. The reasons come from `manifestRefusals`; the database repeats the rules that matter for any
   * writer that bypasses this service, including the restricted places a hub added itself.
   */
  draft(e: Elevated, hubId: string, body: DraftExtensionVersionCommand) {
    const cmd = this.commandContext(e, body);
    return this.run(e.state, async (trx) => {
      if (!(await agentExtensions.mayEdit(trx, hubId))) throw new ApiError('access.forbidden', 'access.forbidden');
      const refusals = manifestRefusals(body.manifest, this.facts);
      const first = refusals[0];
      if (first) throw new ApiError('validation.schema', 'the manifest is refused', { reason: first.code, items: [...new Set(refusals.filter((r) => r.code === first.code).map((r) => r.detail))] });
      const row = await agentExtensions.draft(trx, cmd, hubId, body.manifest);
      return { result: await this.result(trx, cmd, row.id, row.revision), version: versionView(row, []) };
    });
  }

  /** Asks the worker to run the suite on the fake adapter; the outcome arrives only from the worker. */
  requestRun(e: Elevated, hubId: string, versionId: string, body: RequestSafetyRunCommand) {
    const cmd = this.commandContext(e, body);
    return this.run(e.state, async (trx) => {
      const v = await this.versionOf(trx, hubId, versionId);
      const run = await agentExtensions.requestRun(trx, cmd, v.id, body.expectedRevision);
      return { result: await this.result(trx, cmd, run.id, v.revision), run: runView(run) };
    });
  }

  /** Proposes the next list of active versions as a configuration version of domain `agent_extensions`. */
  draftActivation(e: Elevated, hubId: string, body: DraftExtensionActivationCommand) {
    const cmd = this.commandContext(e, body);
    return this.run(e.state, async (trx) => {
      const c = await agentExtensions.draftActivation(trx, cmd, hubId, body.versionIds);
      return { result: await this.result(trx, cmd, c.id, c.revision), activation: activationView(c) };
    });
  }

  /** HUB-001's activation: `pending_second_person`, then applied with `approvalId`. The hook checks every listed version. */
  activate(e: Elevated, hubId: string, configVersionId: string, body: ActivateExtensionsCommand) {
    return this.hubs.activate(e, hubId, configVersionId, { contractVersion: body.contractVersion, idempotencyKey: body.idempotencyKey, reason: body.reason, expectedRevision: body.expectedRevision, approvalId: body.approvalId }, 'agent_extensions');
  }

  /** Immediate and one person: withdrawing an ability is always safe. Executing actions go to reconciliation. */
  suspend(e: Elevated, hubId: string, versionId: string, body: SuspendExtensionVersionCommand) {
    const cmd = this.commandContext(e, body);
    return this.run(e.state, async (trx) => {
      const v = await this.versionOf(trx, hubId, versionId);
      const row = await agentExtensions.suspend(trx, cmd, v.id, body.expectedRevision);
      return { result: await this.result(trx, cmd, row.id, row.revision), version: versionView(row, await agentExtensions.runs(trx, hubId)) };
    });
  }

  retire(e: Elevated, hubId: string, versionId: string, body: RetireExtensionVersionCommand) {
    const cmd = this.commandContext(e, body);
    return this.run(e.state, async (trx) => {
      const v = await this.versionOf(trx, hubId, versionId);
      const row = await agentExtensions.retire(trx, cmd, v.id, body.expectedRevision);
      return { result: await this.result(trx, cmd, row.id, row.revision), version: versionView(row, await agentExtensions.runs(trx, hubId)) };
    });
  }
}
