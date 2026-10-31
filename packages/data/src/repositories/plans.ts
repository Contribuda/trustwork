import { sql } from 'kysely';
import type { PlanContent, PlanDependency, PlanItem } from '../../../contracts/src/plans.js';
import type { Transaction } from '../pool.js';
import type {
  NewPlanItemRow, PermitRecordRow, PlanChangeRow, PlanDependencyRow, PlanItemRow, PlanItemStateRow, PlanRow, PlanShareRow, PlanVersionRow, ProjectDiaryEntryRow, ProjectLocationRow,
} from '../schema/plans.js';
// Brings the kernel tables (taxonomy_term) into the Kysely model by augmentation.
import '../schema/kernel.js';

/**
 * Plans repository (PLAN-001). Thin typed access under `withPrincipal`: RLS scopes every read and write to the owner
 * side of the project, and the guards in packages/data/migrations/plans freeze proposed versions, keep approved ones,
 * record an item's path once and keep shares immutable. Invitees never read these tables: `sharedView` calls the
 * owner-run `trustwork.plan_shared_view`, which returns only the listed fields of their live shares.
 */
/** node-postgres parses `date` as local midnight; local getters give back the calendar date in every time zone. */
export function isoDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Frozen row of a plan item (insert order: parents before children, then by position). */
export function itemToRow(versionId: string, item: PlanItem, position: number): NewPlanItemRow {
  return {
    plan_version_id: versionId, item_key: item.key, parent_key: item.parentKey, position, kind: item.kind, title: item.title, description: item.description,
    step_terms: [...item.stepTerms], required_skills: [...item.requiredSkills],
    quantity_value: item.quantity?.value ?? null, quantity_unit: item.quantity?.unit ?? null,
    estimate_low: item.estimate?.low.minorUnits ?? null, estimate_high: item.estimate?.high.minorUnits ?? null, estimate_currency: item.estimate?.low.currency ?? null,
    estimate_basis: item.estimate?.basis ?? null, estimate_basis_ref: item.estimate?.basisRef ?? null, estimate_as_of: item.estimate?.asOf ?? null,
    duration_low_days: item.duration?.lowDays ?? null, duration_high_days: item.duration?.highDays ?? null,
    window_start: item.window?.earliestStart ?? null, window_finish: item.window?.latestFinish ?? null,
    risk_level: item.riskLevel, decision_question: item.decisionQuestion,
    sources: JSON.stringify(item.sources), attachments: JSON.stringify(item.attachments), private_notes: item.privateNotes,
  };
}
export function rowToItem(row: PlanItemRow): PlanItem {
  return {
    key: row.item_key, parentKey: row.parent_key, kind: row.kind, title: row.title, description: row.description, stepTerms: row.step_terms, requiredSkills: row.required_skills,
    quantity: row.quantity_value !== null && row.quantity_unit !== null ? { value: row.quantity_value, unit: row.quantity_unit } : null,
    estimate: row.estimate_low !== null && row.estimate_high !== null && row.estimate_currency !== null && row.estimate_basis !== null
      ? {
        kind: 'estimate_range', low: { minorUnits: String(row.estimate_low), currency: row.estimate_currency }, high: { minorUnits: String(row.estimate_high), currency: row.estimate_currency },
        basis: row.estimate_basis as NonNullable<PlanItem['estimate']>['basis'], basisRef: row.estimate_basis_ref, asOf: isoDate(row.estimate_as_of) as string,
      }
      : null,
    duration: row.duration_low_days !== null && row.duration_high_days !== null ? { lowDays: row.duration_low_days, highDays: row.duration_high_days } : null,
    window: row.window_start !== null || row.window_finish !== null ? { earliestStart: isoDate(row.window_start), latestFinish: isoDate(row.window_finish) } : null,
    riskLevel: row.risk_level, decisionQuestion: row.decision_question,
    sources: row.sources as PlanItem['sources'], attachments: row.attachments as PlanItem['attachments'], privateNotes: row.private_notes,
  };
}
/** Parents before children (the content is validated acyclic), stable by original position. */
export function insertionOrder(items: readonly PlanItem[]): { item: PlanItem; position: number }[] {
  const indexed = items.map((item, position) => ({ item, position }));
  const done = new Set<string>();
  const out: { item: PlanItem; position: number }[] = [];
  let pending = indexed;
  while (pending.length > 0) {
    const ready = pending.filter((p) => p.item.parentKey === null || done.has(p.item.parentKey));
    if (ready.length === 0) throw new Error('plan items: parent graph is not a forest');
    for (const r of ready) {
      out.push(r);
      done.add(r.item.key);
    }
    pending = pending.filter((p) => !done.has(p.item.key));
  }
  return out;
}

