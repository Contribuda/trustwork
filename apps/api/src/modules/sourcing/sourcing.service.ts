import type { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { Principal, RfqVersionPayload } from '../../deps/contracts.js';
import { auditEvents, type Transaction } from '../../deps/data.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import type { SupplierScreeningPort } from '../supplier-base/screening.js';
import {
  eligibilityRules, levelSheets, quoteVersions, rfqInvitations, rfqs, rfqVersions, sourcingAccess, supplierRecords, type BidLevelSheetPayload, type BidLevelSheetVersionRow, type QuoteVersionRow,
  type RfqRow, type RfqVersionRow,
} from './deps.js';
import { evaluateRules, orderCandidates, overall, type PrequalificationEvidencePort } from './eligibility.js';
import { sourcingRefusal } from './errors.js';
import { checkedPayload, sheetDigest, sheetTemplate } from './levelling.js';
import type { SourcingMandateCheck, SourcingMandatePort } from './mandates.js';
import { EligibilityRuleSchema, type DraftSheetBodySchema, type FreezeSheetBodySchema, type SaveEligibilityBodySchema, type SaveSheetBodySchema } from './schemas.js';
import { partyOfOwner, privateView, sheetVersionContract, sheetVersionView } from './views.js';

type In<T extends z.ZodType> = z.infer<T>;
type Actor = { via: 'person' } | { via: 'agent'; mandateId: string };
const iso = (value: Date | string): string => new Date(value).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many supplier records one candidate list reads; a longer base is filtered in the supplier base first. */
const MAX_CANDIDATES = 200;

/**
 * Sourcing events (PRC-004): buyer-private levelling sheets over pinned quote versions and eligibility rules. A sourcing
 * event is an RFQ with its invitations, quotes, levelling and award; no new top-level object exists. Every mutation runs
 * in one principal transaction with its audit row and completes its idempotency record there (BE-005). The database
 * repeats every rule (`sourcing_*` commands, row-level security): only the buyer side reads, the people holding
 * procurement.sourcing.run write, pins are checked against the stored versions, and a frozen version never changes.
 *
 * Nothing here appends an outbox event, so a sheet cannot reach a notification, an index, a federation feed or a
 * statistic. Audit rows carry identifiers only, never a price or an estimate.
 */
export class SourcingService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: SourcingMandatePort,
    private readonly screening: SupplierScreeningPort,
    private readonly prequalification: PrequalificationEvidencePort,
  ) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(sourcingRefusal);
  }

  private async mandate(principal: Principal, actor: Actor, action: SourcingMandateCheck['action'], rfqId: string): Promise<string | null> {
    if (actor.via === 'person') return null;
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: actor.mandateId, action, context: { kind: 'rfq', id: rfqId }, amount: null, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this RFQ`, { reason: 'mandate_scope' });
    return actor.mandateId;
  }

  private audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: Record<string, unknown>, rfq: RfqRow): Promise<void> {
    return auditEvents.append(trx, {
      actor_person_id: principal.personId, on_behalf_of_company_id: rfq.owner_company_id, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId,
      authz_epoch: principal.authzEpoch, basis,
    });
  }

  /** The RFQ for the buyer side; everybody else, the seller included, does not find it. */
  private async buyerRfq(trx: Transaction, rfqId: string): Promise<RfqRow> {
    if (!UUID.test(rfqId) || !(await sourcingAccess.reader(trx, rfqId))) throw new ApiError('access.not_found');
    const row = await rfqs.get(trx, rfqId);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  private async currentVersion(trx: Transaction, rfq: RfqRow): Promise<RfqVersionRow> {
    if (rfq.current_version_id === null) throw new ApiError('validation.schema', 'the RFQ has no published version yet', { reason: 'not_published' });
    const row = await rfqVersions.get(trx, rfq.current_version_id);
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  /** Sent versions the principal may read on this RFQ, by id. During the seal the buyer side reads none. */
  private async storedVersions(trx: Transaction, rfqId: string): Promise<Map<string, QuoteVersionRow>> {
    const rows = await quoteVersions.listForRfq(trx, rfqId);
    return new Map(rows.filter((r) => r.status !== 'draft').map((r) => [r.id, r]));
  }

  private async requireOpen(trx: Transaction, rfqId: string): Promise<void> {
    if (await sourcingAccess.sealed(trx, rfqId)) throw new ApiError('access.forbidden', 'quotes stay sealed until the response deadline', { reason: 'sealed_until_deadline' });
  }

  private async sheetVersionRow(trx: Transaction, versionId: string): Promise<BidLevelSheetVersionRow> {
    const row = UUID.test(versionId) ? await levelSheets.version(trx, versionId) : undefined;
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  /* ---------- The event ---------- */

  /** What the buyer side reads about its event: the seal, the eligibility rules and the sheet's versions. */
  getEvent(state: RequestState, rfqId: string) {
    return this.run(state, async (trx) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      const [until, sealed, rules, sheet] = await Promise.all([sourcingAccess.sealedUntil(trx, rfq.id), sourcingAccess.sealed(trx, rfq.id), eligibilityRules.get(trx, rfq.id), levelSheets.forRfq(trx, rfq.id)]);
      const versions = sheet ? await levelSheets.versions(trx, sheet.id) : [];
      const stored = await this.storedVersions(trx, rfq.id);
      const now = this.now();
      return privateView({
        rfqId: rfq.id, owner: partyOfOwner(rfq), rfqStatus: rfq.status,
        seal: { sealedUntil: until ? iso(until) : null, sealed },
        eligibility: rules ? { rules: EligibilityRuleSchema.array().parse(rules.rules), revision: rules.revision } : null,
        sheet: sheet ? { id: sheet.id, currentVersionId: sheet.current_version_id, versions: versions.map((v) => sheetVersionView(v, stored, now)) } : null,
      });
    });
  }

  /* ---------- Eligibility and invitation candidates ---------- */

  saveEligibility(state: RequestState, rfqId: string, body: In<typeof SaveEligibilityBodySchema>) {
    return this.run(state, async (trx, p) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      await this.mandate(p, body.actor, 'prepare', rfq.id);
      const row = await eligibilityRules.save(trx, { rfqId: rfq.id, rules: body.rules, expectedRevision: body.expectedRevision });
      await this.audit(trx, p, state, 'sourcing.eligibility_saved', 'rfq', rfq.id, { rules: body.rules.length, via: body.actor.via }, rfq);
      return privateView({ rules: EligibilityRuleSchema.array().parse(row.rules), revision: row.revision });
    });
  }

  /**
   * Suppliers of the buyer's own base to invite, with pass, fail or unknown per rule. Blocked and archived suppliers are
   * not offered. The order is `orderCandidates`: it reads no plan, entitlement or sponsorship.
   */
  listCandidates(state: RequestState, rfqId: string) {
    return this.run(state, async (trx) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      const company = rfq.owner_company_id;
      if (company === null) throw new ApiError('validation.schema', 'the supplier base belongs to a company', { reason: 'company_buyer_required' });
      const rules = EligibilityRuleSchema.array().parse((await eligibilityRules.get(trx, rfq.id))?.rules ?? []);
      const [records, invitations] = await Promise.all([supplierRecords.list(trx, { companyId: company, status: null, limit: MAX_CANDIDATES }), rfqInvitations.listForRfq(trx, rfq.id)]);
      const invited = new Set(invitations.filter((i) => i.rfq_version_id === rfq.current_version_id && i.party_company_id !== null).map((i) => i.party_company_id));
      const now = this.now();
      const items = [];
      for (const record of records) {
        if (record.status === 'blocked' || record.status === 'archived') continue;
        const evaluations = await evaluateRules(trx, { rules, record, buyerCompanyId: company, screening: this.screening, prequalification: this.prequalification, now });
        items.push({
          supplierRecordId: record.id, party: record.linked_company_id ? { kind: 'company' as const, id: record.linked_company_id } : null, invitable: record.linked_company_id !== null,
          invited: record.linked_company_id !== null && invited.has(record.linked_company_id), status: record.status, createdAt: iso(record.created_at),
          eligibility: overall(evaluations.map((e) => e.result)), rules: evaluations,
        });
      }
      return privateView({ rfqId: rfq.id, candidates: orderCandidates(items) });
    });
  }

  /* ---------- Levelling ---------- */

  /** A payload to start from: every sent version with the cells its quote states, and no estimates. Nothing is stored. */
  sheetTemplate(state: RequestState, rfqId: string) {
    return this.run(state, async (trx) => {
      const rfq = await this.buyerRfq(trx, rfqId);
      await this.requireOpen(trx, rfq.id);
      const current = await this.currentVersion(trx, rfq);
      const stored = [...(await this.storedVersions(trx, rfq.id)).values()].filter((v) => v.status === 'sent' || v.status === 'accepted');
      if (stored.length === 0) throw new ApiError('validation.schema', 'no quote to level yet', { reason: 'no_quotes' });
      return privateView({ rfqVersionId: current.id, payload: sheetTemplate(current.id, current.payload as RfqVersionPayload, stored, this.now()) });
    });
  }

  private async validated(trx: Transaction, rfqId: string, rfqVersion: RfqVersionRow, payload: BidLevelSheetPayload): Promise<{ payload: BidLevelSheetPayload; stored: Map<string, QuoteVersionRow> }> {
    await this.requireOpen(trx, rfqId);
    const stored = await this.storedVersions(trx, rfqId);
    return { payload: checkedPayload(payload, rfqVersion.id, rfqVersion.payload as RfqVersionPayload, stored, this.now()), stored };
  }

  openSheetDraft(state: RequestState, rfqId: string, body: In<typeof DraftSheetBodySchema>) {
    return this.run(state, async (trx, p) => {
      if (body.rfqId !== rfqId) throw new ApiError('validation.schema', 'the body names another RFQ', { reason: 'rfq_mismatch' });
      const rfq = await this.buyerRfq(trx, rfqId);
      const mandateId = await this.mandate(p, body.actor, 'prepare', rfq.id);
      const rfqVersion = await rfqVersions.get(trx, body.rfqVersionId);
      if (!rfqVersion || rfqVersion.rfq_id !== rfq.id) throw new ApiError('access.not_found');
      const { payload, stored } = await this.validated(trx, rfq.id, rfqVersion, body.payload);
      const row = await levelSheets.openDraft(trx, { rfqId: rfq.id, rfqVersionId: rfqVersion.id, payload, digest: sheetDigest(rfqVersion.id, payload).value, mandateId });
      await this.audit(trx, p, state, 'sourcing.sheet_drafted', 'bid_level_sheet_version', row.id, { rfqId: rfq.id, version: row.version, via: body.actor.via, mandateId }, rfq);
      return sheetVersionView(row, stored, this.now());
    });
  }

  getSheetVersion(state: RequestState, versionId: string) {
    return this.run(state, async (trx) => {
      const row = await this.sheetVersionRow(trx, versionId);
      return sheetVersionView(row, await this.storedVersions(trx, row.rfq_id), this.now());
    });
  }

  saveSheetDraft(state: RequestState, versionId: string, body: In<typeof SaveSheetBodySchema>) {
    return this.run(state, async (trx, p) => {
      const current = await this.sheetVersionRow(trx, versionId);
      const rfq = await this.buyerRfq(trx, current.rfq_id);
      const mandateId = await this.mandate(p, body.actor, 'prepare', rfq.id);
      const rfqVersion = await rfqVersions.get(trx, current.rfq_version_id);
      if (!rfqVersion) throw new ApiError('access.not_found');
      const { payload, stored } = await this.validated(trx, rfq.id, rfqVersion, body.payload);
      const row = await levelSheets.saveDraft(trx, { versionId, payload, digest: sheetDigest(rfqVersion.id, payload).value, expectedRevision: body.expectedRevision, mandateId });
      await this.audit(trx, p, state, 'sourcing.sheet_saved', 'bid_level_sheet_version', row.id, { rfqId: rfq.id, version: row.version, via: body.actor.via, mandateId }, rfq);
      return sheetVersionView(row, stored, this.now());
    });
  }

  /** Freezes the draft the caller reviewed. A column whose quote changed since the last save is refused: save first. */
  freezeSheet(state: RequestState, versionId: string, body: In<typeof FreezeSheetBodySchema>) {
    return this.run(state, async (trx, p) => {
      const current = await this.sheetVersionRow(trx, versionId);
      const rfq = await this.buyerRfq(trx, current.rfq_id);
      await this.mandate(p, body.actor, 'prepare', rfq.id);
      const version = sheetVersionContract(current);
      if (sheetDigest(version.rfqVersionId, version.payload).value !== current.digest) throw new ApiError('commercial.digest_mismatch', 'the stored sheet no longer reproduces its digest', { reason: 'digest_mismatch' });
      const row = await levelSheets.freeze(trx, { versionId, digest: body.digest.value, expectedRevision: body.expectedRevision });
      await this.audit(trx, p, state, 'sourcing.sheet_frozen', 'bid_level_sheet_version', row.id, { rfqId: rfq.id, version: row.version, digest: row.digest, via: body.actor.via }, rfq);
      return sheetVersionView(row, await this.storedVersions(trx, rfq.id), this.now());
    });
  }
}
