# Onboarding: capabilities (optional multi-select)

Route: `/onboarding` (after signup or first provider login; reachable later from settings as «Интересы»).

## Status and evidence

`proposed (reference: accepted direction)` — `onboarding-capabilities.png` (private design archive), manifest `accepted_direction`: "Multi-select and skip; preferences confer no company authority." Spec R03, R22 ("Optional multi-select onboarding; optional categories/regions second step; skip; preferences confer no legal/company access"), journey 1; locale `onboarding` array (Закупаю / Поставляю / Участвую в жизни отрасли).

## Audience and access policy

Authenticated users without recorded onboarding completion/skip. Selections are **preferences** that influence which overview panels are pinned by default; they are not roles, not company membership, not authority. Skipping is always allowed and leaves all defaults off (reader/author mode). The step can be revisited; the assistant never changes these.

## Data projection

Three options with `selected` boolean each; «skipped» flag; timestamp. No company fields.

## Primary tasks

1. Choose zero or more of the three capabilities.
2. Continue to the optional second step or skip to the workspace.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Top bar: brand, «На сайт ↗», circular avatar (initial letter). Centered column ~1200 px: success pill «Аккаунт создан» (only right after signup), H1 «Что вам интересно на платформе?», subline, hint «Можно выбрать несколько вариантов», three equal selectable cards (illustration, checkbox, title, description, two tag chips), note «Выбор можно изменить в любой момент», primary «Продолжить», link «Пока осмотрюсь» |
| Tablet | Cards 3 columns to 900 px, then 1 column stacked (full width) |
| Mobile <768 | Cards stacked, illustration shrinks to 80 px height or hidden; sticky bottom bar with «Продолжить» and «Пока осмотрюсь» |

## Component inventory

OnboardingShell (top bar + centered column + footer links), SuccessPill, SelectableCard (checkbox semantics: `role="checkbox"` or native checkbox inside label; whole card clickable; visible focus ring on card; selected state with border + check, not colour alone), Button, Link, StickyActionBar (mobile).

## Interaction states

| State | Behaviour |
|---|---|
| Empty (zero selected) | «Продолжить» stays **enabled** and acts as skip (proposal; the reference disables it, which forces users toward the small link). «Пока осмотрюсь» remains as explicit skip |
| Loading | Saving spinner on button; cards disabled |
| Error | FormAlert «Не удалось сохранить. Можно продолжить и вернуться к этому позже.» with «Продолжить без сохранения» |
| Permission-denied | Not applicable |
| Offline | Same as error; selections kept locally until retry |
| Partial/stale | Returning user sees current selections pre-checked and «Сохранить» instead of «Продолжить» (previously entered choices are never asked again from scratch, WCAG 2.2 3.3.7) |

## Keyboard order and focus

Brand → «На сайт» → avatar → card 1 → card 2 → card 3 (each one tab stop; Space toggles) → «Продолжить» → «Пока осмотрюсь». Page load: focus not moved; H1 is first heading. After continue: next step H1 announced.

## Responsive table behaviour

No tables.

## Locale keys

| Key | Russian |
|---|---|
| `ru.onboarding.accountCreated` | Аккаунт создан |
| `ru.onboarding.toSite` | На сайт |
| `ru.onboarding.capabilities.title` | Что вам интересно на платформе? *(wording from reference; editorial review)* |
| `ru.onboarding.capabilities.subtitle` | Настроим рабочее пространство под ваши задачи. |
| `ru.onboarding.multiHint` | Можно выбрать несколько вариантов. |
| `ru.onboarding.buy.description` | Ищу поставщиков, сравниваю предложения и организую закупки. |
| `ru.onboarding.buy.tags` | Поставщики · Закупки |
| `ru.onboarding.sell.description` | Предлагаю товары, работы или услуги и нахожу клиентов. |
| `ru.onboarding.sell.tags` | Компания · Предложения |
| `ru.onboarding.industry.description` | Читаю, публикую статьи и новости, делюсь опытом и знакомлюсь с людьми. |
| `ru.onboarding.industry.tags` | Публикации · Сообщество |
| `ru.onboarding.changeAnytime` | Выбор можно изменить в любой момент. |
| `ru.onboarding.continue` | Продолжить |
| `ru.onboarding.skip` | Пока осмотрюсь |
| `ru.onboarding.save` | Сохранить |
| `ru.onboarding.saveError` | Не удалось сохранить. Можно продолжить и вернуться к этому позже. |
| `ru.onboarding.continueWithoutSaving` | Продолжить без сохранения |
| `ru.onboarding.noAuthorityNote` | Это только настройки интересов. Они не дают прав в компании и не создают обязательств. |

Existing keys reused: `onboarding[0..2]` for the three titles.

## Open questions

- Whether «Продолжить» is enabled with zero selection (proposal: yes) — human/UX decision.
- Whether the illustration set is created by DS-001 or dropped in favour of icons.
