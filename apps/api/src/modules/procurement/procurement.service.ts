import type { z } from 'zod';
import {
  computeRfqVersionDigest, DIGEST_ALGORITHM, PublicRfqSchema, RfqInvitationSchema, RfqPrivateConstraintSchema, RfqSchema, RfqVersionSchema, toSharedRfqVersion,
  type Capability, type ObjectParticipation, type Party, type Principal, type PublicRfq, type RfqInvitation, type RfqVersion,
} from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PolicyResource } from '../identity/policy/policy.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { CommerceService, iso, isoDate, ownerColumns, partyOf, UUID, type ResolvedActor } from './common.js';
import {
  commercePlanLinks, EMPTY_PRIVATE_CONSTRAINT, INVITATION_TRANSITIONS, isSelfInvitation, needMissingFields, NeedListSchema, NeedSchema, needs, needStatusFor, needToRfqPayload, orderInvitations,
  OwnerRfqViewSchema, PLAN_ITEM_RFQ_KINDS, planItemStates, RfqListSchema, RfqPayloadWithKnownUnitsSchema, rfqInvitations, rfqPrivate, rfqPublic, rfqs, rfqVersions, SupplierInvitationListSchema,
  SupplierRfqViewSchema, toSupplierInvitation,
  type CloseRfqCommandSchema, type ConvertNeedCommandSchema, type CreateNeedCommandSchema, type CreateRfqCommandSchema, type InviteSupplierRequestSchema, type Need, type NeedFields,
  type NeedLineRow, type NeedPatch, type NeedRow, type OpenRfqAmendmentCommandSchema, type OwnerRfqView, type PublishRfqCommandSchema, type RespondToInvitationCommandSchema,
  type RevalidateInvitationCommandSchema, type RfqInvitationRow, type RfqPrivateConstraintInput, type RfqPrivateConstraintRow, type RfqRow, type RfqVersionRow, type SaveNeedCommandSchema,
  type SaveRfqDraftCommandSchema, type SaveRfqPrivateConstraintCommandSchema, type SetRfqProjectionCommandSchema, type SupplierInvitation, type SupplierRfqView, type WithdrawInvitationCommandSchema,
} from './deps.js';
import type { CommerceMandatePort } from './mandates.js';

type In<T extends z.ZodType> = z.infer<T>;
type Loaded = { row: RfqRow; rows: ObjectParticipation[]; resource: PolicyResource };
const OWNER_SIDE_LAYERS = new Set(['party_private', 'owner_private']);

/* ---------- Serializers (explicit allowlists, then re-validated by the strict contract schemas) ---------- */

