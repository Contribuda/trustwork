import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  BundleComponentRow, CommerceVia, InvitationChannelValue, InvitationStatusValue, LineKindValue, NeedLineRow, NeedRow, NeedSourceValue, NeedStatusValue, OfferingKindValue, OfferingRow,
  OfferingVersionPrivateRow, OfferingVersionRow, RfqInvitationRow, RfqPrivateConstraintRow, RfqRow, RfqStatusValue, RfqVersionRow,
} from '../schema/commerce.js';
// Brings the plan tables into the Kysely model (plan items can become RFQs, ADR 012 decision 37).
import '../schema/plans.js';

/**
 * Commerce repository (COM-001). Thin typed access under `withPrincipal`: RLS scopes every read and write (owner side of
 * offerings, needs and RFQs; invitees read only their invitations and the versions they pin), and the guards in
 * packages/data/migrations/commerce freeze published versions, pin invitations to the current version, flag stale
 * invitations on amendment and keep everything retained. Public reads call owner-run functions that return only
 * allowlisted fields. Mutable envelopes are changed with an expected revision; `bump` records a change of the aggregate
 * (a draft save) on its envelope so one revision governs optimistic concurrency.
 */
type Owner = { owner_person_id: string | null; owner_company_id: string | null };
const json = (value: unknown): string => JSON.stringify(value);

/* ---------- Catalogue ---------- */

