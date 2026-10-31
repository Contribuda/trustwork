import { computeDigest, DIGEST_ALGORITHM, digestEquals, type Capability, type ObjectParticipation, type Party, type Principal } from '../../deps/contracts.js';
import { auditEvents, outbox, projects, type Transaction } from '../../deps/data.js';
import type * as db from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PolicyResource } from '../identity/policy/policy.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  licensingNotices, LicensingNoticesSchema, OwnerPlanViewSchema, pathChangeAllowed, PATH_LINK_KINDS, PlanContentSchema, planItemTransitionAllowed, planVersionDigestInput, rowToItem,
  sharePreview, SharePreviewSchema, toTimingFacts,
  permitRecords, planChanges, planItemStates, planParts, plans, planShares, planTaxonomy, planVersions, projectDiary, projectLocations,
  type InvitedPlanView, type OwnerPlanView, type PermitRecord, type PlanActor, type PlanActorInput, type PlanChange, type PlanContent, type PlanItem, type PlanItemState, type PlanItemStatus,
  type PlanRow, type PlanShare, type PlanShareAudience, type PlanShareField, type PlanTimingFact, type PlanVersion, type PlanVersionRow, type ProjectDiaryEntry, type ProjectLocation,
  type AcceptanceRefSchema, type PlanItemLink, type PlanItemPath, type RecordPermitCommandSchema, type AddDiaryEntryCommandSchema, type SetProjectLocationCommandSchema,
  type RecordPlanChangeCommandSchema, type LicensingNotice,
} from './deps.js';
import type { LicensingFacetSource } from './facets.js';
import type { PlanMandatePort } from './mandates.js';
import { invitedViewFromRows, toChange, toDiaryEntry, toItemState, toLocation, toPermit, toPlan, toShare, toVersion, toVersionSummary } from './serializers.js';
import type { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Loaded = { row: db.Project; rows: ObjectParticipation[]; resource: PolicyResource };
export type PlanView = OwnerPlanView | InvitedPlanView;

/** Database hints of the plans guards, mapped to frozen contract codes (the shared filter does not know them). */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'plans.version_frozen': { code: 'commercial.version_immutable', reason: 'version_frozen' },
  'plans.invalid_version_transition': { code: 'commercial.version_immutable', reason: 'invalid_version_transition' },
  'plans.change_immutable': { code: 'commercial.version_immutable', reason: 'change_immutable' },
  'plans.share_immutable': { code: 'commercial.version_immutable', reason: 'share_immutable' },
  'plans.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'plans.unknown_term': { code: 'validation.schema', reason: 'unknown_term' },
  'plans.dependency_cycle': { code: 'validation.schema', reason: 'dependency_cycle' },
  'plans.parts_missing': { code: 'validation.schema', reason: 'parts_missing' },
  'plans.item_path_taken': { code: 'validation.revision_conflict', reason: 'item_path_taken' },
  'plans.invalid_item_transition': { code: 'validation.schema', reason: 'invalid_item_transition' },
  'plans.item_not_in_baseline': { code: 'validation.schema', reason: 'item_not_in_baseline' },
  'plans.invalid_change': { code: 'validation.schema', reason: 'invalid_change' },
  'plans.invalid_share': { code: 'validation.schema', reason: 'invalid_share' },
  'plans.restricted_place': { code: 'validation.schema', reason: 'restricted_place' },
  'plans.not_found': { code: 'access.not_found', reason: 'not_found' },
};
function mapDatabaseError(error: unknown): never {
  const pg = error as { code?: string; hint?: string; constraint?: string };
  if (pg && typeof pg.code === 'string') {
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
    if (pg.code === '23503') throw new ApiError('validation.schema', 'a referenced party or record does not exist', { reason: 'unknown_reference' });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { constraint: pg.constraint ?? null });
  }
  throw error;
}

const pick = (fields: readonly PlanShareField[]) => [...fields];

/**
 * Project plans (PLAN-001). The project is the authorization anchor: owner-side operations need the project policy to
 * allow the capability with the owner-private projection (owner person, owner company members with
 * company.deals.manage, or a participation with audience owner_private). Invitees receive only the invited view.
 * Every write runs in one `withPrincipal` transaction with its audit row and an identifiers-only outbox event; the
 * database guards repeat the rules (frozen versions, approval by `accept`, one path per item, immutable shares).
 */
