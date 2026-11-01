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
  // Jurisdiction holds (SANC-001): the clear and its audit row commit in the request transaction.
  'jurisdiction.hold.clear': IN_TRANSACTION,
  // Deployment-location attestation (SANC-009): the attestation and its audit row commit in the request transaction (a
  // refused place rolls back and leaves only a denied audit row written in its own transaction, once per attempt).
  'jurisdiction.attestation.attest': IN_TRANSACTION,
  // Scoped tasks from plan items (TASK-001): every route runs in one PrincipalService.runAs transaction (acceptance
  // events, the assignment, obligations, the request closing trigger and outbox events included) and returns its result
  // unchanged.
  'task.request_create': IN_TRANSACTION,
  'task.draft_save': IN_TRANSACTION,
  'task.version_publish': IN_TRANSACTION,
  'task.private_save': IN_TRANSACTION,
  'task.invite': IN_TRANSACTION,
  'task.request_cancel': IN_TRANSACTION,
  'task.offer_create': IN_TRANSACTION,
  'task.offer_save': IN_TRANSACTION,
  'task.offer_send': IN_TRANSACTION,
  'task.offer_withdraw': IN_TRANSACTION,
  'task.offer_accept': IN_TRANSACTION,
  'task.agreement_confirm': IN_TRANSACTION,
  'task.agreement_decline': IN_TRANSACTION,
  'task.agreement_withdraw': IN_TRANSACTION,
  'task.record': IN_TRANSACTION,
  'task.review': IN_TRANSACTION,
  // Platform administration (ADM-001): staff routes behind an elevated session plus the participant moderation routes;
  // every route runs in one PrincipalService.runAs transaction (the DATA-002 command, its audit row, port calls and
  // outbox intents included) and returns its result unchanged. A denied attempt's audit row is written in its own
  // transaction after the refusal, which completes the record as an error result.
  'admin.staff.assign': IN_TRANSACTION,
  'admin.staff.revoke': IN_TRANSACTION,
  'admin.staff.breakglass': IN_TRANSACTION,
  'admin.staff.conflict_declare': IN_TRANSACTION,
  'admin.staff.conflict_end': IN_TRANSACTION,
  'admin.incident.open': IN_TRANSACTION,
  'admin.approval.request': IN_TRANSACTION,
  'admin.approval.approve': IN_TRANSACTION,
  'admin.approval.decline': IN_TRANSACTION,
  'admin.approval.withdraw': IN_TRANSACTION,
  'admin.case_grant.request': IN_TRANSACTION,
  'admin.case_grant.decide': IN_TRANSACTION,
  'admin.case_grant.revoke': IN_TRANSACTION,
  'admin.moderation.case_open': IN_TRANSACTION,
  'admin.moderation.decide': IN_TRANSACTION,
  'admin.moderation.sanction_apply': IN_TRANSACTION,
  'admin.moderation.sanction_lift': IN_TRANSACTION,
  'admin.moderation.appeal_decide': IN_TRANSACTION,
  'admin.flag.set': IN_TRANSACTION,
  'moderation.report': IN_TRANSACTION,
  'moderation.appeal_file': IN_TRANSACTION,
  // Execution, evidence, reviews, appeals and snapshots (EXE-001): every route runs in one PrincipalService.runAs
  // transaction (observations are materialized inside it) and returns its result unchanged.
  'execution.claim_record': IN_TRANSACTION,
  'execution.evidence_attach': IN_TRANSACTION,
  'execution.defect_report': IN_TRANSACTION,
  'execution.dispute_open': IN_TRANSACTION,
  'execution.claim_decide': IN_TRANSACTION,
  'execution.dispute_appeal': IN_TRANSACTION,
  'trust.review_submit': IN_TRANSACTION,
  'trust.review_respond': IN_TRANSACTION,
  'trust.appeal_file': IN_TRANSACTION,
  'trust.snapshot_compute': IN_TRANSACTION,
  // Assistant (AST-001): every route runs in one PrincipalService.runAs transaction and returns its result unchanged;
  // queued agent actions leave through the job table in that same commit (the dispatch happens in the worker).
  'assistant.mandate_create': IN_TRANSACTION,
  'assistant.mandate_revise': IN_TRANSACTION,
  'assistant.mandate_suspend': IN_TRANSACTION,
  'assistant.mandate_revoke': IN_TRANSACTION,
  'assistant.proposal_confirm': IN_TRANSACTION,
  'assistant.proposal_decline': IN_TRANSACTION,
  'assistant.decision_approve': IN_TRANSACTION,
  'assistant.decision_decline': IN_TRANSACTION,
  'assistant.run_cancel': IN_TRANSACTION,
  'assistant.stop_engage': IN_TRANSACTION,
  'assistant.stop_release': IN_TRANSACTION,
  'assistant.conversation_turn': IN_TRANSACTION,
  'assistant.backlog_status': IN_TRANSACTION,
  // SANC-003: screening review cases. Every decision, its second-person approval, the suspension, the report draft, the
  // audit row and the outbox events commit in the request transaction; the subject's appeal likewise.
  'screening.appeal_file': IN_TRANSACTION,
  'screening.match_confirm': IN_TRANSACTION,
  'screening.match_propose': IN_TRANSACTION,
  'screening.proposal_decide': IN_TRANSACTION,
  'screening.appeal_decide': IN_TRANSACTION,
  // PRC-003: the supplier base. Every route runs in one PrincipalService.runAs transaction (the owner-run command, its
  // audit row; no outbox event) and returns its result unchanged; an import writes all its rows in that transaction.
  'supplier_base.maintain': IN_TRANSACTION,
  'supplier_base.counterparty_create': IN_TRANSACTION,
  'supplier_base.counterparty_update': IN_TRANSACTION,
  'supplier_base.assessment_draft': IN_TRANSACTION,
  'supplier_base.assessment_record': IN_TRANSACTION,
  'supplier_base.assessment_respond': IN_TRANSACTION,
  'supplier_base.import': IN_TRANSACTION,
  // SUP-001: support workspace. Staff commands run their SECURITY DEFINER command (packages/data/migrations/support), audit row, notices and
  // outbox intents in the request transaction; the person's own support routes likewise.
  'support.case_open': IN_TRANSACTION,
  'support.case_update': IN_TRANSACTION,
  'support.case_note': IN_TRANSACTION,
  'support.action_request': IN_TRANSACTION,
  'support.action_activate': IN_TRANSACTION,
  'support.action_execute': IN_TRANSACTION,
  'support.action_cancel': IN_TRANSACTION,
  'support.own_case_open': IN_TRANSACTION,
  'support.own_case_note': IN_TRANSACTION,
  'support.own_case_update': IN_TRANSACTION,
  'support.diagnostics_share': IN_TRANSACTION,
  'support.own_action_cancel': IN_TRANSACTION,
  // HUB-001: hubs, territories, versioned configuration, launch gates, lifecycle, legal documents and credential
  // references. Every route runs in one PrincipalService.runAs transaction through a hubs_* SECURITY DEFINER command that
  // writes its audit row there (a two-person action without an approval writes the approval request instead).
  'hub.create': IN_TRANSACTION,
  'hub.profile_update': IN_TRANSACTION,
  'hub.territory_add': IN_TRANSACTION,
  'hub.territory_remove': IN_TRANSACTION,
  'hub.config_draft': IN_TRANSACTION,
  'hub.config_import_deployment': IN_TRANSACTION,
  'hub.config_activate': IN_TRANSACTION,
  'hub.config_cancel': IN_TRANSACTION,
  'hub.gate_check': IN_TRANSACTION,
  'hub.gate_invalidate': IN_TRANSACTION,
  'hub.transition': IN_TRANSACTION,
  'hub.legal_draft': IN_TRANSACTION,
  'hub.legal_counsel_record': IN_TRANSACTION,
  'hub.legal_activate': IN_TRANSACTION,
  'hub.legal_accept': IN_TRANSACTION,
  'hub.credential_register': IN_TRANSACTION,
  'hub.credential_activate': IN_TRANSACTION,
  'hub.credential_retire': IN_TRANSACTION,
  // AGT-001: goals, reports, job subscriptions, envelopes, escalations, the company representative and company mandates
  'agents.goal_create': IN_TRANSACTION,
  'agents.goal_confirm': IN_TRANSACTION,
  'agents.goal_status': IN_TRANSACTION,
  'agents.goal_evidence': IN_TRANSACTION,
  'agents.goal_report': IN_TRANSACTION,
  'agents.report_share': IN_TRANSACTION,
  'agents.job_subscription_create': IN_TRANSACTION,
  'agents.job_subscription_status': IN_TRANSACTION,
  'agents.envelope_send': IN_TRANSACTION,
  'agents.escalation_resolve': IN_TRANSACTION,
  'agents.representative_configure': IN_TRANSACTION,
  'agents.representative_accept': IN_TRANSACTION,
  'agents.representative_suspend': IN_TRANSACTION,
  'agents.representative_resume': IN_TRANSACTION,
  'agents.representative_disable': IN_TRANSACTION,
  'agents.company_mandate_grant': IN_TRANSACTION,
  'agents.company_mandate_reconfirm': IN_TRANSACTION,
  'agents.company_mandate_revoke': IN_TRANSACTION,
  // REP-001: the reputation builder. Every route runs in one PrincipalService.runAs transaction (derived records are
  // materialized inside it; the credential check calls the read-only register adapter inside it, bounded by a timeout)
  // and returns its result unchanged.
  'reputation.credential_record': IN_TRANSACTION,
  'reputation.credential_check': IN_TRANSACTION,
  'reputation.portfolio_add': IN_TRANSACTION,
  'reputation.relation_declare': IN_TRANSACTION,
  'reputation.confirmation_request': IN_TRANSACTION,
  'reputation.confirmation_remind': IN_TRANSACTION,
  'reputation.confirmation_withdraw': IN_TRANSACTION,
  'reputation.confirmation_answer': IN_TRANSACTION,
  'reputation.appeal_file': IN_TRANSACTION,
  'reputation.limitation_appeal': IN_TRANSACTION,
  // PRC-001: approval routes. Drafting, activation, decisions (with the request's step changes and outbox event),
  // withdrawal and delegation commit with their audit row in the request transaction.
  'approval.route_draft': IN_TRANSACTION,
  'approval.route_activate': IN_TRANSACTION,
  'approval.decide': IN_TRANSACTION,
  'approval.withdraw': IN_TRANSACTION,
  'approval.delegate': IN_TRANSACTION,
  'approval.delegation_revoke': IN_TRANSACTION,
  // CNT-001: every content route runs in one PrincipalService.runAs transaction (the content command, its staff audit
  // row, the domain audit row and outbox events included) and returns its result unchanged.
  'content.publication_create': IN_TRANSACTION,
  'content.publication_draft': IN_TRANSACTION,
  'content.publication_submit': IN_TRANSACTION,
  'content.publication_return': IN_TRANSACTION,
  'content.publication_publish': IN_TRANSACTION,
  'content.publication_correct': IN_TRANSACTION,
  'content.publication_retract': IN_TRANSACTION,
  'content.publication_links': IN_TRANSACTION,
  'content.editor_grant': IN_TRANSACTION,
  'content.editor_revoke': IN_TRANSACTION,
  'content.edition_link': IN_TRANSACTION,
  'content.edition_review': IN_TRANSACTION,
  'content.comment': IN_TRANSACTION,
  'content.wall_add': IN_TRANSACTION,
  'content.wall_remove': IN_TRANSACTION,
  'content.issue_create': IN_TRANSACTION,
  'content.issue_curate': IN_TRANSACTION,
  'content.issue_status': IN_TRANSACTION,
  'content.issue_release': IN_TRANSACTION,
  'content.issue_correct': IN_TRANSACTION,
  'content.render_request': IN_TRANSACTION,
  'content.render_record': IN_TRANSACTION,
  'content.digest_create': IN_TRANSACTION,
  'content.digest_release': IN_TRANSACTION,
  // COMMS-001: every route runs in one PrincipalService.runAs transaction (mail intents are written in it through
  // MAIL-001's outbox) and returns its result unchanged; messenger and SMS sends happen after COMMIT and are not
  // repeated by a replay.
  'comms.thread_open': IN_TRANSACTION,
  'comms.message_post': IN_TRANSACTION,
  'comms.notification_read': IN_TRANSACTION,
  'comms.notification_read_all': IN_TRANSACTION,
  'comms.preference_set': IN_TRANSACTION,
  'comms.mail_unsubscribe': IN_TRANSACTION,
  'comms.channel_grant_create': IN_TRANSACTION,
  'comms.channel_grant_revoke': IN_TRANSACTION,
  'comms.template_draft': IN_TRANSACTION,
  'comms.template_activate': IN_TRANSACTION,
};

/** Completion mode of an action; an unlisted action is a programming error (the route must be classified first). */
export function completionModeOf(action: string): CompletionMode {
  const mode = Object.hasOwn(IDEMPOTENT_ROUTES, action) ? IDEMPOTENT_ROUTES[action] : undefined;
  if (!mode) throw new Error(`idempotent action "${action}" has no completion mode in common/idempotency/routes.ts`);
  return mode;
}