export const offerings = {
  insert(trx: Transaction, row: Owner & { created_by_person_id: string; kind: OfferingKindValue }): Promise<OfferingRow> {
    return trx.insertInto('offering').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<OfferingRow | undefined> {
    return trx.selectFrom('offering').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Serializes version numbering and publication of one offering. */
  lock(trx: Transaction, id: string): Promise<OfferingRow | undefined> {
    return trx.selectFrom('offering').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** Records a change of the aggregate on its envelope (revision + 1) when the expected revision still holds. */
  bump(trx: Transaction, id: string, expectedRevision: number): Promise<OfferingRow | undefined> {
    return trx.updateTable('offering').set((eb) => ({ status: eb.ref('status') })).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  setCurrent(trx: Transaction, id: string, input: { current_version: number; current_version_id: string }): Promise<OfferingRow> {
    return trx.updateTable('offering').set({ ...input, status: 'active' }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  archive(trx: Transaction, id: string, expectedRevision: number, reason: string): Promise<OfferingRow | undefined> {
    return trx.updateTable('offering').set({ status: 'archived', archived_reason: reason }).where('id', '=', id).where('revision', '=', expectedRevision).where('status', '<>', 'archived').returningAll().executeTakeFirst();
  },
};

export const offeringVersions = {
  insertDraft(trx: Transaction, row: { offering_id: string; version: number; payload: unknown; public_fields: string[]; drafted_by_person_id: string }): Promise<OfferingVersionRow> {
    return trx.insertInto('offering_version').values({ ...row, payload: json(row.payload) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<OfferingVersionRow | undefined> {
    return trx.selectFrom('offering_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, offeringId: string): Promise<OfferingVersionRow[]> {
    return trx.selectFrom('offering_version').selectAll().where('offering_id', '=', offeringId).orderBy('version').execute();
  },
  inStatus(trx: Transaction, offeringId: string, status: 'draft' | 'published'): Promise<OfferingVersionRow | undefined> {
    return trx.selectFrom('offering_version').selectAll().where('offering_id', '=', offeringId).where('status', '=', status).executeTakeFirst();
  },
  saveDraft(trx: Transaction, id: string, input: { payload: unknown; public_fields: string[] }): Promise<OfferingVersionRow | undefined> {
    return trx.updateTable('offering_version').set({ payload: json(input.payload), public_fields: input.public_fields }).where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  publish(trx: Transaction, id: string, input: { digest: string; personId: string; via: CommerceVia; mandateId: string | null; at: Date }): Promise<OfferingVersionRow | undefined> {
    return trx.updateTable('offering_version')
      .set({ status: 'published', digest: input.digest, published_at: input.at, published_by_person_id: input.personId, published_via: input.via, published_mandate_id: input.mandateId })
      .where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  supersede(trx: Transaction, id: string, at: Date): Promise<OfferingVersionRow | undefined> {
    return trx.updateTable('offering_version').set({ status: 'superseded', superseded_at: at }).where('id', '=', id).where('status', '=', 'published').returningAll().executeTakeFirst();
  },
};

export const bundleComponents = {
  /** Materialises the payload components of a draft (the guard pins each to its published component version). */
  async materialise(trx: Transaction, versionId: string, components: readonly { offeringId: string; version: number; quantity: { value: string; unit: string } }[]): Promise<void> {
    if (components.length === 0) return;
    await trx.insertInto('bundle_component').values(components.map((c, position) => ({
      offering_version_id: versionId, position, component_offering_id: c.offeringId, component_version: c.version, quantity_value: c.quantity.value, quantity_unit: c.quantity.unit,
    }))).execute();
  },
  list(trx: Transaction, versionId: string): Promise<BundleComponentRow[]> {
    return trx.selectFrom('bundle_component').selectAll().where('offering_version_id', '=', versionId).orderBy('position').execute();
  },
};

export const offeringPrivate = {
  listFor(trx: Transaction, offeringId: string): Promise<OfferingVersionPrivateRow[]> {
    return trx.selectFrom('offering_version_private').selectAll().where('offering_id', '=', offeringId).execute();
  },
  /** Private knowledge is mutable owner data beside the (possibly frozen) version. */
  upsert(trx: Transaction, row: { offering_version_id: string; offering_id: string; cost_basis_minor: string | null; cost_basis_currency: string | null; margin_target: string | null; notes: string | null; updated_by_person_id: string }): Promise<OfferingVersionPrivateRow> {
    return trx.insertInto('offering_version_private').values(row)
      .onConflict((oc) => oc.column('offering_version_id').doUpdateSet({
        cost_basis_minor: row.cost_basis_minor, cost_basis_currency: row.cost_basis_currency, margin_target: row.margin_target, notes: row.notes, updated_by_person_id: row.updated_by_person_id,
      }))
      .returningAll().executeTakeFirstOrThrow();
  },
};

export interface PublicOfferingRow { offering_id: string; owner_person_id: string | null; owner_company_id: string | null; kind: OfferingKindValue; version: number; is_current: boolean; published_at: Date; fields: Record<string, unknown> }
export const cataloguePublic = {
  /** Published versions of active offerings with only their allowlisted fields (`trustwork.catalogue_public_offerings`). */
  async list(trx: Transaction, filter: { ownerPersonId?: string | null; ownerCompanyId?: string | null; offeringId?: string | null; version?: number | null }): Promise<PublicOfferingRow[]> {
    const result = await sql<PublicOfferingRow>`SELECT * FROM trustwork.catalogue_public_offerings(${filter.ownerPersonId ?? null}::uuid, ${filter.ownerCompanyId ?? null}::uuid, ${filter.offeringId ?? null}::uuid, ${filter.version ?? null}::integer)`.execute(trx);
    return result.rows;
  },
};

/* ---------- Needs ---------- */

export interface NeedLineInsert {
  kind: LineKindValue | null;
  description: string;
  quantity: { value: string; unit: string } | null;
  specification: Record<string, string>;
  alternativesAllowed: boolean;
  evidence: unknown;
}
export interface NeedPatch {
  status: Exclude<NeedStatusValue, 'converted'>;
  title: string;
  description: string | null;
  region: string | null;
  window_from: string | null;
  window_to: string | null;
  window_time_zone: string | null;
  window_to_time_zone: string | null;
  acceptance_criteria: string | null;
  missing_fields: string[];
}

export const needs = {
  insert(trx: Transaction, row: Owner & NeedPatch & { project_id: string | null; created_by_person_id: string; source: NeedSourceValue }): Promise<NeedRow> {
    return trx.insertInto('need').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<NeedRow | undefined> {
    return trx.selectFrom('need').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<NeedRow | undefined> {
    return trx.selectFrom('need').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** Needs visible to the principal (RLS: own person and active employer with company.deals.manage), newest first. */
  list(trx: Transaction): Promise<NeedRow[]> {
    return trx.selectFrom('need').selectAll().orderBy('updated_at', 'desc').orderBy('id').limit(200).execute();
  },
  update(trx: Transaction, id: string, expectedRevision: number, patch: NeedPatch): Promise<NeedRow | undefined> {
    return trx.updateTable('need').set(patch).where('id', '=', id).where('revision', '=', expectedRevision).where('status', '<>', 'converted').returningAll().executeTakeFirst();
  },
  convert(trx: Transaction, id: string, expectedRevision: number, rfqId: string): Promise<NeedRow | undefined> {
    return trx.updateTable('need').set({ status: 'converted', rfq_id: rfqId }).where('id', '=', id).where('revision', '=', expectedRevision).where('status', '=', 'ready').returningAll().executeTakeFirst();
  },
  /** The line set of one need revision. */
  lines(trx: Transaction, needId: string, revision: number): Promise<NeedLineRow[]> {
    return trx.selectFrom('need_line').selectAll().where('need_id', '=', needId).where('need_revision', '=', revision).orderBy('position').execute();
  },
  /** Appends the line set of the need's current revision (earlier sets stay as history). */
  async insertLines(trx: Transaction, needId: string, revision: number, lines: readonly NeedLineInsert[]): Promise<NeedLineRow[]> {
    if (lines.length === 0) return [];
    return trx.insertInto('need_line').values(lines.map((l, position) => ({
      need_id: needId, need_revision: revision, position, kind: l.kind, description: l.description, quantity_value: l.quantity?.value ?? null, quantity_unit: l.quantity?.unit ?? null,
      specification: json(l.specification), alternatives_allowed: l.alternativesAllowed, evidence: l.evidence === null ? null : json(l.evidence),
    }))).returningAll().execute();
  },
};

/* ---------- RFQs ---------- */

export const rfqs = {
  insert(trx: Transaction, row: Owner & {
    project_id: string | null; creator_person_id: string; need_id: string | null; plan_project_id: string | null; plan_item_key: string | null;
    public_projection_enabled: boolean; public_projection_fields: string[]; category: string | null;
  }): Promise<RfqRow> {
    return trx.insertInto('rfq').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<RfqRow | undefined> {
    return trx.selectFrom('rfq').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Serializes drafting, publication, invitations' pinning and closing of one RFQ. */
  lock(trx: Transaction, id: string): Promise<RfqRow | undefined> {
    return trx.selectFrom('rfq').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** RFQs the given parties own (the caller passes the principal's person and its employer when it may act for it). */
  listOwned(trx: Transaction, parties: { personId: string; companyId: string | null }): Promise<RfqRow[]> {
    return trx.selectFrom('rfq').selectAll()
      .where((eb) => eb.or([eb('owner_person_id', '=', parties.personId), ...(parties.companyId ? [eb('owner_company_id', '=', parties.companyId)] : [])]))
      .orderBy('updated_at', 'desc').orderBy('id').limit(200).execute();
  },
  bump(trx: Transaction, id: string, expectedRevision: number): Promise<RfqRow | undefined> {
    return trx.updateTable('rfq').set((eb) => ({ status: eb.ref('status') })).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  setCurrent(trx: Transaction, id: string, input: { current_version: number; current_version_id: string }): Promise<RfqRow> {
    return trx.updateTable('rfq').set({ ...input, status: 'published' }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  close(trx: Transaction, id: string, expectedRevision: number, input: { status: Extract<RfqStatusValue, 'closed' | 'cancelled'>; personId: string; reason: string; at: Date }): Promise<RfqRow | undefined> {
    return trx.updateTable('rfq').set({ status: input.status, closed_at: input.at, closed_by_person_id: input.personId, closed_reason: input.reason })
      .where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  setProjection(trx: Transaction, id: string, expectedRevision: number, input: { enabled: boolean; fields: string[]; category: string | null }): Promise<RfqRow | undefined> {
    return trx.updateTable('rfq').set({ public_projection_enabled: input.enabled, public_projection_fields: input.fields, category: input.category })
      .where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const rfqVersions = {
  insertDraft(trx: Transaction, row: { rfq_id: string; version: number; payload: unknown; drafted_by_person_id: string; amendment_reason: string | null }): Promise<RfqVersionRow> {
    return trx.insertInto('rfq_version').values({ ...row, payload: json(row.payload) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<RfqVersionRow | undefined> {
    return trx.selectFrom('rfq_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Every version the principal may read (owner side: all; invitee: the published versions its invitations pin). */
  listFor(trx: Transaction, rfqId: string): Promise<RfqVersionRow[]> {
    return trx.selectFrom('rfq_version').selectAll().where('rfq_id', '=', rfqId).orderBy('version').execute();
  },
  inStatus(trx: Transaction, rfqId: string, status: 'draft' | 'published'): Promise<RfqVersionRow | undefined> {
    return trx.selectFrom('rfq_version').selectAll().where('rfq_id', '=', rfqId).where('status', '=', status).executeTakeFirst();
  },
  saveDraft(trx: Transaction, id: string, payload: unknown): Promise<RfqVersionRow | undefined> {
    return trx.updateTable('rfq_version').set({ payload: json(payload) }).where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  publish(trx: Transaction, id: string, input: { digest: string; personId: string; via: CommerceVia; mandateId: string | null; amendmentReason: string | null; at: Date }): Promise<RfqVersionRow | undefined> {
    return trx.updateTable('rfq_version')
      .set({ status: 'published', digest: input.digest, published_at: input.at, published_by_person_id: input.personId, published_via: input.via, published_mandate_id: input.mandateId, amendment_reason: input.amendmentReason })
      .where('id', '=', id).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  supersede(trx: Transaction, id: string, supersededBy: number, at: Date): Promise<RfqVersionRow | undefined> {
    return trx.updateTable('rfq_version').set({ status: 'superseded', superseded_by: supersededBy, superseded_at: at }).where('id', '=', id).where('status', '=', 'published').returningAll().executeTakeFirst();
  },
};

export interface RfqPrivateInput { budget_ceiling_minor: string | null; budget_ceiling_currency: string | null; evaluation_weights: Record<string, string>; internal_notes: string; shortlist: unknown[] }
export const rfqPrivate = {
  get(trx: Transaction, rfqId: string): Promise<RfqPrivateConstraintRow | undefined> {
    return trx.selectFrom('rfq_private_constraint').selectAll().where('rfq_id', '=', rfqId).executeTakeFirst();
  },
  insert(trx: Transaction, row: Owner & RfqPrivateInput & { rfq_id: string; updated_by_person_id: string }): Promise<RfqPrivateConstraintRow> {
    return trx.insertInto('rfq_private_constraint').values({ ...row, evaluation_weights: json(row.evaluation_weights), shortlist: json(row.shortlist) }).returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, rfqId: string, expectedRevision: number, input: RfqPrivateInput & { updated_by_person_id: string }): Promise<RfqPrivateConstraintRow | undefined> {
    return trx.updateTable('rfq_private_constraint').set({ ...input, evaluation_weights: json(input.evaluation_weights), shortlist: json(input.shortlist) })
      .where('rfq_id', '=', rfqId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const rfqInvitations = {
  insert(trx: Transaction, row: {
    rfq_id: string; rfq_version_id: string; party_person_id: string | null; party_company_id: string | null; channel: InvitationChannelValue;
    sent_by_person_id: string; sent_via: CommerceVia; sent_by_mandate_id: string | null; revalidates_invitation_id: string | null;
  }): Promise<RfqInvitationRow> {
    return trx.insertInto('rfq_invitation').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<RfqInvitationRow | undefined> {
    return trx.selectFrom('rfq_invitation').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<RfqInvitationRow | undefined> {
    return trx.selectFrom('rfq_invitation').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** Invitations of one RFQ the principal may read (owner side: all; an invitee: its own). */
  listForRfq(trx: Transaction, rfqId: string): Promise<RfqInvitationRow[]> {
    return trx.selectFrom('rfq_invitation').selectAll().where('rfq_id', '=', rfqId).orderBy('sent_at', 'desc').orderBy('id').execute();
  },
  /** Invitations addressed to the given parties (the principal and, when it acts for it, its employer). */
  listForParty(trx: Transaction, parties: { personId: string; companyId: string | null }): Promise<RfqInvitationRow[]> {
    return trx.selectFrom('rfq_invitation').selectAll()
      .where((eb) => eb.or([eb('party_person_id', '=', parties.personId), ...(parties.companyId ? [eb('party_company_id', '=', parties.companyId)] : [])]))
      .orderBy('sent_at', 'desc').orderBy('id').limit(200).execute();
  },
  /** Moves an invitation from the given status (the caller holds the row lock; the guard checks the transition and who may make it). */
  setStatus(trx: Transaction, id: string, from: InvitationStatusValue, input: { status: InvitationStatusValue; withdrawn_reason: string | null }): Promise<RfqInvitationRow | undefined> {
    return trx.updateTable('rfq_invitation').set(input).where('id', '=', id).where('status', '=', from).returningAll().executeTakeFirst();
  },
};

export interface PublicRfqRow { id: string; status: RfqStatusValue; category: string | null; public_projection_enabled: boolean; public_projection_fields: string[]; version_id: string; version: number; version_status: 'published'; payload: unknown; published_at: Date }
export const rfqPublic = {
  async read(trx: Transaction, rfqId: string): Promise<PublicRfqRow | undefined> {
    const result = await sql<PublicRfqRow>`SELECT * FROM trustwork.rfq_public_read(${rfqId}::uuid)`.execute(trx);
    return result.rows[0];
  },
};

/* ---------- Plan item to RFQ (ADR 012 decision 37) ---------- */

export const commercePlanLinks = {
  /** The approved-baseline item of a project's plan, if the principal may read the plan (owner side). */
  async baselineItem(trx: Transaction, projectId: string, itemKey: string): Promise<{ planId: string; kind: string; status: string | null; path: string | null; linkId: string | null; stateRevision: number | null } | undefined> {
    const row = await trx.selectFrom('plan as p')
      .innerJoin('plan_item as i', (join) => join.onRef('i.plan_version_id', '=', 'p.current_version_id').on('i.item_key', '=', itemKey))
      .leftJoin('plan_item_state as s', (join) => join.onRef('s.plan_id', '=', 'p.id').on('s.item_key', '=', itemKey))
      .select(['p.id as planId', 'i.kind as kind', 's.status as status', 's.path as path', 's.link_id as linkId', 's.revision as stateRevision'])
      .where('p.project_id', '=', projectId)
      .executeTakeFirst();
    return row ? { planId: row.planId, kind: row.kind, status: row.status ?? null, path: row.path ?? null, linkId: row.linkId ?? null, stateRevision: row.stateRevision ?? null } : undefined;
  },
};
