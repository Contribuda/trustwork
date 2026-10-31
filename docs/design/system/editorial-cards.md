# Editorial cards and lists

Status: proposed design standard (DS-002 / WEB-004, 2026-10-28, author: integrator). Applies to every
public list and teaser: home blocks, "News", "Articles", "Magazine", entity pages and the workspace "In the industry"
digest. It fixes what a card shows, in which order, how long each line may be and which icon or chip marks the
content type, so that every section reads as one product.

## 1. Content types and their marker

| Type (`format` / `articleFormat`) | Label (kicker) | Where the label comes from | Marker on a photo | Marker in text lists |
|---|---|---|---|---|
| `news` | News, or the event rubric "Events" when the news is tied to an event | `articles.formats` / `home.eventsKicker` | blue chip, uppercase | blue uppercase kicker |
| `article` · `analysis` | Analysis | `articles.formats.analysis` | blue chip | kicker |
| `article` · `practice` | Practice | `articles.formats.practice` | blue chip | kicker |
| `article` · `experience` | Experience | `articles.formats.experience` | blue chip | kicker |
| `article` · `interview` | Interview | `articles.formats.interview` | blue chip | kicker |
| `article` · `opinion` | Opinion | `articles.formats.opinion` | blue chip | kicker |
| `article` · `projectStory` | Project story | `articles.formats.projectStory` | blue chip | kicker |
| `article` · `overview` | Overview | `articles.formats.overview` | blue chip | kicker |
| `magazine_piece` | Magazine · No. N | `magazine.issueShort` | navy chip | kicker |
| `company_post` | Company · name | `articles.authorKind.company` | — | kicker + company name in byline |
| `personal_post` | Author · name | `articles.authorKind.person` | — | kicker + author in byline |

Rules

- One kicker per card. Topic-led blocks (industry feed, side tiles about a subject) use the **topic**
  ("Materials", "Technologies", "Markets", "Projects", "People", "Regulation"). People-led and format-led blocks
  (lead carousel, stories, strip, related lists) use the **format**. Never show both as kickers; the second
  dimension goes into the chips row or the meta line.
- Kickers are 10–11 px, weight 700, tracking 0.08 em, uppercase, accent blue. On photographs the same text sits
  in a blue chip (padding 3–5 × 7–10 px, radius 5–6 px) with white text.
- Topic chips (outlined pills, 13 px) appear only in full-width list rows and on detail pages: at most two per card,
  in the order of the publication’s `topics`. They are links to the filtered list.
- Status chips are reserved for records: project lifecycle ("Completed", "In progress"), company record status
  ("Claimed by the company", "From open sources", "Verified"), evidence labels on project updates. They never
  decorate publications.
- No ratings, stars, view counts or "verified" badges on publication cards (product constraint).

## 2. Card anatomy and limits

Order inside every card: media → kicker → title → dek → meta. Nothing else. A card is one link (the title);
the whole card is the hit area through the stretched link; no second interactive control inside a card.

| Surface | Media ratio desktop / phone | Title size desktop / phone | Title limit | Dek | Meta |
|---|---|---|---|---|---|
| Lead carousel | 2:1 panel (≈450 px tall at 1440) / 16:10 card | 36 px / 20 px, weight 700 | ≤ 70 chars, 2–3 lines | ≤ 140 chars, 2 lines (hidden under 3 lines on phone) | author · date · read time |
| Side tile | 16:10 / 16:10 rail card | 20 px / 15 px | ≤ 60 chars, 2 lines | none | none |
| Strip link | none | 16 px / 14 px, weight 600 | ≤ 70 chars, 2 lines | none | none |
| Feed row | 4:3 thumb 184 px / 1:1 thumb 96 px | 18 px / 15 px | ≤ 80 chars, 2 lines (3 on phone) | ≤ 120 chars, 2 lines (hidden on phone) | clock icon + read time |
| Story card (people) | 16:10 / 16:10 rail card | 18 px / 15 px | ≤ 70 chars | ≤ 120 chars, 2–3 lines | none |
| Editor’s pick | 4:3 thumb 96 px / 80 px | 14 px | ≤ 60 chars, 2 lines | none | read time |
| Utility item ("Useful at hand") | icon 40 px / 36 px | 14 px name | `shortTitle` ≤ 32 chars, 1 line | subtitle ≤ 90 chars, 2 lines (1 on phone) | chevron |
| News list row (`/news`) | 16:10 thumb 160 px / none | 18 px / 16 px | ≤ 90 chars | ≤ 160 chars | event date · source · "Corrected" (`common.corrected`) when corrected |
| Articles list row (`/articles`) | 4:3 thumb 184 px / 1:1 96 px | 18 px / 16 px | ≤ 80 chars | ≤ 140 chars | author · read time |
| Magazine piece (issue contents) | none | 16 px, page number in tabular figures | ≤ 70 chars | ≤ 120 chars | section chip · author |

