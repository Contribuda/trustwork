import type { z } from 'zod';
import { COOLING_OFF_ACTIONS, type Capability, type Principal, type SecondFactorNoticeEvent } from '../../deps/contracts.js';
import { outbox, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import { hoursOf } from '../identity/mail.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { staffHubFromEnv } from '../identity/staff-roles.js';
import { randomToken, sha256Hex } from '../identity/tokens.js';
import {
  diagnosticSnapshots, serviceActions, supportAccess, supportCases, type AccountServiceActionRow, type CommandContext, type LookupKind, type SupportCaseRow,
} from './deps.js';
import { rethrowSupport } from './errors.js';
import { explainAccess } from './explainer.js';
import { UnavailableEntitlements, type SupportEntitlementsPort } from './ports.js';
import type {
  AccountCardQuerySchema, ExplainQuerySchema, LookupQuerySchema, OpenCaseCommandSchema, OpenOwnCaseSchema, OwnCaseUpdateSchema, OwnNoteSchema, PlainCommandSchema, RequestActionCommandSchema,
  ShareDiagnosticsSchema, StaffNoteCommandSchema, UpdateCaseCommandSchema,
} from './schemas.js';
import { actionView, caseView, noteView, ownActionView, ownCaseView, ownNoteView, snapshotView, toAccountCard } from './views.js';

type Cmd = z.infer<typeof PlainCommandSchema>;
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }

/**
 * Security notices of a servicing action on every verified address of the subject (template `security_notice`, the
 * worker renders `events.<event>` in the hub language; caused by staff, so no language preference is recorded).
 */
type SupportNoticeEvent = SecondFactorNoticeEvent | 'recovery_email_rebind_requested' | 'recovery_email_rebind_approved' | 'recovery_email_rebind_cancelled'
  | 'recovery_email_rebind_completed' | 'sessions_revoked_by_support' | 'password_reset_required' | 'account_unlocked' | 'support_guided_task';
const NOTICES: Readonly<Record<string, Partial<Record<'requested' | 'activated' | 'cancelled' | 'done', SupportNoticeEvent>>>> = {
  reset_second_factor: { requested: 'second_factor_reset_requested', activated: 'second_factor_reset_approved', cancelled: 'second_factor_reset_cancelled', done: 'second_factor_reset_completed' },
  rebind_recovery_email: { requested: 'recovery_email_rebind_requested', activated: 'recovery_email_rebind_approved', cancelled: 'recovery_email_rebind_cancelled', done: 'recovery_email_rebind_completed' },
  revoke_all_sessions: { done: 'sessions_revoked_by_support' },
  require_password_reset: { done: 'password_reset_required' },
  unlock_after_lockout: { done: 'account_unlocked' },
  send_guided_task: { done: 'support_guided_task' },
};
const isCooling = (action: string): boolean => (COOLING_OFF_ACTIONS as readonly string[]).includes(action);

/**
 * Support workspace use cases (SUP-001): support cases on someone's behalf and the requester's own path, lookup and the
 * allowlisted account card, servicing actions (sign-in factor changes with evidence, a second person and a 72-hour
 * cooling-off on the database clock), the access explainer (reason codes only) and diagnostic snapshots the person
 * shares from their own session.
 *
 * Every staff command runs in one `PrincipalService.runAs` transaction as the staff member through a SECURITY DEFINER
 * command with a `CommandContext` naming the live elevation the route guard verified; the database checks permission,
 * case, conflicts of interest, evidence and the second person, and writes the audit row in that same transaction (the
 * idempotency record completes there too, BE-005). Notices and outbox intents commit with the change. Nothing here
 * issues a session for another person or acts as them: there is no such code path to call.
 */
