# Publications («Публикации»): drafts, lifecycle, corrections

Routes: `/app/publications` (list), `/app/publications/new`, `/app/publications/[id]` (editor), `/app/publications/[id]/history`.

## Status and evidence

`no reference`. Spec R16 (author, format, topics, entity links, lifecycle, corrections; personal/company/editorial authorship; walls reference the same record), "Content and editorial" (editing rights independent from authorship credit; lifecycle draft → review where required → scheduled → published → corrected/retracted; assistant-assisted optional), journey 1; CNT-001 brief (author vs editor rights distinct).

## Audience and access policy

| Role | Access |
|---|---|
| Any registered person | Own personal publications in all states |
| Company member with publish/editor grant | Company-authored publications; may edit without being credited as author |
| Editorial (platform) | Review queue lives in administration, not here; an item «на проверке» shows reviewer feedback |
| Assistant | May create drafts under mandate; «при участии помощника» flag set automatically; publishing requires the person's/ company's publication authority |

## Data projection

| Field | Notes |
|---|---|
| Title, lede, body (rich text with headings, lists, figures, tables, quotes), cover | Body stored versioned |
| Format (разбор, практика, опыт, мнение, интервью, история проекта, обзор, новость) | Separate from topics |
| Topics (taxonomy), entity links (company/person/project; only ones the author may reference) | Links to public projections |
| Author credit (me / company) and editors list | Credit ≠ edit rights |
| Lifecycle state, scheduled time, published time, versions, corrections (summary per correction), retraction record | Visible history |
| Assistant-assisted flag | Read-only once set |
| Where shown: my wall, company wall, magazine issue N (pinned version) | Informational |

## Primary tasks

1. Draft and publish an article under policy (review if required).
2. Correct a published article with a visible correction note; retract if needed.
3. Publish on behalf of the company with the right grant.
4. See where a publication is referenced (walls, magazine).

## Layout regions

| Width | List | Editor |
|---|---|---|
| Desktop ≥1280 | Shell; PageHeader («Публикации», «Написать»); tabs by state (Черновики, На проверке, Запланированные, Опубликованные, Исправленные, Отозванные); DataTable (title, format, author credit, state, updated, where shown) | Shell; PageHeader (title field inline, state chip, actions: Сохранить, Отправить на проверку / Опубликовать / Запланировать, Предпросмотр, меню: История, Отозвать); two-column: editor (max 760 px) + settings rail (format, topics, cover, entity links, author credit, editors, schedule) |
| Tablet | Cards | Rail collapses into a «Настройки» sheet |
| Mobile <768 | Cards | Full-width editor; toolbar sticky; settings sheet |

## Component inventory

PageHeader, Tabs, DataTable, PublicationRow, StatusChip (lifecycle), RichTextEditor (accessible toolbar with labelled buttons, keyboard shortcuts documented, headings/lists/links/figure/table/quote; no colour-only states), CoverUpload, FormatSelect, TopicMultiSelect (Combobox), EntityLinkPicker (search over permitted entities), AuthorCreditSelect (me / company if granted), EditorsList, SchedulePicker, CorrectionDialog (summary required; shows which version is current), RetractDialog (reason; explains visible record), HistoryList (versions, corrections, who/when), PreviewDialog, ReviewFeedbackCard, Toast, EmptyState, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | «Публикаций пока нет» + «Написать»; hint that company authorship needs a grant |
| Loading | Skeleton; editor shows «Загружаем…» |
| Error | Autosave failure banner «Черновик не сохранён» with retry; never lose text locally |
| Permission-denied | «Опубликовать» replaced by «Отправить на проверку» when policy requires review; company credit option hidden without grant; editing someone else's item → NoAccess |
| Offline | Local draft retained; banner |
| Partial/stale | Item pinned in a released issue: editing after release creates a correction (banner «Материал входит в выпуск № N; изменения станут исправлением»); concurrent edit conflict → «Документ изменён другим редактором» with reload/compare |
| Review | «На проверке» shows reviewer feedback and allows withdraw |

## Keyboard order and focus

Shell → header (title input, actions) → editor toolbar (toolbar pattern: one tab stop, arrows between buttons) → editor content → rail fields → footer actions. Dialogs trap focus. After publish, focus to the state chip with announcement «Опубликовано».

## Responsive table behaviour

List table → cards below 768; history table (версия, дата, автор изменения, тип) → stacked list.

## Locale keys

| Key | Russian |
|---|---|
| `ru.publications.title` | Публикации |
| `ru.publications.write` | Написать |
| `ru.publications.empty` | Публикаций пока нет |
| `ru.publications.companyHint` | Чтобы публиковать от имени компании, нужно право публикации в компании. |
| `ru.publications.tabs.drafts` | Черновики |
| `ru.publications.tabs.review` | На проверке |
| `ru.publications.tabs.scheduled` | Запланированные |
| `ru.publications.tabs.published` | Опубликованные |
| `ru.publications.tabs.corrected` | Исправленные |
| `ru.publications.tabs.retracted` | Отозванные |
| `ru.publications.col.title` | Название |
| `ru.publications.col.format` | Формат |
| `ru.publications.col.author` | От чьего имени |
| `ru.publications.col.state` | Состояние |
| `ru.publications.col.updated` | Обновлено |
| `ru.publications.col.shownIn` | Где показывается |
| `ru.pubState.draft` | Черновик |
| `ru.pubState.inReview` | На проверке |
| `ru.pubState.scheduled` | Запланировано на {date} |
| `ru.pubState.published` | Опубликовано |
| `ru.pubState.corrected` | Исправлено |
| `ru.pubState.retracted` | Отозвано |
| `ru.editor.titlePlaceholder` | Заголовок |
| `ru.editor.ledePlaceholder` | Короткое описание |
| `ru.editor.bodyPlaceholder` | Текст материала |
| `ru.editor.save` | Сохранить |
| `ru.editor.autosaved` | Черновик сохранён {time} |
| `ru.editor.autosaveFailed` | Черновик не сохранён |
| `ru.editor.sendToReview` | Отправить на проверку |
| `ru.editor.publish` | Опубликовать |
| `ru.editor.schedule` | Запланировать |
| `ru.editor.preview` | Предпросмотр |
| `ru.editor.history` | История |
| `ru.editor.retract` | Отозвать |
| `ru.editor.settings` | Настройки материала |
| `ru.editor.format` | Формат |
| `ru.editor.topics` | Темы |
| `ru.editor.cover` | Обложка |
| `ru.editor.entityLinks` | Упоминания |
| `ru.editor.authorCredit` | От чьего имени |
| `ru.editor.authorMe` | От себя |
| `ru.editor.authorCompany` | От компании |
| `ru.editor.editors` | Редакторы |
| `ru.editor.assistantAssisted` | При участии помощника |
| `ru.editor.inIssueWarning` | Материал входит в выпуск № {issue}. Изменения станут исправлением с видимой пометкой. |
| `ru.editor.conflict` | Документ изменён другим редактором. Обновите страницу или сравните версии. |
| `ru.editor.correction.title` | Исправление |
| `ru.editor.correction.summary` | Что исправлено |
| `ru.editor.retract.reason` | Причина отзыва |
| `ru.editor.retract.note` | На месте материала останется запись об отзыве. |
| `ru.editor.reviewFeedback` | Замечания редакции |
| `ru.editor.withdrawReview` | Отозвать с проверки |
| `ru.editor.toolbar` | Форматирование |

## Open questions

- Which formats require editorial review (policy by CNT-001).
- Rich-text storage format and image licensing attestation at upload (O06).
- Comments on publications: out of scope.
