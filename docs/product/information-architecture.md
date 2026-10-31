# Information architecture

## Public navigation — exact order and labels

`Главная`, `Новости`, `Статьи`, `События`, `Компании`, `Люди`, `Проекты`, `Журнал` (events added by owner decision, [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md); labels shown in the active language).

Routes: `/`, `/news`, `/articles`, `/events`, `/companies`, `/people`, `/projects`, `/magazine`, plus `/search` and public certificate checks at `/certificates/:id`; details by stable public slug. A public resource is usable before login. Directories include source/claim status and provenance. Authentication routes `/login`, `/signup`, `/recover`; no fake functional auth forms in the bootstrap.

## Workspace navigation

Stable destinations: `Обзор`, `Моя страница`, `Компания`, `Проекты`, `Закупки`, `Продажи`, `Публикации`, `Помощник`; outbound `В отрасль`. Proposed paths `/app`, `/app/me`, `/app/company`, `/app/projects`, `/app/procurement`, `/app/sales`, `/app/publications`, `/app/assistant`.

A non-commercial participant need not pin irrelevant commerce modules. User controls pinning deliberately in contextual settings; the assistant must not reorder the menu. Hidden empty cards do not silently relocate navigation. The shared company hub has no employer selector. If no company is linked, use a purposeful empty state with optional joining/creation; do not force registration completion.

Top-right account is only a circular avatar; menu on click supports account/security/preferences/billing as permitted. Notification bell is not a mailbox. Collapse control belongs inside sidebar brand row. No duplicate account block, separate team/documents/partners/billing navigation, primary menu-customization button, or buyer/seller role-focus switch.

The daily overview highlights decisions, ongoing work and relevant events without giant omnibus charts. Procurement and sales can appear together. Contextual object tabs contain files, correspondence, approval history, budget and participants within permissions. Company settings and company billing live with the company; personal settings with the account. Platform editorial/support/moderation/commercial administration is a separately permissioned administration surface, not an ordinary company setting.

## Assistant

One assistant conversation surface: full page plus icon-only circular bottom-right launcher. Overlay floats above content; never reflows or shrinks the page. Include close/minimize, keyboard focus/return, screen-reader name, unread/action-required state and accessible expanded view. Full page and overlay share conversation/run state. Internal worker roles stay internal. Chat prose is not the source of truth for a structured approval or committed external result.

## Page contract before implementation

Every screen needs audience/access policy, data projection, primary tasks, empty/loading/error/permission-denied states, narrow-width layout, keyboard order, responsive table behavior, locale keys and evidence source. References determine hierarchy/direction, not exact text or field access. Missing pages are enumerated in the design inventory and tasked explicitly.
