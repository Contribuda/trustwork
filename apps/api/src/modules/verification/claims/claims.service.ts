import type { z } from 'zod';
import { withPrincipal, type Transaction } from '../../../deps/data.js';
import { withoutPrincipal } from '../../../common/db.js';
import type { ConsolePermission, Principal } from '../../../deps/contracts.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { CommunicationsService } from '../../communications/communications.service.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { staffHubFromEnv } from '../../identity/staff-roles.js';
import type {
  AddRecordCommandSchema, BindEvidenceCommandSchema, ClaimSettingsCommandSchema, ConfirmDisputeCommandSchema, DecideClaimCommandSchema, ProposeDisputeCommandSchema, RecheckVerificationCommandSchema, RevokeHandoverCommandSchema, SetProfileCommandSchema,
  SourceRecordCommandSchema, SubmitClaimCommandSchema, VerifyIdentifierCommandSchema,
} from './commands.js';
import { adminAudit, claims, type ClaimState, type CommandContext, type RecordKind, type StaffRole } from './deps.js';
import { claimsRefusal, isAuthorityRefusal } from './errors.js';
import { IdentifierKinds } from './identifier-kinds.js';
import { toBadge, toClaim, toDispute, toHandover, toOwnClaim, toOwnHandover, toOwnVerification, toRecipe, toSettings, toVerification } from './views.js';

type Body<S extends z.ZodType> = z.infer<S>;
type Cmd = { idempotencyKey: string; reason: string };
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string; permission: ConsolePermission; action: string; objectType: string; objectId: string }

/**
 * Company claims (CLM-001). Every rule lives in the database: the claimant's commands check the principal, staff
 * commands check the permission at the hub and the elevation and write the audit row, and two reviewers for a dispute,
 * the waiting period and the cooling period hold there whatever calls them. This service adds the transaction, the
 * check that a row belongs to the hub in the path (a row of another hub answers "not found"), the projections, and the
 * e-mail of the notices the commands raised: rendered and enqueued before COMMIT, so a crash loses neither.
 * Refusals of authority leave a `denied` audit row in a transaction of their own.
 */
