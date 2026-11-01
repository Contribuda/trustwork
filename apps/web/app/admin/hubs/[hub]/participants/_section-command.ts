import type { ConsolePermission, ConsoleSecondPersonAction } from '@trustwork/contracts/client';
import { holdsAny } from '../../../_data/commands.js';
import type { ConsoleAccess, StaffViewer } from '../../../_data/port.js';
import type { HubRecord } from '../../../_data/schemas.js';

/**
 * Section commands of HUBC-004's three console groups (participants, support, trust and safety): the common
 * authorization and the outcomes. Pure: no clock, no I/O; the runner is `_section-runner.ts`.
 *
 * They follow the console's command rules (ADM-002 `commands.ts`): the server resolves the viewer again, checks the
 * role on this hub, the command's permission, the elevated session, offline mode and the required reason, then the
 * section's own invariants (no servicing of one's own account, a second person for case grants and sign-in factor
 * changes, no decision by the original decider, no score or badge edits). In demo mode nothing is stored. The live
 * wiring (HUBC-009) sends the same commands to SUP-001, CLM-001 and the trust backends, which repeat every check as
 * the authority.
 */

export const SECTION_REJECT_CODES = [
  'denied', 'elevation_required', 'offline', 'reason_required', 'invalid', 'own_request', 'request_void', 'request_expired', 'digest_mismatch',
  'own_account', 'account_erased', 'evidence_required', 'cooling_off_active', 'conflict_of_interest', 'sanctions_match', 'steps_incomplete',
  'recipe_missing', 'out_of_bounds', 'original_decider', 'grant_too_long', 'too_many_objects', 'case_required', 'case_closed', 'baseline_locked',
  'objection_received', 'not_verified', 'no_representative', 'already_decided', 'type_inactive', 'release_permission',
] as const;
export type SectionRejectCode = (typeof SECTION_REJECT_CODES)[number];

/** What an accepted demo command would have done; each kind has its own message. */
export const ACCEPTED_KINDS = ['saved', 'second_person', 'pending_second', 'grant_requested', 'cooling_off', 'notified', 'version', 'case_opened'] as const;
export type AcceptedKind = (typeof ACCEPTED_KINDS)[number];

export type SectionOutcome =
  | { status: 'demo_not_saved'; kind: AcceptedKind; secondPerson: ConsoleSecondPersonAction | null; date: string | null }
  | { status: 'rejected'; code: SectionRejectCode; field: string | null }
  | { status: 'not_found' };

export type SectionCommandInput = { command: string; reason: string; expectedRevision: number | null; fields: Readonly<Record<string, string>> };
export type SectionCommandContext = { viewer: StaffViewer | null; access: ConsoleAccess; hub: HubRecord | null; now: Date; offline: boolean };

export const reject = (code: SectionRejectCode, field: string | null = null): SectionOutcome => ({ status: 'rejected', code, field });
export const accepted = (kind: AcceptedKind = 'saved', extra: { secondPerson?: ConsoleSecondPersonAction; date?: string } = {}): SectionOutcome => ({
  status: 'demo_not_saved',
  kind,
  secondPerson: extra.secondPerson ?? null,
  date: extra.date ?? null,
});
export const NOT_FOUND: SectionOutcome = { status: 'not_found' };

/**
 * The checks every section command passes first, in the console's order: an unknown viewer or hub is "not found";
 * no role on this hub or none of the command's permissions is "denied"; then the elevated session, offline mode and
 * the reason (1 to 500 characters). Returns null when the command may go on to its own invariants.
 */
export function guard(input: SectionCommandInput, ctx: SectionCommandContext, permissions: readonly ConsolePermission[]): SectionOutcome | null {
  if (!ctx.viewer || !ctx.hub) return NOT_FOUND;
  if (ctx.access.roles.length === 0) return reject('denied');
  if (!holdsAny(ctx.access, permissions)) return reject('denied');
  if (ctx.viewer.elevation.state !== 'elevated') return reject('elevation_required');
  if (ctx.offline) return reject('offline');
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) return reject('reason_required', 'reason');
  return null;
}

/** A field that must be one of the allowed values. */
export function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export type SectionEvaluator = (input: SectionCommandInput, ctx: SectionCommandContext) => SectionOutcome;