Line clamps are CSS (`-webkit-line-clamp`); the limits above are editorial guidance for authors and fixtures so
that clamps rarely fire. Titles use `typo()` (non-breaking spaces after short words, locale-appropriate quotation marks, em dash).

Dek rules: one or two sentences, no colon lists, no repeated title words, ends with a full stop. News deks state
the fact and the consequence; article deks state what the reader learns.

Meta rules: items separated by " · " (U+00B7 with spaces); dates in `longDate` ("October 21, 2026") on cards,
`shortDate` in tables; read time as "N min"; news add "Event: <date>" when `eventTime` differs from the
publication date; corrected items add "Corrected <date>". The assistant-assisted flag is shown only on detail pages.

## 3. Icons

Icons come from Lucide (1.62, ISC) through `Icon`/direct imports. Stroke 1.75, sizes 14 (meta), 16 (inline link
arrow), 20 (utility list), 22 (feature list). Decorative icons carry `aria-hidden`.

| Meaning | Icon |
|---|---|
| read time | `Clock` |
| external / "open in" link | `ArrowUpRight` |
| forward / next | `ArrowRight`, `ChevronRight` |
| carousel controls | `ChevronLeft`, `ChevronRight`, `Pause`, `Play` |
| utility: compare offers | `FileSearch` |
| utility: glossary | `BookOpen` |
| utility: questions | `MessageCircleQuestion` |
| utility: meeting checklist | `ClipboardCheck` |
| utility: documents | `FileText` |
| workspace feature: documents | `FolderOpen` |
| workspace feature: project control | `ChartColumn` |
| region | `MapPin` |
| company | `Building2` |
| person | `User` |
| project | `FolderKanban` |

No emoji, no filled icons, no coloured icon backgrounds except the 40 px accent-tint square of the utility list.

## 4. Photographs and artworks

- Covers are deterministic per story (`storyCover`), pinned for curated slots; the same story shows the same cover
  on every surface.
- People-led stories may use photographs of people at work (editorial illustration), under an open licence with
  recorded attribution. Person **profiles** never get a photograph that is not the person’s own: artwork + initials.
- Every photograph is served in 1600/800/400 px WebP with a blur-up placeholder; `sizes` is set per slot.
- Ratios: panels 2:1 or 21:9, cards 16:10, thumbnails 4:3 (desktop) and 1:1 (phone), magazine covers 3:4.

## 5. Type scale and spacing

Desktop (≥ 1024): section title 28–34 px (clamp), card title 18 px, body 16 px, small 14 px, caption 12 px,
kicker 11 px. Section gap 56–72 px, inner gap 24 px, card gap 20–24 px, radius 16 px (media) / 12 px (cards).

Phone (≤ 767): section title 20 px, card title 15 px, body 14 px, caption 12 px, kicker 10 px. Gutter 16 px, section
gap 40 px, inner gap 12 px, radius 12 px, horizontal rails show 72–76 % of the viewport per card so the next card
peeks in. Tap targets ≥ 44 px (buttons) and ≥ 32 px (chips, footer links).

## 6. Lists: how a section page is built

1. Page head: H1 (34 px / 24 px) + one-sentence lede + the single primary action on the right.
2. Filters: outlined chips (topics or formats) in one scrollable row; the active chip is navy. Filters are links
   with query parameters, so the page stays server-rendered and shareable.
3. Rows: feed rows as in §2, separated by 1 px hairlines, 20 px vertical padding (12 px on phone). No cards inside
   lists on desktop; cards are for grids and rails.
4. Aside (desktop only, sticky): at most two blocks (utility list, editor’s picks or "What the profile shows").
5. "Show more" (`common.showMore`) as a secondary button under the list; pagination appears from page 2.
6. Empty state: one sentence from the locale ("No articles in this format yet") and the link back to all.

## 7. Don’ts

- No duplicate story on one page: every block draws from a shared "used" set in this order — lead, tiles, strip,
  picks, feed, utility, stories.
- No second kicker, no badges stacked on badges, no metrics on publications.
- No full-bleed photographs behind text on phones; the lead is a stacked card there.
- No English words in UI copy; technical identifiers stay out of the interface.
