import { CASE_GRANT_MAX_HOURS, ProjectionClassSchema, type ConsolePermission, type ConsoleSecondPersonAction } from '@trustwork/contracts/client';
import { holdsAny } from '../../../_data/commands.js';
import { accepted, guard, NOT_FOUND, oneOf, reject, type SectionCommandContext, type SectionCommandInput, type SectionOutcome } from '../participants/_section-command.js';
import { CASE_REASONS, GRANT_OBJECT_TYPES, GUIDED_TASKS, SERVICE_ACTIONS, supportOf, type GrantRequest, type RecoveryRequest } from './_fixtures.js';

/**
 * Support commands (HC-30 to HC-35, HUBC-004; docs/engine/hub-console/support.md). There is no command that creates a
 * session for another person, signs in as them or acts with their authority, and none that manages a participant's
 * own agent, mandates, settings, goals or connections (ADR 010 decision 25). What support can do instead:
 *
 * - servicing actions on an account, tied to an open case about that account, never on one's own account, never on an
 *   erased one; changing how someone signs in (recovery e-mail, second factor) needs evidence, a different approver
 *   and a 72-hour cooling-off during which every verified channel is told and an objection cancels it;
 * - case grants: named objects (1 to 100 ids of one type), a projection class, a purpose and at most 72 hours,
 *   approved by a different person who restates the request digest; reads are logged and private field classes are
 *   always excluded.
 */

export const COOLING_OFF_HOURS = 72;

const SERVICE_PERMISSIONS: Record<(typeof SERVICE_ACTIONS)[number], readonly ConsolePermission[]> = {
  resend_verification: ['admin.support.diagnose'],
  unlock_after_lockout: ['admin.support.diagnose'],
  require_password_reset: ['admin.support.diagnose'],
  send_guided_task: ['admin.support.diagnose'],
  revoke_all_sessions: ['admin.support.sessions.revoke'],
  rebind_recovery_email: ['admin.support.diagnose'],
  reset_second_factor: ['admin.support.diagnose'],
  start_data_export: ['admin.support.case.create'],
  open_deletion_request: ['admin.support.case.create'],
};
const SECOND_PERSON: Record<RecoveryRequest['action'], ConsoleSecondPersonAction> = { rebind_recovery_email: 'support.rebind_recovery_email', reset_second_factor: 'support.reset_second_factor' };
/** Who may approve a sign-in factor change (the console's `APPROVER_PERMISSIONS` for these two actions). */
export const RECOVERY_APPROVER: Record<RecoveryRequest['action'], ConsolePermission> = { rebind_recovery_email: 'admin.support.recovery.approve', reset_second_factor: 'admin.support.second_factor.reset' };

