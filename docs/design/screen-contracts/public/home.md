# Public home and shared public shell

Route: `/`. This contract also defines the **public shell** (header, navigation, footer) reused by every `/news`, `/articles`, `/companies`, `/people`, `/projects` and `/magazine` page.

## Status and evidence

`proposed (reference: accepted direction)` — `public-home.png` (private design archive), manifest `accepted_direction`: "Accepted public menu; redraw exact text and remove synthetic traction claims." Spec R15, R16, R24, R25, R26; IA "Public navigation — exact order and labels"; design inventory brand rules.

## Audience and access policy

| Viewer | Sees |
|---|---|
| Anonymous | Everything on this page; header shows "Sign in" |
| Authenticated | Same content; header replaces "Sign in" with one circular avatar (menu: "To the workspace", account, sign-out) — no name/chevron (R24) |
| Editorial/admin | No inline editing on the public page; curation happens in administration |

Only publications with lifecycle `published` or `corrected` and public projections of companies/people/projects appear. Deny by default; the home page never reveals private objects or counts.

## Data projection

| Block | Fields (all public) |
|---|---|
| Hero | 1 featured + 2 secondary publications: cover image (licensed), format badge, title, lede, author kind (editorial/person/company), published time, optional read time (computed from body, not stored copy) |
| "In the industry now" | 4 topic tiles: topic name, latest item title, author kind, relative time |
| "Articles and analyses" | topic chip set; 3–5 articles: format badge, title, lede, author, time, bookmark (authenticated only) |
| "Useful at hand" | 4 curated utility publications (editorial allowlist) |
| "Who builds the industry, and what" | 3 static section tiles with licensed imagery |
| Magazine band | current issue number, date range, cover, links to reader and archive; hidden if no released issue |
| "People and projects", "Meetings and events" | curated story cards |
| Pre-footer | Static description of workspace capabilities that exist; no metrics |
| Footer | Section links (seven), editorial links, platform links, legal links, "Help" (consistent help position, WCAG 2.2 3.2.6) |

No ratings, traction numbers, user counts or "verified" claims on the home page.

## Primary tasks

1. Understand what the resource is and find the seven sections.
2. Open a featured publication.
3. Reach the current magazine issue.
4. Enter the workspace (login/signup) without interrupting reading.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Header: brand (left), tagline, search button, "About the platform", sign-in/avatar (right). Nav row under header, seven items, active underline. Content max-width ~1200 px, 12-column grid: hero 8+4, lists 8 + rail 4, tiles 3×4, magazine band full-bleed tinted, pre-footer full-bleed dark, footer 4 columns |
| Tablet 768–1279 | Nav row scrolls horizontally with visible overflow affordance; hero 1 large + 2 side by side below; rail moves under the list; tiles 3 columns at ≥900 else 2 |
| Mobile <768 | Header: brand + search icon + menu button (opens full-height nav sheet with the same seven items in the same order) + avatar/sign-in; single column; hero stacked; tiles 1 column; magazine band stacks cover above text; footer columns stack |

## Component inventory

PublicHeader, PublicNav (seven items, `aria-current="page"`), SearchButton → SearchDialog, StoryCard (hero/secondary/row variants), TopicTile, ChipGroup (single-select topics), UtilityLinkCard, SectionTile, MagazineBand, CTABand, PublicFooter, BookmarkButton (authenticated), Skeleton variants, AvatarMenu (authenticated).

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Any curated block with no items collapses entirely (no "coming soon" filler); magazine band hidden without a released issue |
| Loading | Server-rendered; client blocks (bookmark state, avatar) hydrate without layout shift; skeleton only for client-fetched personalization |
| Error | Block-level error card "Could not load this section" with retry; rest of page stays usable |
| Permission-denied | Not applicable; nothing private |
| Offline | Page remains readable if cached; bookmark/avatar actions show "No connection" toast |
| Partial/stale | Publication `corrected` shows small "Corrected" label; retracted items never listed |

## Keyboard order and focus

Skip link → header brand → search → "About the platform" → sign-in/avatar → nav items (1–7) → main landmark blocks in reading order → footer. Landmarks: `header`, `nav[aria-label="Sections"]` (`publicShell.navLabel`), `main`, `aside` for rail, `footer`. Mobile nav sheet is a modal dialog: focus moves to first item, Escape closes and returns focus to the menu button. Search dialog likewise.

## Responsive table behaviour

No tables on this screen.

## Locale keys

| Key | English |
|---|---|
| `publicShell.tagline` | Industry. People. Practice. |
| `publicShell.about` | About the platform |
| `publicShell.signIn` | Sign in |
| `publicShell.search` | Search |
| `publicShell.menu` | Menu |
| `publicShell.skipToContent` | Skip to content |
| `publicShell.navLabel` | Sections |
| `publicShell.toWorkspace` | To the workspace |
| `home.nowInIndustry` | In the industry now |
| `home.allNews` | All news |
| `home.articles` | Articles and analyses |
| `home.allArticles` | All articles |
| `home.useful` | Useful at hand |
| `home.shareTitle` | Something to share? |
| `home.shareBody` | Publish an article as yourself or on behalf of a company. |
| `home.becomeAuthor` | Become an author |
| `home.whoCreates` | Who builds the industry, and what |
| `home.magazineKicker` | Magazine |
| `home.magazineTitle` | The whole week in one issue *(wording from reference; editorial review)* |
| `home.readIssue` | Read the issue |
| `home.magazineArchive` | Magazine archive |
| `home.peopleAndProjects` | People and projects |
| `home.events` | Meetings and events |
| `home.continueInWorkspace` | Continue in your workspace |
| `common.corrected` | Corrected |
| `common.sectionLoadError` | Could not load this section |
| `common.retry` | Retry |
| `common.offline` | No connection |
| `footer.sections` | Sections |
| `footer.editorial` | Editorial |
| `footer.platform` | Platform |
| `footer.privacy` | Privacy |
| `footer.terms` | Terms of use |
| `footer.help` | Help |
| `footer.copyright` | © Trustwork (the deployment overlay may rename) |

## Open questions

- Whether "About the platform" is a route (`/about`) or an anchor; not in the IA — propose `/about` as a static page owned by CNT-001.
- Pre-footer feature claims must be rewritten once WEB-001 knows what actually ships.
- Hero imagery licensing (O06).
