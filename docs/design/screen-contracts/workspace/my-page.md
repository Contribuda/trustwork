# My page («Моя страница»): private work view and public projection

Route: `/app/me` (private work view), `/app/me/public` (projection editor and preview), public result at `/people/[slug]`.

## Status and evidence

`no reference`. Spec R01 (persistent profile, public page/wall, experience, publications, reputation; contributions survive employment changes), "Identity, company and public pages" (personal public profile and private work view are separate projections even if reachable from one destination), design inventory missing surface "Personal/company detail and permissions — public vs private views, profile/work separation".

## Audience and access policy

Only the person. Two projections:

| Projection | Contents | Who sees |
|---|---|---|
| Private work view (`/app/me`) | Everything about me: interests/preferences, current employment and its status, memberships history (private), my mandates summary, my drafts, my saved items, my activity, my project roles, my personal budget entry points | Me only |
| Public projection (`/app/me/public`) | What I chose to show on `/people/[slug]`: publish on/off, portrait consent, display employer on/off, bio, topics, which publications/projects to list (only those already public), contact enablement | Me edits; the public sees the result |

Employer-derived data is labelled and disappears from the private view's "current" section when membership ends but stays in private history (O04 policy for the company side is separate).

## Data projection

| Section | Fields |
|---|---|
| Header | Avatar (private view may show image regardless of public consent), name (editable), role line, employer chip with membership state (текущее место работы / приглашение / завершено), «Открыть публичную страницу» (if published) |
| Interests | Capabilities and categories/regions from onboarding, editable here |
| Work | My open decisions, my projects by role, my RFQs/quotes I am operator on (links), my mandates to the assistant (count + link) |
| Contributions | Publications (all lifecycle states, mine), saved items, comments if any |
| History | Employment memberships with dates (private), transfers of project ownership, accepted terms versions |
| Public projection editor | Published toggle, portrait consent toggle with licence statement, show employer toggle, bio (plain text, limit), topics, publication/project list with per-item «показывать» checkboxes, contact toggle; «Предпросмотр» renders the public component in a dialog with the public projection only |

## Primary tasks

1. See my own work and decisions across companies/projects.
2. Control what is public about me, with consent recorded explicitly.
3. Edit name, interests, avatar.
4. Reach account settings (contextual link; not a nav item).

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Shell; PageHeader (H1 «Моя страница», actions «Публичная страница», «Настройки аккаунта»); tabs: Работа, Публикации, Интересы, История, Публичный профиль; Работа tab: two-column (decisions + projects left, mandates + saved right); Публичный профиль tab: form left (max 720 px) + live preview card right |
| Tablet | Tabs scroll; single column; preview below form |
| Mobile <768 | Single column; preview via «Предпросмотр» button opening full-screen dialog |

## Component inventory

PageHeader, Tabs, Avatar + AvatarUpload (file input with accessible label, crop optional), TextField, Textarea with counter, Switch (with visible on/off text), CheckboxList, ConsentStatement (checkbox with legal text and version), PreviewDialog, ObjectRow, StatusChip (membership), MandateSummary, EmptyState, FormAlert, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | New user: Работа shows onboarding hints («Начните с проекта или публикации»); Публичный профиль shows «Страница не опубликована» |
| Loading | Skeleton per tab |
| Error | Save errors inline; FormAlert |
| Permission-denied | Not applicable (own data); employer sections vanish after membership end with explanation row |
| Offline | Edits blocked with toast; reading allowed |
| Partial/stale | Portrait consent withdrawn → public page updates; private view shows «портрет скрыт на публичной странице» |

## Keyboard order and focus

Shell → H1 → header actions → tabs → panel. Public profile form: published switch → consent → employer switch → bio → topics → lists → contact → «Сохранить» → «Предпросмотр». Preview dialog traps focus and returns to the button. Save success announced via toast live region and focus stays on the button.

## Responsive table behaviour

History tab table (организация, роль, с, по, статус) collapses to stacked cards below 768.

## Locale keys

| Key | Russian |
|---|---|
| `ru.me.title` | Моя страница |
| `ru.me.publicPage` | Публичная страница |
| `ru.me.accountSettings` | Настройки аккаунта |
| `ru.me.tabs.work` | Работа |
| `ru.me.tabs.publications` | Публикации |
| `ru.me.tabs.interests` | Интересы |
| `ru.me.tabs.history` | История |
| `ru.me.tabs.publicProfile` | Публичный профиль |
| `ru.me.membership.active` | Текущее место работы |
| `ru.me.membership.invited` | Приглашение |
| `ru.me.membership.ended` | Завершено {date} |
| `ru.me.mandates` | Поручения помощнику |
| `ru.me.saved` | Сохранённое |
| `ru.me.startHint` | Начните с проекта или публикации |
| `ru.me.public.published` | Страница опубликована |
| `ru.me.public.unpublished` | Страница не опубликована |
| `ru.me.public.portraitConsent` | Разрешаю показывать мой портрет на публичной странице |
| `ru.me.public.portraitLicence` | Я подтверждаю, что имею право на использование этого изображения. |
| `ru.me.public.showEmployer` | Показывать текущее место работы |
| `ru.me.public.bio` | О себе |
| `ru.me.public.topics` | Темы |
| `ru.me.public.show` | Показывать |
| `ru.me.public.contact` | Разрешить писать мне через платформу |
| `ru.me.public.preview` | Предпросмотр |
| `ru.me.public.previewTitle` | Так вашу страницу видят другие |
| `ru.me.public.portraitHidden` | Портрет скрыт на публичной странице |
| `ru.me.history.org` | Организация |
| `ru.me.history.role` | Роль |
| `ru.me.history.from` | С |
| `ru.me.history.to` | По |
| `ru.common.save` | Сохранить |
| `ru.common.saved` | Сохранено |
| `ru.common.cancel` | Отмена |

## Open questions

- Whether the public slug is editable (propose: generated, changeable once).
- Contact via platform depends on R08 correspondence model (COM-001); toggle hidden until it exists.
- Which employment-history details the person may see after leaving (O04 covers company history, not own membership record; propose own record always visible).