function needView(row: NeedRow, lines: readonly NeedLineRow[]): Need {
  return NeedSchema.parse({
    projection: 'owner_private', id: row.id, owner: partyOf(row), projectId: row.project_id, source: row.source, status: row.status, title: row.title, description: row.description,
    region: row.region,
    window: row.window_from !== null && row.window_to !== null
      ? { from: { date: isoDate(row.window_from), timeZone: row.window_time_zone }, to: { date: isoDate(row.window_to), timeZone: row.window_to_time_zone } }
      : null,
    acceptanceCriteria: row.acceptance_criteria,
    lines: lines.map((l) => ({
      lineId: l.id, position: l.position, kind: l.kind, description: l.description,
      quantity: l.quantity_value !== null && l.quantity_unit !== null ? { value: l.quantity_value, unit: l.quantity_unit } : null,
      specification: l.specification, alternativesAllowed: l.alternatives_allowed, evidence: l.evidence ?? null,
    })),
    missingFields: row.missing_fields, rfqId: row.rfq_id, revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}
function needPatch(fields: NeedFields): NeedPatch {
  return {
    status: needStatusFor(fields), title: fields.title, description: fields.description, region: fields.region,
    window_from: fields.window?.from.date ?? null, window_to: fields.window?.to.date ?? null, window_time_zone: fields.window?.from.timeZone ?? null, window_to_time_zone: fields.window?.to.timeZone ?? null,
    acceptance_criteria: fields.acceptanceCriteria, missing_fields: needMissingFields(fields),
  };
}
function rfqContract(row: RfqRow) {
  return RfqSchema.parse({
    id: row.id, owner: partyOf(row), projectId: row.project_id, creatorPersonId: row.creator_person_id, status: row.status, currentVersion: row.current_version, currentVersionId: row.current_version_id,
    revision: row.revision, publicProjection: { enabled: row.public_projection_enabled, fields: row.public_projection_fields }, category: row.category, createdAt: iso(row.created_at),
  });
}
function versionContract(row: RfqVersionRow): RfqVersion {
  return RfqVersionSchema.parse({
    id: row.id, rfqId: row.rfq_id, version: row.version, status: row.status, payload: row.payload, digest: row.digest ? { algorithm: DIGEST_ALGORITHM, value: row.digest } : null,
    publishedAt: row.published_at ? iso(row.published_at) : null, publishedBy: row.published_by_person_id, supersededBy: row.superseded_by, amendmentReason: row.amendment_reason,
  });
}
function privateContract(row: RfqPrivateConstraintRow) {
  return RfqPrivateConstraintSchema.parse({
    rfqId: row.rfq_id, ownerParty: partyOf(row), budgetCeiling: row.budget_ceiling_minor !== null && row.budget_ceiling_currency !== null ? { minorUnits: String(row.budget_ceiling_minor), currency: row.budget_ceiling_currency } : null,
    evaluationWeights: row.evaluation_weights, internalNotes: row.internal_notes, shortlist: row.shortlist, revision: row.revision,
  });
}
function privateColumns(input: RfqPrivateConstraintInput) {
  return {
    budget_ceiling_minor: input.budgetCeiling?.minorUnits ?? null, budget_ceiling_currency: input.budgetCeiling?.currency ?? null,
    evaluation_weights: { ...input.evaluationWeights }, internal_notes: input.internalNotes, shortlist: [...input.shortlist],
  };
}
function invitationContract(row: RfqInvitationRow, versions: ReadonlyMap<string, RfqVersionRow>): RfqInvitation {
  const pinned = versions.get(row.rfq_version_id);
  if (!pinned || pinned.digest === null) throw new Error(`pinned version ${row.rfq_version_id} is not readable`);
  return RfqInvitationSchema.parse({
    id: row.id, rfqId: row.rfq_id, rfqVersion: { id: pinned.id, version: pinned.version, digest: { algorithm: DIGEST_ALGORITHM, value: pinned.digest } },
    party: row.party_person_id ? { kind: 'person', id: row.party_person_id } : { kind: 'company', id: row.party_company_id }, channel: row.channel, status: row.status,
    staleReason: row.stale_reason, sentAt: iso(row.sent_at), sentBy: { personId: row.sent_by_person_id, mandateId: row.sent_by_mandate_id },
  });
}
const titleOf = (row: RfqVersionRow | undefined): string => ((row?.payload as { title?: string } | undefined)?.title ?? '');

/**
 * Needs, RFQs and invitations (COM-001). A need is owner-private intake; a ready need converts once into an RFQ draft.
 * An RFQ's owner side follows the access policy for resource kind `rfq`; a published version is immutable and carries
 * its `trustwork-digest-1`; an amendment is the next version and, in the same transaction, flags every invitation
 * pinned to an earlier version `rfq_amended` (database trigger). Invitations pin the current published version; a
 * supplier sees only the versions its own invitations pin, never the buyer-private record or other invitations.
 */
export class ProcurementService extends CommerceService {
  constructor(ctx: AppContext, principals: PrincipalService, private readonly policy: ParticipationService, mandates: CommerceMandatePort) {
    super(ctx, principals, mandates);
  }

  /** A person acts for themself; a company through members holding company.deals.manage. */
  private actsFor(principal: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes('company.deals.manage');
  }
  private parties(principal: Principal): { personId: string; companyId: string | null } {
    return { personId: principal.personId, companyId: principal.membership?.permissions.includes('company.deals.manage') ? principal.membership.companyId : null };
  }

  /* ---------- Needs ---------- */

  private async needOf(trx: Transaction, needId: string, lock = false): Promise<NeedRow> {
    if (!UUID.test(needId)) throw new ApiError('access.not_found');
    const row = lock ? await needs.lock(trx, needId) : await needs.get(trx, needId);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  async createNeed(input: In<typeof CreateNeedCommandSchema>, state: RequestState): Promise<Need> {
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, input.owner)) throw new ApiError('access.forbidden', 'needs belong to a party you act for', { reason: 'not_authorised' });
      const actor = await this.actor(p, input.actor, 'prepare', input.projectId ? { kind: 'project', id: input.projectId } : input.owner.kind === 'company' ? { kind: 'company', id: input.owner.id } : { kind: 'profile', id: input.owner.id });
      if (input.projectId !== null && !UUID.test(input.projectId)) throw new ApiError('validation.schema', 'unknown project', { reason: 'unknown_reference' });
      const row = await needs.insert(trx, { ...ownerColumns(input.owner), ...needPatch(input.fields), project_id: input.projectId, created_by_person_id: p.personId, source: input.source });
      const lines = await needs.insertLines(trx, row.id, row.revision, input.fields.lines);
      await this.audit(trx, p, state, 'need.created', 'need', row.id, { source: input.source, status: row.status, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'need', row.id, row.revision, 'need.created', { needId: row.id, status: row.status, via: actor.via });
      return needView(row, lines);
    });
  }

  async getNeed(needId: string, state: RequestState): Promise<Need> {
    return this.run(state, async (trx) => {
      const row = await this.needOf(trx, needId);
      return needView(row, await needs.lines(trx, row.id, row.revision));
    });
  }

  async listNeeds(state: RequestState): Promise<z.infer<typeof NeedListSchema>> {
    return this.run(state, async (trx) => {
      const rows = await needs.list(trx);
      return NeedListSchema.parse({ needs: rows.map((r) => Object.fromEntries(Object.entries(needView(r, [])).filter(([key]) => key !== 'lines'))) });
    });
  }

  async saveNeed(needId: string, input: In<typeof SaveNeedCommandSchema>, state: RequestState): Promise<Need> {
    return this.run(state, async (trx, p) => {
      const current = await this.needOf(trx, needId, true);
      const actor = await this.actor(p, input.actor, 'prepare', current.project_id ? { kind: 'project', id: current.project_id } : { kind: 'profile', id: p.personId });
      if (current.status === 'converted') throw new ApiError('commercial.version_immutable', 'a converted need is kept as it was', { reason: 'converted' });
      if (current.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const row = await needs.update(trx, current.id, input.expectedRevision, needPatch(input.fields));
      if (!row) throw new ApiError('validation.revision_conflict');
      const lines = await needs.insertLines(trx, row.id, row.revision, input.fields.lines);
      await this.audit(trx, p, state, 'need.saved', 'need', row.id, { status: row.status, missing: row.missing_fields.length, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'need', row.id, row.revision, 'need.saved', { needId: row.id, status: row.status, via: actor.via });
      return needView(row, lines);
    });
  }

  async convertNeed(needId: string, input: In<typeof ConvertNeedCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    return this.run(state, async (trx, p) => {
      const need = await this.needOf(trx, needId, true);
      const actor = await this.actor(p, input.actor, 'prepare', need.project_id ? { kind: 'project', id: need.project_id } : { kind: 'profile', id: p.personId });
      if (need.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (need.status !== 'ready') throw new ApiError('validation.schema', 'only a ready need converts', { reason: 'need_not_ready', missingFields: need.missing_fields });
      const view = needView(need, await needs.lines(trx, need.id, need.revision));
      const payload = needToRfqPayload(view, input.rfq);
      const rfq = await rfqs.insert(trx, {
        ...ownerColumns(view.owner), project_id: need.project_id, creator_person_id: p.personId, need_id: need.id, plan_project_id: null, plan_item_key: null,
        public_projection_enabled: false, public_projection_fields: [], category: input.rfq.category,
      });
      const draft = await rfqVersions.insertDraft(trx, { rfq_id: rfq.id, version: 1, payload, drafted_by_person_id: p.personId, amendment_reason: null });
      await rfqPrivate.insert(trx, { rfq_id: rfq.id, ...ownerColumns(view.owner), ...privateColumns(input.privateConstraint ?? EMPTY_PRIVATE_CONSTRAINT), updated_by_person_id: p.personId });
      const converted = await needs.convert(trx, need.id, input.expectedRevision, rfq.id);
      if (!converted) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'need.converted', 'need', need.id, { rfqId: rfq.id, versionId: draft.id, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'need', need.id, converted.revision, 'need.converted', { needId: need.id, rfqId: rfq.id, via: actor.via });
      await this.event(trx, 'rfq', rfq.id, rfq.revision, 'rfq.created', { rfqId: rfq.id, versionId: draft.id, version: 1, needId: need.id, via: actor.via });
      return this.ownerView(trx, rfq);
    });
  }

  /* ---------- RFQ authority ---------- */

  private async load(trx: Transaction, rfqId: string, lock = false): Promise<Loaded | null> {
    if (!UUID.test(rfqId)) return null;
    const row = lock ? await rfqs.lock(trx, rfqId) : await rfqs.get(trx, rfqId);
    if (!row) return null;
    const rows = await this.policy.rowsFor(trx, { kind: 'rfq', id: rfqId });
    return { row, rows, resource: { kind: 'rfq', id: row.id, ownerParty: partyOf(row), lifecycle: row.status, publishedProjection: false } };
  }

  private isOwnerSide(p: Principal, loaded: Loaded): boolean {
    const read = this.policy.evaluate(p, 'read.party_private', loaded.resource, loaded.rows);
    return read.effect === 'allow' && OWNER_SIDE_LAYERS.has(read.projection);
  }

  /** Allowed with a buyer-private projection; otherwise not found (no owner-side read) or forbidden (read but not this). */
  private ownerSide(p: Principal, loaded: Loaded | null, capability: Capability): Loaded {
    if (!loaded || !this.isOwnerSide(p, loaded)) throw new ApiError('access.not_found');
    if (capability === 'read.party_private') return loaded;
    const decision = this.policy.evaluate(p, capability, loaded.resource, loaded.rows);
    if (decision.effect !== 'allow') this.policy.require(decision);
    if (decision.effect === 'allow' && !OWNER_SIDE_LAYERS.has(decision.projection)) throw new ApiError('access.forbidden', 'RFQs need buyer-side authority');
    return loaded;
  }

  private async ownerView(trx: Transaction, rfq: RfqRow): Promise<OwnerRfqView> {
    const [versions, privateRow, invitations] = await Promise.all([rfqVersions.listFor(trx, rfq.id), rfqPrivate.get(trx, rfq.id), rfqInvitations.listForRfq(trx, rfq.id)]);
    if (!privateRow) throw new Error(`rfq ${rfq.id} has no private constraint`);
    const byId = new Map(versions.map((v) => [v.id, v]));
    return OwnerRfqViewSchema.parse({
      projection: 'owner_private', rfq: rfqContract(rfq), versions: versions.map(versionContract), privateConstraint: privateContract(privateRow),
      invitations: orderInvitations(invitations.map((i) => invitationContract(i, byId))),
      origin: { needId: rfq.need_id, planItem: rfq.plan_project_id && rfq.plan_item_key ? { projectId: rfq.plan_project_id, itemKey: rfq.plan_item_key } : null },
    });
  }

  /** shared_party for an invitee: the versions its own invitations pin and its own invitations; nothing else. */
  private async supplierView(trx: Transaction, p: Principal, rfq: RfqRow): Promise<SupplierRfqView | null> {
    const parties = this.parties(p);
    const own = (await rfqInvitations.listForRfq(trx, rfq.id)).filter((i) => i.party_person_id === parties.personId || (parties.companyId !== null && i.party_company_id === parties.companyId));
    if (own.length === 0) return null;
    const pinned = new Set(own.map((i) => i.rfq_version_id));
    const versions = (await rfqVersions.listFor(trx, rfq.id)).filter((v) => v.status !== 'draft' && pinned.has(v.id));
    const byId = new Map(versions.map((v) => [v.id, v]));
    return SupplierRfqViewSchema.parse({
      projection: 'shared_party',
      rfq: { id: rfq.id, buyer: partyOf(rfq), status: rfq.status, category: rfq.category },
      versions: versions.map((v) => toSharedRfqVersion(versionContract(v))).filter((v) => v !== null),
      invitations: orderInvitations(own.map((i) => toSupplierInvitation(invitationContract(i, byId)))),
    });
  }

  private async checkRevision(trx: Transaction, row: RfqRow, expectedRevision: number): Promise<RfqRow> {
    if (row.revision !== expectedRevision) throw new ApiError('validation.revision_conflict');
    const bumped = await rfqs.bump(trx, row.id, expectedRevision);
    if (!bumped) throw new ApiError('validation.revision_conflict');
    return bumped;
  }

  /* ---------- RFQs ---------- */

  async createRfq(input: In<typeof CreateRfqCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, input.owner)) throw new ApiError('access.forbidden', 'RFQs belong to a party you act for', { reason: 'not_authorised' });
      const actor = await this.actor(p, input.actor, 'prepare', input.projectId ? { kind: 'project', id: input.projectId } : input.owner.kind === 'company' ? { kind: 'company', id: input.owner.id } : { kind: 'profile', id: input.owner.id });
      if (input.projectId !== null && !UUID.test(input.projectId)) throw new ApiError('validation.schema', 'unknown project', { reason: 'unknown_reference' });
      const source = input.source;
      let planState: Awaited<ReturnType<typeof commercePlanLinks.baselineItem>>;
      if (source) {
        // ADR 012 decision 37: a consumer's or small owner's goods become RFQs; inside a company every purchase starts as a requisition.
        if (input.owner.kind !== 'person') throw new ApiError('validation.schema', 'a company buys plan items through requisitions', { reason: 'requisition_required' });
        if (!UUID.test(source.projectId) || (input.projectId !== null && input.projectId !== source.projectId)) throw new ApiError('validation.schema', 'the RFQ belongs to the plan item project', { reason: 'project_mismatch' });
        planState = await commercePlanLinks.baselineItem(trx, source.projectId, source.itemKey);
        if (!planState) throw new ApiError('validation.schema', 'the item is not in the approved plan', { reason: 'item_not_in_baseline' });
        if (!(PLAN_ITEM_RFQ_KINDS as readonly string[]).includes(planState.kind)) throw new ApiError('validation.schema', 'works become tasks, goods become RFQs', { reason: 'plan_item_kind' });
        if (planState.path !== null) throw new ApiError('validation.revision_conflict', 'the item already took a path', { reason: 'item_path_taken' });
        if (planState.status !== null && planState.status !== 'proposed' && planState.status !== 'accepted') throw new ApiError('validation.schema', 'the item is no longer open', { reason: 'invalid_item_transition' });
      }
      if (input.publicProjection.enabled && input.owner.kind === 'company' && !p.membership?.permissions.includes('company.publish')) {
        throw new ApiError('membership.permission_missing', 'a public projection needs company.publish');
      }
      const rfq = await rfqs.insert(trx, {
        ...ownerColumns(input.owner), project_id: source ? source.projectId : input.projectId, creator_person_id: p.personId, need_id: null,
        plan_project_id: source?.projectId ?? null, plan_item_key: source?.itemKey ?? null,
        public_projection_enabled: input.publicProjection.enabled, public_projection_fields: [...input.publicProjection.fields], category: input.category,
      });
      const draft = await rfqVersions.insertDraft(trx, { rfq_id: rfq.id, version: 1, payload: input.payload, drafted_by_person_id: p.personId, amendment_reason: null });
      await rfqPrivate.insert(trx, { rfq_id: rfq.id, ...ownerColumns(input.owner), ...privateColumns(input.privateConstraint ?? EMPTY_PRIVATE_CONSTRAINT), updated_by_person_id: p.personId });
      if (source && planState) await this.linkPlanItem(trx, p, planState.planId, source.projectId, source.itemKey, rfq.id);
      await this.audit(trx, p, state, 'rfq.created', 'rfq', rfq.id, { versionId: draft.id, planItem: source ? { projectId: source.projectId, itemKey: source.itemKey } : null, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'rfq', rfq.id, rfq.revision, 'rfq.created', { rfqId: rfq.id, versionId: draft.id, version: 1, via: actor.via });
      return this.ownerView(trx, rfq);
    });
  }

  /** The plan item records the path `rfq` with this RFQ (the plans guard refuses a second path). */
  private async linkPlanItem(trx: Transaction, p: Principal, planId: string, projectId: string, itemKey: string, rfqId: string): Promise<void> {
    const current = await planItemStates.get(trx, planId, itemKey);
    if (!current) {
      await planItemStates.insert(trx, {
        plan_id: planId, project_id: projectId, item_key: itemKey, status: 'accepted', path: 'rfq', link_kind: 'rfq', link_id: rfqId, blocked_from: null,
        actual_start: null, actual_end: null, updated_by_person_id: p.personId,
      });
      return;
    }
    const saved = await planItemStates.update(trx, planId, itemKey, current.revision, {
      status: 'accepted', path: 'rfq', link_kind: 'rfq', link_id: rfqId, blocked_from: null, updated_by_person_id: p.personId,
      actual_start: current.actual_start === null ? null : isoDate(current.actual_start), actual_end: current.actual_end === null ? null : isoDate(current.actual_end),
    });
    if (!saved) throw new ApiError('validation.revision_conflict');
  }

  /** Owner side: the owner view; an invitee: the supplier view; everyone else (anonymous included): not found. */
  async getRfq(rfqId: string, state: RequestState): Promise<OwnerRfqView | SupplierRfqView> {
    if (!state.principal || !UUID.test(rfqId)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const loaded = await this.load(trx, rfqId);
      if (!loaded) throw new ApiError('access.not_found');
      if (this.isOwnerSide(p, loaded)) return this.ownerView(trx, loaded.row);
      const view = await this.supplierView(trx, p, loaded.row);
      if (!view) throw new ApiError('access.not_found');
      return view;
    });
  }

  async listRfqs(state: RequestState): Promise<z.infer<typeof RfqListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await rfqs.listOwned(trx, this.parties(p));
      const items = [];
      for (const row of rows) {
        const [versions, invitations] = await Promise.all([rfqVersions.listFor(trx, row.id), rfqInvitations.listForRfq(trx, row.id)]);
        const draft = versions.find((v) => v.status === 'draft');
        const current = versions.find((v) => v.id === row.current_version_id);
        items.push({
          id: row.id, owner: partyOf(row), status: row.status, title: titleOf(current ?? draft) || titleOf(versions.at(-1)), currentVersion: row.current_version, draftVersion: draft?.version ?? null,
          category: row.category, invitations: invitations.length, staleInvitations: invitations.filter((i) => i.stale_reason !== null).length, revision: row.revision, updatedAt: iso(row.updated_at),
        });
      }
      return RfqListSchema.parse({ rfqs: items });
    });
  }

  /** Invitations addressed to the principal or to the employer it acts for, newest first (payment-blind order). */
  async listInvitations(state: RequestState): Promise<z.infer<typeof SupplierInvitationListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await rfqInvitations.listForParty(trx, this.parties(p));
      const items = [];
      for (const row of rows) {
        const rfq = await rfqs.get(trx, row.rfq_id);
        const pinned = await rfqVersions.get(trx, row.rfq_version_id);
        if (!rfq || !pinned) continue;
        const payload = pinned.payload as { title: string; responseDeadline: string };
        items.push({ invitation: toSupplierInvitation(invitationContract(row, new Map([[pinned.id, pinned]]))), rfq: { id: rfq.id, buyer: partyOf(rfq), status: rfq.status }, title: payload.title, responseDeadline: payload.responseDeadline });
      }
      const order = orderInvitations(items.map((i) => ({ id: i.invitation.id, sentAt: i.invitation.sentAt }))).map((i) => i.id);
      items.sort((a, b) => order.indexOf(a.invitation.id) - order.indexOf(b.invitation.id));
      return SupplierInvitationListSchema.parse({ invitations: items });
    });
  }

  async saveDraft(rfqId: string, versionId: string, input: In<typeof SaveRfqDraftCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId, true), 'write.draft');
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'rfq', id: rfqId });
      const version = UUID.test(versionId) ? await rfqVersions.get(trx, versionId) : undefined;
      if (!version || version.rfq_id !== rfqId) throw new ApiError('access.not_found');
      if (version.status !== 'draft') throw new ApiError('commercial.version_immutable', 'a published version never changes; open an amendment', { reason: 'version_frozen' });
      const bumped = await this.checkRevision(trx, loaded.row, input.expectedRevision);
      if (!(await rfqVersions.saveDraft(trx, version.id, input.payload))) throw new ApiError('commercial.version_immutable', 'a published version never changes', { reason: 'version_frozen' });
      await this.audit(trx, p, state, 'rfq.draft_saved', 'rfq', rfqId, { versionId: version.id, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'rfq', rfqId, bumped.revision, 'rfq.draft_saved', { rfqId, versionId: version.id, version: version.version, via: actor.via });
      return this.ownerView(trx, bumped);
    });
  }

  async openAmendment(rfqId: string, input: In<typeof OpenRfqAmendmentCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId, true), 'write.draft');
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'rfq', id: rfqId });
      const rfq = loaded.row;
      if (rfq.status !== 'published' || rfq.current_version_id === null || rfq.current_version === null) throw new ApiError('validation.schema', 'only a published RFQ is amended', { reason: 'not_published' });
      if (await rfqVersions.inStatus(trx, rfqId, 'draft')) throw new ApiError('validation.revision_conflict', 'an amendment is already open', { reason: 'draft_exists' });
      const current = await rfqVersions.get(trx, rfq.current_version_id);
      if (!current) throw new ApiError('access.not_found');
      const bumped = await this.checkRevision(trx, rfq, input.expectedRevision);
      const draft = await rfqVersions.insertDraft(trx, { rfq_id: rfqId, version: rfq.current_version + 1, payload: current.payload, drafted_by_person_id: p.personId, amendment_reason: input.amendmentReason });
      await this.audit(trx, p, state, 'rfq.amendment_opened', 'rfq', rfqId, { versionId: draft.id, version: draft.version, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'rfq', rfqId, bumped.revision, 'rfq.amendment_opened', { rfqId, versionId: draft.id, version: draft.version, via: actor.via });
      return this.ownerView(trx, bumped);
    });
  }

  async setPrivateConstraint(rfqId: string, input: In<typeof SaveRfqPrivateConstraintCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId), 'write.draft');
      const { expectedRevision, ...fields } = input;
      const saved = await rfqPrivate.update(trx, rfqId, expectedRevision, { ...privateColumns(fields), updated_by_person_id: p.personId });
      if (!saved) throw new ApiError('validation.revision_conflict');
      // Audit names the change only; the private values never enter audit, outbox or logs.
      await this.audit(trx, p, state, 'rfq.private_constraint_saved', 'rfq', rfqId, { revision: saved.revision });
      return this.ownerView(trx, loaded.row);
    });
  }

  /**
   * Publishes the draft as the current version: the previous version is superseded, the digest is computed from the
   * stored payload, the envelope pointer moves forward and the database flags invitations pinned to earlier versions
   * stale, all in one transaction under the envelope lock.
   */
  async publish(rfqId: string, input: In<typeof PublishRfqCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    if (input.rfqId !== rfqId) throw new ApiError('validation.schema', 'the command names another RFQ', { reason: 'rfq_mismatch' });
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId, true), 'publish');
      const actor = await this.actor(p, input.actor, 'publish', { kind: 'rfq', id: rfqId });
      const rfq = loaded.row;
      if (rfq.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (rfq.status !== 'draft' && rfq.status !== 'published') throw new ApiError('commercial.version_immutable', `a ${rfq.status} RFQ is not published again`, { reason: 'closed' });
      const draft = await rfqVersions.inStatus(trx, rfqId, 'draft');
      if (!draft || draft.version !== input.version) throw new ApiError('commercial.version_immutable', 'only the open draft is published', { reason: 'version_frozen' });
      if (draft.version > 1 && input.amendmentReason === null) throw new ApiError('validation.schema', 'an amendment states its reason', { reason: 'amendment_reason_required' });
      if (draft.version === 1 && input.amendmentReason !== null) throw new ApiError('validation.schema', 'the first version is not an amendment', { reason: 'amendment_reason_not_allowed' });
      const payload = RfqPayloadWithKnownUnitsSchema.parse(draft.payload);
      const at = this.now();
      const previous = rfq.current_version_id ? await rfqVersions.get(trx, rfq.current_version_id) : undefined;
      if (previous) await rfqVersions.supersede(trx, previous.id, draft.version, at);
      const published = await rfqVersions.publish(trx, draft.id, { digest: computeRfqVersionDigest(payload).value, personId: p.personId, via: actor.via, mandateId: actor.mandateId, amendmentReason: input.amendmentReason, at });
      if (!published) throw new ApiError('validation.revision_conflict');
      const current = await rfqs.setCurrent(trx, rfqId, { current_version: published.version, current_version_id: published.id });
      const staleCount = previous ? (await rfqInvitations.listForRfq(trx, rfqId)).filter((i) => i.rfq_version_id !== published.id && i.stale_reason === 'rfq_amended').length : 0;
      if (current.plan_project_id && current.plan_item_key) await this.markPlanItemRequested(trx, p, current);
      await this.audit(trx, p, state, 'rfq.version_published', 'rfq', rfqId, {
        versionId: published.id, version: published.version, digest: published.digest, superseded: previous?.id ?? null, staleCount, via: actor.via, mandateId: actor.mandateId,
      });
      await this.event(trx, 'rfq', rfqId, current.revision, 'rfq.version_published', { rfqId, versionId: published.id, version: published.version, staleCount, via: actor.via });
      return this.ownerView(trx, current);
    });
  }

  /** The linked plan item moves from accepted to requested when its RFQ is first published (if it is still in the baseline). */
  private async markPlanItemRequested(trx: Transaction, p: Principal, rfq: RfqRow): Promise<void> {
    const item = await commercePlanLinks.baselineItem(trx, rfq.plan_project_id as string, rfq.plan_item_key as string);
    if (!item || item.status !== 'accepted' || item.linkId !== rfq.id || item.stateRevision === null) return;
    const current = await planItemStates.get(trx, item.planId, rfq.plan_item_key as string);
    if (!current) return;
    await planItemStates.update(trx, item.planId, rfq.plan_item_key as string, current.revision, {
      status: 'requested', path: 'rfq', link_kind: 'rfq', link_id: rfq.id, blocked_from: null, updated_by_person_id: p.personId,
      actual_start: current.actual_start === null ? null : isoDate(current.actual_start), actual_end: current.actual_end === null ? null : isoDate(current.actual_end),
    });
  }

  private async sendInvitation(trx: Transaction, p: Principal, state: RequestState, rfq: RfqRow, input: { rfqVersionId: string; party: Party; channel: RfqInvitation['channel'] }, actor: ResolvedActor, revalidates: string | null): Promise<RfqInvitation> {
    if (rfq.status !== 'published' || rfq.current_version_id === null) throw new ApiError('commercial.rfq_version_not_current', 'invitations pin a published version', { reason: 'not_published' });
    if (input.rfqVersionId !== rfq.current_version_id) throw new ApiError('commercial.rfq_version_not_current', 'invitations pin the current published version', { reason: 'rfq_version_not_current', currentRfqVersionId: rfq.current_version_id });
    if (isSelfInvitation(partyOf(rfq), input.party)) throw new ApiError('validation.schema', 'the buyer does not invite itself', { reason: 'self_invitation' });
    if (!UUID.test(input.party.id)) throw new ApiError('validation.schema', 'unknown party', { reason: 'unknown_reference' });
    const row = await rfqInvitations.insert(trx, {
      rfq_id: rfq.id, rfq_version_id: input.rfqVersionId, party_person_id: input.party.kind === 'person' ? input.party.id : null, party_company_id: input.party.kind === 'company' ? input.party.id : null,
      channel: input.channel, sent_by_person_id: p.personId, sent_via: actor.via, sent_by_mandate_id: actor.mandateId, revalidates_invitation_id: revalidates,
    });
    const pinned = await rfqVersions.get(trx, row.rfq_version_id);
    if (!pinned) throw new ApiError('access.not_found');
    await this.audit(trx, p, state, revalidates ? 'rfq.invitation_revalidated' : 'rfq.invitation_sent', 'rfq', rfq.id, { invitationId: row.id, versionId: row.rfq_version_id, party: input.party, channel: input.channel, revalidates, via: actor.via, mandateId: actor.mandateId });
    // Identifiers only: the notification consumer reads the supplier view under the invitee's own authority.
    await this.event(trx, 'rfq', rfq.id, rfq.revision, revalidates ? 'rfq.invitation_revalidated' : 'rfq.invitation_sent', {
      rfqId: rfq.id, invitationId: row.id, versionId: row.rfq_version_id, inviteeKind: input.party.kind, inviteeId: input.party.id, previousInvitationId: revalidates, via: actor.via,
    });
    return invitationContract(row, new Map([[pinned.id, pinned]]));
  }

  async invite(rfqId: string, input: In<typeof InviteSupplierRequestSchema>, state: RequestState): Promise<RfqInvitation> {
    if (input.rfqId !== rfqId) throw new ApiError('validation.schema', 'the command names another RFQ', { reason: 'rfq_mismatch' });
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId), 'invite');
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'rfq', id: rfqId });
      return this.sendInvitation(trx, p, state, loaded.row, input, actor, null);
    });
  }

  /** Revalidation is a new invitation for the same party pinned to the current version; the stale one stays as history. */
  async revalidate(rfqId: string, invitationId: string, input: In<typeof RevalidateInvitationCommandSchema>, state: RequestState): Promise<RfqInvitation> {
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId), 'invite');
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'rfq', id: rfqId });
      const previous = UUID.test(invitationId) ? await rfqInvitations.get(trx, invitationId) : undefined;
      if (!previous || previous.rfq_id !== rfqId) throw new ApiError('access.not_found');
      if (previous.stale_reason !== 'rfq_amended') throw new ApiError('validation.schema', 'only an invitation flagged by an amendment is revalidated', { reason: 'not_stale' });
      if (previous.status === 'withdrawn' || previous.status === 'declined') throw new ApiError('validation.schema', `a ${previous.status} invitation is not revalidated`, { reason: 'invalid_transition' });
      const party: Party = previous.party_person_id ? { kind: 'person', id: previous.party_person_id } : { kind: 'company', id: previous.party_company_id as string };
      return this.sendInvitation(trx, p, state, loaded.row, { rfqVersionId: loaded.row.current_version_id as string, party, channel: previous.channel }, actor, previous.id);
    });
  }

  async withdraw(rfqId: string, invitationId: string, input: In<typeof WithdrawInvitationCommandSchema>, state: RequestState): Promise<RfqInvitation> {
    return this.run(state, async (trx, p) => {
      this.ownerSide(p, await this.load(trx, rfqId), 'invite');
      const row = UUID.test(invitationId) ? await rfqInvitations.lock(trx, invitationId) : undefined;
      if (!row || row.rfq_id !== rfqId) throw new ApiError('access.not_found');
      if (!INVITATION_TRANSITIONS[row.status].includes('withdrawn')) throw new ApiError('validation.schema', `a ${row.status} invitation is not withdrawn`, { reason: 'invalid_transition' });
      const saved = await rfqInvitations.setStatus(trx, row.id, row.status, { status: 'withdrawn', withdrawn_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'rfq.invitation_withdrawn', 'rfq', rfqId, { invitationId: row.id, reason: input.reason });
      await this.event(trx, 'rfq', rfqId, saved.revision, 'rfq.invitation_withdrawn', { rfqId, invitationId: row.id, status: 'withdrawn' });
      const pinned = await rfqVersions.get(trx, saved.rfq_version_id);
      return invitationContract(saved, new Map(pinned ? [[pinned.id, pinned]] : []));
    });
  }

  /** The invitee records that it viewed or declined; a stale invitation is answered only after revalidation. */
  async respond(invitationId: string, input: In<typeof RespondToInvitationCommandSchema>, state: RequestState): Promise<SupplierInvitation> {
    return this.run(state, async (trx, p) => {
      const row = UUID.test(invitationId) ? await rfqInvitations.lock(trx, invitationId) : undefined;
      const parties = this.parties(p);
      if (!row || !(row.party_person_id === parties.personId || (parties.companyId !== null && row.party_company_id === parties.companyId))) throw new ApiError('access.not_found');
      if (row.stale_reason !== null) throw new ApiError('commercial.rfq_version_not_current', 'the RFQ changed; wait for a revalidated invitation', { reason: row.stale_reason });
      if (row.status !== input.status && !INVITATION_TRANSITIONS[row.status].includes(input.status)) throw new ApiError('validation.schema', `invitation ${row.status} -> ${input.status} is not allowed`, { reason: 'invalid_transition' });
      const saved = row.status === input.status ? row : await rfqInvitations.setStatus(trx, row.id, row.status, { status: input.status, withdrawn_reason: null });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, `rfq.invitation_${input.status}`, 'rfq', row.rfq_id, { invitationId: row.id });
      await this.event(trx, 'rfq', row.rfq_id, saved.revision, `rfq.invitation_${input.status}`, { rfqId: row.rfq_id, invitationId: row.id, status: input.status });
      const pinned = await rfqVersions.get(trx, saved.rfq_version_id);
      return toSupplierInvitation(invitationContract(saved, new Map(pinned ? [[pinned.id, pinned]] : [])));
    });
  }

  async close(rfqId: string, input: In<typeof CloseRfqCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId, true), 'publish');
      const rfq = loaded.row;
      if (rfq.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const allowed = input.outcome === 'cancelled' ? rfq.status === 'draft' || rfq.status === 'published' : rfq.status === 'published';
      if (!allowed) throw new ApiError('validation.schema', `a ${rfq.status} RFQ cannot become ${input.outcome}`, { reason: 'invalid_transition' });
      const closed = await rfqs.close(trx, rfqId, input.expectedRevision, { status: input.outcome, personId: p.personId, reason: input.reason, at: this.now() });
      if (!closed) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, `rfq.${input.outcome}`, 'rfq', rfqId, { reason: input.reason });
      await this.event(trx, 'rfq', rfqId, closed.revision, `rfq.${input.outcome}`, { rfqId, status: input.outcome });
      return this.ownerView(trx, closed);
    });
  }

  async setProjection(rfqId: string, input: In<typeof SetRfqProjectionCommandSchema>, state: RequestState): Promise<OwnerRfqView> {
    return this.run(state, async (trx, p) => {
      const loaded = this.ownerSide(p, await this.load(trx, rfqId, true), 'publish');
      if (loaded.row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const saved = await rfqs.setProjection(trx, rfqId, input.expectedRevision, { enabled: input.publicProjection.enabled, fields: [...input.publicProjection.fields], category: input.category });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'rfq.projection_set', 'rfq', rfqId, { enabled: input.publicProjection.enabled, fields: input.publicProjection.fields });
      await this.event(trx, 'rfq', rfqId, saved.revision, 'rfq.projection_set', { rfqId, status: input.publicProjection.enabled ? 'public' : 'private' });
      return this.ownerView(trx, saved);
    });
  }

  /** Public projection (anonymous callers included): allowlisted fields of the current published version, or not found. */
  async publicRfq(rfqId: string, state: RequestState): Promise<PublicRfq> {
    if (!UUID.test(rfqId)) throw new ApiError('access.not_found');
    const read = async (trx: Transaction) => {
      const row = await rfqPublic.read(trx, rfqId);
      if (!row) throw new ApiError('access.not_found');
      const payload = RfqPayloadWithKnownUnitsSchema.parse(row.payload);
      const all: Record<string, unknown> = {
        title: payload.title, category: row.category, region: payload.deliveryTerms.location.region, publishedAt: iso(row.published_at), openUntil: payload.responseDeadline,
        lineSummary: payload.lines.map((l) => ({ kind: l.kind, quantity: l.quantity })),
      };
      const picked: Record<string, unknown> = { id: row.id };
      for (const key of row.public_projection_fields) if (key in all) picked[key] = all[key];
      return PublicRfqSchema.parse(picked);
    };
    return this.read(state, (trx) => read(trx), read);
  }
}
