import type { z } from 'zod';
import {
  computeDigest, HUB_CONSOLE_CONTRACT_VERSION, type ConsoleCommandResult, type ConsolePermission, type HubConfigDomain, type HubLifecycle, type Principal,
} from '../../deps/contracts.js';
import { withPrincipal, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  adminAudit, approvals, hubConfig, hubs, launchGates, legalDocuments, providerCredentials, type CommandContext, type HubConfigVersionRow, type StaffRole, configActivationAction, configActivationDigestInput, configDraftPermissions, configPayloadProblems, credentialActivationDigestInput, legalActivationDigestInput, lifecycleTransitionDigestInput, splitDeploymentConfig, transitionAction, type ActivateConfigVersionCommand, type CreateHubCommand, type DraftConfigVersionCommand, type ImportDeploymentCommand, type LegalDocumentKind, type TransitionHubCommand, type UpdateHubProfileCommand, type AddTerritoryCommandSchema, type CheckLaunchGateCommandSchema, type DraftLegalDocumentCommandSchema, type InvalidateLaunchGateCommandSchema, type PlainHubCommandSchema, type RecordCounselApprovalCommandSchema, type ActivateLegalDocumentCommandSchema, type RegisterCredentialCommandSchema, type ActivateCredentialCommandSchema, type AcceptLegalDocumentCommandSchema, PublicLegalDocumentsSchema, type PublicLegalDocuments,
} from './deps.js';
import { hubsRefusal, isAuthorityRefusal } from './errors.js';
import {
  toAcceptance, toChecklist, toConfigVersion, toCounselApproval, toCredential, toGate, toHub, toLegalDocument, toPublicLegalDocument, toRetention, toTerritory,
} from './views.js';

type Cmd = z.infer<typeof PlainHubCommandSchema>;
type Body<S extends z.ZodType> = z.infer<S>;
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string | null; permission: ConsolePermission; action: string; objectType: string; objectId: string }

const CLOCK_SKEW_MS = 60_000;
const BACKDATING_MS = 5 * 60_000;

/**
 * Hub use cases (HUB-001): hubs and territories, versioned configuration with a current pointer and second-person
 * activation, launch gates and the lifecycle, legal documents with counsel approvals and acceptances, and provider
 * credential references.
 *
 * Every staff command runs in one `PrincipalService.runAs` transaction as the staff member through a `hubs_*` SECURITY
 * DEFINER command that checks the permission at the hub, the elevation, the second-person rules and the restricted
 * places, and writes the audit row in that transaction (BE-005 completes the idempotency record there too). A
 * two-person action called without an approval creates the approval request in the same transaction and answers
 * `pending_second_person`; the same person calls again with the approved request's id. Refusals of authority leave a
 * `denied` audit row in a transaction of their own.
 */