export const plans = {
  getByProject(trx: Transaction, projectId: string): Promise<PlanRow | undefined> {
    return trx.selectFrom('plan').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  },
  /** Serializes version numbering, proposals and approvals of one plan. */
  lockByProject(trx: Transaction, projectId: string): Promise<PlanRow | undefined> {
    return trx.selectFrom('plan').selectAll().where('project_id', '=', projectId).forUpdate().executeTakeFirst();
  },
  insert(trx: Transaction, row: { project_id: string; time_zone: string; created_by_person_id: string; drafted_via: 'person' | 'agent'; drafted_mandate_id: string | null }): Promise<PlanRow> {
    return trx.insertInto('plan').values(row).returningAll().executeTakeFirstOrThrow();
  },
  setBaseline(trx: Transaction, planId: string, versionId: string): Promise<PlanRow> {
    return trx.updateTable('plan').set({ current_version_id: versionId, status: 'active' }).where('id', '=', planId).returningAll().executeTakeFirstOrThrow();
  },
};

export const planVersions = {
  listForPlan(trx: Transaction, planId: string): Promise<PlanVersionRow[]> {
    return trx.selectFrom('plan_version').selectAll().where('plan_id', '=', planId).orderBy('version', 'asc').execute();
  },
  get(trx: Transaction, id: string): Promise<PlanVersionRow | undefined> {
    return trx.selectFrom('plan_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<PlanVersionRow | undefined> {
    return trx.selectFrom('plan_version').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  inStatus(trx: Transaction, planId: string, status: PlanVersionRow['status']): Promise<PlanVersionRow | undefined> {
    return trx.selectFrom('plan_version').selectAll().where('plan_id', '=', planId).where('status', '=', status).executeTakeFirst();
  },
  async nextNumber(trx: Transaction, planId: string): Promise<number> {
    const row = await trx.selectFrom('plan_version').select((eb) => eb.fn.max('version').as('max')).where('plan_id', '=', planId).executeTakeFirst();
    return Number(row?.max ?? 0) + 1;
  },
  insertDraft(trx: Transaction, row: {
    plan_id: string; project_id: string; version: number; content: PlanContent; based_on_version_id: string | null; drafted_by_person_id: string; drafted_via: 'person' | 'agent'; drafted_mandate_id: string | null;
  }): Promise<PlanVersionRow> {
    return trx.insertInto('plan_version').values({ ...row, content: JSON.stringify(row.content) }).returningAll().executeTakeFirstOrThrow();
  },
  /** Optimistic edit of a draft; `undefined` when the revision moved or the version is no longer a draft. */
  saveContent(trx: Transaction, id: string, expectedRevision: number, content: PlanContent): Promise<PlanVersionRow | undefined> {
    return trx.updateTable('plan_version').set({ content: JSON.stringify(content) })
      .where('id', '=', id).where('revision', '=', expectedRevision).where('status', '=', 'draft').returningAll().executeTakeFirst();
  },
  propose(trx: Transaction, id: string, input: { digest: string; personId: string; via: 'person' | 'agent'; mandateId: string | null; at: Date }): Promise<PlanVersionRow> {
    return trx.updateTable('plan_version').set({ status: 'proposed', digest: input.digest, proposed_by_person_id: input.personId, proposed_via: input.via, proposed_mandate_id: input.mandateId, proposed_at: input.at })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  approve(trx: Transaction, id: string, input: { personId: string; at: Date; changeId: string | null }): Promise<PlanVersionRow> {
    return trx.updateTable('plan_version').set({ status: 'approved', approved_by_person_id: input.personId, approved_at: input.at, ...(input.changeId ? { change_id: input.changeId } : {}) })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  supersede(trx: Transaction, id: string, input: { byVersionId: string | null; reason: 'returned' | 'replaced'; at: Date }): Promise<PlanVersionRow> {
    return trx.updateTable('plan_version').set({ status: 'superseded', superseded_at: input.at, superseded_by_version_id: input.byVersionId, superseded_reason: input.reason })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
};

export const planParts = {
  /** Materialises the frozen items and dependencies of a draft that is being proposed (same transaction). */
  async materialise(trx: Transaction, versionId: string, content: PlanContent): Promise<void> {
    const ordered = insertionOrder(content.items);
    for (let i = 0; i < ordered.length; i += 200) {
      const chunk = ordered.slice(i, i + 200).map(({ item, position }) => itemToRow(versionId, item, position));
      if (chunk.length) await trx.insertInto('plan_item').values(chunk).execute();
    }
    for (let i = 0; i < content.dependencies.length; i += 500) {
      const chunk = content.dependencies.slice(i, i + 500).map((d: PlanDependency) => ({ plan_version_id: versionId, predecessor_key: d.predecessorKey, successor_key: d.successorKey, type: d.type, lag_days: d.lagDays }));
      if (chunk.length) await trx.insertInto('plan_dependency').values(chunk).execute();
    }
  },
  items(trx: Transaction, versionId: string): Promise<PlanItemRow[]> {
    return trx.selectFrom('plan_item').selectAll().where('plan_version_id', '=', versionId).orderBy('position', 'asc').execute();
  },
  dependencies(trx: Transaction, versionId: string): Promise<PlanDependencyRow[]> {
    return trx.selectFrom('plan_dependency').selectAll().where('plan_version_id', '=', versionId).orderBy('predecessor_key').orderBy('successor_key').execute();
  },
  item(trx: Transaction, versionId: string, itemKey: string): Promise<PlanItemRow | undefined> {
    return trx.selectFrom('plan_item').selectAll().where('plan_version_id', '=', versionId).where('item_key', '=', itemKey).executeTakeFirst();
  },
};

export const planItemStates = {
  get(trx: Transaction, planId: string, itemKey: string): Promise<PlanItemStateRow | undefined> {
    return trx.selectFrom('plan_item_state').selectAll().where('plan_id', '=', planId).where('item_key', '=', itemKey).executeTakeFirst();
  },
  list(trx: Transaction, planId: string): Promise<PlanItemStateRow[]> {
    return trx.selectFrom('plan_item_state').selectAll().where('plan_id', '=', planId).orderBy('item_key').execute();
  },
  insert(trx: Transaction, row: Omit<PlanItemStateRow, 'revision' | 'created_at' | 'updated_at' | 'actual_start' | 'actual_end'> & { actual_start: string | null; actual_end: string | null }): Promise<PlanItemStateRow> {
    return trx.insertInto('plan_item_state').values(row).returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, planId: string, itemKey: string, expectedRevision: number, patch: Pick<PlanItemStateRow, 'status' | 'path' | 'link_kind' | 'link_id' | 'blocked_from' | 'updated_by_person_id'> & { actual_start: string | null; actual_end: string | null }): Promise<PlanItemStateRow | undefined> {
    return trx.updateTable('plan_item_state').set(patch).where('plan_id', '=', planId).where('item_key', '=', itemKey).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const planChanges = {
  insert(trx: Transaction, row: Omit<PlanChangeRow, 'id' | 'status' | 'decided_by_person_id' | 'decided_at' | 'revision' | 'created_at' | 'updated_at'>): Promise<PlanChangeRow> {
    return trx.insertInto('plan_change').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<PlanChangeRow | undefined> {
    return trx.selectFrom('plan_change').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<PlanChangeRow | undefined> {
    return trx.selectFrom('plan_change').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  list(trx: Transaction, planId: string): Promise<PlanChangeRow[]> {
    return trx.selectFrom('plan_change').selectAll().where('plan_id', '=', planId).orderBy('created_at').orderBy('id').execute();
  },
  decide(trx: Transaction, id: string, expectedRevision: number, input: { status: 'approved' | 'rejected' | 'withdrawn'; personId: string; at: Date }): Promise<PlanChangeRow | undefined> {
    return trx.updateTable('plan_change').set({ status: input.status, decided_by_person_id: input.personId, decided_at: input.at })
      .where('id', '=', id).where('revision', '=', expectedRevision).where('status', '=', 'proposed').returningAll().executeTakeFirst();
  },
};

/** Row of `trustwork.plan_shared_view`: columns outside the share's fields are NULL. */
export interface PlanSharedViewRow {
  share_id: string; plan_id: string; item_key: string; audience: 'invited' | 'after_acceptance'; fields: string[]; acceptance_kind: string | null; acceptance_id: string | null;
  valid_until: Date | null; confirmed_by: string; confirmed_at: Date; preview_digest: string; share_revision: number; invitee_person_id: string | null; invitee_company_id: string | null;
  plan_version: number; time_zone: string; item_position: number; kind: PlanItemRow['kind']; title: string;
  description: string | null; step_terms: string[] | null; required_skills: string[] | null; quantity_value: string | null; quantity_unit: string | null;
  estimate_low: string | null; estimate_high: string | null; estimate_currency: string | null; estimate_basis: string | null; estimate_basis_ref: string | null; estimate_as_of: Date | string | null;
  duration_low_days: number | null; duration_high_days: number | null; window_start: Date | string | null; window_finish: Date | string | null; attachments: unknown;
  region_code: string | null; address: unknown; site_contact: unknown; site_access_notes: string | null;
}

export const planShares = {
  insert(trx: Transaction, row: {
    plan_id: string; project_id: string; item_key: string; audience: PlanShareRow['audience']; invitee_person_id: string | null; invitee_company_id: string | null; fields: string[];
    acceptance_kind: PlanShareRow['acceptance_kind']; acceptance_id: string | null; preview_digest: string; confirmed_by_person_id: string; confirmed_at: Date; valid_until: Date | null;
  }): Promise<PlanShareRow> {
    return trx.insertInto('plan_share').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<PlanShareRow | undefined> {
    return trx.selectFrom('plan_share').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listForPlan(trx: Transaction, planId: string): Promise<PlanShareRow[]> {
    return trx.selectFrom('plan_share').selectAll().where('plan_id', '=', planId).orderBy('created_at').orderBy('id').execute();
  },
  revoke(trx: Transaction, id: string, expectedRevision: number, input: { personId: string; reason: string; at: Date }): Promise<PlanShareRow | undefined> {
    return trx.updateTable('plan_share').set({ revoked_at: input.at, revoked_by_person_id: input.personId, revoked_reason: input.reason })
      .where('id', '=', id).where('revision', '=', expectedRevision).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
  },
  /** The invitee's projection (owner-run, re-checks the live share for the principal at every call). */
  async sharedView(trx: Transaction, projectId: string): Promise<PlanSharedViewRow[]> {
    const { rows } = await sql<PlanSharedViewRow>`SELECT * FROM trustwork.plan_shared_view(${projectId}::uuid)`.execute(trx);
    return rows;
  },
};

export const projectLocations = {
  get(trx: Transaction, projectId: string): Promise<ProjectLocationRow | undefined> {
    return trx.selectFrom('project_location').selectAll().where('project_id', '=', projectId).executeTakeFirst();
  },
  insert(trx: Transaction, row: { project_id: string; address: unknown; region_code: string | null; cadastral_ref: string | null; site_contact: unknown; site_access_notes: string | null; updated_by_person_id: string }): Promise<ProjectLocationRow> {
    return trx.insertInto('project_location').values({ ...row, address: row.address === null ? null : JSON.stringify(row.address), site_contact: row.site_contact === null ? null : JSON.stringify(row.site_contact) })
      .returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, projectId: string, expectedRevision: number, row: { address: unknown; region_code: string | null; cadastral_ref: string | null; site_contact: unknown; site_access_notes: string | null; updated_by_person_id: string }): Promise<ProjectLocationRow | undefined> {
    return trx.updateTable('project_location')
      .set({ ...row, address: row.address === null ? null : JSON.stringify(row.address), site_contact: row.site_contact === null ? null : JSON.stringify(row.site_contact) })
      .where('project_id', '=', projectId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const permitRecords = {
  insert(trx: Transaction, row: {
    project_id: string; plan_item_key: string | null; jurisdiction: string; permit_type: string; authority: string; number: string | null; applied_at: string | null; issued_at: string | null;
    expires_at: string | null; inspection_results: unknown; evidence: unknown; status: PermitRecordRow['status']; created_by_person_id: string;
  }): Promise<PermitRecordRow> {
    return trx.insertInto('permit_record').values({ ...row, inspection_results: JSON.stringify(row.inspection_results), evidence: JSON.stringify(row.evidence) }).returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, projectId: string): Promise<PermitRecordRow[]> {
    return trx.selectFrom('permit_record').selectAll().where('project_id', '=', projectId).orderBy('created_at').orderBy('id').execute();
  },
};

export const projectDiary = {
  insert(trx: Transaction, row: { project_id: string; author_person_id: string; entry_date: string; body: string; evidence: unknown; plan_item_key: string | null; visibility: 'owner_private' | 'participants' }): Promise<ProjectDiaryEntryRow> {
    return trx.insertInto('project_diary_entry').values({ ...row, evidence: JSON.stringify(row.evidence) }).returningAll().executeTakeFirstOrThrow();
  },
  list(trx: Transaction, projectId: string): Promise<ProjectDiaryEntryRow[]> {
    return trx.selectFrom('project_diary_entry').selectAll().where('project_id', '=', projectId).orderBy('entry_date').orderBy('created_at').orderBy('id').execute();
  },
};

export const planTaxonomy = {
  /** Codes that are not released taxonomy terms visible to the principal (the item guard refuses them at proposal). */
  async unknownCodes(trx: Transaction, codes: readonly string[]): Promise<string[]> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return [];
    const rows = await trx.selectFrom('taxonomy_term').select('code').where('code', 'in', unique).where('status', '=', 'released').execute();
    const known = new Set(rows.map((r) => r.code));
    return unique.filter((c) => !known.has(c)).sort();
  },
};
