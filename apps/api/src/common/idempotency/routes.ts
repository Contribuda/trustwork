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
  // Project plans and owner-private project records (PLAN-001): every route runs in one PrincipalService.runAs
  // transaction and returns its result unchanged.
  'plan.create': IN_TRANSACTION,
  'plan.draft_create': IN_TRANSACTION,
  'plan.draft_save': IN_TRANSACTION,
  'plan.version_propose': IN_TRANSACTION,
  'plan.version_approve': IN_TRANSACTION,
  'plan.version_return': IN_TRANSACTION,
  'plan.item_state': IN_TRANSACTION,
  'plan.change_record': IN_TRANSACTION,
  'plan.change_decide': IN_TRANSACTION,
  'plan.item_share': IN_TRANSACTION,
  'plan.share_revoke': IN_TRANSACTION,
  'project.location_set': IN_TRANSACTION,
  'project.permit_record': IN_TRANSACTION,
  'project.diary_add': IN_TRANSACTION,
  // Profiles, consent, portraits, experience and private records (PPL-001): every route runs in one
  // PrincipalService.runAs transaction (consent withdrawal, unpublication and tombstones included) and returns its
  // result unchanged.
  'profile.save': IN_TRANSACTION,
  'profile.visibility': IN_TRANSACTION,
  'consent.grant': IN_TRANSACTION,
  'consent.withdraw': IN_TRANSACTION,
  'media_licence.record': IN_TRANSACTION,
  'media_licence.revoke': IN_TRANSACTION,
  'portrait.set': IN_TRANSACTION,
  'portrait.remove': IN_TRANSACTION,
  'experience.add': IN_TRANSACTION,
  'experience.update': IN_TRANSACTION,
  'experience.archive': IN_TRANSACTION,
  'preferences.save': IN_TRANSACTION,
  'follow.add': IN_TRANSACTION,
  'follow.end': IN_TRANSACTION,
  'bookmark.add': IN_TRANSACTION,
  'bookmark.remove': IN_TRANSACTION,
  'reading_progress.record': IN_TRANSACTION,
  // Catalogue, needs, RFQs and invitations (COM-001): every route runs in one PrincipalService.runAs transaction (the
  // invitation outbox event included) and returns its result unchanged.
  'offering.create': IN_TRANSACTION,
  'offering.draft_open': IN_TRANSACTION,
  'offering.draft_save': IN_TRANSACTION,
  'offering.private_save': IN_TRANSACTION,
  'offering.version_publish': IN_TRANSACTION,
  'offering.archive': IN_TRANSACTION,
  'need.create': IN_TRANSACTION,
  'need.save': IN_TRANSACTION,
  'need.convert': IN_TRANSACTION,
  'rfq.create': IN_TRANSACTION,
  'rfq.draft_save': IN_TRANSACTION,
  'rfq.amendment_open': IN_TRANSACTION,
  'rfq.version_publish': IN_TRANSACTION,
  'rfq.private_save': IN_TRANSACTION,
  'rfq.invite': IN_TRANSACTION,
  'rfq.invitation_revalidate': IN_TRANSACTION,
  'rfq.invitation_withdraw': IN_TRANSACTION,
  'rfq.invitation_respond': IN_TRANSACTION,
  'rfq.close': IN_TRANSACTION,
  'rfq.projection_set': IN_TRANSACTION,
  // Files (FILE-001): every route runs in one PrincipalService.runAs transaction (audit and outbox intent included) and
  // returns its result unchanged; signed URLs are computed locally, never a provider call inside the request.
  'file.upload_start': IN_TRANSACTION,
  'file.upload_complete': IN_TRANSACTION,
  'file.copy': IN_TRANSACTION,
  'file.move': IN_TRANSACTION,
  'file.delete': IN_TRANSACTION,
  // Quotes, negotiation, agreements, orders and order changes (COM-002): every route runs in one PrincipalService.runAs
  // transaction (budget reservations and releases, acceptance events and outbox events included) and returns its result
  // unchanged.
  'quote.create': IN_TRANSACTION,
  'quote.version_open': IN_TRANSACTION,
  'quote.draft_save': IN_TRANSACTION,
  'quote.private_save': IN_TRANSACTION,
  'quote.send': IN_TRANSACTION,
  'quote.withdraw': IN_TRANSACTION,
  'quote.amendment_request': IN_TRANSACTION,
  'quote.amendment_request_withdraw': IN_TRANSACTION,
  'agreement.accept_terms': IN_TRANSACTION,
  'agreement.seller_accept': IN_TRANSACTION,
  'agreement.seller_decline': IN_TRANSACTION,
  'agreement.withdraw': IN_TRANSACTION,
  'agreement.private_save': IN_TRANSACTION,
  'order.place': IN_TRANSACTION,
  'order.cancel': IN_TRANSACTION,
  'order.change_propose': IN_TRANSACTION,
  'order.change_decide': IN_TRANSACTION,
  // Support reset of a second factor (BE-004): staff routes behind an elevated session; each runs in one
  // PrincipalService.runAs transaction (the subject's notices, audit and outbox intents included) and returns its result
  // unchanged. The routes that consume one-time codes or return secrets (enrolment, recovery codes, elevation, sign-in)
  // are deliberately not idempotent: a code is its own replay guard and a secret must never be stored in a record.
  'support.second_factor_reset.request': IN_TRANSACTION,
  'support.second_factor_reset.approve': IN_TRANSACTION,
  'support.second_factor_reset.cancel': IN_TRANSACTION,
  'support.second_factor_reset.execute': IN_TRANSACTION,
};

/** Completion mode of an action; an unlisted action is a programming error (the route must be classified first). */
export function completionModeOf(action: string): CompletionMode {
  const mode = Object.hasOwn(IDEMPOTENT_ROUTES, action) ? IDEMPOTENT_ROUTES[action] : undefined;
  if (!mode) throw new Error(`idempotent action "${action}" has no completion mode in common/idempotency/routes.ts`);
  return mode;
}
