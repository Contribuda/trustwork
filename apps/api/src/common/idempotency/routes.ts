/**
 * How each `@Idempotent(action)` route completes its idempotency record (ADR 012 decision 39, BE-005).
 *
 * - `in_transaction`: the route's single request transaction (`PrincipalService.runAs`) writes the completion in the
 *   same commit as the change, audit and outbox intents, and returns the response body unchanged to the controller.
 *   A retry after a crash replays the stored response; a takeover after the lease only ever re-runs an execution
 *   that did not commit, and the lease fence makes a late original execution roll back instead of committing.
 * - `lease`: the route cannot complete inside one transaction (effects outside the request transaction, or a response
 *   that is not the transaction's result). It keeps the BE-002 behaviour: completion in a separate bookkeeping
 *   transaction and a takeover after the lease, which may repeat the effects of an execution that crashed between its
 *   commit and the bookkeeping. Each entry states why that repetition is acceptable.
 *
 * Every action used with `@Idempotent` must be listed here (checked by tests/backend/idempotency/routes.test.ts); an
 * unlisted action is refused at request time instead of silently falling back to the lease.
 */
export type CompletionMode = { kind: 'in_transaction' } | { kind: 'lease'; reason: string };

const IN_TRANSACTION: CompletionMode = { kind: 'in_transaction' };

export const IDEMPOTENT_ROUTES: Readonly<Record<string, CompletionMode>> = {
  // Directory (BE-003)
  'company.create': IN_TRANSACTION,
  'person.set_handle': IN_TRANSACTION,
  'company.set_handle': IN_TRANSACTION,
  'project.set_handle': IN_TRANSACTION,
  // Company memberships (identity)
  'membership.invite': {
    kind: 'lease',
    reason: 'The response is a constant acknowledgement that must not reveal whether the address belongs to an account, so there is not always a request transaction to complete in; the mailbox proof is issued in its own owner-run transaction before it and the invitation mail is sent after COMMIT. A takeover after a crash re-issues a fresh proof and re-sends the mail; the membership row is not duplicated because a pending invitation is re-sent instead of inserted again.',
  },
  'membership.accept': IN_TRANSACTION,
  'membership.change': IN_TRANSACTION,
  'membership.end': IN_TRANSACTION,
  // Projects
  'project.create': IN_TRANSACTION,
  'project.assign_leader': IN_TRANSACTION,
  'project.publish': IN_TRANSACTION,
  'project.transfer_propose': IN_TRANSACTION,
  'project.transfer_consent': IN_TRANSACTION,
  'project.transfer_reject': IN_TRANSACTION,
  'project.transfer_withdraw': IN_TRANSACTION,
  'project.transfer_apply': IN_TRANSACTION,
  'project.participant_grant': IN_TRANSACTION,
  'project.participant_revoke': IN_TRANSACTION,
};

/** Completion mode of an action; an unlisted action is a programming error (the route must be classified first). */
export function completionModeOf(action: string): CompletionMode {
  const mode = Object.hasOwn(IDEMPOTENT_ROUTES, action) ? IDEMPOTENT_ROUTES[action] : undefined;
  if (!mode) throw new Error(`idempotent action "${action}" has no completion mode in common/idempotency/routes.ts`);
  return mode;
}
