# Magazine: current issue, web reader, archive, issue detail, PDF, corrections

Routes: `/magazine` (current issue landing), `/magazine/archive`, `/magazine/[issue]` (issue detail), `/magazine/[issue]/read` (web reader), `/magazine/[issue]/pdf` (download endpoint, not a page).

## Status and evidence

`proposed (reference: accepted direction)` — `weekly-magazine.png` (private design archive), manifest `accepted_direction`: "Desktop reference only; mobile reader and separately laid-out downloadable PDF missing." Spec R17, "Content and editorial" (issue release freezes curated order and publication versions; corrections create visible revisions; web reader and PDF are separate artifacts with shared provenance); journey 9; accessibility doc (mobile reader single column; PDF pagination/reading order/text checked separately).

## Audience and access policy

All released issues are public (no paywall; the old journal paywall is rejected). Editorial staff curate in administration, not here. An issue in `draft/curated/review` is invisible publicly; its slug returns 404. Download of the PDF is public once the PDF artifact for that edition exists.

## Data projection

| Field | Public |
|---|---|
| Issue number, date range, headline, lede, cover (licensed) | yes |
| Edition identity: edition number (1 = original, 2+ = corrected), release date | yes |
| Table of contents: ordering, pinned publication versions, format per item, page numbers (only if the PDF exists) | yes |
| Article content (the pinned publication version, not the latest) | yes, with a banner if a newer corrected version exists |
| PDF: size, page count, generation date, accessibility note | yes when present; «готовится» when generation pending |
| Corrections list per issue: affected item, old/new edition, summary, date | yes |
| Draft issues, reviewer notes, unreleased PDFs | never |

## Primary tasks

1. Find the latest issue and read it on any device.
2. Download the designed PDF.
3. Browse the archive by year/month/topic/number.
4. See what was corrected since release.

## Layout regions

| Width | Current issue (`/magazine`) and issue detail (`/magazine/[issue]`) | Web reader (`/magazine/[issue]/read`) | Archive |
|---|---|---|---|
| Desktop ≥1280 | Public shell; breadcrumb; H1 «Еженедельный журнал» (detail: issue title); «Архив выпусков» link; issue block: cover left (~40%), right: «Свежий выпуск» badge (current only), «№ N · date range», headline, lede, meta («N материалов»; page count only with PDF), dark «Читать онлайн», outlined «Скачать PDF» with size, helper line; «В этом номере» short TOC; CorrectionBanner if edition > 1; optional spread preview (desktop-only, decorative; reader is the real thing); full TOC two columns; «Исправления в выпуске» list; next/previous issue links; CTA «Предложить материал»; footer | Reader shell (brand, issue label, «К выпуску», «Содержание» button, progress «3 из 8», font size control, «Скачать PDF», close); article column max ~720 px; left sticky TOC on ≥1280; prev/next item at bottom; correction banner per item when pinned version was corrected | Public shell; H1 «Архив выпусков»; filters (year, month, search by topic/number); grid of cover cards (number, date range, title, item count, «Читать онлайн», «Скачать PDF»); pagination |
| Tablet | Cover above text; TOC single column; spread preview hidden | TOC in a sheet; single column | Grid 2 columns |
| Mobile <768 | Single column; cover ~60% width centered; buttons full width stacked; TOC single column; no spread | Single column, 16 px gutters, 18 px base text; sticky compact top bar; TOC sheet; swipe is optional, buttons mandatory | Grid 1 column; filters in sheet |

The two-page spread in the reference is **optional desktop presentation**; the reader never depends on it. Spread emulation is not used on mobile.

## Component inventory

PublicShell, ReaderShell, Breadcrumb, IssueHeader, CoverImage, IssueBadge, TOCList (numbered, format chips, page numbers optional), DownloadButton (with size/format/accessibility note), CorrectionBanner, CorrectionList, EditionLabel, ReaderTopBar, ReaderProgress, FontSizeControl, ArticleBody, PrevNextNav, ArchiveFilters, IssueCard, Pagination, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | No released issue: `/magazine` shows «Первый выпуск готовится» with link to articles; archive shows «Выпусков пока нет» |
| Loading | Skeleton issue block; reader streams item by item |
| Error | Inline error + retry; reader shows error per item without losing TOC |
| Permission-denied | Unreleased slug → 404 |
| Offline | Reader keeps already-loaded items; «Скачать PDF» disabled with toast |
| Partial/stale | PDF missing: button replaced by «PDF готовится» (disabled, `aria-disabled`, reason); edition > 1: CorrectionBanner at issue and item level, link to «Исправления в выпуске»; item whose source publication was retracted shows RetractionNotice in the pinned place of the TOC |

