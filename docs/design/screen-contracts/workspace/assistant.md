# Assistant («Помощник»): full page and floating overlay

Routes: `/app/assistant` (full page), `/app/assistant/mandates`, `/app/assistant/approvals`, `/app/assistant/runs/[id]`; the overlay is route-less and available on every `/app/*` page via the launcher.

## Status and evidence

`no reference` (the reference overview shows only the launcher button). Spec R09 (one assistant; full page and icon-only bottom-right overlay launcher; overlay does not shrink content; internals may specialize without exposing agent management), R10 (delegation within explicit authority: action/context/conditions/limits/time/budgets/approval/escalation/revocation), R11 (proactive deliverables; user service backlog distinct), R29 (durable structured run/action/approval/outcome records; outcome_unknown → reconciliation), "Assistant journeys"; IA "Assistant"; accessibility doc (overlay traps focus only when modal, Escape/close, restore focus to launcher, does not cover focused control, no reflow); [lifecycles](../../../data/lifecycles.md) (Proposed → Authorized → Reserved → Queued → Executing → Pending/Succeeded/Failed/OutcomeUnknown → Reconciling; Revoked). Rejection ledger: no docked panel, no "Agents" UI.

## Audience and access policy

Authenticated person; the assistant acts only for that principal under structured mandates. Chat prose never grants authority; a mandate is a structured record created through a form, inspectable and revocable. Company-scoped mandates require company grants and vanish on membership end. Platform staff never see conversations without an audited case grant.

## Data projection

| Surface | Content |
|---|---|
| Conversation (shared by page and overlay) | Messages (user/assistant), proposal cards (deliverable suggestions → «Создать черновик»), structured action cards (what, context, conditions, budget, state), citation chips on cited claims (see [search contract](../public/search-and-citations.md)), unread marker |
| Mandates list | Each mandate: action type, context (RFQ/project/company), conditions and limits (amount ceiling, delivery terms), validity window, budgets (transaction / platform-service), approval policy (none within limits / digest approval / always escalate), version, state (active / paused / revoked / expired), «Изменить» creates new version |
| Approval digest | Exact action digest: action, counterparty, amount, version ids, conditions; expiry; «Одобрить» / «Отклонить»; invalidation notice when terms changed |
| Run status | Per run: lifecycle state with timestamp, attempts, external action evidence (receipt ids), outcome_unknown with reconciliation status, «Остановить» (blocks subsequent actions; explains what cannot be undone), useful action log (no chain-of-thought) |
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
| Desktop ≥1280 | Shell; PageHeader («Помощник», tabs: Разговор, Поручения, Согласования, Запуски); Разговор: conversation column max 840 px with composer at bottom (sticky), right rail: active mandates summary, approvals waiting, runs in progress | Panel 400×640 px anchored bottom-right above the launcher, `position: fixed`, z-index above content and below modal dialogs; shadow; header (name «Помощник», state line, buttons: «Открыть страницу», «Свернуть», «Закрыть»); conversation; composer; attention strip for approvals («Ждёт решения: 1 — Открыть»). Page content is never pushed or resized |
| Tablet | Page: rail below conversation | Overlay 380×600 px; same behaviour |
| Mobile <768 | Page: single column; tabs scroll | Overlay becomes full-screen modal sheet (focus trapped), with close in header; launcher hidden while open |