export const SUPPORT_COMMANDS: Readonly<Record<string, readonly ConsolePermission[]>> = {
  'cases.create': ['admin.support.case.create'],
  'cases.reply': ['admin.support.case.create'],
  'cases.assign': ['admin.support.grant.approve'],
  'cases.close': ['admin.support.case.close'],
  'grants.request': ['admin.support.grant.request'],
  'grants.approve': ['admin.support.grant.approve'],
  'grants.revoke': ['admin.support.grant.request', 'admin.support.grant.approve'],
  'accounts.service': [...new Set(Object.values(SERVICE_PERMISSIONS).flat())],
  'recovery.approve': ['admin.support.recovery.approve', 'admin.support.second_factor.reset'],
  'recovery.cancel': ['admin.support.diagnose'],
  'recovery.complete': ['admin.support.recovery.approve', 'admin.support.second_factor.reset'],
  'explain.copy': ['admin.support.explain'],
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const plusHours = (iso: string | Date, hours: number) => new Date((typeof iso === 'string' ? Date.parse(iso) : iso.getTime()) + hours * 3_600_000).toISOString();

/** Ids typed into a grant request: separated by commas, spaces or new lines. */
export function parseObjectIds(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Why the viewer cannot approve this grant request now, or null. */
export function grantBlocker(request: GrantRequest, viewerId: string, permissions: readonly ConsolePermission[], now: Date): 'own_request' | 'denied' | 'request_expired' | null {
  if (request.requestedBy === viewerId) return 'own_request';
  if (!permissions.includes('admin.support.grant.approve')) return 'denied';
  if (Date.parse(request.requestedAt) + CASE_GRANT_MAX_HOURS * 3_600_000 <= now.getTime()) return 'request_expired';
  return null;
}

/** Why the viewer cannot approve this recovery request now, or null. */
export function recoveryBlocker(request: RecoveryRequest, viewerId: string, permissions: readonly ConsolePermission[]): 'own_request' | 'denied' | 'request_void' | 'evidence_required' | null {
  if (request.requestedBy === viewerId) return 'own_request';
  if (!permissions.includes(RECOVERY_APPROVER[request.action])) return 'denied';
  if (request.state !== 'awaiting_approval') return 'request_void';
  if (request.evidence !== 'recorded') return 'evidence_required';
  return null;
}

export function evaluateSupport(input: SectionCommandInput, ctx: SectionCommandContext): SectionOutcome {
  const permissions = SUPPORT_COMMANDS[input.command];
  if (!permissions) return reject('invalid');
  const blocked = guard(input, ctx, permissions);
  if (blocked) return blocked;
  const data = supportOf(ctx.hub!.hub.id);
  const me = ctx.viewer!.person.id;
  const f = input.fields;
  const openCase = (id: string | undefined) => data.cases.find((c) => c.id === id);

  switch (input.command) {
    case 'cases.create': {
      const kind = oneOf(f.subjectKind, ['person', 'company'] as const);
      if (!kind) return reject('invalid', 'subjectKind');
      const exists = kind === 'person' ? data.accounts.some((a) => a.summary.personId === f.subjectId) : data.companies.some((c) => c.companyId === f.subjectId);
      if (!exists) return NOT_FOUND;
      if (kind === 'person' && f.subjectId === me) return reject('own_account', 'subjectId');
      return oneOf(f.reason, CASE_REASONS) ? accepted('case_opened') : reject('invalid', 'reason');
    }
    case 'cases.reply':
    case 'cases.assign':
    case 'cases.close': {
      const c = openCase(f.caseId);
      if (!c) return NOT_FOUND;
      if (c.state === 'closed') return reject('case_closed');
      if (input.command === 'cases.reply') {
        const text = (f.text ?? '').trim();
        return text.length > 0 && text.length <= 2000 ? accepted('notified') : reject('invalid', 'text');
      }
      if (input.command === 'cases.assign') return f.assignee === 'p-support' || f.assignee === 'p-support-agent' ? accepted() : reject('invalid', 'assignee');
      return accepted('notified');
    }
    case 'grants.request': {
      const c = openCase(f.caseId);
      if (!c) return NOT_FOUND;
      if (c.state === 'closed') return reject('case_closed');
      if (!oneOf(f.objectType, GRANT_OBJECT_TYPES)) return reject('invalid', 'objectType');
      const ids = parseObjectIds(f.ids ?? '');
      if (ids.length === 0 || ids.some((id) => !ID.test(id))) return reject('invalid', 'ids');
      if (ids.length > 100) return reject('too_many_objects', 'ids');
      if (!ProjectionClassSchema.safeParse(f.projectionClass).success) return reject('invalid', 'projectionClass');
      if (!(f.purpose ?? '').trim()) return reject('invalid', 'purpose');
      const hours = Number(f.hours);
      if (!Number.isInteger(hours) || hours < 1) return reject('invalid', 'hours');
      if (hours > CASE_GRANT_MAX_HOURS) return reject('grant_too_long', 'hours');
      return accepted('grant_requested');
    }
    case 'grants.approve': {
      const request = data.grantRequests.find((g) => g.id === f.requestId);
      if (!request) return NOT_FOUND;
      const why = grantBlocker(request, me, ctx.access.permissions, ctx.now);
      if (why) return reject(why);
      if (openCase(request.caseId)?.state === 'closed') return reject('case_closed');
      if (f.digest !== request.digest.value) return reject('digest_mismatch');
      return oneOf(f.decision, ['approve', 'decline'] as const) ? accepted() : reject('invalid', 'decision');
    }
    case 'grants.revoke': {
      const grant = data.grants.find((g) => g.id === f.grantId);
      if (!grant) return NOT_FOUND;
      if (grant.revokedAt !== null || Date.parse(grant.expiresAt) <= ctx.now.getTime()) return reject('request_void');
      return accepted();
    }
    case 'accounts.service': {
      const account = data.accounts.find((a) => a.summary.personId === f.personId);
      if (!account) return NOT_FOUND;
      if (account.summary.personId === me) return reject('own_account');
      if (account.summary.accountState === 'erased') return reject('account_erased');
      const action = oneOf(f.action, SERVICE_ACTIONS);
      if (!action) return reject('invalid', 'action');
      if (!holdsAny(ctx.access, SERVICE_PERMISSIONS[action])) return reject('denied');
      const c = openCase(f.caseId);
      if (!c || c.state === 'closed' || c.subject.kind !== 'person' || c.subject.id !== account.summary.personId) return reject('case_required', 'caseId');
      if (action === 'resend_verification' && account.summary.emailVerified) return reject('invalid', 'action');
      if (action === 'unlock_after_lockout' && account.summary.accountState !== 'locked') return reject('invalid', 'action');
      if (action === 'send_guided_task' && !oneOf(f.task, GUIDED_TASKS)) return reject('invalid', 'task');
      if (action === 'rebind_recovery_email' || action === 'reset_second_factor') {
        if (f.evidence !== 'on') return reject('evidence_required', 'evidence');
        if (data.recovery.some((r) => r.subject.personId === account.summary.personId && r.action === action && (r.state === 'awaiting_approval' || r.state === 'cooling_off'))) return reject('cooling_off_active');
        return accepted('second_person', { secondPerson: SECOND_PERSON[action] });
      }
      return accepted('notified');
    }
    case 'recovery.approve': {
      const request = data.recovery.find((r) => r.id === f.requestId);
      if (!request) return NOT_FOUND;
      const why = recoveryBlocker(request, me, ctx.access.permissions);
      if (why) return reject(why);
      return accepted('cooling_off', { date: plusHours(ctx.now, COOLING_OFF_HOURS) });
    }
    case 'recovery.cancel': {
      const request = data.recovery.find((r) => r.id === f.requestId);
      if (!request) return NOT_FOUND;
      return request.state === 'awaiting_approval' || request.state === 'cooling_off' ? accepted('notified') : reject('request_void');
    }
    case 'recovery.complete': {
      const request = data.recovery.find((r) => r.id === f.requestId);
      if (!request) return NOT_FOUND;
      if (request.objection) return reject('objection_received');
      if (request.state === 'cancelled' || request.state === 'awaiting_approval') return reject('request_void');
      if (!holdsAny(ctx.access, [RECOVERY_APPROVER[request.action]])) return reject('denied');
      if (!request.effectiveAt || Date.parse(request.effectiveAt) > ctx.now.getTime()) return reject('cooling_off_active');
      return accepted('notified');
    }
    case 'explain.copy': {
      const c = openCase(f.caseId);
      if (!c) return NOT_FOUND;
      if (c.state === 'closed') return reject('case_closed');
      if (!data.principals.some((p) => p.id === f.principal) || !data.objects.some((o) => o.id === f.object)) return NOT_FOUND;
      return accepted();
    }
  }
  return reject('invalid');
}
