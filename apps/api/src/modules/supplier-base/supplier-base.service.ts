import type { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { Principal } from '../../deps/contracts.js';
import { auditEvents, type Transaction } from '../../deps/data.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { requireApprovedChange, statusRoute, submitStatusChange } from './approvals.js';
import { buildSupplierCard } from './card.js';
import { externalCounterparties, supplierAssessments, supplierRecords, type RecordFields, type SupplierRecordRow, type SupplierStatus } from './deps.js';
import { supplierBaseRefusal } from './errors.js';
import { IMPORT_COLUMNS, IMPORT_TEMPLATE_CSV, ImportFileError, mapImportRows, MAX_IMPORT_ROWS, nameKey, readImportFile, type ImportRowError } from './import.js';
import type { SupplierBaseMandateCheck, SupplierBaseMandatePort } from './mandates.js';
import type {
  CreateCounterpartyBodySchema, DraftAssessmentBodySchema, ImportBodySchema, MaintainSupplierBodySchema, RecordAssessmentBodySchema, RespondBodySchema, UpdateCounterpartyBodySchema,
} from './schemas.js';
import type { SupplierScreeningPort } from './screening.js';
import { assessmentView, counterpartyContract, privateView, recordContract, sharedAssessmentView } from './views.js';

type In<T extends z.ZodType> = z.infer<T>;
type Actor = { via: 'person' } | { via: 'agent'; mandateId: string };

/**
 * Supplier base use cases (PRC-003). Every mutation runs in one principal transaction with its audit row and completes
 * its idempotency record there (BE-005). The database repeats every rule (`supplier_base_*` commands): only members
 * holding procurement.suppliers.manage write, links read nothing but the public claim status, and revisions are
 * checked under a row lock.
 *
 * Nothing here appends an outbox event, so no notification, search index, federation feed or statistic can ever learn
 * that a supplier is listed. Audit rows carry identifiers and the names of changed fields only, never a status, a note
 * or a contact.
 */
export class SupplierBaseService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: SupplierBaseMandatePort,
    private readonly screening: SupplierScreeningPort,
  ) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(supplierBaseRefusal);
  }

  private companyOf(principal: Principal): string {
    const company = principal.membership?.companyId;
    if (!company) throw new ApiError('access.not_found', 'the supplier base belongs to a company you are an active member of', { reason: 'no_company' });
    return company;
  }

  private async via(principal: Principal, actor: Actor, action: SupplierBaseMandateCheck['action'], companyId: string): Promise<'person' | 'agent'> {
    if (actor.via === 'person') return 'person';
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: actor.mandateId, action, context: { kind: 'company', id: companyId }, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this company`, { reason: 'mandate_scope' });
    return 'agent';
  }

  private audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: Record<string, unknown>, companyId: string | null): Promise<void> {
    return auditEvents.append(trx, {
      actor_person_id: principal.personId, on_behalf_of_company_id: companyId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId,
      authz_epoch: principal.authzEpoch, basis,
    });
  }

  private sameKey(body: { idempotencyKey?: string | undefined }, header: string | undefined): void {
    if (body.idempotencyKey !== undefined && header !== undefined && header !== body.idempotencyKey) {
      throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key' });
    }
  }

  private async record(trx: Transaction, id: string): Promise<SupplierRecordRow> {
    const row = await supplierRecords.get(trx, id);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  /* ---------- Supplier records ---------- */

  listSuppliers(state: RequestState, query: { status?: SupplierStatus | undefined; limit?: number | undefined }) {
    return this.run(state, async (trx, p) => {
      const rows = await supplierRecords.list(trx, { companyId: this.companyOf(p), status: query.status ?? null, limit: query.limit ?? 50 });
      return privateView({ items: rows.map(recordContract) });
    });
  }

  getSupplier(state: RequestState, id: string) {
    return this.run(state, async (trx) => {
      const row = await this.record(trx, id);
      const counterparty = row.external_counterparty_id ? await externalCounterparties.get(trx, row.external_counterparty_id) : undefined;
      return privateView({ record: recordContract(row), counterparty: counterparty ? counterpartyContract(counterparty) : null });
    });
  }

  card(state: RequestState, id: string) {
    return this.run(state, async (trx, p) => buildSupplierCard(trx, p, await this.record(trx, id), this.screening, this.now()));
  }

  /**
   * `procurement.maintain_supplier`. An agent needs a `maintain_records` mandate; blocking a supplier is the person's
   * own act (the design asks for a confirmation of each block, so an agent request to block is refused here and left
   * to the person on the first-party surface).
   */
  maintain(state: RequestState, body: In<typeof MaintainSupplierBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      const via = await this.via(p, body.actor, 'maintain_records', company);
      if (via === 'agent' && body.status === 'blocked') throw new ApiError('access.mandate_scope', 'blocking a supplier is confirmed by the person each time', { reason: 'confirmation_required' });
      if (body.supplierRecordId === null) {
        const fields: RecordFields = {
          status: body.status, categories: body.categories ?? [], regions: body.regions ?? [], internalNotes: body.internalNotes ?? null,
          defaultPaymentTerms: body.defaultPaymentTerms ?? null, onboarding: body.onboarding ?? [],
        };
        // A status the company's supplier-status route reviews starts as `prospect` and is submitted for approval.
        const needsApproval = fields.status !== 'prospect' && (await statusRoute(trx, company, fields.status, fields.categories)) !== null;
        const row = await supplierRecords.create(trx, { companyId: company, link: body.link, ...fields, status: needsApproval ? 'prospect' : fields.status });
        const approval = needsApproval ? await submitStatusChange(trx, company, row, fields.status, this.now()) : null;
        await this.audit(trx, p, state, 'supplier_base.record_created', 'supplier_record', row.id, {
          linkKind: body.link.kind, approvalRequestId: approval?.id ?? null, via, mandateId: body.actor.via === 'agent' ? body.actor.mandateId : null,
        }, company);
        return privateView({ record: recordContract(row), approval: approval ? { request: approval, status: fields.status } : null });
      }
      let current = await this.record(trx, body.supplierRecordId);
      let expected = body.expectedRevision;
      const currentLink = current.linked_company_id ? { kind: 'company', id: current.linked_company_id }
        : current.linked_sourced_company_id ? { kind: 'sourced_company', id: current.linked_sourced_company_id } : { kind: 'external_counterparty', id: current.external_counterparty_id };
      const changed: string[] = [];
      if (currentLink.kind !== body.link.kind || currentLink.id !== body.link.id) {
        if (body.link.kind !== 'company') throw new ApiError('validation.schema', 'a link only moves to the claimed company', { reason: 'invalid_link' });
        current = await supplierRecords.linkClaimed(trx, { id: current.id, companyId: body.link.id, expectedRevision: expected });
        expected = current.revision;
        changed.push('link');
      }
      const fields: RecordFields = {
        status: body.status, categories: body.categories ?? current.categories, regions: body.regions ?? current.regions,
        internalNotes: body.internalNotes === undefined ? current.internal_notes : body.internalNotes,
        defaultPaymentTerms: body.defaultPaymentTerms === undefined ? current.default_payment_terms : body.defaultPaymentTerms,
        onboarding: body.onboarding ?? (current.onboarding as unknown[]),
      };
      if (fields.status !== current.status) changed.push('status');
      if (body.categories !== undefined) changed.push('categories');
      if (body.regions !== undefined) changed.push('regions');
      if (body.internalNotes !== undefined) changed.push('internalNotes');
      if (body.defaultPaymentTerms !== undefined) changed.push('defaultPaymentTerms');
      if (body.onboarding !== undefined) changed.push('onboarding');
      const statusChange = fields.status !== current.status;
      if (statusChange && body.approvalRequestId !== undefined) {
        // The approved change is bound to the record as it was submitted: check it before anything else changes.
        if (current.revision !== expected) throw new ApiError('validation.revision_conflict', 'the supplier record changed meanwhile', { reason: 'revision_conflict' });
        await requireApprovedChange(trx, body.approvalRequestId, current, fields.status);
      }
      const route = statusChange && body.approvalRequestId === undefined ? await statusRoute(trx, company, fields.status, fields.categories) : null;
      let row: SupplierRecordRow;
      if (route) {
        // The other changes apply now; the status waits for the route, bound to the record as it is after them.
        const others = changed.filter((f) => f !== 'status' && f !== 'link');
        if (others.length === 0 && current.revision !== expected) throw new ApiError('validation.revision_conflict', 'the supplier record changed meanwhile', { reason: 'revision_conflict' });
        row = others.length > 0 ? await supplierRecords.update(trx, { id: current.id, expectedRevision: expected, ...fields, status: current.status }) : current;
      } else {
        row = await supplierRecords.update(trx, { id: current.id, expectedRevision: expected, ...fields });
      }
      const approval = route ? await submitStatusChange(trx, company, row, fields.status, this.now()) : null;
      await this.audit(trx, p, state, 'supplier_base.record_changed', 'supplier_record', row.id, {
        fields: approval ? changed.filter((f) => f !== 'status') : changed, approvalRequestId: approval?.id ?? body.approvalRequestId ?? null, via, mandateId: body.actor.via === 'agent' ? body.actor.mandateId : null,
      }, company);
      return privateView({ record: recordContract(row), approval: approval ? { request: approval, status: fields.status } : null });
    });
  }

  /* ---------- External counterparties ---------- */

  listCounterparties(state: RequestState, limit: number) {
    return this.run(state, async (trx, p) => privateView({ items: (await externalCounterparties.list(trx, this.companyOf(p), limit)).map(counterpartyContract) }));
  }

  getCounterparty(state: RequestState, id: string) {
    return this.run(state, async (trx) => {
      const row = await externalCounterparties.get(trx, id);
      if (!row) throw new ApiError('access.not_found');
      return privateView({ counterparty: counterpartyContract(row) });
    });
  }

  createCounterparty(state: RequestState, body: In<typeof CreateCounterpartyBodySchema>) {
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      const via = await this.via(p, body.actor, 'maintain_records', company);
      const row = await externalCounterparties.create(trx, { companyId: company, name: body.name, identifiers: body.identifiers, contacts: body.contacts, source: 'manual' });
      await this.audit(trx, p, state, 'supplier_base.counterparty_created', 'external_counterparty', row.id, { source: 'manual', via }, company);
      return privateView({ counterparty: counterpartyContract(row) });
    });
  }

  updateCounterparty(state: RequestState, id: string, body: In<typeof UpdateCounterpartyBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      const via = await this.via(p, body.actor, 'maintain_records', company);
      const current = await externalCounterparties.get(trx, id);
      if (!current) throw new ApiError('access.not_found');
      const row = await externalCounterparties.update(trx, {
        id, name: body.name ?? current.name, identifiers: body.identifiers ?? (current.identifiers as unknown[]), contacts: body.contacts ?? (current.contacts as unknown[]), expectedRevision: body.expectedRevision,
      });
      const changed = (['name', 'identifiers', 'contacts'] as const).filter((f) => body[f] !== undefined);
      await this.audit(trx, p, state, 'supplier_base.counterparty_changed', 'external_counterparty', row.id, { fields: changed, via }, company);
      return privateView({ counterparty: counterpartyContract(row) });
    });
  }

  /* ---------- Assessments ---------- */

  listAssessments(state: RequestState, recordId: string) {
    return this.run(state, async (trx) => {
      await this.record(trx, recordId);
      return privateView({ items: (await supplierAssessments.listFor(trx, recordId, 100)).map(assessmentView) });
    });
  }

  draftAssessment(state: RequestState, recordId: string, body: In<typeof DraftAssessmentBodySchema>) {
    if (body.supplierRecordId !== recordId) throw new ApiError('validation.schema', 'supplierRecordId must match the path', { reason: 'record_mismatch' });
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      const via = await this.via(p, body.actor, 'prepare', company);
      const row = await supplierAssessments.draft(trx, { supplierRecordId: recordId, from: body.period.from, to: body.period.to, criteriaVersion: body.criteriaVersion, scores: body.scores });
      await this.audit(trx, p, state, 'supplier_base.assessment_drafted', 'supplier_assessment', row.id, { supplierRecordId: recordId, via }, company);
      return privateView({ assessment: assessmentView(row) });
    });
  }

  recordAssessment(state: RequestState, id: string, body: In<typeof RecordAssessmentBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    if (body.assessmentDraftId !== id) throw new ApiError('validation.schema', 'assessmentDraftId must match the path', { reason: 'assessment_mismatch' });
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      const draft = await supplierAssessments.get(trx, id);
      if (!draft) throw new ApiError('access.not_found');
      if (draft.supplier_record_id !== body.supplierRecordId) throw new ApiError('validation.schema', 'the draft belongs to another supplier record', { reason: 'record_mismatch' });
      const via = await this.via(p, body.actor, 'maintain_records', company);
      const row = await supplierAssessments.record(trx, { id, share: body.shareWithSupplier, expectedRevision: body.expectedRevision });
      await this.audit(trx, p, state, 'supplier_base.assessment_recorded', 'supplier_assessment', row.id, { supplierRecordId: row.supplier_record_id, shared: row.shared_with_supplier, via }, company);
      return privateView({ assessment: assessmentView(row) });
    });
  }

  /* ---------- The supplier's side of shared assessments ---------- */

  sharedWithMe(state: RequestState, limit: number) {
    return this.run(state, async (trx) => ({ audience: 'shared_party' as const, items: (await supplierAssessments.sharedWithMe(trx, limit)).map(sharedAssessmentView) }));
  }

  respond(state: RequestState, id: string, body: In<typeof RespondBodySchema>, idempotencyHeader?: string) {
    this.sameKey(body, idempotencyHeader);
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      const via = await this.via(p, body.actor, 'communicate', company);
      const row = await supplierAssessments.respond(trx, { id, response: body.response, expectedRevision: body.expectedRevision });
      await this.audit(trx, p, state, 'supplier_base.assessment_answered', 'supplier_assessment', row.id, { via }, company);
      return sharedAssessmentView(row);
    });
  }

  /* ---------- Import ---------- */

  importTemplate() {
    return { columns: IMPORT_COLUMNS, maxRows: MAX_IMPORT_ROWS, csv: IMPORT_TEMPLATE_CSV, formats: ['csv', 'xlsx'] };
  }

  /**
   * CSV or XLSX of existing suppliers: every valid row becomes one private external counterparty (source `import`) and
   * one private supplier record of the caller's company. All or nothing: a file with any row error creates nothing.
   * Names already in the base are skipped and reported. An import never creates a company, membership, claim, handle,
   * directory entry or any public record, and never contacts anybody.
   */
  importSuppliers(state: RequestState, body: In<typeof ImportBodySchema>) {
    let table: string[][];
    try {
      table = readImportFile(body.file);
    } catch (error) {
      if (error instanceof ImportFileError) throw new ApiError('validation.schema', 'the file cannot be read as a supplier list', { reason: 'import_file', detail: error.reason });
      throw error;
    }
    const mapped = mapImportRows(table);
    return this.run(state, async (trx, p) => {
      const company = this.companyOf(p);
      const via = await this.via(p, body.actor, 'maintain_records', company);
      if (!(await supplierRecords.mayManage(trx, company))) throw new ApiError('access.forbidden', 'the supplier base is maintained by members holding procurement.suppliers.manage', { reason: 'not_authorised' });
      const errors: ImportRowError[] = [...mapped.errors];
      const existing = await externalCounterparties.existingNameKeys(trx, company, mapped.rows.map((r) => nameKey(r.name)));
      const skipped = mapped.rows.filter((r) => existing.has(nameKey(r.name))).map((r) => ({ rowNumber: r.rowNumber, reason: 'already_listed' as const }));
      const toCreate = mapped.rows.filter((r) => !existing.has(nameKey(r.name)));
      if (errors.length > 0 || body.dryRun) {
        return privateView({ outcome: errors.length > 0 ? 'rejected' as const : 'previewed' as const, rows: Math.max(0, table.length - 1), created: 0, wouldCreate: errors.length > 0 ? 0 : toCreate.length, skipped, errors, recordIds: [] as string[], statusPendingApproval: [] as number[] });
      }
      const recordIds: string[] = [];
      // A status the company's supplier-status route reviews is imported as `prospect`; the person then changes it
      // through the route (an import never floods approvers with requests).
      const statusPendingApproval: number[] = [];
      for (const row of toCreate) {
        const reviewed = row.status !== 'prospect' && (await statusRoute(trx, company, row.status, row.categories)) !== null;
        if (reviewed) statusPendingApproval.push(row.rowNumber);
        const counterparty = await externalCounterparties.create(trx, { companyId: company, name: row.name, identifiers: row.identifiers, contacts: row.contacts, source: 'import' });
        const record = await supplierRecords.create(trx, {
          companyId: company, link: { kind: 'external_counterparty', id: counterparty.id }, status: reviewed ? 'prospect' : row.status, categories: row.categories, regions: row.regions,
          internalNotes: row.internalNotes, defaultPaymentTerms: row.defaultPaymentTerms, onboarding: [],
        });
        recordIds.push(record.id);
      }
      await this.audit(trx, p, state, 'supplier_base.imported', 'company', company, { format: body.file.format, rows: Math.max(0, table.length - 1), created: recordIds.length, skipped: skipped.length, via }, company);
      return privateView({ outcome: 'imported' as const, rows: Math.max(0, table.length - 1), created: recordIds.length, wouldCreate: recordIds.length, skipped, errors, recordIds, statusPendingApproval });
    });
  }
}