export class HubsService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService) {}

  /* ---------- Plumbing ---------- */

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }

  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt | null, fn: (trx: Transaction, cmd: CommandContext, p: Principal) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, cmd, p));
    } catch (error) {
      const refusal = hubsRefusal(error);
      if (refusal && attempt && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('hubs.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw hubsRefusal(error) ?? error;
    });
  }

  /** A denied audit row, when the person holds a staff role covering the hub (their own assignments are readable). */
  private async recordDenied(e: Elevated, cmd: CommandContext, attempt: Attempt, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const role = await trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.personId).where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('scope_kind', 'in', ['platform', 'node']), ...(attempt.hubId ? [eb('hub_id', '=', attempt.hubId)] : [])]))
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())])).orderBy('breakglass').limit(1).executeTakeFirst();
      if (!role) return;
      const nodeId = attempt.hubId ? null : (await trx.selectFrom('admin_node').select('id').executeTakeFirst())?.id ?? null;
      if (!attempt.hubId && !nodeId) return;
      const reason = typeof refusal.details?.reason === 'string' ? refusal.details.reason : refusal.code.replace(/\W/g, '_');
      await adminAudit.append(trx, {
        actorPersonId: p.personId, actorRole: role.role as StaffRole, scope: attempt.hubId ? { kind: 'hub', hubId: attempt.hubId } : { kind: 'node', nodeId: nodeId as string },
        permission: attempt.permission, elevationId: cmd.elevationId, action: attempt.action, objectType: attempt.objectType, objectId: attempt.objectId,
        reasonCode: `denied_${reason}`.slice(0, 64), reasonText: cmd.reasonText, outcome: 'denied', requestId: cmd.requestId,
      });
    });
  }

  /** The audit row this request wrote for the object (the actor reads their own rows). */
  private async auditId(trx: Transaction, requestId: string, objectId: string): Promise<string> {
    const row = await trx.selectFrom('admin_audit_event').select('id').where('request_id', '=', requestId).where('object_id', '=', objectId).orderBy('sequence', 'desc').limit(1).executeTakeFirst();
    if (!row) throw new Error('the command wrote no audit row');
    return row.id;
  }

  private async result(trx: Transaction, cmd: CommandContext, outcome: 'applied' | 'pending_second_person', objectId: string, revision: number, approvalRequestId: string | null, auditObjectId = objectId): Promise<ConsoleCommandResult> {
    return { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, outcome, objectId, revision, approvalRequestId, auditEventId: await this.auditId(trx, cmd.requestId, auditObjectId) };
  }

  /** Asks a second person for exactly this action and answers `pending_second_person`. */
  private async pending(trx: Transaction, cmd: CommandContext, action: string, hubId: string, digestInput: unknown, objectId: string, revision: number) {
    const request = await approvals.request(trx, cmd, { action, scope: { kind: 'hub', hubId }, actionDigest: computeDigest(digestInput).value });
    return this.result(trx, cmd, 'pending_second_person', objectId, revision, request.id, request.id);
  }

  private async requireHub(trx: Transaction, hubId: string) {
    const [hub, profile] = await Promise.all([hubs.get(trx, hubId), hubs.profile(trx, hubId)]);
    if (!hub || !profile) throw new ApiError('access.not_found', 'access.not_found');
    return { hub, profile };
  }

  private async hubView(trx: Transaction, hubId: string) {
    const { hub, profile } = await this.requireHub(trx, hubId);
    return toHub(hub, profile, await hubs.territories(trx, hubId));
  }

  /* ---------- Hubs, profile and territories ---------- */

  list(state: RequestState) {
    return this.read(state, async (trx) => {
      const profiles = await hubs.list(trx);
      return { items: await Promise.all(profiles.map((p) => this.hubView(trx, p.hub_id))) };
    });
  }

  get(state: RequestState, hubId: string) {
    return this.read(state, (trx) => this.hubView(trx, hubId));
  }

  create(e: Elevated, body: CreateHubCommand) {
    return this.staff(e, body, { hubId: null, permission: 'admin.node.hubs.manage', action: 'hub.created', objectType: 'hub', objectId: '00000000-0000-4000-8000-000000000000' }, async (trx, cmd) => {
      const profile = await hubs.create(trx, cmd, { slug: body.slug, name: body.name, defaultLocale: body.defaultLocale, locales: body.locales, timeZone: body.timeZone, currency: body.currency,
        countryPack: body.countryPack, territories: body.territories });
      const view = await this.hubView(trx, profile.hub_id);
      return { result: await this.result(trx, cmd, 'applied', profile.hub_id, view.hub.revision, null), ...view };
    });
  }

  updateProfile(e: Elevated, hubId: string, body: UpdateHubProfileCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.identity.edit', action: 'hub.profile_updated', objectType: 'hub', objectId: hubId }, async (trx, cmd) => {
      const row = await hubs.updateProfile(trx, cmd, hubId, body.expectedRevision, { name: body.name, defaultLocale: body.defaultLocale, locales: body.locales, timeZone: body.timeZone, currency: body.currency, brandOverlay: body.brandOverlay });
      return { result: await this.result(trx, cmd, 'applied', hubId, row.revision, null), ...(await this.hubView(trx, hubId)) };
    });
  }

  addTerritory(e: Elevated, hubId: string, body: Body<typeof AddTerritoryCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.identity.edit', action: 'hub.territory_added', objectType: 'hub_territory', objectId: hubId }, async (trx, cmd) => {
      const row = await hubs.addTerritory(trx, cmd, hubId, body.territory);
      return { result: await this.result(trx, cmd, 'applied', row.id, 1, null), territory: toTerritory(row) };
    });
  }

  removeTerritory(e: Elevated, hubId: string, territoryId: string, body: Cmd) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.identity.edit', action: 'hub.territory_removed', objectType: 'hub_territory', objectId: territoryId }, async (trx, cmd) => {
      const row = await hubs.removeTerritory(trx, cmd, hubId, territoryId);
      return { result: await this.result(trx, cmd, 'applied', row.id, 1, null), territory: toTerritory(row) };
    });
  }

  /* ---------- Configuration ---------- */

  versions(state: RequestState, hubId: string, domain: HubConfigDomain | undefined) {
    return this.read(state, async (trx) => {
      await this.requireHub(trx, hubId);
      return { items: (await hubConfig.list(trx, hubId, domain)).map(toConfigVersion) };
    });
  }

  current(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireHub(trx, hubId);
      return { items: (await hubConfig.current(trx, hubId)).map(toConfigVersion), retention: (await hubConfig.retention(trx, hubId)).map(toRetention) };
    });
  }

  version(state: RequestState, hubId: string, versionId: string) {
    return this.read(state, async (trx) => {
      const v = await hubConfig.get(trx, versionId);
      if (!v || v.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      return { version: toConfigVersion(v) };
    });
  }

  draft(e: Elevated, hubId: string, body: DraftConfigVersionCommand) {
    const problems = configPayloadProblems(body.domain, body.payload);
    if (problems.length) throw new ApiError('validation.schema', 'the payload does not match its domain', { reason: 'payload_invalid', items: problems.slice(0, 20) });
    return this.staff(e, body, { hubId, permission: configDraftPermissions(body.domain)[0]!, action: 'hub.config_drafted', objectType: 'hub_config_version', objectId: hubId }, async (trx, cmd) => {
      const v = await hubConfig.draft(trx, cmd, hubId, body.domain, body.payload);
      return { result: await this.result(trx, cmd, 'applied', v.id, v.revision, null), version: toConfigVersion(v) };
    });
  }

  cancel(e: Elevated, hubId: string, versionId: string, body: Cmd) {
    return this.staff(e, body, { hubId, permission: 'admin.config.edit', action: 'hub.config_cancelled', objectType: 'hub_config_version', objectId: versionId }, async (trx, cmd) => {
      await this.versionOf(trx, hubId, versionId);
      const v = await hubConfig.cancel(trx, cmd, versionId);
      return { result: await this.result(trx, cmd, 'applied', v.id, v.revision, null), version: toConfigVersion(v) };
    });
  }

  private async versionOf(trx: Transaction, hubId: string, versionId: string): Promise<HubConfigVersionRow> {
    const v = await hubConfig.get(trx, versionId);
    if (!v || v.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return v;
  }

  /** Activates now (scheduled activation is a follow-up); a sensitive domain without `approvalId` asks a second person. */
  activate(e: Elevated, hubId: string, versionId: string, body: ActivateConfigVersionCommand) {
    if (body.effectiveFrom !== undefined) {
      const at = Date.parse(body.effectiveFrom);
      const now = this.ctx.clock.now().getTime();
      if (at > now + CLOCK_SKEW_MS) throw new ApiError('validation.schema', 'scheduled activation is not supported yet; activate when it should take effect', { reason: 'scheduled_activation_unsupported' });
      if (at < now - BACKDATING_MS) throw new ApiError('validation.schema', 'effectiveFrom cannot precede activation', { reason: 'no_backdating' });
    }
    return this.staff(e, body, { hubId, permission: 'admin.config.edit', action: 'hub.config_activated', objectType: 'hub_config_version', objectId: versionId }, async (trx, cmd, p) => {
      const v = await this.versionOf(trx, hubId, versionId);
      const domain = v.domain as HubConfigDomain;
      const action = configActivationAction(domain);
      if (action && body.approvalId === null) {
        if (v.status !== 'draft') throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'invalid_transition' });
        if (v.revision !== body.expectedRevision) throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'revision_conflict' });
        if (v.drafted_by === p.personId) throw new ApiError('access.second_approver_required', 'a sensitive version is activated by someone other than its drafter', { reason: 'self_approval' });
        return { result: await this.pending(trx, cmd, action, hubId, configActivationDigestInput({ id: v.id, hubId, domain, version: v.version, payloadDigest: v.payload_digest }), v.id, v.revision), version: toConfigVersion(v) };
      }
      const boundContext = domain === 'jurisdiction' ? { ...cmd, sessionId: e.state.session?.id } : cmd;
      const active = await hubConfig.activate(trx, boundContext, versionId, body.expectedRevision, action ? body.approvalId : null);
      return { result: await this.result(trx, cmd, 'applied', active.id, active.revision, null), version: toConfigVersion(active) };
    });
  }

  /**
   * CFG-001's deployment settings become configuration version 1 of `identity` and `country` (drafted from the
   * document, activated at once: neither domain is sensitive). Refused once either domain has a version.
   */
  importDeployment(e: Elevated, hubId: string, body: ImportDeploymentCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.config.edit', action: 'hub.config_activated', objectType: 'hub', objectId: hubId }, async (trx, cmd) => {
      await this.requireHub(trx, hubId);
      const existing = (await hubConfig.list(trx, hubId)).filter((v) => v.domain === 'identity' || v.domain === 'country');
      if (existing.length) throw new ApiError('validation.revision_conflict', 'the hub already has identity or country versions; draft a new version instead', { reason: 'already_configured' });
      const { identity, country } = splitDeploymentConfig(body.deployment);
      const out = [];
      for (const [domain, payload] of [['identity', identity], ['country', country]] as const) {
        const problems = configPayloadProblems(domain, payload);
        if (problems.length) throw new ApiError('validation.schema', 'the deployment document does not match its domain', { reason: 'payload_invalid', items: problems.slice(0, 20) });
        const v = await hubConfig.draft(trx, cmd, hubId, domain, payload as Record<string, unknown>, 'deployment_import');
        out.push(await hubConfig.activate(trx, cmd, v.id, v.revision, null));
      }
      return { result: await this.result(trx, cmd, 'applied', out[0]!.id, out[0]!.revision, null, out[1]!.id), versions: out.map(toConfigVersion) };
    });
  }

  /* ---------- Launch gates and the lifecycle ---------- */

  checklist(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      const { hub } = await this.requireHub(trx, hubId);
      const [gates, engine, soft, pub] = await Promise.all([launchGates.list(trx, hubId), launchGates.preconditions(trx, hubId), hubs.blockers(trx, hubId, 'soft_launch'), hubs.blockers(trx, hubId, 'public')]);
      return toChecklist(hub, gates, engine, { soft_launch: soft, public: pub });
    });
  }

  checkGate(e: Elevated, hubId: string, body: Body<typeof CheckLaunchGateCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.launch.check', action: 'hub.launch_gate_passed', objectType: 'launch_gate', objectId: hubId }, async (trx, cmd) => {
      const g = await launchGates.check(trx, cmd, hubId, body.gate, body.evidenceRef);
      return { result: await this.result(trx, cmd, 'applied', g.id, g.revision, null), gate: toGate(g) };
    });
  }

  invalidateGate(e: Elevated, hubId: string, body: Body<typeof InvalidateLaunchGateCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.launch.check', action: 'hub.launch_gate_invalidated', objectType: 'launch_gate', objectId: hubId }, async (trx, cmd) => {
      const g = await launchGates.invalidate(trx, cmd, hubId, body.gate);
      return { result: await this.result(trx, cmd, 'applied', g.id, g.revision, null), gate: toGate(g) };
    });
  }

  /** soft_launch and public: blockers first (no approval is requested for an impossible transition), then a second person. */
  transition(e: Elevated, hubId: string, body: TransitionHubCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.lifecycle.request', action: 'hub.lifecycle_changed', objectType: 'hub', objectId: hubId }, async (trx, cmd) => {
      // A caller who cannot read the hub gets the database's own refusal (forbidden for staff of the hub, not found otherwise).
      if (!(await hubs.get(trx, hubId))) await hubs.transition(trx, cmd, hubId, body.to, body.expectedRevision, body.approvalId);
      const { hub } = await this.requireHub(trx, hubId);
      const action = transitionAction(body.to);
      if (action && body.approvalId === null) {
        if (hub.revision !== body.expectedRevision) throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'revision_conflict' });
        const blockers = await hubs.blockers(trx, hubId, body.to as 'soft_launch' | 'public');
        if (blockers.length) throw new ApiError('validation.schema', 'the hub cannot go there with open launch gates', { reason: 'launch_gate_open', items: blockers });
        return { result: await this.pending(trx, cmd, action, hubId, lifecycleTransitionDigestInput({ hubId, from: hub.lifecycle as HubLifecycle, to: body.to as 'soft_launch' | 'public', revision: hub.revision }), hubId, hub.revision), ...(await this.hubView(trx, hubId)) };
      }
      const row = await hubs.transition(trx, cmd, hubId, body.to, body.expectedRevision, action ? body.approvalId : null);
      return { result: await this.result(trx, cmd, 'applied', hubId, row.revision, null), ...(await this.hubView(trx, hubId)) };
    });
  }

  /* ---------- Legal documents ---------- */

  legal(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireHub(trx, hubId);
      const [docs, counsel] = await Promise.all([legalDocuments.list(trx, hubId), legalDocuments.counselApprovals(trx, hubId)]);
      const latest = (id: string) => counsel.find((c) => c.document_version_ids.includes(id))?.id ?? null;
      return { documents: docs.map((d) => toLegalDocument(d, latest(d.id))), counselApprovals: counsel.map(toCounselApproval) };
    });
  }

  draftLegal(e: Elevated, hubId: string, body: Body<typeof DraftLegalDocumentCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.legal.edit', action: 'legal.document_drafted', objectType: 'legal_document_version', objectId: hubId }, async (trx, cmd) => {
      const d = await legalDocuments.draft(trx, cmd, hubId, body);
      return { result: await this.result(trx, cmd, 'applied', d.id, d.revision, null), document: toLegalDocument(d, null) };
    });
  }

  recordCounselApproval(e: Elevated, hubId: string, body: Body<typeof RecordCounselApprovalCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.legal.edit', action: 'legal.counsel_approval_recorded', objectType: 'counsel_approval', objectId: hubId }, async (trx, cmd) => {
      const c = await legalDocuments.recordCounselApproval(trx, cmd, hubId, body);
      return { result: await this.result(trx, cmd, 'applied', c.id, 1, null), counselApproval: toCounselApproval(c) };
    });
  }

  activateLegal(e: Elevated, hubId: string, documentId: string, body: Body<typeof ActivateLegalDocumentCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.hub.legal.activate', action: 'legal.document_activated', objectType: 'legal_document_version', objectId: documentId }, async (trx, cmd) => {
      const d = await legalDocuments.get(trx, documentId);
      if (!d || d.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      if (body.approvalId === null) {
        if (d.status !== 'draft') throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'invalid_transition' });
        const counsel = (await legalDocuments.counselApprovals(trx, hubId)).find((c) => c.document_version_ids.includes(d.id));
        if (!counsel) throw new ApiError('validation.schema', 'record the counsel approval of this version first', { reason: 'counsel_approval_required' });
        return { result: await this.pending(trx, cmd, 'legal.activate_document_version', hubId, legalActivationDigestInput({ id: d.id, hubId, kind: d.kind as LegalDocumentKind, locale: d.locale, version: d.version, bodyDigest: d.body_digest, counselApprovalId: counsel.id }), d.id, d.revision), document: toLegalDocument(d, counsel.id) };
      }
      const active = await legalDocuments.activate(trx, cmd, documentId, body.expectedRevision, body.approvalId);
      return { result: await this.result(trx, cmd, 'applied', active.id, active.revision, null), document: toLegalDocument(active, null) };
    });
  }

  /**
   * Active legal texts of the hub this API serves (`TRUSTWORK_HUB_ID`, read per request) for everyone, signed in or not
   * (QA-002 D4: the legal pages and sign-up). Read without an identity: the row policy shows active texts of a hub that
   * is visible to everyone (from soft launch on) and never a draft; before that the list is empty.
   */
  async servedLegal(hubId: string | null = staffHubFromEnv(process.env)): Promise<PublicLegalDocuments> {
    if (!hubId) return { hubConfigured: false, documents: [] };
    const rows = await withoutPrincipal(this.ctx.pool, (trx) => legalDocuments.list(trx, hubId));
    return PublicLegalDocumentsSchema.parse({ hubConfigured: true, documents: rows.filter((d) => d.status === 'active').map(toPublicLegalDocument) });
  }

  /** Active legal texts of a hub that is visible to the caller (from soft launch on). */
  publicLegal(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ documents: (await legalDocuments.list(trx, hubId)).filter((d) => d.status === 'active').map(toPublicLegalDocument) }));
  }

  accept(state: RequestState, hubId: string, documentId: string, body: Body<typeof AcceptLegalDocumentCommandSchema>) {
    return this.read(state, async (trx) => {
      const d = await legalDocuments.get(trx, documentId);
      if (!d || d.hub_id !== hubId || d.status !== 'active') throw new ApiError('access.not_found', 'access.not_found');
      return { acceptance: toAcceptance(await legalDocuments.accept(trx, documentId, body.context)) };
    });
  }

  /* ---------- Provider credential references ---------- */

  credentials(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => {
      await this.requireHub(trx, hubId);
      return { items: (await providerCredentials.list(trx, hubId)).map(toCredential) };
    });
  }

  registerCredential(e: Elevated, hubId: string, body: Body<typeof RegisterCredentialCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.secret.write', action: 'providers.credential_registered', objectType: 'provider_credential_ref', objectId: hubId }, async (trx, cmd) => {
      const c = await providerCredentials.register(trx, cmd, hubId, { provider: body.provider, adapter: body.adapter, mode: body.mode, secretStore: body.secret.store, secretRef: body.secret.ref });
      return { result: await this.result(trx, cmd, 'applied', c.id, c.revision, null), credential: toCredential(c) };
    });
  }

  activateCredential(e: Elevated, hubId: string, credentialId: string, body: Body<typeof ActivateCredentialCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.toggle', action: 'providers.credential_activated', objectType: 'provider_credential_ref', objectId: credentialId }, async (trx, cmd) => {
      const c = await providerCredentials.get(trx, credentialId);
      if (!c || c.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      if (c.mode !== 'fake' && body.approvalId === null) {
        if (c.status !== 'registered') throw new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: 'invalid_transition' });
        return { result: await this.pending(trx, cmd, 'providers.enable_non_fake', hubId, credentialActivationDigestInput({ id: c.id, hubId, provider: c.provider, adapter: c.adapter, mode: c.mode, secretStore: c.secret_store, secretRef: c.secret_ref }), c.id, c.revision), credential: toCredential(c) };
      }
      const active = await providerCredentials.activate(trx, cmd, credentialId, c.mode === 'fake' ? null : body.approvalId);
      return { result: await this.result(trx, cmd, 'applied', active.id, active.revision, null), credential: toCredential(active) };
    });
  }

  retireCredential(e: Elevated, hubId: string, credentialId: string, body: Cmd) {
    return this.staff(e, body, { hubId, permission: 'admin.providers.toggle', action: 'providers.credential_retired', objectType: 'provider_credential_ref', objectId: credentialId }, async (trx, cmd) => {
      const c = await providerCredentials.get(trx, credentialId);
      if (!c || c.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
      const retired = await providerCredentials.retire(trx, cmd, credentialId);
      return { result: await this.result(trx, cmd, 'applied', retired.id, retired.revision, null), credential: toCredential(retired) };
    });
  }

  /* ---------- Runtime readers (no principal) ---------- */

  /** The active identity and country payloads joined back into a CFG-001 document (null fields when not configured). */
  async deploymentSettings(hubId: string): Promise<{ identity: Record<string, unknown> | null; country: Record<string, unknown> | null }> {
    const [identity, country] = await Promise.all([hubConfig.publicPayload(this.ctx.pool, hubId, 'identity'), hubConfig.publicPayload(this.ctx.pool, hubId, 'country')]);
    return { identity, country };
  }

}
