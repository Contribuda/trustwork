# Assistant: full page and floating overlay

Routes: `/app/assistant` (full page), `/app/assistant/mandates`, `/app/assistant/approvals`, `/app/assistant/runs/[id]`; the overlay is route-less and available on every `/app/*` page via the launcher.

## Status and evidence

`no reference` (the reference overview shows only the launcher button). Spec R09 (one assistant; full page and icon-only bottom-right overlay launcher; overlay does not shrink content; internals may specialize without exposing agent management), R10 (delegation within explicit authority: action/context/conditions/limits/time/budgets/approval/escalation/revocation), R11 (proactive deliverables; user service backlog distinct), R29 (durable structured run/action/approval/outcome records; outcome_unknown → reconciliation), "Assistant journeys"; IA "Assistant"; accessibility doc (overlay traps focus only when modal, Escape/close, restore focus to launcher, does not cover focused control, no reflow); [lifecycles](../../../data/lifecycles.md) (Proposed → Authorized → Reserved → Queued → Executing → Pending/Succeeded/Failed/OutcomeUnknown → Reconciling; Revoked). Rejection ledger: no docked panel, no "Agents" UI.

## Audience and access policy

Authenticated person; the assistant acts only for that principal under structured mandates. Chat prose never grants authority; a mandate is a structured record created through a form, inspectable and revocable. Company-scoped mandates require company grants and vanish on membership end. Platform staff never see conversations without an audited case grant.

## Data projection

| Surface | Content |
|---|---|
| Conversation (shared by page and overlay) | Messages (user/assistant), proposal cards (deliverable suggestions → "Create a draft"), structured action cards (what, context, conditions, budget, state), citation chips on cited claims (see [search contract](../public/search-and-citations.md)), unread marker |
| Mandates list | Each mandate: action type, context (RFQ/project/company), conditions and limits (amount ceiling, delivery terms), validity window, budgets (transaction / platform-service), approval policy (none within limits / digest approval / always escalate), version, state (active / paused / revoked / expired), "Edit" creates new version |
| Approval digest | Exact action digest: action, counterparty, amount, version ids, conditions; expiry; "Approve" / "Reject"; invalidation notice when terms changed |
| Run status | Per run: lifecycle state with timestamp, attempts, external action evidence (receipt ids), outcome_unknown with reconciliation status, "Stop" (blocks subsequent actions; explains what cannot be undone), useful action log (no chain-of-thought) |
| Connected channels | Email/messenger grants with scopes, revoke (see settings) |
| Budgets | Transaction budget and platform-service budget reservation state per run |

## Primary tasks

1. Ask, get cited answers, and turn suggestions into drafts.
2. Delegate a bounded action (e.g., choose a supplier under a ceiling) via a mandate form (journey 7).
3. Approve or reject exact digests.
4. Watch runs; stop or revoke; understand what is already committed and what is unknown.

## Layout regions

| Width | Full page | Overlay |
|---|---|---|
| Desktop ≥1280 | Shell; PageHeader ("Assistant", tabs: Conversation, Mandates, Approvals, Runs; `assistantPage.tabs.*`); Conversation: conversation column max 840 px with composer at bottom (sticky), right rail: active mandates summary, approvals waiting, runs in progress | Panel 400×640 px anchored bottom-right above the launcher, `position: fixed`, z-index above content and below modal dialogs; shadow; header (name "Assistant", state line, buttons: "Open page", "Minimize", "Close"); conversation; composer; attention strip for approvals ("Awaiting decision: 1 — Open"). Page content is never pushed or resized |
| Tablet | Page: rail below conversation | Overlay 380×600 px; same behaviour |
| Mobile <768 | Page: single column; tabs scroll | Overlay becomes full-screen modal sheet (focus trapped), with close in header; launcher hidden while open |