export class SupportService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly entitlements: SupportEntitlementsPort = new UnavailableEntitlements()) {}

  private get now(): Date {
    return this.ctx.clock.now();
  }

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: body.reasonCode ?? 'console_action', reasonText: body.reason };
  }
  /** A read that records itself (lookup, card, explainer): the context names the elevation and the staff reason. */
  private queryContext(e: Elevated, reason: string): CommandContext {
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'support_query', reasonText: reason };
  }

  private staff<T>(e: Elevated, ctx: CommandContext, fn: (trx: Transaction, p: Principal, cmd: CommandContext) => Promise<T>): Promise<T> {
    return this.principals.runAs(e.state, (trx, p) => fn(trx, p, ctx)).catch(rethrowSupport);
  }
  private participant<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(rethrowSupport);
  }

  private hub(explicit: string | undefined): string {
    const hub = explicit ?? staffHubFromEnv(process.env);
    if (!hub) throw new ApiError('validation.schema', 'this deployment serves no hub; name it', { reason: 'hub_required' });
    return hub;
  }

  private async intent(trx: Transaction, aggregate: { kind: string; id: string }, type: string, payload: Record<string, unknown>): Promise<void> {
    await outbox.append(trx, { aggregate_kind: aggregate.kind, aggregate_id: aggregate.id, revision: 1, type, payload });
  }

  /** Security notice on every verified address of the subject, for the given step of the action. */
  private async notify(trx: Transaction, row: AccountServiceActionRow, step: 'requested' | 'activated' | 'cancelled' | 'done'): Promise<void> {
    const event = NOTICES[row.action]?.[step];
    if (!event) return;
    for (const to of await serviceActions.addresses(trx, row.id, 'verified')) await this.ctx.mail.record(trx, { to, template: 'security_notice', params: { event } });
  }

  private async view(trx: Transaction, row: AccountServiceActionRow) {
    return actionView(row, row.action === 'rebind_recovery_email' ? await serviceActions.maskedEmail(trx, row.id) : null);
  }

  /* ---------- Support cases (staff) ---------- */

  openCase(e: Elevated, body: z.infer<typeof OpenCaseCommandSchema>) {
    return this.staff(e, this.commandContext(e, body), async (trx, _p, cmd) => {
      const row = await supportCases.open(trx, cmd, {
        hubId: this.hub(body.hubId), requesterPersonId: body.requesterPersonId, subject: body.subject, category: body.category, summary: body.summary, ...(body.urgency ? { priority: body.urgency } : {}),
      });
      await this.intent(trx, { kind: 'support_case', id: row.id }, 'support.case_opened', { hubId: row.hub_id, openedBy: 'staff' });
      return { case: caseView(row) };
    });
  }

  updateCase(e: Elevated, id: string, body: z.infer<typeof UpdateCaseCommandSchema>) {
    return this.staff(e, this.commandContext(e, body), async (trx, _p, cmd) => {
      const row = await supportCases.update(trx, cmd, id, {
        ...(body.status ? { status: body.status } : {}), ...(body.assignedTo ? { assignedTo: body.assignedTo } : {}), ...(body.urgency ? { priority: body.urgency } : {}),
        ...(body.resolutionCode ? { resolutionCode: body.resolutionCode } : {}),
      });
      await this.intent(trx, { kind: 'support_case', id: row.id }, 'support.case_updated', { status: row.status });
      return { case: caseView(row) };
    });
  }

  addNote(e: Elevated, id: string, body: z.infer<typeof StaffNoteCommandSchema>) {
    return this.staff(e, this.commandContext(e, body), async (trx, _p, cmd) => {
      const note = await supportCases.addNote(trx, cmd, id, body.body, body.visibility);
      if (body.visibility === 'requester') await this.intent(trx, { kind: 'support_case', id }, 'support.case_answered', { noteId: note.id });
      return { note: noteView(note) };
    });
  }

  /** Cases row-level security shows the staff member at their hubs, except their own requests. */
  cases(state: RequestState, status: SupportCaseRow['status'] | undefined) {
    return this.participant(state, async (trx, p) => {
      let query = trx.selectFrom('support_case').selectAll().where('requester_person_id', '<>', p.personId);
      if (status) query = query.where('status', '=', status);
      return { cases: (await query.orderBy('opened_at', 'desc').limit(200).execute()).map(caseView) };
    });
  }

  /** Staff view of one case: notes, servicing actions and the snapshots the requester shared. */
  caseDetail(state: RequestState, id: string) {
    return this.participant(state, async (trx, p) => {
      const row = await supportCases.get(trx, id);
      // Row-level security shows a case to its requester too; this route is the staff view.
      if (!row || row.requester_person_id === p.personId) throw new ApiError('access.not_found', 'case not found');
      const actions = await serviceActions.forCase(trx, id);
      return {
        case: caseView(row),
        notes: (await supportCases.notes(trx, id)).map(noteView),
        actions: await Promise.all(actions.map((a) => this.view(trx, a))),
        snapshots: (await diagnosticSnapshots.forCase(trx, id)).map(snapshotView),
      };
    });
  }

  /* ---------- Lookup, account card, explainer (recorded reads) ---------- */

  lookup(e: Elevated, body: z.infer<typeof LookupQuerySchema>) {
    return this.staff(e, this.queryContext(e, body.reason), async (trx, _p, cmd) => {
      const rows = await supportAccess.lookup(trx, cmd, { hubId: this.hub(body.hubId), caseId: body.caseId ?? null, kind: body.kind as LookupKind, value: body.value });
      return { results: rows.map((r) => ({ kind: r.kind, id: r.id, displayName: r.display_name })) };
    });
  }

  accountCard(e: Elevated, caseId: string, personId: string, body: z.infer<typeof AccountCardQuerySchema>) {
    return this.staff(e, this.queryContext(e, body.reason), async (trx, _p, cmd) => {
      const json = await supportAccess.accountCard(trx, cmd, caseId, personId, { threshold: this.ctx.config.lockout.accountThreshold, windowSeconds: this.ctx.config.lockout.windowSeconds });
      // Billing owns entitlements (payment neutrality); the card asks it through the port, after the database authorized the read.
      const entitlements = await this.entitlements.entitlementsOf(trx, personId, this.now);
      return { account: toAccountCard({ ...json, entitlements: entitlements ?? [] }), entitlementsAvailable: entitlements !== null };
    });
  }

  explain(e: Elevated, caseId: string, body: z.infer<typeof ExplainQuerySchema>) {
    return this.staff(e, this.queryContext(e, body.reason), async (trx, _p, cmd) => {
      const inputs = await supportAccess.explainInputs(trx, cmd, caseId, body.subjectPersonId, body.resource);
      return { explanation: explainAccess(body.subjectPersonId, inputs, body.resource, (body.capability ?? 'read.shared') as Capability, this.now) };
    });
  }

  /* ---------- Servicing actions (staff) ---------- */

  requestAction(e: Elevated, caseId: string, body: z.infer<typeof RequestActionCommandSchema>) {
    return this.staff(e, this.commandContext(e, body), async (trx, _p, cmd) => {
      const params: Record<string, unknown> = {};
      let token: string | null = null;
      if (body.action === 'rebind_recovery_email') params.newEmail = body.newEmail;
      if (body.action === 'send_guided_task') params.taskCode = body.taskCode;
      if (body.action === 'resend_verification') {
        token = randomToken();
        params.tokenHash = sha256Hex(token);
        params.expiresInSeconds = Math.round(this.ctx.config.tokens.verifyEmailMs / 1000);
      }
      const row = await serviceActions.request(trx, cmd, { caseId, subjectPersonId: body.subjectPersonId, action: body.action, evidenceRefs: body.evidenceRefs ?? [], params });
      if (token) {
        const expiresAt = new Date(this.now.getTime() + this.ctx.config.tokens.verifyEmailMs);
        // To the unverified address on file only, never to an address staff typed.
        for (const to of await serviceActions.addresses(trx, row.id, 'verification')) {
          await this.ctx.mail.record(trx, { to, template: 'verify_email', params: { hours: hoursOf(this.ctx.config.tokens.verifyEmailMs) }, secret: { token, expiresAt } });
        }
      }
      await this.notify(trx, row, isCooling(row.action) ? 'requested' : 'done');
      if (row.action === 'revoke_all_sessions' || row.action === 'require_password_reset') {
        await this.intent(trx, { kind: 'person', id: row.subject_person_id }, 'identity.sessions_revoked', { reason: 'support' });
      }
      if (row.action === 'reset_second_factor') await this.intent(trx, { kind: 'person', id: row.subject_person_id }, 'identity.second_factor_reset_requested', { serviceActionId: row.id });
      await this.intent(trx, { kind: 'account_service_action', id: row.id }, 'support.action_requested', { action: row.action, state: row.state, supportCaseId: row.support_case_id });
      return { action: await this.view(trx, row) };
    });
  }

  activateAction(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, this.commandContext(e, body), async (trx, _p, cmd) => {
      const row = await serviceActions.activate(trx, cmd, id);
      await this.notify(trx, row, 'activated');
      if (row.action === 'reset_second_factor') {
        await this.intent(trx, { kind: 'person', id: row.subject_person_id }, 'identity.second_factor_reset_approved', { serviceActionId: row.id, effectiveAt: row.effective_at.toISOString() });
      }
      await this.intent(trx, { kind: 'account_service_action', id: row.id }, 'support.action_cooling_off', { action: row.action, effectiveAt: row.effective_at.toISOString() });
      return { action: await this.view(trx, row) };
    });
  }

  executeAction(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, this.commandContext(e, body), async (trx, _p, cmd) => {
      const before = await serviceActions.get(trx, id);
      if (!before) throw new ApiError('access.not_found', 'action not found');
      const token = before.action === 'rebind_recovery_email' ? randomToken() : null;
      const row = await serviceActions.execute(trx, cmd, id, token ? { tokenHashHex: sha256Hex(token), validForSeconds: Math.round(this.ctx.config.tokens.emailChangeMs / 1000) } : null);
      if (token) {
        const expiresAt = new Date(this.now.getTime() + this.ctx.config.tokens.emailChangeMs);
        for (const to of await serviceActions.addresses(trx, row.id, 'new_email')) {
          await this.ctx.mail.record(trx, { to, template: 'email_change', params: { hours: hoursOf(this.ctx.config.tokens.emailChangeMs) }, secret: { token, expiresAt } });
        }
      }
      await this.notify(trx, row, 'done');
      if (row.action === 'reset_second_factor') {
        await this.intent(trx, { kind: 'person', id: row.subject_person_id }, 'identity.second_factor_reset_completed', { serviceActionId: row.id });
        await this.intent(trx, { kind: 'person', id: row.subject_person_id }, 'identity.sessions_revoked', { reason: 'second_factor_reset' });
      }
      await this.intent(trx, { kind: 'account_service_action', id: row.id }, 'support.action_done', { action: row.action });
      return { action: await this.view(trx, row) };
    });
  }

  cancelAction(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, this.commandContext(e, body), async (trx, _p, cmd) => {
      const row = await serviceActions.cancel(trx, cmd, id);
      await this.notify(trx, row, 'cancelled');
      await this.intent(trx, { kind: 'account_service_action', id: row.id }, 'support.action_cancelled', { action: row.action, by: 'staff' });
      return { action: await this.view(trx, row) };
    });
  }

  action(state: RequestState, id: string) {
    return this.participant(state, async (trx, p) => {
      const row = await serviceActions.get(trx, id);
      if (!row || row.subject_person_id === p.personId) throw new ApiError('access.not_found', 'action not found');
      return { action: await this.view(trx, row) };
    });
  }

  /* ---------- Participant path ---------- */

  openOwnCase(state: RequestState, body: z.infer<typeof OpenOwnCaseSchema>) {
    return this.participant(state, async (trx) => {
      const row = await supportCases.openOwn(trx, { hubId: this.hub(body.hubId), forCompany: body.forCompany ?? false, category: body.category, summary: body.summary });
      await this.intent(trx, { kind: 'support_case', id: row.id }, 'support.case_opened', { hubId: row.hub_id, openedBy: 'requester' });
      return { case: ownCaseView(row) };
    });
  }

  ownCases(state: RequestState) {
    return this.participant(state, async (trx, p) => ({
      cases: (await trx.selectFrom('support_case').selectAll().where('requester_person_id', '=', p.personId).orderBy('opened_at', 'desc').limit(200).execute()).map(ownCaseView),
    }));
  }

  ownCase(state: RequestState, id: string) {
    return this.participant(state, async (trx, p) => {
      const row = await supportCases.get(trx, id);
      if (!row || row.requester_person_id !== p.personId) throw new ApiError('access.not_found', 'case not found');
      // Row-level security returns only the notes visible to the requester.
      const notes = (await supportCases.notes(trx, id)).filter((n) => n.visibility === 'requester');
      return { case: ownCaseView(row), notes: notes.map((n) => ownNoteView(n, p.personId)) };
    });
  }

  ownNote(state: RequestState, id: string, body: z.infer<typeof OwnNoteSchema>) {
    return this.participant(state, async (trx, p) => {
      const note = await supportCases.addRequesterNote(trx, id, body.body);
      await this.intent(trx, { kind: 'support_case', id }, 'support.requester_replied', { noteId: note.id });
      return { note: ownNoteView(note, p.personId) };
    });
  }

  ownCaseUpdate(state: RequestState, id: string, body: z.infer<typeof OwnCaseUpdateSchema>) {
    return this.participant(state, async (trx) => ({ case: ownCaseView(await supportCases.requesterUpdate(trx, id, body.status)) }));
  }

  shareDiagnostics(state: RequestState, id: string, body: z.infer<typeof ShareDiagnosticsSchema>) {
    return this.participant(state, async (trx) => {
      const row = await diagnosticSnapshots.share(trx, {
        caseId: id, pageId: body.pageId, appVersion: body.appVersion, locale: body.locale ?? null, featureFlags: body.featureFlags ?? [], errorCodes: body.errorCodes ?? [],
        requestIds: body.requestIds ?? [], objects: body.objects ?? [],
      });
      await this.intent(trx, { kind: 'support_case', id }, 'support.diagnostics_shared', { snapshotId: row.id });
      return { snapshot: snapshotView(row) };
    });
  }

  /** Servicing actions on the caller's own account, newest first: what support did or asked, and what can still be stopped. */
  ownActions(state: RequestState) {
    return this.participant(state, async (trx, p) => {
      const rows = await serviceActions.forSubject(trx, p.personId);
      return { actions: await Promise.all(rows.map(async (r) => ownActionView(r, r.action === 'rebind_recovery_email' ? await serviceActions.maskedEmail(trx, r.id) : null))) };
    });
  }

  /** The subject stops a change of their own sign-in factors before it takes effect. */
  cancelOwnAction(state: RequestState, id: string) {
    return this.participant(state, async (trx) => {
      const row = await serviceActions.cancelOwn(trx, id);
      await this.notify(trx, row, 'cancelled');
      if (row.action === 'reset_second_factor') await this.intent(trx, { kind: 'person', id: row.subject_person_id }, 'identity.second_factor_reset_cancelled', { serviceActionId: row.id });
      await this.intent(trx, { kind: 'account_service_action', id: row.id }, 'support.action_cancelled', { action: row.action, by: 'subject' });
      return { action: ownActionView(row, row.action === 'rebind_recovery_email' ? await serviceActions.maskedEmail(trx, row.id) : null) };
    });
  }

  /** When support looked at the caller's account and for which case; never who. */
  ownAccessRecords(state: RequestState) {
    return this.participant(state, async (trx) => ({
      records: (await supportAccess.own(trx)).map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), kind: r.kind, supportCaseId: r.support_case_id })),
    }));
  }
}
