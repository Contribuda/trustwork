# Publications: drafts, lifecycle, corrections

Routes: `/app/publications` (list), `/app/publications/new`, `/app/publications/[id]` (editor), `/app/publications/[id]/history`.

## Status and evidence

`no reference`. Spec R16 (author, format, topics, entity links, lifecycle, corrections; personal/company/editorial authorship; walls reference the same record), "Content and editorial" (editing rights independent from authorship credit; lifecycle draft → review where required → scheduled → published → corrected/retracted; assistant-assisted optional), journey 1; CNT-001 brief (author vs editor rights distinct).

## Audience and access policy

| Role | Access |
|---|---|
| Any registered person | Own personal publications in all states |
| Company member with publish/editor grant | Company-authored publications; may edit without being credited as author |
| Editorial (platform) | Review queue lives in administration, not here; an item "in review" shows reviewer feedback |
| Assistant | May create drafts under mandate; "with the assistant's help" flag set automatically; publishing requires the person's/ company's publication authority |

## Data projection

| Field | Notes |
|---|---|
| Title, lede, body (rich text with headings, lists, figures, tables, quotes), cover | Body stored versioned |
| Format (analysis, practice, experience, opinion, interview, project story, overview, news) | Separate from topics |
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
| Desktop ≥1280 | Shell; PageHeader ("Publications", "Write"); tabs by state (Drafts, In review, Scheduled, Published, Corrected, Retracted; `publications.tabs.*`); DataTable (title, format, author credit, state, updated, where shown) | Shell; PageHeader (title field inline, state chip, actions: Save, Send for review / Publish / Schedule, Preview, menu: History, Retract); two-column: editor (max 760 px) + settings rail (format, topics, cover, entity links, author credit, editors, schedule) |
| Tablet | Cards | Rail collapses into a "Settings" sheet |
| Mobile <768 | Cards | Full-width editor; toolbar sticky; settings sheet |

## Component inventory

PageHeader, Tabs, DataTable, PublicationRow, StatusChip (lifecycle), RichTextEditor (accessible toolbar with labelled buttons, keyboard shortcuts documented, headings/lists/links/figure/table/quote; no colour-only states), CoverUpload, FormatSelect, TopicMultiSelect (Combobox), EntityLinkPicker (search over permitted entities), AuthorCreditSelect (me / company if granted), EditorsList, SchedulePicker, CorrectionDialog (summary required; shows which version is current), RetractDialog (reason; explains visible record), HistoryList (versions, corrections, who/when), PreviewDialog, ReviewFeedbackCard, Toast, EmptyState, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | "No publications yet" + "Write"; hint that company authorship needs a grant |
| Loading | Skeleton; editor shows "Loading…" |
| Error | Autosave failure banner "Draft not saved" with retry; never lose text locally |
| Permission-denied | "Publish" replaced by "Send for review" when policy requires review; company credit option hidden without grant; editing someone else's item → NoAccess |
| Offline | Local draft retained; banner |
| Partial/stale | Item pinned in a released issue: editing after release creates a correction (banner "The material is part of issue No. N; changes will become a correction"); concurrent edit conflict → "Another editor changed the document" with reload/compare |
| Review | "In review" shows reviewer feedback and allows withdraw |

## Keyboard order and focus

Shell → header (title input, actions) → editor toolbar (toolbar pattern: one tab stop, arrows between buttons) → editor content → rail fields → footer actions. Dialogs trap focus. After publish, focus to the state chip with announcement "Published".

## Responsive table behaviour

List table → cards below 768; history table (version, date, author of the change, type) → stacked list.

## Locale keys

| Key | English |
|---|---|
| `publications.title` | Publications |
| `publications.write` | Write |
| `publications.empty` | No publications yet |
| `publications.companyHint` | To publish on behalf of the company you need the publishing right in the company. |
| `publications.tabs.drafts` | Drafts |
| `publications.tabs.review` | In review |
| `publications.tabs.scheduled` | Scheduled |
| `publications.tabs.published` | Published |
| `publications.tabs.corrected` | Corrected |
| `publications.tabs.retracted` | Retracted |
| `publications.col.title` | Title |
| `publications.col.format` | Format |
| `publications.col.author` | On behalf of |
| `publications.col.state` | State |
| `publications.col.updated` | Updated |
| `publications.col.shownIn` | Shown in |
| `pubState.draft` | Draft |
| `pubState.inReview` | In review |
| `pubState.scheduled` | Scheduled for {date} |
| `pubState.published` | Published |
| `pubState.corrected` | Corrected |
| `pubState.retracted` | Retracted |
| `editor.titlePlaceholder` | Title |
| `editor.ledePlaceholder` | Short description |
| `editor.bodyPlaceholder` | Text of the material |
| `editor.save` | Save |
| `editor.autosaved` | Draft saved {time} |
| `editor.autosaveFailed` | Draft not saved |
| `editor.sendToReview` | Send for review |
| `editor.publish` | Publish |
| `editor.schedule` | Schedule |
| `editor.preview` | Preview |
| `editor.history` | History |
| `editor.retract` | Retract |
| `editor.settings` | Material settings |
| `editor.format` | Format |
| `editor.topics` | Topics |
| `editor.cover` | Cover |
| `editor.entityLinks` | Mentions |
| `editor.authorCredit` | Published as |
| `editor.authorMe` | Myself |
| `editor.authorCompany` | The company |
| `editor.editors` | Editors |
| `editor.assistantAssisted` | With the assistant's help |
| `editor.inIssueWarning` | The material is part of issue No. {issue}. Changes will become a correction with a visible note. |
| `editor.conflict` | Another editor changed the document. Reload the page or compare versions. |
| `editor.correction.title` | Correction |
| `editor.correction.summary` | What was corrected |
| `editor.retract.reason` | Reason for retraction |
| `editor.retract.note` | A retraction notice will remain in place of the material. |
| `editor.reviewFeedback` | Editorial comments |
| `editor.withdrawReview` | Withdraw from review |
| `editor.toolbar` | Formatting |

## Open questions

- Which formats require editorial review (policy by CNT-001).
- Rich-text storage format and image licensing attestation at upload (O06).
- Comments on publications: out of scope.
