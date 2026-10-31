# Public home and shared public shell

Route: `/`. This contract also defines the **public shell** (header, navigation, footer) reused by every `/news`, `/articles`, `/companies`, `/people`, `/projects` and `/magazine` page.

## Status and evidence

`proposed (reference: accepted direction)` — `public-home.png` (private design archive), manifest `accepted_direction`: "Accepted public menu; redraw exact text and remove synthetic traction claims." Spec R15, R16, R24, R25, R26; IA "Public navigation — exact order and labels"; design inventory brand rules.

## Audience and access policy

| Viewer | Sees |
|---|---|
| Anonymous | Everything on this page; header shows «Войти в сервис» |
| Authenticated | Same content; header replaces «Войти в сервис» with one circular avatar (menu: «В рабочее пространство», account, sign-out) — no name/chevron (R24) |
| Editorial/admin | No inline editing on the public page; curation happens in administration |

Only publications with lifecycle `published` or `corrected` and public projections of companies/people/projects appear. Deny by default; the home page never reveals private objects or counts.

## Data projection

| Block | Fields (all public) |
|---|---|
| Hero | 1 featured + 2 secondary publications: cover image (licensed), format badge, title, lede, author kind (editorial/person/company), published time, optional read time (computed from body, not stored copy) |
| «Сейчас в отрасли» | 4 topic tiles: topic name, latest item title, author kind, relative time |
| «Статьи и разборы» | topic chip set; 3–5 articles: format badge, title, lede, author, time, bookmark (authenticated only) |
| «Полезно под рукой» | 4 curated utility publications (editorial allowlist) |
| «Кто и что создаёт отрасль» | 3 static section tiles with licensed imagery |
| Magazine band | current issue number, date range, cover, links to reader and archive; hidden if no released issue |
| «Люди и проекты», «Встречи и события» | curated story cards |
| Pre-footer | Static description of workspace capabilities that exist; no metrics |
| Footer | Section links (seven), editorial links, platform links, legal links, «Помощь» (consistent help position, WCAG 2.2 3.2.6) |

No ratings, traction numbers, user counts or «verified» claims on the home page.

## Primary tasks

1. Understand what the resource is and find the seven sections.
2. Open a featured publication.
3. Reach the current magazine issue.
4. Enter the workspace (login/signup) without interrupting reading.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Header: brand (left), tagline, search button, «О платформе», sign-in/avatar (right). Nav row under header, seven items, active underline. Content max-width ~1200 px, 12-column grid: hero 8+4, lists 8 + rail 4, tiles 3×4, magazine band full-bleed tinted, pre-footer full-bleed dark, footer 4 columns |
| Tablet 768–1279 | Nav row scrolls horizontally with visible overflow affordance; hero 1 large + 2 side by side below; rail moves under the list; tiles 3 columns at ≥900 else 2 |
| Mobile <768 | Header: brand + search icon + menu button (opens full-height nav sheet with the same seven items in the same order) + avatar/sign-in; single column; hero stacked; tiles 1 column; magazine band stacks cover above text; footer columns stack |

## Component inventory

PublicHeader, PublicNav (seven items, `aria-current="page"`), SearchButton → SearchDialog, StoryCard (hero/secondary/row variants), TopicTile, ChipGroup (single-select topics), UtilityLinkCard, SectionTile, MagazineBand, CTABand, PublicFooter, BookmarkButton (authenticated), Skeleton variants, AvatarMenu (authenticated).

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Any curated block with no items collapses entirely (no "coming soon" filler); magazine band hidden without a released issue |
| Loading | Server-rendered; client blocks (bookmark state, avatar) hydrate without layout shift; skeleton only for client-fetched personalization |
| Error | Block-level error card «Не удалось загрузить раздел» with retry; rest of page stays usable |
| Permission-denied | Not applicable; nothing private |
| Offline | Page remains readable if cached; bookmark/avatar actions show «Нет соединения» toast |
| Partial/stale | Publication `corrected` shows small «Исправлено» label; retracted items never listed |

## Keyboard order and focus

Skip link → header brand → search → «О платформе» → sign-in/avatar → nav items (1–7) → main landmark blocks in reading order → footer. Landmarks: `header`, `nav[aria-label="Разделы"]`, `main`, `aside` for rail, `footer`. Mobile nav sheet is a modal dialog: focus moves to first item, Escape closes and returns focus to the menu button. Search dialog likewise.

## Responsive table behaviour

No tables on this screen.

## Locale keys

| Key | Russian |
|---|---|
| `ru.publicShell.tagline` | Отрасль. Люди. Практика. |
| `ru.publicShell.about` | О платформе |
| `ru.publicShell.signIn` | Войти в сервис |
| `ru.publicShell.search` | Поиск |
| `ru.publicShell.menu` | Меню |
| `ru.publicShell.skipToContent` | Перейти к содержимому |
| `ru.publicShell.navLabel` | Разделы |
| `ru.publicShell.toWorkspace` | В рабочее пространство |
| `ru.home.nowInIndustry` | Сейчас в отрасли |
| `ru.home.allNews` | Все новости |
| `ru.home.articles` | Статьи и разборы |
| `ru.home.allArticles` | Все статьи |
| `ru.home.useful` | Полезно под рукой |
| `ru.home.shareTitle` | Есть чем поделиться? |
| `ru.home.shareBody` | Опубликуйте статью от себя или от компании. |
| `ru.home.becomeAuthor` | Стать автором |
| `ru.home.whoCreates` | Кто и что создаёт отрасль |
| `ru.home.magazineKicker` | Журнал |
| `ru.home.magazineTitle` | Неделя в одном выпуске *(wording from reference; editorial review)* |
| `ru.home.readIssue` | Читать выпуск |
| `ru.home.magazineArchive` | Архив журнала |
| `ru.home.peopleAndProjects` | Люди и проекты |
| `ru.home.events` | Встречи и события |
| `ru.home.continueInWorkspace` | Продолжите в своём рабочем пространстве |
| `ru.common.corrected` | Исправлено |
| `ru.common.sectionLoadError` | Не удалось загрузить раздел |
| `ru.common.retry` | Повторить |
| `ru.common.offline` | Нет соединения |
| `ru.footer.sections` | Разделы |
| `ru.footer.editorial` | Редакция |
| `ru.footer.platform` | Платформа |
| `ru.footer.privacy` | Конфиденциальность |
| `ru.footer.terms` | Условия использования |
| `ru.footer.help` | Помощь |
| `footer.copyright` | © Trustwork (the deployment overlay may rename) |

## Open questions

- Whether «О платформе» is a route (`/about`) or an anchor; not in the IA — propose `/about` as a static page owned by CNT-001.
- Pre-footer feature claims must be rewritten once WEB-001 knows what actually ships.
- Hero imagery licensing (O06).