Launcher: 56 px (48 px mobile) circular button, icon only, label "Assistant", badge for unread/action-required, never overlaps the focused control (accessibility: when a focused element is under the launcher's area, the page scrolls the element into unobstructed view, `scroll-padding-bottom`).

## Component inventory

AssistantLauncher, AssistantOverlay (non-modal `role="complementary"` with `aria-label` on desktop/tablet; `role="dialog"` `aria-modal="true"` on mobile), OverlayHeader (Minimize, Close, OpenPage), ConversationList (`role="log"`, `aria-live="polite"` for new assistant messages; user messages not re-announced), MessageBubble, ProposalCard (title, why, "Create a draft", "Dismiss"), ActionCard (state, digest summary, links), CitationChip, Composer (textarea auto-grow, send button, attach with scan note, Enter sends / Shift+Enter newline documented), MandateForm (action type select, context picker, conditions, limits with currency, validity, budgets, approval policy, escalation contact, summary review step), MandateCard (version, state, "Pause", "Revoke", "Edit"), ApprovalDigestCard (field list, expiry countdown as text, Approve/Reject with ConfirmDialog), RunStatusBadge (proposed/authorized/reserved/queued/executing/pending/succeeded/failed/outcome_unknown/reconciling/revoked), RunTimeline (events with timestamps, evidence receipts), StopDialog (explains blocked future actions vs committed external actions), BudgetStatus, EmptyState, Skeleton, Toast.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (new user) | Conversation shows a short explanation and three suggested starts (read-only text, not auto-actions); Mandates: "No mandates" + "Create a mandate"; Approvals: "No decisions needed" |
| Loading | Conversation history skeleton; run page skeleton |
| Error | Message send failed: inline "Not sent" with retry; model provider unavailable: assistant replies with status card "The assistant is temporarily unavailable. Search over exact data still works." |
| Permission-denied | Mandate form for company context without grant: context not offered; run for a revoked grant: state "Revoked: rights changed" |
| Offline | Overlay opens read-only; composer disabled with text |
| Partial/stale | Cited answer with unavailable citations → `qualified`; conversation after employment end: employer-derived messages replaced by "Content unavailable: company access has ended" |
| Unread | Launcher badge count; overlay header announces "New messages: N" on open |
| Action required | Launcher amber badge + text alternative; attention strip in overlay; Overview Decisions row |
| Outcome unknown | RunStatusBadge "Outcome unknown"; card explains reconciliation, no retry; stop button shows "Stop further actions" only |
| Revoked/stopped | Card lists actions that were already committed externally (cannot be undone) and those blocked |
| Digest invalidated | ApprovalDigestCard disabled actions with "The terms changed; request a new approval" |

## Keyboard order and focus

Launcher is the last tab stop of the page (after main content). Activating it opens the overlay and moves focus to the overlay header close button (or first unread message if the user preference says so); `Escape` closes (desktop: only when focus is inside the overlay) and returns focus to the launcher; "Minimize" collapses to the launcher with state retained. Desktop overlay is non-modal: Tab leaves the overlay to the page in DOM order (overlay is placed after main content, before the launcher); page remains fully operable. Mobile overlay is modal with focus trap. Composer: Enter sends, Shift+Enter newline; send button has label. Conversation `role="log"` so new assistant messages are announced without stealing focus. Full page tabs follow the tabs pattern. Approval dialogs focus the non-destructive button first.

## Responsive table behaviour

Mandates list and runs list tables → cards below 768; digest field list is a `dl` at all widths.

## Locale keys

| Key | English |
|---|---|
| `assistant.title` | Assistant |
| `assistant.tabs.conversation` | Conversation |
| `assistant.tabs.mandates` | Mandates |
| `assistant.tabs.approvals` | Approvals |
| `assistant.tabs.runs` | Runs |
| `assistant.overlay.label` | Assistant window |
| `assistant.overlay.openPage` | Open page |
| `assistant.overlay.minimize` | Minimize |
| `assistant.overlay.close` | Close |
| `assistant.overlay.newMessages` | {count, plural, one {# new message} other {# new messages}} |
| `assistant.attention` | {count, plural, one {# decision is waiting for you} other {# decisions are waiting for you}} |
| `assistant.attentionOpen` | Open |
| `assistant.composer.placeholder` | Ask a question or describe a task |
| `assistant.composer.send` | Send |
| `assistant.composer.attach` | Attach a file |
| `assistant.composer.attachNote` | Files are scanned, but their content is treated as untrusted until you confirm it. |
| `assistant.composer.hint` | Enter — send, Shift+Enter — new line |
| `assistant.notSent` | Not sent |
| `assistant.unavailable` | The assistant is temporarily unavailable. Search over exact data still works. |
| `assistant.offline` | No connection. You can read the history. |
| `assistant.intro` | The assistant answers with sources, prepares drafts and carries out mandates only within the authority you set. |
| `assistant.proposal.createDraft` | Create a draft |
| `assistant.proposal.dismiss` | Dismiss |
| `assistant.employerContentRemoved` | Content unavailable: company access has ended |
| `mandate.create` | Create a mandate |
| `mandate.empty` | No mandates |
| `mandate.action` | Action |
| `mandate.context` | Context |
| `mandate.conditions` | Conditions |
| `mandate.limit` | Amount limit |
| `mandate.validity` | Validity |
| `mandate.budget.transaction` | Transaction budget |
| `mandate.budget.platform` | Budget for paid platform services |
| `mandate.approvalPolicy` | Approval |
| `mandate.approval.none` | Not required within the limits |
| `mandate.approval.digest` | Every action needs approval |
| `mandate.approval.escalate` | Always pass the decision to me |
| `mandate.escalation` | Who takes the decision if the conditions are not met |
| `mandate.version` | Version {version} |
| `mandate.state.active` | Active |
| `mandate.state.paused` | Paused |
| `mandate.state.revoked` | Revoked |
| `mandate.state.expired` | Expired |
| `mandate.pause` | Pause |
| `mandate.revoke` | Revoke |
| `mandate.edit` | Edit |
| `mandate.editNote` | Editing creates a new version of the mandate. Current tasks will be rechecked. |
| `mandate.noAuthorityNote` | Text in the conversation gives the assistant no authority. Authority is set only here. |
| `approval.title` | Action approval |
| `approval.empty` | No decisions needed |
| `approval.approve` | Approve |
| `approval.reject` | Reject |
| `approval.expiresIn` | Valid until {date} |
| `approval.invalidated` | The terms changed; request a new approval |
| `approval.bindsDigest` | The approval applies only to these exact terms. |
| `run.state.proposed` | Proposed |
| `run.state.authorized` | Authorized |
| `run.state.reserved` | Budget reserved |
| `run.state.queued` | Queued |
| `run.state.executing` | Running |
| `run.state.pending` | Awaiting confirmation |
| `run.state.succeeded` | Done |
| `run.state.failed` | Failed |
| `run.state.outcomeUnknown` | Outcome unknown |
| `run.state.reconciling` | Reconciling |
| `run.state.revoked` | Revoked |
| `run.outcomeUnknownExplain` | The external system did not answer. We are reconciling the outcome; the action is not retried automatically. |
| `run.stop` | Stop |
| `run.stopFuture` | Stop further actions |
| `run.stopExplain` | Future actions will be blocked. External actions already performed cannot be undone: |
| `run.committed` | Already performed |
| `run.blocked` | Blocked |
| `run.evidence` | Confirmation: {receipt} |
| `run.revokedRights` | Revoked: rights changed |
| `run.log` | Action log |

## Open questions

- Overlay default focus target on open (close button vs first unread) — a11y review.
- Overlay size persistence and resizability (proposal: fixed sizes, no resize in first slice).
- Proactive proposals cadence and the service backlog UI (R11) — AST-001; only a card is contracted here.
- Z-order when citation drawer and overlay are both open: drawer above overlay (overlay 20, panel/drawer 30 in the [layout proposal](../layout-and-tokens-proposal.md)).
