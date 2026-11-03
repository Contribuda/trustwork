# Compliance staff notice (SANC-006)

ADR 014 decision 14: compliance staff hear that work is waiting, the notice cannot be muted and it names nobody. `screening_staff_notice` tells every independent compliance officer of the node, through the existing mail delivery, outbox consumer and transport, when a subject enters the review queue and when a jurisdiction hold is placed.

The template takes no parameter, so a subject, a list, an entry, a count or a hub cannot reach it. The link is the fixed console path. Details open only in the console under the officer's elevated session.

Recipients come from `trustwork.screening_record_staff_notice`, in the transaction of the event: node compliance officers (no break-glass assignment) who are not the subject, not a member of the subject company, have no declared conflict and are neither held nor suspended, at each verified address. An address that already has an unsent notice gets no second one: the notice says work is waiting, and the waiting one already says so. A notice that went out is never a reason to skip the next one.

There is no preference for this notice, which is what "cannot be muted" means; the suppression list still protects an address that bounced or complained. Dispatch rechecks the same binding and the officer's current eligibility through `screening_notice_allowed`, holding the binding row through the transport effect, so a revoked officer gets nothing.

Dictionaries are machine drafts in every maintained language; Russian renders the English reference. Tests: [`tests/web/admin/screening/staff-notice.test.ts`](../../../../../../tests/web/admin/screening/staff-notice.test.ts).
