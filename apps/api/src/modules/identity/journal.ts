import { auditEvents, outbox, type Transaction } from '../../deps/data.js';

/**
 * Outbox event types emitted by the identity module. They are intents for the worker (notifications and mail in
 * MAIL-001, projections later) and carry identifiers only: never an address, a token, a hash or a password.
 */
export type IdentityEventType =
  | 'identity.person_registered'
  | 'identity.signup_on_bound_address'
  | 'identity.session_started'
  | 'identity.login_throttled'
  | 'identity.recovery_requested'
  | 'identity.sessions_revoked'
  | 'identity.email_verified'
  | 'identity.email_changed'
  | 'identity.binding_claimed'
  | 'identity.provider_linked'
  | 'identity.provider_unlinked'
  | 'identity.second_factor_enabled'
  | 'identity.second_factor_removed'
  | 'identity.second_factor_throttled'
  | 'identity.recovery_codes_regenerated'
  | 'identity.recovery_code_used'
  | 'identity.session_elevated'
  | 'identity.second_factor_reset_requested'
  | 'identity.second_factor_reset_approved'
  | 'identity.second_factor_reset_cancelled'
  | 'identity.second_factor_reset_completed';

export interface AuditEntry {
  action: string;
  objectKind: string;
  objectId: string;
  requestId: string;
  actor?: string | null;
  epoch?: number | null;
  basis?: unknown;
  reason?: string;
}
export interface Intent { personId: string; type: IdentityEventType; payload?: Record<string, unknown> }

/**
 * Writes the audit rows and outbox intents of an identity change inside the transaction that made the change
 * (architecture rule "aggregate change, audit event and outbox intent in one transaction"): a failure of any of them
 * rolls the change back, and a committed change always has its evidence.
 */
export async function journal(trx: Transaction, entries: AuditEntry | readonly AuditEntry[], intents: readonly Intent[] = []): Promise<void> {
  for (const entry of Array.isArray(entries) ? entries : [entries as AuditEntry]) {
    await auditEvents.append(trx, {
      actor_person_id: entry.actor ?? null,
      action: entry.action,
      object_kind: entry.objectKind,
      object_id: entry.objectId,
      request_id: entry.requestId,
      ...(entry.epoch !== undefined && entry.epoch !== null ? { authz_epoch: entry.epoch } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}),
      basis: entry.basis,
    });
  }
  for (const intent of intents) {
    await outbox.append(trx, { aggregate_kind: 'person', aggregate_id: intent.personId, revision: 1, type: intent.type, payload: intent.payload ?? {} });
  }
}