## Keyboard order and focus

Issue page: shell → H1 → archive link → «Читать онлайн» → «Скачать PDF» → TOC links → corrections → prev/next. Reader: skip link → top bar (back, TOC, font size, PDF, close) → article content → prev/next. TOC sheet is a modal dialog with focus return. Reader `Escape` closes TOC sheet, not the reader. Font size control is a group of two buttons with live region announcing size.

## Responsive table behaviour

Tables inside articles follow the [articles contract](articles.md). The TOC is an ordered list, not a table.

## Locale keys

| Key | Russian |
|---|---|
| `ru.magazine.title` | Еженедельный журнал |
| `ru.magazine.lede` | Люди, идеи и практика отрасли — в одном выпуске. *(wording from reference; editorial review)* |
| `ru.magazine.archive` | Архив выпусков |
| `ru.magazine.current` | Свежий выпуск |
| `ru.magazine.issueLabel` | № {number} · {dateRange} |
| `ru.magazine.readOnline` | Читать онлайн |
| `ru.magazine.downloadPdf` | Скачать PDF |
| `ru.magazine.downloadPdfMeta` | PDF, {size} |
| `ru.magazine.pdfPending` | PDF готовится |
| `ru.magazine.formatsHint` | Онлайн — адаптивная версия для чтения с любого экрана. PDF — отдельно свёрстанная версия для сохранения и печати. |
| `ru.magazine.inThisIssue` | В этом номере |
| `ru.magazine.fullContents` | Полное содержание |
| `ru.magazine.contents` | Содержание выпуска |
| `ru.magazine.itemsCount` | {count, plural, one {# материал} few {# материала} many {# материалов}} |
| `ru.magazine.pagesCount` | {count, plural, one {# страница} few {# страницы} many {# страниц}} |
| `ru.magazine.edition` | Редакция выпуска {edition} от {date} |
| `ru.magazine.corrections` | Исправления в выпуске |
| `ru.magazine.correctionItem` | {title}: {summary} ({date}) |
| `ru.magazine.noIssues` | Выпусков пока нет |
| `ru.magazine.firstIssuePending` | Первый выпуск готовится |
| `ru.magazine.previousIssue` | Предыдущий выпуск |
| `ru.magazine.nextIssue` | Следующий выпуск |
| `ru.magazine.allIssues` | Все выпуски |
| `ru.magazine.suggestTitle` | Есть история для следующего выпуска? |
| `ru.magazine.suggestAction` | Предложить материал |
| `ru.magazine.aboutEditorial` | О журнале и редакции |
| `ru.reader.backToIssue` | К выпуску |
| `ru.reader.progress` | {index} из {total} |
| `ru.reader.fontSize` | Размер текста |
| `ru.reader.fontSmaller` | Меньше |
| `ru.reader.fontLarger` | Больше |
| `ru.reader.close` | Закрыть режим чтения |
| `ru.reader.previous` | Предыдущий материал |
| `ru.reader.next` | Следующий материал |
| `ru.archive.year` | Год |
| `ru.archive.month` | Месяц |
| `ru.archive.searchPlaceholder` | Тема или номер выпуска |

## Open questions

- Whether the spread preview is kept at all (decorative, costs rendering work); proposal: drop it in the first slice.
- Page count on web before PDF exists: hide.
- Font size control vs browser zoom only: proposal keep the control (reader comfort), persisted per browser.
- PDF artifact requirements (handoff to CNT-001, to be confirmed there): separate layout template (A4 portrait proposed), own typography, page numbers matching the TOC, cover, colophon with edition number and date; tagged PDF with reading order, real text (no outlined fonts), alt text for figures, document language `ru`, bookmarks per item, checked page-by-page per the accessibility doc; filename pattern `trustwork-NN-YYYY.pdf`, corrected edition appends `-r2`.
