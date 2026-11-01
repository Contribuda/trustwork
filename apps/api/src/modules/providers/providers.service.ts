import { sql } from 'kysely';
import type { z } from 'zod';
import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION, type ConsoleCommandResult, type ConsolePermission, type DataClass, type Principal, type ProviderCapability } from '../../deps/contracts.js';
import { withPrincipal, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import type { ProviderAdapterRegistry } from './adapters.js';
import {
  adminAudit, approvals, egressAllowDigestInput, egressRuleNeedsSecondPerson, egressRules, isPinned, modelPricing, modelRoutes, providerBudgets, providerChanges,
  providerConnections, providerKills, providerUsage, providerKillReleaseDigestInput, routeNeedsSecondPerson, syntheticProbesFor, AdapterTestReportSchema, ProviderCallDecisionSchema,
  type CommandContext, type ConnectionTestRow, type CreateCapCommandSchema, type CreateConnectionCommand, type DraftRouteCommand, type EngageProviderKillCommandSchema,
  type ExplainCallCommandSchema, type ModelRouteRow, type PlainProvidersCommandSchema, type ProviderConnectionRow, type ProviderSecretSubmitCommand,
  type RecordModelPricingCommand, type ReleaseProviderKillCommandSchema, type RevisionedProvidersCommandSchema, type SetEgressRuleCommand, type StaffRole, type UpdateCapCommandSchema,
  type UpdateConnectionCommand, type ActivateRouteCommandSchema, type EnableConnectionCommandSchema, type AdapterTestReport,
} from './deps.js';
import { isAuthorityRefusal, providersRefusal } from './errors.js';
import { ExternalSecretReader, SecretStoreError, SecretValue, type SecretSealer } from './secret-store.js';
import {
  hostingOf, routeDigestInput, toCap, toChange, toConnection, toConnectionKill, toEgress, toPricing, toRoute, toRouteKill, toSecretVersion, toTest, toUsage,
} from './views.js';

type Body<S extends z.ZodType> = z.infer<S>;
type Cmd = Body<typeof PlainProvidersCommandSchema>;
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string; permission: ConsolePermission; action: string; objectType: string; objectId: string }
export interface ProvidersRuntime { sealer: SecretSealer | null; adapters: ProviderAdapterRegistry; external: ExternalSecretReader; testTimeoutMs: number }

/**
 * Provider connections, write-only secrets, connection tests, egress, routes, caps, cost records and kill switches
 * (KEYS-001). Every staff command runs in one `PrincipalService.runAs` transaction as the staff member through a
 * `providers_*` SECURITY DEFINER command that checks the permission at the hub, the elevation and the guard rails and
 * writes the audit and change-log rows there (BE-005 completes the idempotency record in the same commit). A two-person
 * action called without an approval checks what it can first, then creates the approval request in the same
 * transaction and answers `pending_second_person`; the same person calls again with the approved request's id.
 *
 * Secret values: the only input that carries one is the write-only secret command. It is sealed here (envelope
 * encryption) and only ciphertext is written; the value is never logged, returned, audited or put in the outbox, and
 * the route keeps no idempotency record of it.
 */
