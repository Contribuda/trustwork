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
| PDF: size, page count, generation date, accessibility note | yes when present; "in preparation" when generation pending |
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
| Desktop ≥1280 | Public shell; breadcrumb; H1 "Weekly magazine" (detail: issue title); "Magazine archive" link; issue block: cover left (~40%), right: "Latest issue" badge (current only), "№ N · date range", headline, lede, meta ("N materials"; page count only with PDF), dark "Read online", outlined "Download PDF" with size, helper line; "In this issue" short TOC; CorrectionBanner if edition > 1; optional spread preview (desktop-only, decorative; reader is the real thing); full TOC two columns; "Corrections in the issue" list; next/previous issue links; CTA "Suggest a material"; footer | Reader shell (brand, issue label, "To the issue", "Contents" (`reader.contents`) button, progress "3 of 8", font size control, "Download PDF", close); article column max ~720 px; left sticky TOC on ≥1280; prev/next item at bottom; correction banner per item when pinned version was corrected | Public shell; H1 "Magazine archive"; filters (year, month, search by topic/number); grid of cover cards (number, date range, title, item count, "Read online", "Download PDF"); pagination |
| Tablet | Cover above text; TOC single column; spread preview hidden | TOC in a sheet; single column | Grid 2 columns |
| Mobile <768 | Single column; cover ~60% width centered; buttons full width stacked; TOC single column; no spread | Single column, 16 px gutters, 18 px base text; sticky compact top bar; TOC sheet; swipe is optional, buttons mandatory | Grid 1 column; filters in sheet |

The two-page spread in the reference is **optional desktop presentation**; the reader never depends on it. Spread emulation is not used on mobile.

## Component inventory

PublicShell, ReaderShell, Breadcrumb, IssueHeader, CoverImage, IssueBadge, TOCList (numbered, format chips, page numbers optional), DownloadButton (with size/format/accessibility note), CorrectionBanner, CorrectionList, EditionLabel, ReaderTopBar, ReaderProgress, FontSizeControl, ArticleBody, PrevNextNav, ArchiveFilters, IssueCard, Pagination, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | No released issue: `/magazine` shows "The first issue is in preparation" with link to articles; archive shows "No issues yet" |
| Loading | Skeleton issue block; reader streams item by item |
| Error | Inline error + retry; reader shows error per item without losing TOC |
| Permission-denied | Unreleased slug → 404 |
| Offline | Reader keeps already-loaded items; "Download PDF" disabled with toast |
| Partial/stale | PDF missing: button replaced by "PDF in preparation" (disabled, `aria-disabled`, reason); edition > 1: CorrectionBanner at issue and item level, link to "Corrections in the issue"; item whose source publication was retracted shows RetractionNotice in the pinned place of the TOC |

## Keyboard order and focus

Issue page: shell → H1 → archive link → "Read online" → "Download PDF" → TOC links → corrections → prev/next. Reader: skip link → top bar (back, TOC, font size, PDF, close) → article content → prev/next. TOC sheet is a modal dialog with focus return. Reader `Escape` closes TOC sheet, not the reader. Font size control is a group of two buttons with live region announcing size.

## Responsive table behaviour

Tables inside articles follow the [articles contract](articles.md). The TOC is an ordered list, not a table.

## Locale keys

| Key | English |
|---|---|
| `magazine.title` | Weekly magazine |
| `magazine.lede` | People, ideas and practice of the industry in one issue. Every week: analyses, reports, interviews and numbers. *(wording from reference; editorial review)* |
| `magazine.archive` | Magazine archive |
| `magazine.current` | Latest issue |
| `magazine.issueLabel` | No. {number} · {dateRange} |
| `magazine.readOnline` | Read online |
| `magazine.downloadPdf` | Download PDF |
| `magazine.downloadPdfMeta` | {size} |
| `magazine.pdfPending` | PDF in preparation |
| `magazine.formatsHint` | Online is the responsive version for reading on any screen. PDF is a separately laid-out version for saving and printing. |
| `magazine.inThisIssue` | In this issue |
| `magazine.fullContents` | Full contents |
| `magazine.contents` | Issue contents |
| `magazine.itemsCount` | {count, plural, one {# material} other {# materials}} |
| `magazine.pagesCount` | {count, plural, one {# page} other {# pages}} |
| `magazine.edition` | Issue edition {edition} of {date} |
| `magazine.corrections` | Corrections in the issue |
| `magazine.correctionItem` | {title}: {summary} ({date}) |
| `magazine.noIssues` | No issues yet |
| `magazine.firstIssuePending` | The first issue is in preparation |
| `magazine.previousIssue` | Previous issue |
| `magazine.nextIssue` | Next issue |
| `magazine.allIssues` | All issues |
| `magazine.suggestTitle` | A story for the next issue? |
| `magazine.suggestAction` | Suggest a material |
| `magazine.aboutEditorial` | About the magazine and the editors |
| `reader.backToIssue` | To the issue |
| `reader.progress` | {index} of {total} |
| `reader.fontSize` | Text size |
| `reader.fontSmaller` | Smaller |
| `reader.fontLarger` | Larger |
| `reader.close` | Close reading mode |
| `reader.previous` | Previous material |
| `reader.next` | Next material |
| `archive.year` | Year |
| `archive.month` | Month |
| `archive.searchPlaceholder` | Topic or issue number |

## Open questions

- Whether the spread preview is kept at all (decorative, costs rendering work); proposal: drop it in the first slice.
- Page count on web before PDF exists: hide.
- Font size control vs browser zoom only: proposal keep the control (reader comfort), persisted per browser.
- PDF artifact requirements (handoff to CNT-001, to be confirmed there): separate layout template (A4 portrait proposed), own typography, page numbers matching the TOC, cover, colophon with edition number and date; tagged PDF with reading order, real text (no outlined fonts), alt text for figures, document language `ru`, bookmarks per item, checked page-by-page per the accessibility doc; filename pattern `trustwork-NN-YYYY.pdf`, corrected edition appends `-r2`.