export class PlansService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly policy: ParticipationService,
    private readonly mandates: PlanMandatePort,
    private readonly facets: LicensingFacetSource,
  ) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapDatabaseError);
  }

  private async project(trx: Transaction, projectId: string): Promise<Loaded | null> {
    if (!UUID.test(projectId)) return null;
    const row = await projects.getById(trx, projectId);
    if (!row) return null;
    const rows = await this.policy.rowsFor(trx, { kind: 'project', id: projectId });
    const ownerParty: Party = row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id as string };
    return { row, rows, resource: { kind: 'project', id: row.id, ownerParty, lifecycle: row.status, publishedProjection: row.publicity_enabled } };
  }

  /** Allowed with the owner-private projection; otherwise not found (no owner-side read) or forbidden (read but not this). */
  private ownerSide(principal: Principal, loaded: Loaded | null, capability: Capability): Loaded {
    if (!loaded) throw new ApiError('access.not_found');
    const read = this.policy.evaluate(principal, 'read.owner_private', loaded.resource, loaded.rows);
    if (read.effect !== 'allow' || read.projection !== 'owner_private') throw new ApiError('access.not_found');
    if (capability === 'read.owner_private') return loaded;
    const decision = this.policy.evaluate(principal, capability, loaded.resource, loaded.rows);
    if (decision.effect !== 'allow') this.policy.require(decision);
    if (decision.effect === 'allow' && decision.projection !== 'owner_private') throw new ApiError('access.forbidden', 'plans need owner-private authority');
    return loaded;
  }

  private async planOf(trx: Transaction, projectId: string, lock = false): Promise<PlanRow> {
    const plan = lock ? await plans.lockByProject(trx, projectId) : await plans.getByProject(trx, projectId);
    if (!plan) throw new ApiError('access.not_found');
    return plan;
  }

  private async versionOf(trx: Transaction, plan: PlanRow, versionId: string, lock = false): Promise<PlanVersionRow> {
    if (!UUID.test(versionId)) throw new ApiError('access.not_found');
    const version = lock ? await planVersions.lock(trx, versionId) : await planVersions.get(trx, versionId);
    if (!version || version.plan_id !== plan.id) throw new ApiError('access.not_found');
    return version;
  }

  /** A person acts on their own authority; their agent only under a `prepare` mandate covering the project. */
  private async actor(principal: Principal, input: PlanActorInput, projectId: string): Promise<PlanActor> {
    if (input.via === 'person') return { via: 'person', personId: principal.personId, mandateId: null };
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: input.mandateId, projectId, action: 'prepare', at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', 'the agent needs a prepare mandate for this project');
    return { via: 'agent', personId: principal.personId, mandateId: input.mandateId };
  }

  private async requireKnownTerms(trx: Transaction, content: PlanContent): Promise<void> {
    const unknown = await planTaxonomy.unknownCodes(trx, content.items.flatMap((i) => [...i.stepTerms, ...i.requiredSkills]));
    if (unknown.length > 0) throw new ApiError('validation.schema', 'plan items name unknown or unreleased taxonomy terms', { reason: 'unknown_term', codes: unknown.slice(0, 20) });
  }

  private async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }
  /** Identifiers only (PLAN_EVENT_PAYLOAD_KEYS): notifications read the projection under the recipient's authority. */
  private async event(trx: Transaction, plan: PlanRow, revision: number, type: string, payload: Record<string, string | number | null>): Promise<void> {
    await outbox.append(trx, { aggregate_kind: 'plan', aggregate_id: plan.id, revision, type, payload: { planId: plan.id, projectId: plan.project_id, ...payload } });
  }

  private async ownerView(trx: Transaction, plan: PlanRow): Promise<OwnerPlanView> {
    const versions = await planVersions.listForPlan(trx, plan.id);
    const find = (status: PlanVersionRow['status']) => versions.find((v) => v.status === status);
    const full = (row: PlanVersionRow | undefined) => (row ? toVersion(row) : null);
    return OwnerPlanViewSchema.parse({ projection: 'owner_private', plan: toPlan(plan), versions: versions.map(toVersionSummary), approved: full(find('approved')), proposed: full(find('proposed')), draft: full(find('draft')) });
  }

  /* ---------- Plan and versions ---------- */

  async create(projectId: string, input: { timeZone: string; actor: PlanActorInput; content: PlanContent }, state: RequestState): Promise<OwnerPlanView> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const actor = await this.actor(p, input.actor, projectId);
      if (await plans.getByProject(trx, projectId)) throw new ApiError('validation.revision_conflict', 'the project already has a plan', { reason: 'plan_exists' });
      await this.requireKnownTerms(trx, input.content);
      const plan = await plans.insert(trx, { project_id: projectId, time_zone: input.timeZone, created_by_person_id: p.personId, drafted_via: actor.via, drafted_mandate_id: actor.mandateId });
      const draft = await planVersions.insertDraft(trx, { plan_id: plan.id, project_id: projectId, version: 1, content: input.content, based_on_version_id: null, drafted_by_person_id: p.personId, drafted_via: actor.via, drafted_mandate_id: actor.mandateId });
      await this.audit(trx, p, state, 'plan.created', 'plan', plan.id, { projectId, versionId: draft.id, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, plan, plan.revision, 'plan.created', { versionId: draft.id, version: 1, via: actor.via });
      return this.ownerView(trx, plan);
    });
  }

  /** Owner side: the owner view. An invitee: the invited view. Anyone else, and anonymous callers: not found. */
  async get(projectId: string, state: RequestState): Promise<PlanView> {
    if (!state.principal || !UUID.test(projectId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const loaded = await this.project(trx, projectId);
      if (loaded) {
        const read = this.policy.evaluate(p, 'read.owner_private', loaded.resource, loaded.rows);
        if (read.effect === 'allow' && read.projection === 'owner_private') return this.ownerView(trx, await this.planOf(trx, projectId));
      }
      return this.invited(trx, p, projectId);
    });
  }

  private async invited(trx: Transaction, p: Principal, projectId: string): Promise<InvitedPlanView> {
    const rows = await planShares.sharedView(trx, projectId);
    const companyId = p.membership && p.membership.permissions.includes('company.deals.manage') ? p.membership.companyId : null;
    const view = invitedViewFromRows(projectId, rows, { personId: p.personId, companyId }, this.now());
    if (!view) throw new ApiError('access.not_found');
    return view;
  }

  async sharedWithMe(projectId: string, state: RequestState): Promise<InvitedPlanView> {
    if (!state.principal || !UUID.test(projectId)) throw new ApiError('access.not_found');
    return this.run(state, (trx, p) => this.invited(trx, p, projectId));
  }

  async getVersion(projectId: string, versionId: string, state: RequestState): Promise<PlanVersion> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      return toVersion(await this.versionOf(trx, await this.planOf(trx, projectId), versionId));
    });
  }

  async createDraft(projectId: string, input: { basedOnVersionId: string | null; actor: PlanActorInput }, state: RequestState): Promise<PlanVersion> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const actor = await this.actor(p, input.actor, projectId);
      const plan = await this.planOf(trx, projectId, true);
      if (await planVersions.inStatus(trx, plan.id, 'draft')) throw new ApiError('validation.revision_conflict', 'the plan already has an open draft', { reason: 'draft_exists' });
      const base = input.basedOnVersionId ? await this.versionOf(trx, plan, input.basedOnVersionId)
        : (await planVersions.inStatus(trx, plan.id, 'approved')) ?? (await planVersions.inStatus(trx, plan.id, 'proposed'));
      const content = base ? PlanContentSchema.parse(base.content) : { summary: null, assumptions: [], budget: null, timeline: null, items: [], dependencies: [] };
      const draft = await planVersions.insertDraft(trx, {
        plan_id: plan.id, project_id: projectId, version: await planVersions.nextNumber(trx, plan.id), content, based_on_version_id: base?.id ?? null,
        drafted_by_person_id: p.personId, drafted_via: actor.via, drafted_mandate_id: actor.mandateId,
      });
      await this.audit(trx, p, state, 'plan.draft_created', 'plan_version', draft.id, { basedOnVersionId: base?.id ?? null, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, plan, draft.version, 'plan.draft_created', { versionId: draft.id, version: draft.version, via: actor.via });
      return toVersion(draft);
    });
  }

  async saveDraft(projectId: string, versionId: string, input: { expectedRevision: number; content: PlanContent; actor: PlanActorInput }, state: RequestState): Promise<PlanVersion> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const actor = await this.actor(p, input.actor, projectId);
      const plan = await this.planOf(trx, projectId);
      const current = await this.versionOf(trx, plan, versionId);
      if (current.status !== 'draft') throw new ApiError('commercial.version_immutable', 'a proposed or approved version is frozen; create a new draft', { reason: 'version_frozen' });
      await this.requireKnownTerms(trx, input.content);
      const saved = await planVersions.saveContent(trx, versionId, input.expectedRevision, input.content);
      if (!saved) {
        const now = await planVersions.get(trx, versionId);
        if (now && now.status !== 'draft') throw new ApiError('commercial.version_immutable', 'the version was proposed meanwhile', { reason: 'version_frozen' });
        throw new ApiError('validation.revision_conflict');
      }
      await this.audit(trx, p, state, 'plan.draft_saved', 'plan_version', versionId, { revision: saved.revision, via: actor.via, mandateId: actor.mandateId, items: input.content.items.length });
      return toVersion(saved);
    });
  }

  /** Freezes a draft: materialised items and dependencies, digest; a previous proposal is superseded (replaced). */
  async propose(projectId: string, versionId: string, input: { expectedRevision: number; actor: PlanActorInput }, state: RequestState): Promise<PlanVersion> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const actor = await this.actor(p, input.actor, projectId);
      const plan = await this.planOf(trx, projectId, true);
      const version = await this.versionOf(trx, plan, versionId, true);
      if (version.status !== 'draft') throw new ApiError('commercial.version_immutable', 'only a draft can be proposed', { reason: 'version_frozen' });
      if (version.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const content = PlanContentSchema.parse(version.content);
      await this.requireKnownTerms(trx, content);
      const digest = computeDigest(planVersionDigestInput({ planId: plan.id, version: version.version, content }));
      await planParts.materialise(trx, version.id, content);
      const previous = await planVersions.inStatus(trx, plan.id, 'proposed');
      const at = this.now();
      if (previous) await planVersions.supersede(trx, previous.id, { byVersionId: version.id, reason: 'replaced', at });
      const proposed = await planVersions.propose(trx, version.id, { digest: digest.value, personId: p.personId, via: actor.via, mandateId: actor.mandateId, at });
      await this.audit(trx, p, state, 'plan.version_proposed', 'plan_version', version.id, { digest: digest.value, via: actor.via, mandateId: actor.mandateId, replaced: previous?.id ?? null });
      await this.event(trx, plan, proposed.version, 'plan.version_proposed', { versionId: version.id, version: proposed.version, via: actor.via, mandateId: actor.mandateId });
      return toVersion(proposed);
    });
  }

  private async approveLocked(trx: Transaction, p: Principal, state: RequestState, plan: PlanRow, versionId: string, expectedRevision: number, digest: { value: string }, changeId: string | null): Promise<PlanVersionRow> {
    const version = await this.versionOf(trx, plan, versionId, true);
    if (version.status !== 'proposed') throw new ApiError('commercial.version_immutable', 'only a proposed version can be approved', { reason: 'not_proposed' });
    if (version.revision !== expectedRevision) throw new ApiError('validation.revision_conflict');
    if (!version.digest || !digestEquals({ algorithm: DIGEST_ALGORITHM, value: version.digest }, { algorithm: DIGEST_ALGORITHM, value: digest.value })) {
      throw new ApiError('commercial.digest_mismatch', 'the approved digest differs from the proposed version');
    }
    const at = this.now();
    if (plan.current_version_id) await planVersions.supersede(trx, plan.current_version_id, { byVersionId: version.id, reason: 'replaced', at });
    const approved = await planVersions.approve(trx, version.id, { personId: p.personId, at, changeId });
    const updatedPlan = await plans.setBaseline(trx, plan.id, version.id);
    await this.audit(trx, p, state, 'plan.version_approved', 'plan_version', version.id, { digest: version.digest, supersedes: plan.current_version_id, changeId });
    await this.event(trx, updatedPlan, approved.version, 'plan.version_approved', { versionId: version.id, version: approved.version, changeId });
    return approved;
  }

  /** Governance: the owner (or a person holding `accept` with owner-private audience) approves exactly the digest seen. */
  async approve(projectId: string, versionId: string, input: { expectedRevision: number; digest: { value: string } }, state: RequestState): Promise<PlanVersion> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'accept');
      const plan = await this.planOf(trx, projectId, true);
      return toVersion(await this.approveLocked(trx, p, state, plan, versionId, input.expectedRevision, input.digest, null));
    });
  }

  /** The owner returns a proposal: it stays frozen (superseded, returned) and its content continues as the open draft. */
  async returnVersion(projectId: string, versionId: string, input: { expectedRevision: number; reason: string }, state: RequestState): Promise<PlanVersion> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'accept');
      const plan = await this.planOf(trx, projectId, true);
      const version = await this.versionOf(trx, plan, versionId, true);
      if (version.status !== 'proposed') throw new ApiError('commercial.version_immutable', 'only a proposed version can be returned', { reason: 'not_proposed' });
      if (version.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      let draft = await planVersions.inStatus(trx, plan.id, 'draft');
      if (!draft) {
        draft = await planVersions.insertDraft(trx, {
          plan_id: plan.id, project_id: projectId, version: await planVersions.nextNumber(trx, plan.id), content: PlanContentSchema.parse(version.content), based_on_version_id: version.id,
          drafted_by_person_id: p.personId, drafted_via: 'person', drafted_mandate_id: null,
        });
      }
      const returned = await planVersions.supersede(trx, version.id, { byVersionId: draft.id, reason: 'returned', at: this.now() });
      await this.audit(trx, p, state, 'plan.version_returned', 'plan_version', version.id, { draftId: draft.id });
      // The reason stays in the audit trail only (free text never travels in events).
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'plan.version_return_reason', object_kind: 'plan_version', object_id: version.id, request_id: state.requestId, authz_epoch: p.authzEpoch, reason: input.reason });
      await this.event(trx, plan, returned.version, 'plan.version_returned', { versionId: version.id, version: returned.version });
      return toVersion(returned);
    });
  }

  /* ---------- Execution state ---------- */

  async listItemStates(projectId: string, state: RequestState): Promise<{ items: PlanItemState[] }> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      return { items: (await planItemStates.list(trx, (await this.planOf(trx, projectId)).id)).map(toItemState) };
    });
  }

  async updateItemState(projectId: string, itemKey: string, input: { status: PlanItemStatus; path: PlanItemPath | null; link: PlanItemLink | null; actualStart: string | null; actualEnd: string | null; expectedRevision: number | null }, state: RequestState): Promise<PlanItemState> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const plan = await this.planOf(trx, projectId);
      if (!plan.current_version_id) throw new ApiError('validation.schema', 'items get an execution state once a version is approved', { reason: 'no_baseline' });
      if (input.link && (input.path === null || !PATH_LINK_KINDS[input.path].includes(input.link.kind))) throw new ApiError('validation.schema', 'the link does not match the path', { reason: 'link_path_mismatch' });
      const current = await planItemStates.get(trx, plan.id, itemKey);
      let saved;
      if (!current) {
        if (input.expectedRevision !== null) throw new ApiError('validation.revision_conflict');
        if (input.status !== 'proposed' && !planItemTransitionAllowed('proposed', input.status)) throw new ApiError('validation.schema', 'invalid initial state', { reason: 'invalid_item_transition' });
        if (input.status === 'blocked') throw new ApiError('validation.schema', 'invalid initial state', { reason: 'invalid_item_transition' });
        saved = await planItemStates.insert(trx, {
          plan_id: plan.id, project_id: projectId, item_key: itemKey, status: input.status, path: input.path, link_kind: input.link?.kind ?? null, link_id: input.link?.id ?? null,
          blocked_from: null, actual_start: input.actualStart, actual_end: input.actualEnd, updated_by_person_id: p.personId,
        });
      } else {
        if (input.expectedRevision === null || current.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
        if (!pathChangeAllowed(current.path, input.path) || (current.link_id !== null && (input.link?.id !== current.link_id || input.link?.kind !== current.link_kind))) {
          throw new ApiError('validation.revision_conflict', 'the item already took a path', { reason: 'item_path_taken' });
        }
        if (current.status !== input.status && !planItemTransitionAllowed(current.status, input.status, current.blocked_from)) {
          throw new ApiError('validation.schema', `item state ${current.status} -> ${input.status} is not allowed`, { reason: 'invalid_item_transition' });
        }
        const blockedFrom = input.status === 'blocked' ? (current.status === 'blocked' ? current.blocked_from : (current.status as 'requested' | 'in_progress')) : null;
        saved = await planItemStates.update(trx, plan.id, itemKey, input.expectedRevision, {
          status: input.status, path: input.path, link_kind: input.link?.kind ?? null, link_id: input.link?.id ?? null, blocked_from: blockedFrom,
          actual_start: input.actualStart, actual_end: input.actualEnd, updated_by_person_id: p.personId,
        });
        if (!saved) throw new ApiError('validation.revision_conflict');
      }
      await this.audit(trx, p, state, 'plan.item_state_changed', 'plan', plan.id, { itemKey, status: saved.status, path: saved.path, link: saved.link_kind ? { kind: saved.link_kind, id: saved.link_id } : null });
      await this.event(trx, plan, saved.revision, 'plan.item_state_changed', { status: saved.status });
      return toItemState(saved);
    });
  }

  /* ---------- Changes and timing ---------- */

  async recordChange(projectId: string, input: z.infer<typeof RecordPlanChangeCommandSchema>, state: RequestState): Promise<PlanChange> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const plan = await this.planOf(trx, projectId);
      await this.versionOf(trx, plan, input.fromVersionId);
      await this.versionOf(trx, plan, input.toVersionId);
      const row = await planChanges.insert(trx, {
        plan_id: plan.id, project_id: projectId, from_version_id: input.fromVersionId, to_version_id: input.toVersionId, reason: input.reason, cause: input.cause,
        requested_by_person_id: input.requestedBy.kind === 'person' ? input.requestedBy.id : null, requested_by_company_id: input.requestedBy.kind === 'company' ? input.requestedBy.id : null,
        accountable_person_id: input.accountable.kind === 'person' ? input.accountable.id : null, accountable_company_id: input.accountable.kind === 'company' ? input.accountable.id : null,
        agreement_id: input.agreementId, schedule_impact_days: input.scheduleImpactDays, created_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'plan.change_recorded', 'plan_change', row.id, { fromVersionId: input.fromVersionId, toVersionId: input.toVersionId, cause: input.cause, accountable: input.accountable, agreementId: input.agreementId });
      await this.event(trx, plan, row.revision, 'plan.change_recorded', { changeId: row.id });
      return toChange(row);
    });
  }

  async decideChange(projectId: string, changeId: string, input: { decision: 'approve'; expectedRevision: number; digest: { value: string } } | { decision: 'reject' | 'withdraw'; expectedRevision: number }, state: RequestState): Promise<PlanChange> {
    return this.run(state, async (trx, p) => {
      const loaded = await this.project(trx, projectId);
      this.ownerSide(p, loaded, input.decision === 'withdraw' ? 'write.draft' : 'accept');
      const plan = await this.planOf(trx, projectId, true);
      if (!UUID.test(changeId)) throw new ApiError('access.not_found');
      const change = await planChanges.lock(trx, changeId);
      if (!change || change.plan_id !== plan.id) throw new ApiError('access.not_found');
      if (change.status !== 'proposed') throw new ApiError('commercial.version_immutable', 'the change is already decided', { reason: 'change_decided' });
      if (change.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (input.decision === 'withdraw' && change.created_by_person_id !== p.personId) throw new ApiError('access.forbidden', 'only the proposer withdraws a change');
      if (input.decision === 'approve') {
        const target = await this.versionOf(trx, plan, change.to_version_id, true);
        await this.approveLocked(trx, p, state, plan, target.id, target.revision, input.digest, change.id);
      }
      const status = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'withdrawn';
      const decided = await planChanges.decide(trx, change.id, input.expectedRevision, { status, personId: p.personId, at: this.now() });
      if (!decided) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, `plan.change_${status}`, 'plan_change', change.id, { toVersionId: change.to_version_id });
      await this.event(trx, plan, decided.revision, `plan.change_${status}`, { changeId: change.id, status });
      return toChange(decided);
    });
  }

  async listChanges(projectId: string, state: RequestState): Promise<{ items: PlanChange[] }> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      return { items: (await planChanges.list(trx, (await this.planOf(trx, projectId)).id)).map(toChange) };
    });
  }

  /** The approved changes with both version numbers, for EXE-001's fair-timing attribution. */
  async timingFacts(projectId: string, state: RequestState): Promise<{ items: PlanTimingFact[] }> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      const plan = await this.planOf(trx, projectId);
      const versions = await planVersions.listForPlan(trx, plan.id);
      return { items: toTimingFacts((await planChanges.list(trx, plan.id)).map(toChange), new Map(versions.map((v) => [v.id, v.version]))) };
    });
  }

  /* ---------- Sharing ---------- */

  private async baselineItem(trx: Transaction, plan: PlanRow, itemKey: string): Promise<PlanItem> {
    if (!plan.current_version_id) throw new ApiError('validation.schema', 'items are shared from the approved baseline', { reason: 'no_baseline' });
    const row = await planParts.item(trx, plan.current_version_id, itemKey);
    if (!row) throw new ApiError('validation.schema', 'the item is not in the approved baseline', { reason: 'item_not_in_baseline' });
    return rowToItem(row);
  }

  private shareCapability(audience: PlanShareAudience): Capability {
    return audience === 'public' ? 'publish' : 'invite';
  }

  private async preview(trx: Transaction, plan: PlanRow, projectId: string, input: { itemKey: string; audience: PlanShareAudience; fields: readonly PlanShareField[] }) {
    const item = await this.baselineItem(trx, plan, input.itemKey);
    const locationRow = await projectLocations.get(trx, projectId);
    const preview = sharePreview(item, input.audience, input.fields, locationRow ? toLocation(locationRow) : null);
    return SharePreviewSchema.parse({ preview, previewDigest: computeDigest(preview), notice: 'plans.share.forwarding_notice' });
  }

  /** What the share would reveal, with the digest the owner confirms (forwarded copies leave the platform: the notice says so). */
  async previewShare(projectId: string, input: { itemKey: string; audience: PlanShareAudience; invitee: Party | null; fields: PlanShareField[]; acceptanceRef: z.infer<typeof AcceptanceRefSchema> | null }, state: RequestState) {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), this.shareCapability(input.audience));
      return this.preview(trx, await this.planOf(trx, projectId), projectId, input);
    });
  }

  async share(projectId: string, input: { itemKey: string; audience: PlanShareAudience; invitee: Party | null; fields: PlanShareField[]; acceptanceRef: z.infer<typeof AcceptanceRefSchema> | null; validUntil: string | null; previewDigest: { value: string } }, state: RequestState): Promise<PlanShare> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), this.shareCapability(input.audience));
      const plan = await this.planOf(trx, projectId);
      if (input.invitee && input.invitee.kind === 'person' && input.invitee.id === p.personId) throw new ApiError('validation.schema', 'share with another party', { reason: 'self_share' });
      const now = this.now();
      if (input.validUntil && Date.parse(input.validUntil) <= now.getTime()) throw new ApiError('validation.schema', 'validUntil is in the past', { reason: 'expired' });
      const reviewed = await this.preview(trx, plan, projectId, input);
      if (reviewed.previewDigest.value !== input.previewDigest.value) throw new ApiError('commercial.digest_mismatch', 'the shared projection changed since the owner reviewed it');
      const row = await planShares.insert(trx, {
        plan_id: plan.id, project_id: projectId, item_key: input.itemKey, audience: input.audience,
        invitee_person_id: input.invitee?.kind === 'person' ? input.invitee.id : null, invitee_company_id: input.invitee?.kind === 'company' ? input.invitee.id : null,
        fields: pick(input.fields), acceptance_kind: input.acceptanceRef?.kind ?? null, acceptance_id: input.acceptanceRef?.id ?? null, preview_digest: reviewed.previewDigest.value,
        confirmed_by_person_id: p.personId, confirmed_at: now, valid_until: input.validUntil ? new Date(input.validUntil) : null,
      });
      await this.audit(trx, p, state, 'plan.item_shared', 'plan_share', row.id, { itemKey: input.itemKey, audience: input.audience, invitee: input.invitee, fields: input.fields, previewDigest: reviewed.previewDigest.value });
      await this.event(trx, plan, row.revision, 'plan.item_shared', { shareId: row.id, inviteeKind: input.invitee?.kind ?? null, inviteeId: input.invitee?.id ?? null });
      return toShare(row);
    });
  }

  async revokeShare(projectId: string, shareId: string, input: { expectedRevision: number; reason: string }, state: RequestState): Promise<PlanShare> {
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      const plan = await this.planOf(trx, projectId);
      if (!UUID.test(shareId)) throw new ApiError('access.not_found');
      const share = await planShares.get(trx, shareId);
      if (!share || share.plan_id !== plan.id) throw new ApiError('access.not_found');
      this.ownerSide(p, loaded, this.shareCapability(share.audience));
      if (share.revoked_at) throw new ApiError('commercial.version_immutable', 'revocation is final', { reason: 'share_revoked' });
      const revoked = await planShares.revoke(trx, shareId, input.expectedRevision, { personId: p.personId, reason: input.reason, at: this.now() });
      if (!revoked) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'plan.share_revoked', 'plan_share', shareId, { itemKey: share.item_key });
      await this.event(trx, plan, revoked.revision, 'plan.share_revoked', { shareId, inviteeKind: share.invitee_person_id ? 'person' : share.invitee_company_id ? 'company' : null, inviteeId: share.invitee_person_id ?? share.invitee_company_id });
      return toShare(revoked);
    });
  }

  async listShares(projectId: string, state: RequestState): Promise<{ items: PlanShare[] }> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      return { items: (await planShares.listForPlan(trx, (await this.planOf(trx, projectId)).id)).map(toShare) };
    });
  }

  /* ---------- Location, permits, diary, licensing ---------- */

  async getLocation(projectId: string, state: RequestState): Promise<ProjectLocation | null> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      const row = await projectLocations.get(trx, projectId);
      return row ? toLocation(row) : null;
    });
  }

  async setLocation(projectId: string, input: z.infer<typeof SetProjectLocationCommandSchema>, state: RequestState): Promise<ProjectLocation> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const values = { address: input.address, region_code: input.regionCode, cadastral_ref: input.cadastralRef, site_contact: input.siteContact, site_access_notes: input.siteAccessNotes, updated_by_person_id: p.personId };
      const row = input.expectedRevision === null
        ? await projectLocations.insert(trx, { project_id: projectId, ...values })
        : await projectLocations.update(trx, projectId, input.expectedRevision, values);
      if (!row) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'project.location_set', 'project', projectId, { regionCode: input.regionCode, hasAddress: input.address !== null });
      return toLocation(row);
    });
  }

  async recordPermit(projectId: string, input: z.infer<typeof RecordPermitCommandSchema>, state: RequestState): Promise<PermitRecord> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const row = await permitRecords.insert(trx, {
        project_id: projectId, plan_item_key: input.planItemKey, jurisdiction: input.jurisdiction, permit_type: input.permitType, authority: input.authority, number: input.number,
        applied_at: input.appliedAt, issued_at: input.issuedAt, expires_at: input.expiresAt, inspection_results: input.inspectionResults, evidence: input.evidence, status: input.status, created_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'project.permit_recorded', 'permit_record', row.id, { permitType: input.permitType, jurisdiction: input.jurisdiction, status: input.status });
      return toPermit(row);
    });
  }

  async listPermits(projectId: string, state: RequestState): Promise<{ items: PermitRecord[] }> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      return { items: (await permitRecords.list(trx, projectId)).map(toPermit) };
    });
  }

  async addDiaryEntry(projectId: string, input: z.infer<typeof AddDiaryEntryCommandSchema>, state: RequestState): Promise<ProjectDiaryEntry> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'write.draft');
      const row = await projectDiary.insert(trx, { project_id: projectId, author_person_id: p.personId, entry_date: input.entryDate, body: input.text, evidence: input.evidence, plan_item_key: input.planItemKey, visibility: input.visibility });
      await this.audit(trx, p, state, 'project.diary_entry_added', 'project_diary_entry', row.id, { visibility: input.visibility });
      return toDiaryEntry(row);
    });
  }

  /** Owner side: every entry. Project participants: entries marked `participants` (RLS). Plan invitees and others: not found. */
  async listDiary(projectId: string, state: RequestState): Promise<{ items: ProjectDiaryEntry[] }> {
    return this.run(state, async (trx, p) => {
      const loaded = await this.project(trx, projectId);
      const readable = loaded ? this.policy.readable(p, loaded.resource, loaded.rows, loaded.row.revision) : null;
      if (!readable || readable.projection === 'public') throw new ApiError('access.not_found');
      return { items: (await projectDiary.list(trx, projectId)).map(toDiaryEntry) };
    });
  }

  /** Which steps may need a licensed professional here, from the taxonomy facets and the country pack (never a ruling). */
  async licensing(projectId: string, state: RequestState): Promise<{ facets: { pack: string | null; regionCode: string | null }; items: LicensingNotice[] }> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.project(trx, projectId), 'read.owner_private');
      const plan = await this.planOf(trx, projectId);
      const version = (await planVersions.inStatus(trx, plan.id, 'approved')) ?? (await planVersions.inStatus(trx, plan.id, 'proposed')) ?? (await planVersions.inStatus(trx, plan.id, 'draft'));
      const items = version ? PlanContentSchema.parse(version.content).items : [];
      const location = await projectLocations.get(trx, projectId);
      const facets = this.facets.load(location?.region_code ?? null);
      return LicensingNoticesSchema.parse({ facets: { pack: facets.pack, regionCode: facets.regionCode }, items: licensingNotices(items, facets) });
    });
  }
}
