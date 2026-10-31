# People hub and person public page

Routes: `/people`, `/people/[slug]`.

## Status and evidence

`proposed (reference: reviewed, proceeded)` for the hub — `people-hub.png` (private design archive), manifest `reviewed_proceeded`: "Publication consent and portrait licensing unresolved; no blanket scraping rights." `no reference` for the person page. Spec R01, R15, "Identity, company and public pages" (personal public profile vs private work view are separate projections); open decision O06.

## Audience and access policy

| Viewer | Hub | Person page |
|---|---|---|
| Anonymous / registered | Only people who **published** their profile (explicit consent). No sourced-only people in the directory | Public projection chosen by the person: name, role, employer (if the person chose to show it and membership is current), public publications, public project participations, consented portrait |
| The person themself | Same list; own card shows «Это вы» | Same page plus «Редактировать на моей странице» link to `/app/me`; a preview toggle «Как видят другие» lives in `/app/me`, not here |
| Company member of the same employer | Same | Same; no private fields |

No scraping-derived person records are shown. Portrait appears only with the person's consent and a licence to the image; otherwise an initials avatar. Hidden contact details never appear; contact goes through the platform if the person enabled it.

## Data projection

| Field | Public when |
|---|---|
| Display name (as entered in `auth.name`) | profile published |
| Role/specialization, one-line statement, topics | published and filled |
| Current employer chip (company public page link) | person opted in and membership current; drops automatically on employment end (R01) |
| «Независимый специалист» | person chose it |
| Portrait | consent + licence recorded |
| Publications (published), projects (public projection in which the person is a public participant), interviews | always, as counts and lists |
| Historical employment, private notes, email, phone, reputation inputs | never |
| Consent/publication state | only to the person themself |

## Primary tasks

1. Find a specialist by topic, role, company or region.
2. Read what the person published and which public projects they took part in.
3. Create or edit own public profile (leads to `/app/me`).

## Layout regions

| Width | Hub | Person page |
|---|---|---|
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; outlined «Создать свой профиль» (or «Моя страница» when authenticated); feature story; search + «Найти»; chips (specializations); filters (Регион, Опыт в проектах, Темы публикаций, sort); 2-column person cards (avatar/initials, name, role, employer chip or independent chip, tags, statement, counts, «Открыть профиль», bookmark); right rail (interests, «Ваш опыт остаётся с вами», «Поделитесь своим опытом»); «О чём пишут специалисты»; «Разговор по существу»; «Люди встречаются в проектах»; CTA band; footer | Public shell; breadcrumb; header card (avatar/initials, name, role, employer chip, topics, «Написать» if enabled); tabs: Публикации, Проекты, Опыт (self-written, no verification claim); right rail: «Как мы показываем людей» consent note, report link |
| Tablet | Cards 2 columns; rail below | Tabs scroll |
| Mobile <768 | Cards 1 column; filters in sheet; chips scroll | Single column |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect/FilterSheet, PersonCard, Avatar (image/initials, decorative alt rules), EmployerChip, Tabs, PublicationCardList, ProjectCardList, RailCard, ConsentNote, ReportIssueLink, BookmarkButton, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (no published profiles in filter) | «Специалисты не найдены» + reset |
| Loading | Skeleton cards keep avatar circle |
| Error | Inline error + retry |
| Permission-denied | Unpublished or withdrawn profile → 404 (never «профиль скрыт», which reveals existence) |
| Offline | Cached readable |
| Partial/stale | Employer chip removed when membership ended; publications whose company author page became private show company as text |

## Keyboard order and focus

Shell → H1 → CTA → search → chips → filters → cards (name link, bookmark) → rail. Person page: header links → tabs → panel → rail.

## Responsive table behaviour

No tables.

## Locale keys

| Key | Russian |
|---|---|
| `ru.people.title` | Люди, с которыми хочется работать *(wording from reference; editorial review)* |
| `ru.people.lede` | Опыт, идеи и профессиональные связи. Знакомьтесь с теми, кто создаёт отрасль. *(wording from reference; editorial review)* |
| `ru.people.createProfile` | Создать свой профиль |
| `ru.people.myPage` | Моя страница |
| `ru.people.searchPlaceholder` | Имя, специализация, компания или тема |
| `ru.people.allSpecialists` | Все специалисты |
| `ru.people.filter.region` | Регион |
| `ru.people.filter.projectExperience` | Опыт в проектах |
| `ru.people.filter.topics` | Темы публикаций |
| `ru.people.independent` | Независимый специалист |
| `ru.people.openProfile` | Открыть профиль |
| `ru.people.itsYou` | Это вы |
| `ru.people.projectsCount` | {count, plural, one {# проект} few {# проекта} many {# проектов}} |
| `ru.people.publicationsCount` | {count, plural, one {# публикация} few {# публикации} many {# публикаций}} |
| `ru.people.empty` | Специалисты не найдены |
| `ru.people.tabs.publications` | Публикации |
| `ru.people.tabs.projects` | Проекты |
| `ru.people.tabs.experience` | Опыт |
| `ru.people.consentNote` | Человек сам решает, что показывать на странице. Портрет публикуется только с согласия. |
| `ru.people.write` | Написать сообщение |
| `ru.people.shareExperience` | Поделитесь своим опытом |
| `ru.people.writeArticle` | Написать статью |
| `ru.people.experienceStaysTitle` | Ваш опыт остаётся с вами |
| `ru.people.experienceStaysBody` | Личная страница, публикации и профессиональная история — в одном профиле. |

## Open questions

- O06: portrait licensing wording and jurisdiction-specific consent records.
- Whether in-platform «Написать» exists in the first slice (depends on COM-001/R08 correspondence model); propose hidden until then.
- Whether employer chip requires company confirmation of membership (claim policy O05).
