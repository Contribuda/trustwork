import type { z } from 'zod';
import { computeDigest, DIGEST_ALGORITHM, type Party, type Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { CommerceService, iso, ownerColumns, partyOf, UUID } from '../procurement/common.js';
import {
  bundleComponents, cataloguePublic, offeringDraftViolations, offeringPrivate, offerings, offeringVersionDigestInput, offeringVersions, orderPublicOfferings, OwnerOfferingViewSchema,
  PublicCatalogueSchema, PublicOfferingSchema,
  type ArchiveOfferingCommandSchema, type CreateOfferingCommandSchema, type OfferingDraftInput, type OfferingPrivateKnowledge, type OfferingRow, type OfferingVersionPrivateRow,
  type OfferingVersionRow, type OpenOfferingDraftCommandSchema, type OwnerOfferingView, type PublicOffering, type PublicOfferingRow, type PublishOfferingVersionCommandSchema,
  type SaveOfferingDraftCommandSchema, type SetOfferingPrivateKnowledgeCommandSchema,
} from '../procurement/deps.js';
import type { CommerceMandatePort } from '../procurement/mandates.js';

type In<T extends z.ZodType> = z.infer<T>;
const EMPTY_PRIVATE: OfferingPrivateKnowledge = { costBasis: null, marginTarget: null, notes: null };

function privateOf(row: OfferingVersionPrivateRow | undefined): OfferingPrivateKnowledge {
  if (!row) return EMPTY_PRIVATE;
  return {
    costBasis: row.cost_basis_minor !== null && row.cost_basis_currency !== null ? { minorUnits: String(row.cost_basis_minor), currency: row.cost_basis_currency } : null,
    marginTarget: row.margin_target, notes: row.notes,
  };
}
function privateColumns(p: OfferingPrivateKnowledge) {
  return { cost_basis_minor: p.costBasis?.minorUnits ?? null, cost_basis_currency: p.costBasis?.currency ?? null, margin_target: p.marginTarget, notes: p.notes };
}
function toPublic(row: PublicOfferingRow): PublicOffering {
  return PublicOfferingSchema.parse({
    offeringId: row.offering_id, version: row.version, fields: row.fields, owner: partyOf({ owner_person_id: row.owner_person_id, owner_company_id: row.owner_company_id }),
    kind: row.kind, publishedAt: iso(row.published_at), current: row.is_current,
  });
}

/**
 * The catalogue (COM-001): reusable, versioned offerings of a person or a company. The owner side is the owner person
 * or members of the owner company holding `company.catalogue.edit` (RLS repeats it). A published version is immutable:
 * every edit opens a new version, so a quote line that cited version N keeps citing exactly what N said. Private
 * commercial knowledge lives beside each version and never leaves the owner side; the public sees only the allowlisted
 * fields of published versions of active offerings, through `trustwork.catalogue_public_offerings`.
 */
export class CatalogueService extends CommerceService {
  constructor(ctx: AppContext, principals: PrincipalService, mandates: CommerceMandatePort) {
    super(ctx, principals, mandates);
  }

  private actsFor(principal: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes('company.catalogue.edit');
  }

  private async owned(trx: Transaction, offeringId: string, lock = false): Promise<OfferingRow> {
    if (!UUID.test(offeringId)) throw new ApiError('access.not_found');
    const row = lock ? await offerings.lock(trx, offeringId) : await offerings.get(trx, offeringId);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  private async versionOf(trx: Transaction, offering: OfferingRow, versionId: string): Promise<OfferingVersionRow> {
    if (!UUID.test(versionId)) throw new ApiError('access.not_found');
    const version = await offeringVersions.get(trx, versionId);
    if (!version || version.offering_id !== offering.id) throw new ApiError('access.not_found');
    return version;
  }

  private checkDraft(kind: OfferingRow['kind'], draft: Pick<OfferingDraftInput, 'payload'>): void {
    const violations = offeringDraftViolations(kind, draft);
    if (violations.length > 0) throw new ApiError('validation.schema', violations[0] as string, { reason: 'invalid_draft', violations });
  }

  private async bump(trx: Transaction, offering: OfferingRow, expectedRevision: number): Promise<OfferingRow> {
    if (offering.revision !== expectedRevision) throw new ApiError('validation.revision_conflict');
    const bumped = await offerings.bump(trx, offering.id, expectedRevision);
    if (!bumped) throw new ApiError('validation.revision_conflict');
    return bumped;
  }

  private async ownerView(trx: Transaction, offering: OfferingRow): Promise<OwnerOfferingView> {
    const [versions, privates] = await Promise.all([offeringVersions.listFor(trx, offering.id), offeringPrivate.listFor(trx, offering.id)]);
    const byVersion = new Map(privates.map((p) => [p.offering_version_id, p]));
    return OwnerOfferingViewSchema.parse({
      projection: 'owner_private',
      offering: {
        id: offering.id, owner: partyOf(offering), kind: offering.kind, status: offering.status, currentVersion: offering.current_version, currentVersionId: offering.current_version_id,
        revision: offering.revision, createdAt: iso(offering.created_at), updatedAt: iso(offering.updated_at),
      },
      versions: versions.map((v) => ({
        id: v.id, offeringId: v.offering_id, version: v.version, status: v.status, payload: v.payload, publicFields: v.public_fields, privateKnowledge: privateOf(byVersion.get(v.id)),
        publishedAt: v.published_at ? iso(v.published_at) : null, digest: v.digest ? { algorithm: DIGEST_ALGORITHM, value: v.digest } : null,
      })),
    });
  }

  async create(input: In<typeof CreateOfferingCommandSchema>, state: RequestState): Promise<OwnerOfferingView> {
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, input.owner)) throw new ApiError('access.forbidden', 'the catalogue belongs to a party you do not act for', { reason: 'not_authorised' });
      this.checkDraft(input.kind, input.draft);
      const actor = await this.actor(p, input.actor, 'prepare', input.owner.kind === 'company' ? { kind: 'company', id: input.owner.id } : { kind: 'profile', id: input.owner.id });
      const offering = await offerings.insert(trx, { ...ownerColumns(input.owner), created_by_person_id: p.personId, kind: input.kind });
      const draft = await offeringVersions.insertDraft(trx, { offering_id: offering.id, version: 1, payload: input.draft.payload, public_fields: [...input.draft.publicFields], drafted_by_person_id: p.personId });
      await offeringPrivate.upsert(trx, { offering_version_id: draft.id, offering_id: offering.id, ...privateColumns(input.draft.privateKnowledge), updated_by_person_id: p.personId });
      await this.audit(trx, p, state, 'offering.created', 'offering', offering.id, { versionId: draft.id, kind: input.kind, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'offering', offering.id, offering.revision, 'offering.created', { offeringId: offering.id, versionId: draft.id, version: 1, via: actor.via });
      return this.ownerView(trx, offering);
    });
  }

  /** Owner side: the owner view. Everyone else (anonymous included): the public projection of an active offering, or not found. */
  async get(offeringId: string, version: number | null, state: RequestState): Promise<OwnerOfferingView | PublicOffering> {
    if (!UUID.test(offeringId)) throw new ApiError('access.not_found');
    const publicRead = async (trx: Transaction) => {
      const [row] = await cataloguePublic.list(trx, { offeringId, version });
      if (!row) throw new ApiError('access.not_found');
      return toPublic(row);
    };
    return this.read(state, async (trx) => {
      const owned = await offerings.get(trx, offeringId);
      return owned ? this.ownerView(trx, owned) : publicRead(trx);
    }, publicRead);
  }

  async publicCatalogue(owner: Party, state: RequestState): Promise<z.infer<typeof PublicCatalogueSchema>> {
    if (!UUID.test(owner.id)) throw new ApiError('access.not_found');
    const list = async (trx: Transaction) => {
      const rows = await cataloguePublic.list(trx, owner.kind === 'person' ? { ownerPersonId: owner.id } : { ownerCompanyId: owner.id });
      return PublicCatalogueSchema.parse({ owner, offerings: orderPublicOfferings(rows.map(toPublic)) });
    };
    return this.read(state, (trx) => list(trx), list);
  }

  async openDraft(offeringId: string, input: In<typeof OpenOfferingDraftCommandSchema>, state: RequestState): Promise<OwnerOfferingView> {
    return this.run(state, async (trx, p) => {
      const offering = await this.owned(trx, offeringId, true);
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'catalogue_offering', id: offering.id });
      if (offering.status === 'archived') throw new ApiError('validation.schema', 'an archived offering takes no new versions', { reason: 'archived' });
      if (await offeringVersions.inStatus(trx, offering.id, 'draft')) throw new ApiError('validation.revision_conflict', 'the offering already has an open draft', { reason: 'draft_exists' });
      const base = await offeringVersions.inStatus(trx, offering.id, 'published');
      if (!base) throw new ApiError('validation.revision_conflict', 'the first version is still a draft', { reason: 'draft_exists' });
      const bumped = await this.bump(trx, offering, input.expectedRevision);
      const versions = await offeringVersions.listFor(trx, offering.id);
      const next = Math.max(...versions.map((v) => v.version)) + 1;
      const draft = await offeringVersions.insertDraft(trx, { offering_id: offering.id, version: next, payload: base.payload, public_fields: base.public_fields, drafted_by_person_id: p.personId });
      const basePrivate = (await offeringPrivate.listFor(trx, offering.id)).find((r) => r.offering_version_id === base.id);
      await offeringPrivate.upsert(trx, { offering_version_id: draft.id, offering_id: offering.id, ...privateColumns(privateOf(basePrivate)), updated_by_person_id: p.personId });
      await this.audit(trx, p, state, 'offering.draft_opened', 'offering', offering.id, { versionId: draft.id, version: next, basedOn: base.id, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'offering', offering.id, bumped.revision, 'offering.draft_opened', { offeringId: offering.id, versionId: draft.id, version: next, via: actor.via });
      return this.ownerView(trx, bumped);
    });
  }

  async saveDraft(offeringId: string, versionId: string, input: In<typeof SaveOfferingDraftCommandSchema>, state: RequestState): Promise<OwnerOfferingView> {
    return this.run(state, async (trx, p) => {
      const offering = await this.owned(trx, offeringId, true);
      const version = await this.versionOf(trx, offering, versionId);
      const actor = await this.actor(p, input.actor, 'prepare', { kind: 'catalogue_offering', id: offering.id });
      if (version.status !== 'draft') throw new ApiError('commercial.version_immutable', 'a published version never changes; open a new version', { reason: 'version_frozen' });
      this.checkDraft(offering.kind, input.draft);
      const bumped = await this.bump(trx, offering, input.expectedRevision);
      const saved = await offeringVersions.saveDraft(trx, version.id, { payload: input.draft.payload, public_fields: [...input.draft.publicFields] });
      if (!saved) throw new ApiError('commercial.version_immutable', 'a published version never changes', { reason: 'version_frozen' });
      await offeringPrivate.upsert(trx, { offering_version_id: version.id, offering_id: offering.id, ...privateColumns(input.draft.privateKnowledge), updated_by_person_id: p.personId });
      await this.audit(trx, p, state, 'offering.draft_saved', 'offering', offering.id, { versionId: version.id, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'offering', offering.id, bumped.revision, 'offering.draft_saved', { offeringId: offering.id, versionId: version.id, via: actor.via });
      return this.ownerView(trx, bumped);
    });
  }

  /** Private knowledge stays editable after publication: it is owner data beside the frozen version, never part of it. */
  async setPrivateKnowledge(offeringId: string, versionId: string, input: In<typeof SetOfferingPrivateKnowledgeCommandSchema>, state: RequestState): Promise<OwnerOfferingView> {
    return this.run(state, async (trx, p) => {
      const offering = await this.owned(trx, offeringId, true);
      const version = await this.versionOf(trx, offering, versionId);
      const bumped = await this.bump(trx, offering, input.expectedRevision);
      await offeringPrivate.upsert(trx, { offering_version_id: version.id, offering_id: offering.id, ...privateColumns(input.privateKnowledge), updated_by_person_id: p.personId });
      await this.audit(trx, p, state, 'offering.private_knowledge_saved', 'offering', offering.id, { versionId: version.id });
      return this.ownerView(trx, bumped);
    });
  }

  async publish(offeringId: string, versionId: string, input: In<typeof PublishOfferingVersionCommandSchema>, state: RequestState): Promise<OwnerOfferingView> {
    return this.run(state, async (trx, p) => {
      const offering = await this.owned(trx, offeringId, true);
      const version = await this.versionOf(trx, offering, versionId);
      const actor = await this.actor(p, input.actor, 'publish', { kind: 'catalogue_offering', id: offering.id });
      if (version.status !== 'draft') throw new ApiError('commercial.version_immutable', 'this version is already published', { reason: 'version_frozen' });
      if (offering.status === 'archived') throw new ApiError('validation.schema', 'an archived offering is not published', { reason: 'archived' });
      const payload = version.payload as OfferingDraftInput['payload'];
      this.checkDraft(offering.kind, { payload });
      await this.bump(trx, offering, input.expectedRevision);
      const at = this.now();
      const previous = await offeringVersions.inStatus(trx, offering.id, 'published');
      if (previous) await offeringVersions.supersede(trx, previous.id, at);
      await bundleComponents.materialise(trx, version.id, payload.components);
      const published = await offeringVersions.publish(trx, version.id, { digest: computeDigest(offeringVersionDigestInput(payload)).value, personId: p.personId, via: actor.via, mandateId: actor.mandateId, at });
      if (!published) throw new ApiError('validation.revision_conflict');
      const current = await offerings.setCurrent(trx, offering.id, { current_version: published.version, current_version_id: published.id });
      await this.audit(trx, p, state, 'offering.version_published', 'offering', offering.id, { versionId: published.id, version: published.version, digest: published.digest, superseded: previous?.id ?? null, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'offering', offering.id, current.revision, 'offering.version_published', { offeringId: offering.id, versionId: published.id, version: published.version, via: actor.via });
      return this.ownerView(trx, current);
    });
  }

  async archive(offeringId: string, input: In<typeof ArchiveOfferingCommandSchema>, state: RequestState): Promise<OwnerOfferingView> {
    return this.run(state, async (trx, p) => {
      const offering = await this.owned(trx, offeringId, true);
      if (offering.status === 'archived') throw new ApiError('validation.schema', 'already archived', { reason: 'archived' });
      if (offering.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const archived = await offerings.archive(trx, offering.id, input.expectedRevision, input.reason);
      if (!archived) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'offering.archived', 'offering', offering.id, { reason: input.reason });
      await this.event(trx, 'offering', offering.id, archived.revision, 'offering.archived', { offeringId: offering.id, status: 'archived' });
      return this.ownerView(trx, archived);
    });
  }
}