export class ClaimsService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly notices: Pick<CommunicationsService, 'deliverPlanned'>, private readonly env: NodeJS.ProcessEnv = process.env, private readonly kinds: IdentifierKinds = new IdentifierKinds()) {}

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }

  private async sendNotices(trx: Transaction): Promise<void> {
    await this.notices.deliverPlanned(trx, await claims.plannedDeliveries(trx));
  }

  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt, fn: (trx: Transaction, cmd: CommandContext) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, async (trx) => {
        const result = await fn(trx, cmd);
        await this.sendNotices(trx);
        return result;
      });
    } catch (error) {
      const refusal = claimsRefusal(error);
      if (refusal && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('claims.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw claimsRefusal(error) ?? error;
    });
  }

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
        action: attempt.action, objectType: attempt.objectType, objectId: attempt.objectId, reasonCode: `denied_${reason}`.slice(0, 64).replace(/[^a-z0-9_]/g, '_'), reasonText: cmd.reasonText,
        outcome: 'denied', requestId: cmd.requestId,
      });
    });
  }

  private static ofHub<T extends { hub_id: string }>(row: T | undefined, hubId: string): T {
    if (!row || row.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return row;
  }

  /* ---------- Public ---------- */

  /** The badges of the hub this API serves: categories and dates. Nobody needs a session; no hub, no badges. */
  async badges(companyId: string, hubId: string | null = staffHubFromEnv(this.env)) {
    if (!hubId) return { items: [] };
    return { items: (await withoutPrincipal(this.ctx.pool, (trx) => claims.publicBadges(trx, hubId, companyId))).map(toBadge) };
  }

  /** What anyone may read about a company: identifiers, registrations, public branches and the fields it chose to show. */
  async publicRecords(companyId: string) {
    const records = await withoutPrincipal(this.ctx.pool, (trx) => claims.publicRecords(trx, companyId)) as { identifiers: Array<{ kind: string }> };
    // The table says private for what the API recorded; a value from the old column is held to the pack here as well.
    return { ...records, identifiers: records.identifiers.filter((i) => !this.kinds.isPrivate(i.kind)) };
  }

  /* ---------- The company ---------- */

  private checkIdentifier(record: { kind: string; identifierKind?: string; value?: string }): void {
    if (record.kind === 'identifier' && !this.kinds.accepts(record.identifierKind as string, record.value as string)) {
      throw new ApiError('validation.schema', 'the value does not fit the identifier kind of the country pack', { reason: 'identifier_invalid' });
    }
  }

  /** Whether a value may be public comes from the country pack, never from the request. */
  private withPrivacy<T extends { kind: string; identifierKind?: string }>(record: T): T & { private?: boolean } {
    return record.kind === 'identifier' ? { ...record, private: this.kinds.isPrivate(record.identifierKind as string) } : record;
  }

  companyRecords(state: RequestState, companyId: string) {
    return this.read(state, (trx) => claims.companyRecords(trx, companyId));
  }

  addRecord(state: RequestState, companyId: string, body: Body<typeof AddRecordCommandSchema>) {
    this.checkIdentifier(body);
    return this.read(state, async (trx) => ({ record: { kind: body.kind, id: await claims.addRecord(trx, companyId, body.kind, this.withPrivacy(body)) } }));
  }

  retireRecord(state: RequestState, companyId: string, kind: RecordKind, recordId: string) {
    return this.read(state, async (trx) => {
      await claims.retireRecord(trx, companyId, kind, recordId);
      return { record: { kind, id: recordId, retired: true } };
    });
  }

  setProfile(state: RequestState, companyId: string, body: Body<typeof SetProfileCommandSchema>) {
    return this.read(state, async (trx) => {
      const row = await claims.setProfile(trx, companyId, body);
      return { profile: { legalForm: row.legal_form, websiteUrl: row.website_url, regionCode: row.region_code, categories: row.categories, publicFields: row.public_fields, revision: row.revision } };
    });
  }

  /* ---------- The claimant ---------- */

  recipes(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ items: (await claims.activeRecipes(trx, hubId)).map(toRecipe) }));
  }

  own(state: RequestState) {
    return this.read(state, async (trx, p) => ({
      claims: (await claims.own(trx, p.personId)).map(toOwnClaim),
      handovers: (await claims.ownHandovers(trx, p.personId)).map(toOwnHandover),
    }));
  }

  /** Submission changes nothing on the page: no status, no role. It enters the claim, the screening and the notices. */
  submit(state: RequestState, body: Body<typeof SubmitClaimCommandSchema>) {
    return this.read(state, async (trx) => {
      const row = await claims.submit(trx, body.hubId, body.companyId, body.level, body.recipeId, body.tie);
      await this.sendNotices(trx);
      return { claim: toOwnClaim(row) };
    });
  }

  withdraw(state: RequestState, claimId: string) {
    return this.read(state, async (trx) => {
      const row = await claims.withdraw(trx, claimId);
      await this.sendNotices(trx);
      return { claim: toOwnClaim(row) };
    });
  }

  /* ---------- Staff reads ---------- */

  /**
   * A staff role does not lift what a claimant may see of their own case: their own claims and hand-overs keep the
   * claimant's projection, and a dispute they are a party to, with the other claims in it, is not theirs to read here.
   */
  overview(state: RequestState, hubId: string, claimState: ClaimState | null) {
    return this.read(state, async (trx, p) => {
      const parties = new Set((await claims.own(trx, p.personId)).map((c) => c.dispute_id).filter((id) => id !== null));
      return {
        claims: (await claims.list(trx, hubId, claimState)).filter((c) => c.claimant_id === p.personId || c.dispute_id === null || !parties.has(c.dispute_id))
          .map((c) => (c.claimant_id === p.personId ? toOwnClaim(c) : toClaim(c))),
        disputes: (await claims.disputes(trx, hubId)).filter((d) => !parties.has(d.id)).map(toDispute),
        settings: toSettings(hubId, await claims.settings(trx, hubId)),
      };
    });
  }

  claim(state: RequestState, hubId: string, claimId: string) {
    return this.read(state, async (trx, p) => {
      const row = ClaimsService.ofHub(await claims.get(trx, claimId), hubId);
      if (row.claimant_id === p.personId) return { claim: toOwnClaim(row) };
      if (row.dispute_id !== null && (await claims.own(trx, p.personId)).some((c) => c.dispute_id === row.dispute_id)) throw new ApiError('access.not_found', 'access.not_found');
      return { claim: { ...toClaim(row), evidence: await claims.evidence(trx, claimId) } };
    });
  }

  handovers(state: RequestState, hubId: string, companyId: string | null) {
    return this.read(state, async (trx, p) => {
      const rows = companyId ? (await claims.handovers(trx, companyId)).filter((h) => h.hub_id === hubId) : await claims.hubHandovers(trx, hubId);
      return { items: rows.map((h) => (h.person_id === p.personId ? toOwnHandover(h) : toHandover(h))) };
    });
  }

  verifications(state: RequestState, hubId: string, filter: { companyId?: string; dueDays?: number }) {
    return this.read(state, async (trx, p) => {
      const own = new Set((await claims.ownHandovers(trx, p.personId)).map((h) => h.id));
      return { items: (await claims.verifications(trx, hubId, filter)).map((v) => (own.has(v.handover_id) ? toOwnVerification(v) : toVerification(v))) };
    });
  }

  /** Private records need an open claim or case of the company at this hub, and each read is audited in the database. */
  staffRecords(e: Elevated, hubId: string, companyId: string) {
    const reason = 'Read company records for an open claim or case';
    return this.staff(e, { idempotencyKey: '', reason }, { hubId, permission: 'admin.claims.read', action: 'claims.records_read', objectType: 'company', objectId: companyId },
      (trx, cmd) => claims.staffRecords(trx, cmd, hubId, companyId));
  }

  /* ---------- Staff commands ---------- */

  decide(e: Elevated, hubId: string, claimId: string, body: Body<typeof DecideClaimCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: `claims.${body.decision}`, objectType: 'company_claim', objectId: claimId }, async (trx, cmd) => {
      ClaimsService.ofHub(await claims.get(trx, claimId), hubId);
      return { claim: toClaim(await claims.decide(trx, cmd, claimId, body.expectedRevision, body.decision, body.officerMatch, body.note)) };
    });
  }

  bindEvidence(e: Elevated, hubId: string, claimId: string, body: Body<typeof BindEvidenceCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'claims.evidence_bound', objectType: 'company_claim', objectId: claimId }, async (trx, cmd) => {
      ClaimsService.ofHub(await claims.get(trx, claimId), hubId);
      await claims.bindEvidence(trx, cmd, claimId, body.checkIds);
      return { evidence: await claims.evidence(trx, claimId) };
    });
  }

  proposeDispute(e: Elevated, hubId: string, disputeId: string, body: Body<typeof ProposeDisputeCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'claims.dispute_proposed', objectType: 'claim_dispute', objectId: disputeId }, async (trx, cmd) => {
      ClaimsService.ofHub(await claims.dispute(trx, disputeId), hubId);
      return { dispute: toDispute(await claims.proposeDispute(trx, cmd, disputeId, body.expectedRevision, body.winnerClaimId, body.note)) };
    });
  }

  confirmDispute(e: Elevated, hubId: string, disputeId: string, body: Body<typeof ConfirmDisputeCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'claims.dispute_decided', objectType: 'claim_dispute', objectId: disputeId }, async (trx, cmd) => {
      ClaimsService.ofHub(await claims.dispute(trx, disputeId), hubId);
      return { dispute: toDispute(await claims.confirmDispute(trx, cmd, disputeId, body.expectedRevision)) };
    });
  }

  revoke(e: Elevated, hubId: string, handoverId: string, body: Body<typeof RevokeHandoverCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.revoke', action: 'claims.revoked', objectType: 'company_handover', objectId: handoverId }, async (trx, cmd) => {
      ClaimsService.ofHub(await claims.handover(trx, handoverId), hubId);
      return { handover: toHandover(await claims.revoke(trx, cmd, handoverId, body.revocationReason)) };
    });
  }

  recheck(e: Elevated, hubId: string, verificationId: string, body: Body<typeof RecheckVerificationCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'claims.rechecked', objectType: 'company_verification', objectId: verificationId }, async (trx, cmd) => {
      ClaimsService.ofHub(await claims.verification(trx, verificationId), hubId);
      return { verification: toVerification(await claims.recheck(trx, cmd, verificationId, body.recipeId)) };
    });
  }

  sourceRecord(e: Elevated, hubId: string, companyId: string, body: Body<typeof SourceRecordCommandSchema>) {
    this.checkIdentifier(body.record);
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'claims.record_sourced', objectType: 'company', objectId: companyId },
      async (trx, cmd) => ({ record: { kind: body.record.kind, id: await claims.sourceRecord(trx, cmd, hubId, companyId, body.record.kind, this.withPrivacy(body.record), body.sourceRef) } }));
  }

  /** The label on the identifier is all that changes: a badge comes only from a claim decision. */
  verifyIdentifier(e: Elevated, hubId: string, identifierId: string, body: Body<typeof VerifyIdentifierCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.decide', action: 'claims.identifier_verified', objectType: 'company_identifier', objectId: identifierId }, async (trx, cmd) => {
      const row = await claims.verifyIdentifier(trx, cmd, hubId, identifierId, body.expectedRevision, body.checkId);
      return { identifier: { id: row.id, kind: row.kind, value: row.value, status: row.status, revision: row.revision } };
    });
  }

  setSettings(e: Elevated, hubId: string, body: Body<typeof ClaimSettingsCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.claims.policy.edit', action: 'claims.settings_set', objectType: 'claims_settings', objectId: hubId },
      async (trx, cmd) => ({ settings: toSettings(hubId, await claims.setSettings(trx, cmd, hubId, body.waitingDays, body.coolingDays)) }));
  }
}
