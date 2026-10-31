# Onboarding: categories and regions (optional second step)

Route: `/onboarding/interests` (one page per selected capability: `?for=buy`, `?for=sell`, `?for=industry`; shown only for capabilities chosen in step 1).

## Status and evidence

`proposed (reference: accepted direction)` — `onboarding-procurement.png` (private design archive), manifest `accepted_direction`: "Categories and regions optional; no compulsory company/INN form." The reference shows the «Закупаю» variant only; «Поставляю» and «Участвую» variants are derived. Spec R22, O11 (localized taxonomy).

## Audience and access policy

Authenticated users who selected at least one capability. Everything optional; «Настрою позже» and «Продолжить» with nothing selected both proceed. No company, INN, legal or address questions. Supplier variant asks what the person's work concerns, not for a company catalogue; catalogue lives in the company workspace under company permissions.

## Data projection

Per capability: selected category ids (from a localized taxonomy, O11), selected region ids (optional, multi), free-text search for categories. Stored as personal preferences.

## Primary tasks

1. Pick usual categories (buy / supply / topics).
2. Optionally pick regions.
3. Skip or continue.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | OnboardingShell; «← Назад»; step pill with capability name («✓ Закупаю»); H1 by variant («Что вы обычно закупаете?» / «Что вы предлагаете?» / «Какие темы вам интересны?»); subline; hint; group «Направления» with search input and 3×2 checkbox cards (icon, label, checkbox); group «Где нужны поставки или работы?» / «Где вы работаете?» marked «Необязательно» with region multiselect combobox and helper; note «Интересы можно изменить позже»; bottom row: link «Настрою позже» (left), primary «Продолжить» (right). Progress «Шаг 2 из N» for screen readers and visually small |
| Tablet | Cards 2 columns |
| Mobile <768 | Cards 1 column (compact row: icon, label, checkbox); region combobox full width; sticky bottom bar with both actions |

## Component inventory

OnboardingShell, BackLink, StepPill, SearchField (filters cards client-side; announces count), CheckboxCard, Combobox (multi-select, tags, Russian a11y names, typeahead), Button, Link, StickyActionBar, StepProgress.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Nothing selected; both actions proceed |
| Loading | Taxonomy loads with skeleton cards; combobox shows «Загружаем регионы…» |
| Error | Taxonomy unavailable: «Не удалось загрузить список. Можно настроить позже.» + continue |
| Permission-denied | Not applicable |
| Offline | Same as error; selections kept locally |
| Partial/stale | Search with no match: «Ничего не нашли. Можно продолжить без выбора.» |

## Keyboard order and focus

Back → cards (one tab stop each) → search → combobox (arrow keys open list, Enter selects, Backspace removes last tag) → «Настрою позже» → «Продолжить». On arrival focus is on H1 via `tabindex="-1"` (multi-step flow). After the last step: `/app` with focus on H1 «Обзор».

## Responsive table behaviour

No tables.

## Locale keys

| Key | Russian |
|---|---|
| `ru.onboarding.back` | Назад |
| `ru.onboarding.step` | Шаг {index} из {total} |
| `ru.onboarding.buy.title` | Что вы обычно закупаете? *(wording from reference; editorial review)* |
| `ru.onboarding.buy.subtitle` | Подберём компании и материалы по вашим интересам. |
| `ru.onboarding.sell.title` | Что вы предлагаете? |
| `ru.onboarding.sell.subtitle` | Покажем запросы и проекты по вашему профилю. |
| `ru.onboarding.industry.title` | Какие темы вам интересны? |
| `ru.onboarding.industry.subtitle` | Соберём новости и статьи по вашим темам. |
| `ru.onboarding.multiDirectionsHint` | Можно выбрать несколько направлений. |
| `ru.onboarding.directions` | Направления |
| `ru.onboarding.directionsSearch` | Найти направление, товар или услугу |
| `ru.onboarding.regions.buy` | Где нужны поставки или работы? |
| `ru.onboarding.regions.sell` | Где вы работаете? |
| `ru.onboarding.regions.placeholder` | Выберите регионы |
| `ru.onboarding.regions.hint` | Можно указать несколько регионов или оставить без ограничений. |
| `ru.onboarding.regions.loading` | Загружаем регионы… |
| `ru.onboarding.optional` | Необязательно |
| `ru.onboarding.changeLater` | Интересы можно изменить позже. |
| `ru.onboarding.setupLater` | Настрою позже |
| `ru.onboarding.taxonomyError` | Не удалось загрузить список. Можно настроить позже. |
| `ru.onboarding.noMatches` | Ничего не нашли. Можно продолжить без выбора. |
| `ru.taxonomy.materials` | Строительные материалы |
| `ru.taxonomy.equipment` | Оборудование |
| `ru.taxonomy.engineering` | Инженерные системы |
| `ru.taxonomy.rawMaterials` | Сырьё и комплектующие |
| `ru.taxonomy.works` | Строительные работы |
| `ru.taxonomy.designServices` | Проектирование и услуги |

Taxonomy labels are placeholders until O11 defines the localized catalogue; they must come from data, not hard-coded keys, once it exists.

## Open questions

- O11 taxonomy source and depth (top-level only in onboarding is proposed).
- Region list source (official Russian subjects list vs custom) and licensing.
