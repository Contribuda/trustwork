# People hub and person public page

Routes: `/people`, `/people/[slug]`.

## Status and evidence

`proposed (reference: reviewed, proceeded)` for the hub — `people-hub.png` (private design archive), manifest `reviewed_proceeded`: "Publication consent and portrait licensing unresolved; no blanket scraping rights." `no reference` for the person page. Spec R01, R15, "Identity, company and public pages" (personal public profile vs private work view are separate projections); open decision O06.

## Audience and access policy

| Viewer | Hub | Person page |
|---|---|---|
| Anonymous / registered | Only people who **published** their profile (explicit consent). No sourced-only people in the directory | Public projection chosen by the person: name, role, employer (if the person chose to show it and membership is current), public publications, public project participations, consented portrait |
| The person themself | Same list; own card shows "This is you" | Same page plus "Edit on my page" (`people.editOnMyPage`) link to `/app/me`; a preview toggle "How others see it" lives in `/app/me`, not here |
| Company member of the same employer | Same | Same; no private fields |

No scraping-derived person records are shown. Portrait appears only with the person's consent and a licence to the image; otherwise an initials avatar. Hidden contact details never appear; contact goes through the platform if the person enabled it.

## Data projection

| Field | Public when |
|---|---|
| Display name (as entered in `auth.name`) | profile published |
| Role/specialization, one-line statement, topics | published and filled |
| Current employer chip (company public page link) | person opted in and membership current; drops automatically on employment end (R01) |
| "Independent professional" | person chose it |
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
| Desktop ≥1280 | Public shell; breadcrumb; H1 + lede; outlined "Create your profile" (or "My page" when authenticated); feature story; search + "Find"; chips (specializations); filters (Region, Project experience, Publication topics, sort; `people.filter.*`); 2-column person cards (avatar/initials, name, role, employer chip or independent chip, tags, statement, counts, "Open the profile", bookmark); right rail (interests, "Your experience stays with you", "Share your experience"); "What professionals write about" (`people.writingTitle`); "Straight talk" (`people.talkTitle`); "People meet in projects" (`people.meetTitle`); CTA band; footer | Public shell; breadcrumb; header card (avatar/initials, name, role, employer chip, topics, "Write" if enabled); tabs: Publications, Projects, Experience (`people.tabs.*`; self-written, no verification claim); right rail: "How we show people" consent note, report link |
| Tablet | Cards 2 columns; rail below | Tabs scroll |
| Mobile <768 | Cards 1 column; filters in sheet; chips scroll | Single column |

## Component inventory

PublicShell, Breadcrumb, SearchField, ChipGroup, FilterSelect/FilterSheet, PersonCard, Avatar (image/initials, decorative alt rules), EmployerChip, Tabs, PublicationCardList, ProjectCardList, RailCard, ConsentNote, ReportIssueLink, BookmarkButton, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty (no published profiles in filter) | "No professionals found" + reset |
| Loading | Skeleton cards keep avatar circle |
| Error | Inline error + retry |
| Permission-denied | Unpublished or withdrawn profile → 404 (never "profile hidden", which reveals existence) |
| Offline | Cached readable |
| Partial/stale | Employer chip removed when membership ended; publications whose company author page became private show company as text |

## Keyboard order and focus

Shell → H1 → CTA → search → chips → filters → cards (name link, bookmark) → rail. Person page: header links → tabs → panel → rail.

## Responsive table behaviour

No tables.

## Locale keys

| Key | English |
|---|---|
| `people.title` | People you want to work with *(wording from reference; editorial review)* |
| `people.lede` | Experience, ideas and professional connections. Meet the people who build the industry. *(wording from reference; editorial review)* |
| `people.createProfile` | Create your profile |
| `people.myPage` | My page |
| `people.searchPlaceholder` | Name, specialisation, company or topic |
| `people.allSpecialists` | All professionals |
| `people.filter.region` | Region |
| `people.filter.projectExperience` | Project experience |
| `people.filter.topics` | Publication topics |
| `people.independent` | Independent professional |
| `people.openProfile` | Open the profile |
| `people.itsYou` | This is you |
| `people.projectsCount` | {count, plural, one {# project} other {# projects}} |
| `people.publicationsCount` | {count, plural, one {# publication} other {# publications}} |
| `people.empty` | No professionals found |
| `people.tabs.publications` | Publications |
| `people.tabs.projects` | Projects |
| `people.tabs.experience` | Experience |
| `people.consentNote` | The person decides what the page shows. A portrait is published only with consent. |
| `people.write` | Send a message |
| `people.shareExperience` | Share your experience |
| `people.writeArticle` | Write an article |
| `people.experienceStaysTitle` | Your experience stays with you |
| `people.experienceStaysBody` | Your page, publications and professional history in one profile. |

## Open questions

- O06: portrait licensing wording and jurisdiction-specific consent records.
- Whether in-platform "Write" exists in the first slice (depends on COM-001/R08 correspondence model); propose hidden until then.
- Whether employer chip requires company confirmation of membership (claim policy O05).