export class ProvidersService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly runtime: ProvidersRuntime) {}

  /* ---------- Plumbing ---------- */

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }

  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt, fn: (trx: Transaction, cmd: CommandContext, p: Principal) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, cmd, p));
    } catch (error) {
      const refusal = providersRefusal(error);
      if (refusal && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('providers.denied_audit_failed', failure instanceof Error ? failure.name : 'error'));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw providersRefusal(error) ?? error;
    });
  }

  /** A denied audit row, when the person holds a staff role covering the hub. */
  private async recordDenied(e: Elevated, cmd: CommandContext, attempt: Attempt, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const role = await trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.personId).where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('scope_kind', 'in', ['platform', 'node']), eb('hub_id', '=', attempt.hubId)]))
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())])).orderBy('breakglass').limit(1).executeTakeFirst();
      if (!role) return;
      const reason = typeof refusal.details?.reason === 'string' ? refusal.details.reason : refusal.code.replace(/\W/g, '_');
      await adminAudit.append(trx, {
        actorPersonId: p.personId, actorRole: role.role as StaffRole, scope: { kind: 'hub', hubId: attempt.hubId }, permission: attempt.permission, elevationId: cmd.elevationId,
        action: attempt.action, objectType: attempt.objectType, objectId: attempt.objectId, reasonCode: `denied_${reason}`.slice(0, 64), reasonText: cmd.reasonText, outcome: 'denied',
        requestId: cmd.requestId,
      });
    });
  }

  private async auditId(trx: Transaction, requestId: string, objectId: string): Promise<string> {
    const row = await trx.selectFrom('admin_audit_event').select('id').where('request_id', '=', requestId).where('object_id', '=', objectId).orderBy('sequence', 'desc').limit(1).executeTakeFirst();
    if (!row) throw new Error('the command wrote no audit row');
    return row.id;
  }

  private async result(trx: Transaction, cmd: CommandContext, outcome: 'applied' | 'pending_second_person', objectId: string, revision: number, approvalRequestId: string | null, auditObjectId = objectId): Promise<ConsoleCommandResult> {
    return { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, outcome, objectId, revision, approvalRequestId, auditEventId: await this.auditId(trx, cmd.requestId, auditObjectId) };
  }

  private async pending(trx: Transaction, cmd: CommandContext, action: string, hubId: string, digestInput: unknown, objectId: string, revision: number) {
    const request = await approvals.request(trx, cmd, { action, scope: { kind: 'hub', hubId }, actionDigest: computeDigest(digestInput).value });
    return this.result(trx, cmd, 'pending_second_person', objectId, revision, request.id, request.id);
  }

  private async connectionOf(trx: Transaction, hubId: string, connectionId: string): Promise<ProviderConnectionRow> {
    const c = await providerConnections.get(trx, connectionId);
    if (!c || c.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return c;
  }

  private async connectionView(trx: Transaction, hubId: string, connectionId: string) {
    const [c, secrets, tests, facts] = await Promise.all([this.connectionOf(trx, hubId, connectionId), providerConnections.secretRefs(trx, hubId), providerConnections.tests(trx, hubId), providerConnections.facts(trx, hubId)]);
    return toConnection(c, secrets, tests.find((t) => t.id === c.last_test_id) ?? null, facts.find((f) => f.connection_id === c.id));
  }

  private async routeOf(trx: Transaction, hubId: string, routeId: string): Promise<ModelRouteRow> {
    const r = await modelRoutes.get(trx, routeId);
    if (!r || r.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return r;
  }

  /** Staff of the hub only (row-level security): an outsider sees "not found", never an empty configuration. */
  private async requireReader(trx: Transaction, hubId: string): Promise<void> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.providers_staff_reader(${hubId}::uuid) AS ok`.execute(trx);
    if (!rows[0]?.ok) throw new ApiError('access.not_found', 'access.not_found');
  }

  /* ---------- Reads ---------- */

  connections(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const [rows, secrets, tests, facts] = await Promise.all([providerConnections.list(trx, hubId), providerConnections.secretRefs(trx, hubId), providerConnections.tests(trx, hubId), providerConnections.facts(trx, hubId)]);
      return { items: rows.map((c) => toConnection(c, secrets, tests.find((t) => t.id === c.last_test_id) ?? null, facts.find((f) => f.connection_id === c.id))) };
    });
  }

  connection(state: RequestState, hubId: string, connectionId: string) {
    return this.read(state, async (trx) => {
      const connection = await this.connectionView(trx, hubId, connectionId);
      const tests = (await providerConnections.tests(trx, hubId)).filter((t) => t.connection_id === connectionId).slice(0, 20);
      return { connection, tests: tests.map((t) => ({ id: t.id, ...toTest(t) })) };
    });
  }

  egress(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const all = (await egressRules.list(trx, hubId)).map(toEgress);
      const current = new Map<string, (typeof all)[number]>();
      for (const r of all) if (!current.has(`${r.connectionId}/${r.dataClass}`)) current.set(`${r.connectionId}/${r.dataClass}`, r);
      return { cells: [...current.values()], history: all };
    });
  }

  routes(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const [rows, kills] = await Promise.all([modelRoutes.list(trx, hubId), providerKills.routeSwitches(trx, hubId)]);
      const engaged = kills.filter((k) => k.state === 'engaged');
      return { items: rows.map((r) => toRoute(r, r.status === 'active' ? engaged.find((k) => k.job === r.job && k.scope_kind === r.scope_kind && k.module_key === r.module_key && k.extension_id === r.extension_id)?.id ?? null : null)) };
    });
  }

  caps(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const [rows, usage] = await Promise.all([providerBudgets.list(trx, hubId), providerBudgets.usage(trx, hubId)]);
      return { items: rows.map((b) => toCap(b, usage.find((u) => u.budget_id === b.id))) };
    });
  }

  pricing(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      return { items: (await modelPricing.list(trx, hubId)).map(toPricing) };
    });
  }

  killSwitches(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const [connections, routes] = await Promise.all([providerKills.connectionSwitches(trx, hubId), providerKills.routeSwitches(trx, hubId)]);
      return { items: [...connections.map(toConnectionKill), ...routes.map(toRouteKill)].sort((x, y) => y.engagedAt.localeCompare(x.engagedAt)) };
    });
  }

  usage(state: RequestState, hubId: string, from: Date, to: Date) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      return { items: (await providerUsage.aggregate(trx, hubId, from, to)).map((r) => toUsage(hubId, r)) };
    });
  }

  changes(state: RequestState, hubId: string, filter: { objectType?: string | undefined; objectId?: string | undefined }) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      return { items: (await providerChanges.list(trx, hubId, filter)).map(toChange) };
    });
  }

  /** The call gate's decision for a described call, without reserving anything (the console's preview). */
  explain(state: RequestState, hubId: string, body: Body<typeof ExplainCallCommandSchema>) {
    return this.read(state, async (trx) => {
      await this.requireReader(trx, hubId);
      const request = { hubId, job: body.job, moduleKey: body.moduleKey, extensionId: body.extensionId, pipelineId: body.pipelineId, dataClasses: body.dataClasses, estimatedCost: body.estimatedCost, requestRef: 'console-preview' };
      const { rows } = await sql<{ d: unknown }>`SELECT trustwork.providers_authorize_call(${JSON.stringify(request)}::jsonb, true) AS d`.execute(trx);
      return { decision: ProviderCallDecisionSchema.parse(rows[0]?.d) };
    });
  }

  /* ---------- Connections ---------- */

  createConnection(e: Elevated, hubId: string, body: CreateConnectionCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.connection.edit', action: 'providers.connection_created', objectType: 'provider_connection', objectId: hubId }, async (trx, cmd) => {
      const c = await providerConnections.create(trx, cmd, hubId, { adapterId: body.adapterId, mode: body.mode, label: body.label, capabilities: body.capabilities, endpoint: body.endpoint,
        hosting: body.hosting, storageCountry: body.storageCountry, region: body.region, credentialRefId: body.credentialRefId });
      return { result: await this.result(trx, cmd, 'applied', c.id, c.revision, null), connection: await this.connectionView(trx, hubId, c.id) };
    });
  }

  updateConnection(e: Elevated, hubId: string, connectionId: string, body: UpdateConnectionCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.connection.edit', action: 'providers.connection_updated', objectType: 'provider_connection', objectId: connectionId }, async (trx, cmd) => {
      await this.connectionOf(trx, hubId, connectionId);
      const c = await providerConnections.update(trx, cmd, connectionId, body.expectedRevision, { label: body.label, capabilities: body.capabilities, endpoint: body.endpoint, hosting: body.hosting,
        storageCountry: body.storageCountry, region: body.region, credentialRefId: body.credentialRefId });
      return { result: await this.result(trx, cmd, 'applied', c.id, c.revision, null), connection: await this.connectionView(trx, hubId, c.id) };
    });
  }

  /**
   * The write-only secret endpoint: seals the value (envelope encryption) and stores ciphertext. The answer is the new
   * reference (`SecretSubmitResultSchema` fields) and never the value.
   */
  submitSecret(e: Elevated, hubId: string, connectionId: string, body: ProviderSecretSubmitCommand) {
    if (body.connectionId !== connectionId) throw new ApiError('validation.schema', 'the body names another connection', { reason: 'connection_mismatch' });
    const sealer = this.runtime.sealer;
    if (!sealer) throw new ApiError('validation.schema', 'no key-encryption key is configured', { reason: 'secret_store_unconfigured' });
    const value = new SecretValue(body.value);
    return this.staff(e, body, { hubId, permission: 'admin.providers.secret.write', action: 'providers.secret_written', objectType: 'secret_ref', objectId: connectionId }, async (trx, cmd) => {
      await this.connectionOf(trx, hubId, connectionId);
      const sealed = await sealer.seal(value);
      const ref = await providerConnections.storeSecret(trx, cmd, connectionId, body.expectedRevision, sealed, body.graceHours);
      const connection = await this.connectionOf(trx, hubId, connectionId);
      return {
        result: await this.result(trx, cmd, 'applied', ref.id, ref.revision, null),
        contractVersion: HUB_CONSOLE_CONTRACT_VERSION, secretRef: toSecretVersion(ref).ref, connectionRevision: connection.revision,
      };
    });
  }

  revokeSecret(e: Elevated, hubId: string, connectionId: string, body: Body<typeof RevisionedProvidersCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.secret.write', action: 'providers.connection_secret_revoked', objectType: 'provider_connection', objectId: connectionId }, async (trx, cmd) => {
      await this.connectionOf(trx, hubId, connectionId);
      const c = await providerConnections.revokeSecret(trx, cmd, connectionId, body.expectedRevision);
      return { result: await this.result(trx, cmd, 'applied', c.id, c.revision, null), connection: await this.connectionView(trx, hubId, c.id) };
    });
  }

  /**
   * "Test connection": only the engine's synthetic probes reach the adapter, with the connection's own secret. The
   * result records outcome, latency, models listed and the probe digest; a live adapter that is not registered tests
   * as `error` (`adapter_unavailable`). The adapter call happens inside the request transaction (bounded by a timeout).
   */
  testConnection(e: Elevated, hubId: string, connectionId: string, body: Cmd & { connectionId: string }) {
    if (body.connectionId !== connectionId) throw new ApiError('validation.schema', 'the body names another connection', { reason: 'connection_mismatch' });
    return this.staff(e, body, { hubId, permission: 'admin.providers.test', action: 'providers.connection_tested', objectType: 'provider_connection', objectId: connectionId }, async (trx, cmd) => {
      const c = await this.connectionOf(trx, hubId, connectionId);
      const material = await providerConnections.testMaterial(trx, cmd, connectionId);
      const probes = syntheticProbesFor(c.capabilities as ProviderCapability[]);
      const resolved = this.runtime.adapters.resolve(c.adapter_id, c.mode);
      let report: AdapterTestReport = { outcome: 'error', latencyMs: null, modelsListed: null, costMinorUnits: null };
      let reason: string | null = resolved.reason;
      if (resolved.adapter) {
        let secret: SecretValue | null = null;
        try {
          if (material.ciphertext && material.iv && material.auth_tag && material.wrapped_key && material.kek_id) {
            if (!this.runtime.sealer) throw new SecretStoreError('unconfigured');
            secret = await this.runtime.sealer.open({ ciphertext: material.ciphertext, iv: material.iv, authTag: material.auth_tag, wrappedKey: material.wrapped_key, kekId: material.kek_id });
          } else if (material.credential_store && material.credential_ref) {
            secret = await this.runtime.external.read(material.credential_store, material.credential_ref);
          }
          report = AdapterTestReportSchema.parse(await withTimeout(resolved.adapter.test({ probes, endpoint: c.endpoint, secret }), this.runtime.testTimeoutMs));
        } catch (error) {
          // Never the error's message: an adapter's error could quote what it was given.
          reason = error instanceof SecretStoreError ? (error.code === 'unconfigured' ? 'secret_store_unconfigured' : 'secret_not_found') : error instanceof TimeoutError ? 'timeout' : 'adapter_error';
          report = { outcome: error instanceof TimeoutError ? 'unreachable' : 'error', latencyMs: null, modelsListed: null, costMinorUnits: null };
        }
      }
      const profile = await trx.selectFrom('hub_profile').select('currency').where('hub_id', '=', hubId).executeTakeFirst();
      const test: ConnectionTestRow = await providerConnections.recordTest(trx, cmd, connectionId, {
        configDigest: material.config_digest, outcome: report.outcome, latencyMs: report.latencyMs, modelsListed: report.modelsListed,
        cost: report.costMinorUnits === null || !profile ? null : { minorUnits: report.costMinorUnits, currency: profile.currency }, probeDigest: computeDigest(probes).value, secretRefId: material.secret_ref_id,
      });
      return { result: await this.result(trx, cmd, 'applied', test.id, 1, null), test: { id: test.id, ...toTest(test) }, reason, connection: await this.connectionView(trx, hubId, connectionId) };
    });
  }

  enableConnection(e: Elevated, hubId: string, connectionId: string, body: Body<typeof EnableConnectionCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.toggle', action: 'providers.connection_enabled', objectType: 'provider_connection', objectId: connectionId }, async (trx, cmd) => {
      const c = await this.connectionOf(trx, hubId, connectionId);
      if (c.mode !== 'fake' && body.approvalId === null) {
        const view = await this.connectionView(trx, hubId, connectionId);
        if (c.revision !== body.expectedRevision) throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'revision_conflict' });
        if (c.status === 'enabled') throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'invalid_transition' });
        if (view.status === 'killed') throw new ApiError('validation.schema', 'release the kill switch first', { reason: 'connection_killed' });
        const facts = (await providerConnections.facts(trx, hubId)).find((f) => f.connection_id === c.id);
        const test = (await providerConnections.tests(trx, hubId)).find((t) => t.id === c.last_test_id);
        if (!test || test.config_digest !== facts?.config_digest) throw new ApiError('validation.schema', 'test the current configuration first', { reason: 'test_required' });
        if (test.outcome !== 'ok') throw new ApiError('validation.schema', 'the last test did not pass', { reason: 'test_failed' });
        if (c.mode === 'live' && c.hosting_kind === 'vendor' && !c.credential_ref_id && !view.secret.versions.some((v) => v.status === 'active')) {
          throw new ApiError('validation.schema', 'a live vendor connection needs its secret', { reason: 'secret_required' });
        }
        if (!view.enable) throw new ApiError('validation.schema', 'test the current configuration first', { reason: 'test_required' });
        const request = await approvals.request(trx, cmd, { action: 'providers.enable_non_fake', scope: { kind: 'hub', hubId }, actionDigest: view.enable.actionDigest });
        return { result: await this.result(trx, cmd, 'pending_second_person', c.id, c.revision, request.id, request.id), connection: view };
      }
      const enabled = await providerConnections.enable(trx, cmd, connectionId, body.expectedRevision, c.mode === 'fake' ? null : body.approvalId);
      return { result: await this.result(trx, cmd, 'applied', enabled.id, enabled.revision, null), connection: await this.connectionView(trx, hubId, connectionId) };
    });
  }

  disableConnection(e: Elevated, hubId: string, connectionId: string, body: Body<typeof RevisionedProvidersCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.toggle', action: 'providers.connection_disabled', objectType: 'provider_connection', objectId: connectionId }, async (trx, cmd) => {
      await this.connectionOf(trx, hubId, connectionId);
      const c = await providerConnections.disable(trx, cmd, connectionId, body.expectedRevision);
      return { result: await this.result(trx, cmd, 'applied', c.id, c.revision, null), connection: await this.connectionView(trx, hubId, connectionId) };
    });
  }

  /* ---------- Egress ---------- */

  setEgress(e: Elevated, hubId: string, body: SetEgressRuleCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.egress.edit', action: 'providers.egress_rule_set', objectType: 'egress_rule', objectId: body.connectionId }, async (trx, cmd) => {
      const c = await this.connectionOf(trx, hubId, body.connectionId);
      if (egressRuleNeedsSecondPerson(body) && body.approvalId === null) {
        const hosting = hostingOf(c);
        if (hosting.kind === 'vendor' && hosting.trainsOnInputs) throw new ApiError('validation.schema', 'a vendor that trains on inputs never receives non-public data', { reason: 'egress_training' });
        if (hosting.kind === 'vendor' && hosting.broker) throw new ApiError('validation.schema', 'brokers carry public data only', { reason: 'egress_broker' });
        const facts = (await providerConnections.facts(trx, hubId)).find((f) => f.connection_id === c.id);
        if (!facts?.in_residency) throw new ApiError('validation.schema', 'the connection is outside the hub\'s residency', { reason: 'egress_not_in_residency' });
        if (hosting.kind === 'vendor' && !hosting.zeroRetention) throw new ApiError('validation.schema', 'the vendor retains inputs', { reason: 'egress_retention' });
        const version = await egressRules.nextVersion(trx, c.id, body.dataClass);
        return { result: await this.pending(trx, cmd, 'egress.allow_private_class', hubId, egressAllowDigestInput({ hubId, connectionId: c.id, dataClass: body.dataClass, requireInResidency: body.requireInResidency, requireZeroRetention: body.requireZeroRetention, version }), c.id, version) };
      }
      const rule = await egressRules.set(trx, cmd, { connectionId: c.id, dataClass: body.dataClass, decision: body.decision, requireInResidency: body.requireInResidency, requireZeroRetention: body.requireZeroRetention, approvalId: body.approvalId });
      return { result: await this.result(trx, cmd, 'applied', rule.id, rule.version, null), rule: toEgress(rule) };
    });
  }

  /* ---------- Routes ---------- */

  draftRoute(e: Elevated, hubId: string, body: DraftRouteCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.models.route.edit', action: 'providers.route_drafted', objectType: 'model_route', objectId: hubId }, async (trx, cmd) => {
      const r = await modelRoutes.draft(trx, cmd, hubId, { job: body.job, scope: body.scope, primary: body.primary, fallbacks: body.fallbacks, allowedDataClasses: body.allowedDataClasses, limits: body.limits, budgetId: body.budgetId });
      return { result: await this.result(trx, cmd, 'applied', r.id, r.revision, null), route: toRoute(r, null) };
    });
  }

  activateRoute(e: Elevated, hubId: string, routeId: string, body: Body<typeof ActivateRouteCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.models.route.activate', action: 'providers.route_activated', objectType: 'model_route', objectId: routeId }, async (trx, cmd, p) => {
      const r = await this.routeOf(trx, hubId, routeId);
      if (routeNeedsSecondPerson({ allowedDataClasses: r.allowed_data_classes as DataClass[] }) && body.approvalId === null) {
        if (r.revision !== body.expectedRevision) throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'revision_conflict' });
        if (r.status !== 'draft') throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'invalid_transition' });
        const refs = [r.primary_ref, ...r.fallbacks];
        if (!refs.every(isPinned)) throw new ApiError('validation.schema', 'active routes name pinned provider revisions', { reason: 'route_unpinned' });
        const connections = await providerConnections.list(trx, hubId);
        const facts = await providerConnections.facts(trx, hubId);
        for (const ref of refs) {
          const c = connections.find((x) => x.id === ref.connectionId);
          if (!c || c.status !== 'enabled') throw new ApiError('validation.schema', 'every model of an active route is on an enabled connection', { reason: 'route_connection_unusable' });
          if (!facts.find((f) => f.connection_id === c.id)?.in_residency) throw new ApiError('validation.schema', 'a route for non-public data stays in the hub\'s residency', { reason: 'route_outside_residency' });
        }
        if (r.drafted_by === p.personId) throw new ApiError('access.second_approver_required', 'access.second_approver_required', { reason: 'drafter_cannot_activate' });
        return { result: await this.pending(trx, cmd, 'models.activate_private_route', hubId, routeDigestInput(r), r.id, r.revision), route: toRoute(r, null) };
      }
      const active = await modelRoutes.activate(trx, cmd, routeId, body.expectedRevision, body.approvalId);
      return { result: await this.result(trx, cmd, 'applied', active.id, active.revision, null), route: toRoute(active, null) };
    });
  }

  disableRoute(e: Elevated, hubId: string, routeId: string, body: Body<typeof RevisionedProvidersCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.models.route.activate', action: 'providers.route_disabled', objectType: 'model_route', objectId: routeId }, async (trx, cmd) => {
      await this.routeOf(trx, hubId, routeId);
      const r = await modelRoutes.disable(trx, cmd, routeId, body.expectedRevision);
      return { result: await this.result(trx, cmd, 'applied', r.id, r.revision, null), route: toRoute(r, null) };
    });
  }

  /* ---------- Caps ---------- */

  createCap(e: Elevated, hubId: string, body: Body<typeof CreateCapCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.budget.edit', action: 'providers.cap_created', objectType: 'provider_budget', objectId: hubId }, async (trx, cmd) => {
      const b = await providerBudgets.create(trx, cmd, hubId, { scope: body.scope, period: body.period, limit: body.limit, alertAtPercent: body.alertAtPercent, onExhausted: body.onExhausted });
      return { result: await this.result(trx, cmd, 'applied', b.id, b.revision, null), cap: toCap(b, undefined) };
    });
  }

  updateCap(e: Elevated, hubId: string, budgetId: string, body: Body<typeof UpdateCapCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.budget.edit', action: 'providers.cap_updated', objectType: 'provider_budget', objectId: budgetId }, async (trx, cmd) => {
      const before = await providerBudgets.get(trx, budgetId);
      if (!before || before.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const b = await providerBudgets.update(trx, cmd, budgetId, body.expectedRevision, { limit: body.limit, alertAtPercent: body.alertAtPercent, onExhausted: body.onExhausted });
      const usage = (await providerBudgets.usage(trx, hubId)).find((u) => u.budget_id === b.id);
      return { result: await this.result(trx, cmd, 'applied', b.id, b.revision, null), cap: toCap(b, usage) };
    });
  }

  retireCap(e: Elevated, hubId: string, budgetId: string, body: Body<typeof RevisionedProvidersCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.budget.edit', action: 'providers.cap_retired', objectType: 'provider_budget', objectId: budgetId }, async (trx, cmd) => {
      const before = await providerBudgets.get(trx, budgetId);
      if (!before || before.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const b = await providerBudgets.retire(trx, cmd, budgetId, body.expectedRevision);
      return { result: await this.result(trx, cmd, 'applied', b.id, b.revision, null), cap: toCap(b, undefined) };
    });
  }

  /* ---------- Cost records ---------- */

  recordPricing(e: Elevated, hubId: string, body: RecordModelPricingCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.connection.edit', action: 'providers.pricing_recorded', objectType: 'model_pricing', objectId: body.connectionId }, async (trx, cmd) => {
      await this.connectionOf(trx, hubId, body.connectionId);
      const row = await modelPricing.record(trx, cmd, { connectionId: body.connectionId, modelId: body.modelId, currency: body.currency, inputPerMillionTokens: body.inputPerMillionTokens,
        outputPerMillionTokens: body.outputPerMillionTokens, perImage: body.perImage, perAudioMinute: body.perAudioMinute, basis: body.basis, observedAt: body.observedAt, sourceNote: body.sourceNote });
      return { result: await this.result(trx, cmd, 'applied', row.id, row.version, null), pricing: toPricing(row) };
    });
  }

  /* ---------- Kill switches ---------- */

  engageKill(e: Elevated, hubId: string, body: Body<typeof EngageProviderKillCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.kill', action: 'kill_switch.engage', objectType: 'kill_switch', objectId: hubId }, async (trx, cmd) => {
      if (body.target.kind === 'connection') await this.connectionOf(trx, hubId, body.target.connectionId);
      const k = await providerKills.engage(trx, cmd, hubId, body.target);
      return { result: await this.result(trx, cmd, 'applied', k.id, 1, null), killSwitch: await this.killView(trx, hubId, k.id) };
    });
  }

  releaseKill(e: Elevated, hubId: string, killSwitchId: string, body: Body<typeof ReleaseProviderKillCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.kill', action: 'kill_switch.release', objectType: 'kill_switch', objectId: killSwitchId }, async (trx, cmd) => {
      const current = await this.killView(trx, hubId, killSwitchId);
      if (body.approvalId === null) {
        if (current.state !== 'engaged') throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'kill_not_engaged' });
        return { result: await this.pending(trx, cmd, 'kill_switch.release', hubId, providerKillReleaseDigestInput({ killSwitchId, incidentNote: body.incidentNote }), killSwitchId, 1), killSwitch: current };
      }
      await providerKills.release(trx, cmd, hubId, killSwitchId, body.approvalId, body.incidentNote);
      return { result: await this.result(trx, cmd, 'applied', killSwitchId, 2, null), killSwitch: await this.killView(trx, hubId, killSwitchId) };
    });
  }

  private async killView(trx: Transaction, hubId: string, killSwitchId: string) {
    const connection = (await providerKills.connectionSwitches(trx, hubId)).find((k) => k.id === killSwitchId);
    if (connection) return toConnectionKill(connection);
    const route = (await providerKills.routeSwitches(trx, hubId)).find((k) => k.id === killSwitchId);
    if (route) return toRouteKill(route);
    throw new ApiError('access.not_found', 'access.not_found');
  }
}

class TimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError('timeout')), ms); })]).finally(() => clearTimeout(timer));
}