Launcher: 56 px (48 px mobile) circular button, icon only, label «Помощник», badge for unread/action-required, never overlaps the focused control (accessibility: when a focused element is under the launcher's area, the page scrolls the element into unobstructed view, `scroll-padding-bottom`).

## Component inventory

AssistantLauncher, AssistantOverlay (non-modal `role="complementary"` with `aria-label` on desktop/tablet; `role="dialog"` `aria-modal="true"` on mobile), OverlayHeader (Minimize, Close, OpenPage), ConversationList (`role="log"`, `aria-live="polite"` for new assistant messages; user messages not re-announced), MessageBubble, ProposalCard (title, why, «Создать черновик», «Скрыть»), ActionCard (state, digest summary, links), CitationChip, Composer (textarea auto-grow, send button, attach with scan note, Enter sends / Shift+Enter newline documented), MandateForm (action type select, context picker, conditions, limits with currency, validity, budgets, approval policy, escalation contact, summary review step), MandateCard (version, state, «Приостановить», «Отозвать», «Изменить»), ApprovalDigestCard (field list, expiry countdown as text, Approve/Reject with ConfirmDialog), RunStatusBadge (proposed/authorized/reserved/queued/executing/pending/succeeded/failed/outcome_unknown/reconciling/revoked), RunTimeline (events with timestamps, evidence receipts), StopDialog (explains blocked future actions vs committed external actions), BudgetStatus, EmptyState, Skeleton, Toast.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (new user) | Conversation shows a short explanation and three suggested starts (read-only text, not auto-actions); Mandates: «Поручений нет» + «Создать поручение»; Approvals: «Решений не требуется» |
| Loading | Conversation history skeleton; run page skeleton |
| Error | Message send failed: inline «Не отправлено» with retry; model provider unavailable: assistant replies with status card «Помощник временно недоступен. Поиск по точным данным работает.» |
| Permission-denied | Mandate form for company context without grant: context not offered; run for a revoked grant: state «Отозвано: права изменились» |
| Offline | Overlay opens read-only; composer disabled with text |
| Partial/stale | Cited answer with unavailable citations → `qualified`; conversation after employment end: employer-derived messages replaced by «Содержимое недоступно: доступ компании завершён» |
| Unread | Launcher badge count; overlay header announces «Новых сообщений: N» on open |
| Action required | Launcher amber badge + text alternative; attention strip in overlay; Overview Decisions row |
| Outcome unknown | RunStatusBadge «Результат неизвестен»; card explains reconciliation, no retry; stop button shows «Остановить дальнейшие действия» only |
| Revoked/stopped | Card lists actions that were already committed externally (cannot be undone) and those blocked |
| Digest invalidated | ApprovalDigestCard disabled actions with «Условия изменились; запросите новое согласование» |

## Keyboard order and focus

Launcher is the last tab stop of the page (after main content). Activating it opens the overlay and moves focus to the overlay header close button (or first unread message if the user preference says so); `Escape` closes (desktop: only when focus is inside the overlay) and returns focus to the launcher; «Свернуть» collapses to the launcher with state retained. Desktop overlay is non-modal: Tab leaves the overlay to the page in DOM order (overlay is placed after main content, before the launcher); page remains fully operable. Mobile overlay is modal with focus trap. Composer: Enter sends, Shift+Enter newline; send button has label. Conversation `role="log"` so new assistant messages are announced without stealing focus. Full page tabs follow the tabs pattern. Approval dialogs focus the non-destructive button first.

## Responsive table behaviour

Mandates list and runs list tables → cards below 768; digest field list is a `dl` at all widths.

## Locale keys

| Key | Russian |
|---|---|
| `ru.assistant.title` | Помощник |
| `ru.assistant.tabs.conversation` | Разговор |
| `ru.assistant.tabs.mandates` | Поручения |
| `ru.assistant.tabs.approvals` | Согласования |
| `ru.assistant.tabs.runs` | Запуски |
| `ru.assistant.overlay.label` | Окно помощника |
| `ru.assistant.overlay.openPage` | Открыть страницу |
| `ru.assistant.overlay.minimize` | Свернуть |
| `ru.assistant.overlay.close` | Закрыть |
| `ru.assistant.overlay.newMessages` | {count, plural, one {# новое сообщение} few {# новых сообщения} many {# новых сообщений}} |
| `ru.assistant.attention` | {count, plural, one {# решение ждёт вас} few {# решения ждут вас} many {# решений ждут вас}} |
| `ru.assistant.attentionOpen` | Открыть |
| `ru.assistant.composer.placeholder` | Спросите или опишите задачу |
| `ru.assistant.composer.send` | Отправить |
| `ru.assistant.composer.attach` | Прикрепить файл |
| `ru.assistant.composer.attachNote` | Файлы сканируются, но их содержимое считается недостоверным, пока вы его не подтвердите. |
| `ru.assistant.composer.hint` | Enter — отправить, Shift+Enter — новая строка |
| `ru.assistant.notSent` | Не отправлено |
| `ru.assistant.unavailable` | Помощник временно недоступен. Поиск по точным данным работает. |
| `ru.assistant.offline` | Нет соединения. Можно читать историю. |
| `ru.assistant.intro` | Помощник отвечает с указанием источников, готовит черновики и выполняет поручения только в рамках заданных вами полномочий. |
| `ru.assistant.proposal.createDraft` | Создать черновик |
| `ru.assistant.proposal.dismiss` | Скрыть |
| `ru.assistant.employerContentRemoved` | Содержимое недоступно: доступ компании завершён |
| `ru.mandate.create` | Создать поручение |
| `ru.mandate.empty` | Поручений нет |
| `ru.mandate.action` | Действие |
| `ru.mandate.context` | Контекст |
| `ru.mandate.conditions` | Условия |
| `ru.mandate.limit` | Лимит суммы |
| `ru.mandate.validity` | Срок действия |
| `ru.mandate.budget.transaction` | Бюджет сделки |
| `ru.mandate.budget.platform` | Бюджет платных услуг платформы |
| `ru.mandate.approvalPolicy` | Согласование |
| `ru.mandate.approval.none` | Не требуется в пределах лимитов |
| `ru.mandate.approval.digest` | Требуется согласование каждого действия |
| `ru.mandate.approval.escalate` | Всегда передавать мне решение |
| `ru.mandate.escalation` | Кому передать решение, если условия не выполняются |
| `ru.mandate.version` | Версия {version} |
| `ru.mandate.state.active` | Действует |
| `ru.mandate.state.paused` | Приостановлено |
| `ru.mandate.state.revoked` | Отозвано |
| `ru.mandate.state.expired` | Истекло |
| `ru.mandate.pause` | Приостановить |
| `ru.mandate.revoke` | Отозвать |
| `ru.mandate.edit` | Изменить |
| `ru.mandate.editNote` | Изменение создаст новую версию поручения. Текущие задачи будут перепроверены. |
| `ru.mandate.noAuthorityNote` | Текст в разговоре не даёт помощнику полномочий. Полномочия задаются только здесь. |
| `ru.approval.title` | Согласование действия |
| `ru.approval.empty` | Решений не требуется |
| `ru.approval.approve` | Одобрить |
| `ru.approval.reject` | Отклонить |
| `ru.approval.expiresIn` | Действительно до {date} |
| `ru.approval.invalidated` | Условия изменились; запросите новое согласование |
| `ru.approval.bindsDigest` | Одобрение относится только к этим точным условиям. |
| `ru.run.state.proposed` | Предложено |
| `ru.run.state.authorized` | Разрешено |
| `ru.run.state.reserved` | Бюджет зарезервирован |
| `ru.run.state.queued` | В очереди |
| `ru.run.state.executing` | Выполняется |
| `ru.run.state.pending` | Ожидает подтверждения |
| `ru.run.state.succeeded` | Выполнено |
| `ru.run.state.failed` | Не выполнено |
| `ru.run.state.outcomeUnknown` | Результат неизвестен |
| `ru.run.state.reconciling` | Сверка |
| `ru.run.state.revoked` | Отозвано |
| `ru.run.outcomeUnknownExplain` | Внешняя система не ответила. Мы сверяем результат; повторное действие не выполняется автоматически. |
| `ru.run.stop` | Остановить |
| `ru.run.stopFuture` | Остановить дальнейшие действия |
| `ru.run.stopExplain` | Будущие действия будут заблокированы. Уже совершённые внешние действия отменить нельзя: |
| `ru.run.committed` | Уже совершено |
| `ru.run.blocked` | Заблокировано |
| `ru.run.evidence` | Подтверждение: {receipt} |
| `ru.run.revokedRights` | Отозвано: права изменились |
| `ru.run.log` | Журнал действий |

## Open questions

- Overlay default focus target on open (close button vs first unread) — a11y review.
- Overlay size persistence and resizability (proposal: fixed sizes, no resize in first slice).
- Proactive proposals cadence and the service backlog UI (R11) — AST-001; only a card is contracted here.
- Z-order when citation drawer and overlay are both open: drawer above overlay (overlay 20, panel/drawer 30 in the [layout proposal](../layout-and-tokens-proposal.md)).
