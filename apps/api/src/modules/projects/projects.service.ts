import {
  OwnershipTransferSchema, ProjectSchema, toParticipantProject, toPublicProject,
  type Capability, type GrantAudience, type ObjectParticipation, type OwnershipTransfer, type ParticipantProject, type Party, type Principal, type Project, type PublicProject, type PublicProjectOwner, type ResourceRef,
} from '../../deps/contracts.js';
import { admission, admissionScopes, auditEvents, auth, leadershipAssignments, outbox, ownershipTransfers, participations, projects, type Transaction } from '../../deps/data.js';
import type * as db from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import { directory } from '../directory/deps.js';
import { toPublicOwner } from '../directory/directory.service.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import { LEADER_CAPABILITIES, OWNER_CAPABILITIES, type PolicyResource } from '../identity/policy/policy.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { iso, toParticipation } from '../identity/serializers.js';

export type ProjectView = { projection: 'owner_private'; project: Project } | { projection: 'shared_party' | 'party_private'; project: ParticipantProject } | { projection: 'public'; project: PublicProject };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSFER_TTL_MS = 14 * 86_400_000;

function ownerOf(row: db.Project): Party {
  return row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id as string };
}
function resourceOf(row: db.Project): PolicyResource {
  return { kind: 'project', id: row.id, ownerParty: ownerOf(row), lifecycle: row.status, publishedProjection: row.publicity_enabled };
}
/** owner_private record from the row plus the participant list (DATA-001 slice: no milestones/files/budgets tables yet). */
function toProject(row: db.Project, rows: readonly ObjectParticipation[]): Project {
  return ProjectSchema.parse({
    id: row.id, owner: ownerOf(row), creatorPersonId: row.creator_person_id, leaderPersonId: row.leader_person_id,
    name: row.name, summary: row.summary, status: row.status,
    publicity: { enabled: row.publicity_enabled, publishedStory: row.published_story, openNeedIds: [], publicParticipantIds: [] },
    milestones: [], sharedFiles: [], baselinePlanId: null, budgets: [],
    participantIds: rows.filter((p) => p.revokedAt === null && p.side !== 'owner' && p.side !== 'staff').map((p) => p.party.id),
    privateFiles: [], privateNotes: row.private_notes, revision: row.revision, createdAt: iso(row.created_at),
  });
}
function toTransfer(row: db.OwnershipTransfer): OwnershipTransfer {
  return OwnershipTransferSchema.parse({
    id: row.id, projectId: row.project_id,
    from: row.from_person_id ? { kind: 'person', id: row.from_person_id } : { kind: 'company', id: row.from_company_id as string },
    to: row.to_person_id ? { kind: 'person', id: row.to_person_id } : { kind: 'company', id: row.to_company_id as string },
    status: row.status, proposedBy: row.proposed_by, proposedAt: iso(row.proposed_at),
    recipientConsentAt: row.recipient_consent_at ? iso(row.recipient_consent_at) : null, effectiveAt: row.effective_at ? iso(row.effective_at) : null, expiresAt: iso(row.expires_at),
  });
}

/**
 * Projects: owner person XOR company, creator and leader distinct roles, owner participation row materialised in the
 * same transaction, transfer with recipient consent through the owner-run finalizer, leadership assignment, scoped
 * participants within `canGrant`, and projections by policy layer (public never carries private fields).
 */
export class ProjectsService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly policy: ParticipationService) {}

  private async load(trx: Transaction, id: string): Promise<{ row: db.Project; rows: ObjectParticipation[]; resource: PolicyResource }> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = await projects.getById(trx, id);
    if (!row) throw new ApiError('access.not_found');
    const rows = await this.policy.rowsFor(trx, { kind: 'project', id });
    return { row, rows, resource: resourceOf(row) };
  }

  private authorize(principal: Principal, action: Capability, resource: PolicyResource, rows: readonly ObjectParticipation[]) {
    const decision = this.policy.evaluate(principal, action, resource, rows);
    this.policy.require(decision);
    return decision;
  }

  async create(input: { owner: Party; name: string; summary: string | null; leaderPersonId: string | null }, state: RequestState): Promise<Project> {
    const principal = state.principal as Principal;
    if (input.owner.kind === 'person' && input.owner.id !== principal.personId) throw new ApiError('access.forbidden', 'a personal project is owned by its creator', { reason: 'owner_mismatch' });
    if (input.owner.kind === 'company') {
      if (!principal.membership || principal.membership.companyId !== input.owner.id) throw new ApiError('access.forbidden', 'company projects are created by members of the owner company', { reason: 'owner_mismatch' });
      if (!principal.membership.permissions.includes('company.deals.manage')) throw new ApiError('membership.permission_missing');
    }
    return this.principals.runAs(state, async (trx, p) => {
      const row = await projects.insert(trx, {
        owner_person_id: input.owner.kind === 'person' ? input.owner.id : null, owner_company_id: input.owner.kind === 'company' ? input.owner.id : null,
        creator_person_id: p.personId, leader_person_id: input.leaderPersonId, name: input.name, summary: input.summary,
      });
      await participations.grant(trx, {
        resource_kind: 'project', resource_id: row.id, party_person_id: input.owner.kind === 'person' ? input.owner.id : null, party_company_id: input.owner.kind === 'company' ? input.owner.id : null,
        side: 'owner', capabilities: [...OWNER_CAPABILITIES], audience: 'owner_private', granted_by_person_id: p.personId,
      });
      if (input.leaderPersonId) await this.materialiseLeader(trx, p, row, input.leaderPersonId, input.owner);
      await auditEvents.append(trx, { actor_person_id: p.personId, on_behalf_of_company_id: input.owner.kind === 'company' ? input.owner.id : null, action: 'project.created', object_kind: 'project', object_id: row.id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { owner: input.owner, leaderPersonId: input.leaderPersonId } });
      await outbox.append(trx, { aggregate_kind: 'project', aggregate_id: row.id, revision: row.revision, type: 'project.created', payload: { owner: input.owner } });
      const rows = await this.policy.rowsFor(trx, { kind: 'project', id: row.id });
      return toProject(row, rows);
    });
  }

  private async materialiseLeader(trx: Transaction, principal: Principal, row: db.Project, leaderPersonId: string, owner: Party): Promise<void> {
    await leadershipAssignments.assign(trx, row.id, leaderPersonId, principal.personId, this.ctx.clock.now());
    if (owner.kind === 'person' && owner.id === leaderPersonId) return;
    const existing = (await participations.liveForResource(trx, 'project', row.id, this.ctx.clock.now())).find((r) => r.party_person_id === leaderPersonId && r.side !== 'owner');
    if (existing) return;
    await participations.grant(trx, {
      resource_kind: 'project', resource_id: row.id, party_person_id: leaderPersonId, party_company_id: null, side: 'participant', capabilities: [...LEADER_CAPABILITIES], audience: 'shared_party',
      granted_by_person_id: principal.personId, on_behalf_of_company_id: owner.kind === 'company' ? owner.id : null,
    });
  }

  /** The public owner of a published project (QA-002 D2) through the owner-run directory lookup, or null. */
  private async publicOwner(id: string): Promise<PublicProjectOwner | null> {
    const [row] = await withoutPrincipal(this.ctx.pool, (trx) => directory.publicProjectOwners(trx, [id]));
    return row ? toPublicOwner(row) : null;
  }

  /** Projection by the highest readable layer; anonymous callers get the public projection through the owner-run lookup. */
  async get(id: string, state: RequestState): Promise<ProjectView> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    if (!state.principal) {
      const pub = await auth.publicProjectRead(this.ctx.pool, id);
      if (!pub) throw new ApiError('access.not_found');
      const project = toPublicProject(ProjectSchema.parse({
        id: pub.id, owner: { kind: 'person', id: pub.id }, creatorPersonId: pub.id, leaderPersonId: null, name: pub.name, summary: pub.summary, status: pub.status,
        publicity: { enabled: true, publishedStory: pub.published_story, openNeedIds: [], publicParticipantIds: [] }, milestones: [], sharedFiles: [], baselinePlanId: null, budgets: [], participantIds: [], privateFiles: [], privateNotes: null, revision: pub.revision, createdAt: new Date(0).toISOString(),
      }), await this.publicOwner(pub.id));
      if (!project) throw new ApiError('access.not_found');
      return { projection: 'public', project };
    }
    return this.principals.runAs(state, async (trx, principal) => {
      const { row, rows, resource } = await this.load(trx, id);
      const readable = this.policy.readable(principal, resource, rows, row.revision);
      if (!readable) throw new ApiError('access.not_found');
      const full = toProject(row, rows);
      if (readable.projection === 'owner_private' || readable.projection === 'staff_case') return { projection: 'owner_private', project: full };
      if (readable.projection === 'public') {
        const project = toPublicProject(full, await this.publicOwner(full.id));
        if (!project) throw new ApiError('access.not_found');
        return { projection: 'public', project };
      }
      return { projection: readable.projection, project: toParticipantProject(full) };
    });
  }

  async assignLeader(id: string, input: { leaderPersonId: string | null; expectedRevision: number }, state: RequestState): Promise<Project> {
    return this.principals.runAs(state, async (trx, p) => {
      const { row, rows, resource } = await this.load(trx, id);
      this.authorize(p, 'manage_participants', resource, rows);
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const updated = await projects.setLeader(trx, id, input.expectedRevision, input.leaderPersonId);
      if (!updated) throw new ApiError('validation.revision_conflict');
      for (const r of rows.filter((r) => r.revokedAt === null && r.side === 'participant' && r.party.kind === 'person' && r.capabilities.includes('lead') && r.party.id !== input.leaderPersonId)) {
        await participations.revoke(trx, r.id, r.revision, 'leadership reassigned', this.ctx.clock.now());
      }
      if (input.leaderPersonId) await this.materialiseLeader(trx, p, updated, input.leaderPersonId, ownerOf(updated));
      else await trx.updateTable('leadership_assignment').set({ ended_at: this.ctx.clock.now(), ended_by: p.personId }).where('project_id', '=', id).where('ended_at', 'is', null).execute();
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'project.leader_assigned', object_kind: 'project', object_id: id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { leaderPersonId: input.leaderPersonId } });
      await outbox.append(trx, { aggregate_kind: 'project', aggregate_id: id, revision: updated.revision, type: 'project.leader_assigned', payload: { leaderPersonId: input.leaderPersonId } });
      return toProject(updated, await this.policy.rowsFor(trx, { kind: 'project', id }));
    });
  }

  async publish(id: string, input: { publishedStory: string; openNeedIds: string[]; expectedRevision: number; reason?: string | undefined }, state: RequestState): Promise<Project> {
    if (input.openNeedIds.length > 0) throw new ApiError('validation.schema', 'open needs are not available before the procurement slice', { field: 'openNeedIds' });
    return this.principals.runAs(state, async (trx, p) => {
      const { row, rows, resource } = await this.load(trx, id);
      this.authorize(p, 'publish', resource, rows);
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const updated = await projects.update(trx, id, input.expectedRevision, { publicity_enabled: true, published_story: input.publishedStory });
      if (!updated) throw new ApiError('validation.revision_conflict');
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'project.published', object_kind: 'project', object_id: id, request_id: state.requestId, authz_epoch: p.authzEpoch, ...(input.reason ? { reason: input.reason } : {}) });
      await outbox.append(trx, { aggregate_kind: 'project', aggregate_id: id, revision: updated.revision, type: 'project.published', payload: {} });
      return toProject(updated, rows);
    });
  }

  async proposeTransfer(id: string, input: { to: Party; expectedRevision: number }, state: RequestState): Promise<OwnershipTransfer> {
    return this.principals.runAs(state, async (trx, p) => {
      const { row, rows, resource } = await this.load(trx, id);
      this.authorize(p, 'transfer_ownership', resource, rows);
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const from = ownerOf(row);
      if (from.kind === input.to.kind && from.id === input.to.id) throw new ApiError('validation.schema', 'recipient equals the current owner');
      const transfer = await ownershipTransfers.propose(trx, {
        project_id: id, from_person_id: from.kind === 'person' ? from.id : null, from_company_id: from.kind === 'company' ? from.id : null,
        to_person_id: input.to.kind === 'person' ? input.to.id : null, to_company_id: input.to.kind === 'company' ? input.to.id : null,
        proposed_by: p.personId, expires_at: new Date(this.ctx.clock.now().getTime() + TRANSFER_TTL_MS),
      });
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'project.transfer_proposed', object_kind: 'project', object_id: id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { transferId: transfer.id, to: input.to } });
      await outbox.append(trx, { aggregate_kind: 'project', aggregate_id: id, revision: row.revision, type: 'project.transfer_proposed', payload: { transferId: transfer.id } });
      return toTransfer(transfer);
    });
  }

  async listTransfers(id: string, state: RequestState): Promise<{ items: OwnershipTransfer[] }> {
    return this.principals.runAs(state, async (trx) => {
      if (!UUID.test(id)) throw new ApiError('access.not_found');
      return { items: (await ownershipTransfers.listForProject(trx, id)).map(toTransfer) };
    });
  }

  /** Recipient consent / rejection: the person, or an administrator of the recipient company. */
  async answerTransfer(id: string, transferId: string, answer: 'accepted_by_recipient' | 'rejected' | 'withdrawn', state: RequestState): Promise<OwnershipTransfer> {
    return this.principals.runAs(state, async (trx, p) => {
      if (!UUID.test(id) || !UUID.test(transferId)) throw new ApiError('access.not_found');
      const transfer = await ownershipTransfers.getById(trx, transferId);
      if (!transfer || transfer.project_id !== id) throw new ApiError('access.not_found');
      if (answer === 'withdrawn') {
        if (transfer.proposed_by !== p.personId) throw new ApiError('access.forbidden', 'only the proposer withdraws a transfer');
      } else {
        const recipient = transfer.to_person_id ? transfer.to_person_id === p.personId : (p.membership?.companyId === transfer.to_company_id && p.membership.role === 'administrator');
        if (!recipient) throw new ApiError('access.forbidden', 'only the recipient (or an administrator of the recipient company) answers a transfer');
      }
      const updated = await ownershipTransfers.transition(trx, transferId, transfer.revision, answer, this.ctx.clock.now());
      if (!updated) throw new ApiError('validation.revision_conflict');
      await auditEvents.append(trx, { actor_person_id: p.personId, action: `project.transfer_${answer}`, object_kind: 'project', object_id: id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { transferId } });
      return toTransfer(updated);
    });
  }

  /** Owner applies an accepted transfer; the owner row is re-materialised by the owner-run finalizer. */
  async applyTransfer(id: string, transferId: string, state: RequestState): Promise<Project> {
    return this.principals.runAs(state, async (trx, p) => {
      const { rows, resource } = await this.load(trx, id);
      this.authorize(p, 'transfer_ownership', resource, rows);
      if (!UUID.test(transferId)) throw new ApiError('access.not_found');
      const transfer = await ownershipTransfers.getById(trx, transferId);
      if (!transfer || transfer.project_id !== id) throw new ApiError('access.not_found');
      if (transfer.status === 'proposed') throw new ApiError('commercial.transfer_consent_pending');
      const updated = await projects.finalizeOwnershipTransfer(trx, transferId);
      await admission.revokeMany(trx, [admissionScopes.resource('project', id)], `ownership of project ${id} transferred`);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'project.transfer_effective', object_kind: 'project', object_id: id, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { transferId, owner: ownerOf(updated) } });
      await outbox.append(trx, { aggregate_kind: 'project', aggregate_id: id, revision: updated.revision, type: 'project.ownership_transferred', payload: { transferId, owner: ownerOf(updated) } });
      return toProject(updated, await this.policy.rowsFor(trx, { kind: 'project', id }));
    });
  }

  async listParticipants(id: string, state: RequestState): Promise<{ items: ObjectParticipation[] }> {
    return this.principals.runAs(state, async (trx, p) => {
      const { rows, resource } = await this.load(trx, id);
      this.authorize(p, 'read.owner_private', resource, rows);
      return { items: rows };
    });
  }

  async grantParticipant(id: string, input: { party: Party; side: 'buyer' | 'seller' | 'participant'; capabilities: Capability[]; audience: GrantAudience; validUntil: string | null }, state: RequestState): Promise<ObjectParticipation> {
    return this.principals.runAs(state, async (trx, p) => {
      const { row, rows, resource } = await this.load(trx, id);
      const onBehalfOfCompany = row.owner_company_id;
      return this.policy.grant(trx, p, resource, rows, { ...input, onBehalfOfCompany }, state.requestId);
    });
  }

  async revokeParticipant(id: string, participationId: string, input: { expectedRevision: number; reason: string }, state: RequestState): Promise<ObjectParticipation> {
    return this.principals.runAs(state, async (trx, p) => {
      const { rows, resource } = await this.load(trx, id);
      if (!UUID.test(participationId)) throw new ApiError('access.not_found');
      return this.policy.revoke(trx, p, resource, rows, participationId, input.expectedRevision, input.reason, state.requestId);
    });
  }

  /** Internal helper for tests and dev seed: participation rows of a project as seen by the principal. */
  rowsFor(trx: Transaction, resource: ResourceRef): Promise<ObjectParticipation[]> {
    return participations.listForResource(trx, resource.kind, resource.id).then((rows) => rows.map(toParticipation));
  }
}
