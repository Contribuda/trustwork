# Onboarding: categories and regions (optional second step)

Route: `/onboarding/interests` (one page per selected capability: `?for=buy`, `?for=sell`, `?for=industry`; shown only for capabilities chosen in step 1).

## Status and evidence

`proposed (reference: accepted direction)` — `onboarding-procurement.png` (private design archive), manifest `accepted_direction`: "Categories and regions optional; no compulsory company/INN form." The reference shows the "I buy" variant only; "I supply" and "I take part" variants are derived. Spec R22, O11 (localized taxonomy).

## Audience and access policy

Authenticated users who selected at least one capability. Everything optional; "I'll set this up later" and "Continue" with nothing selected both proceed. No company, INN, legal or address questions. Supplier variant asks what the person's work concerns, not for a company catalogue; catalogue lives in the company workspace under company permissions.

## Data projection

Per capability: selected category ids (from a localized taxonomy, O11), selected region ids (optional, multi), free-text search for categories. Stored as personal preferences.

## Primary tasks

1. Pick usual categories (buy / supply / topics).
2. Optionally pick regions.
3. Skip or continue.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | OnboardingShell; "← Back"; step pill with capability name ("✓ I buy"); H1 by variant ("What do you usually buy?" / "What do you offer?" / "Which topics interest you?"); subline; hint; group "Areas" with search input and 3×2 checkbox cards (icon, label, checkbox); group "Where do you need deliveries or works?" / "Where do you work?" marked "Optional" with region multiselect combobox and helper; note "You can change your interests later"; bottom row: link "I'll set this up later" (left), primary "Continue" (right). Progress "Step 2 of N" for screen readers and visually small |
| Tablet | Cards 2 columns |
| Mobile <768 | Cards 1 column (compact row: icon, label, checkbox); region combobox full width; sticky bottom bar with both actions |

## Component inventory

OnboardingShell, BackLink, StepPill, SearchField (filters cards client-side; announces count), CheckboxCard, Combobox (multi-select, tags, localized a11y names, typeahead), Button, Link, StickyActionBar, StepProgress.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | Nothing selected; both actions proceed |
| Loading | Taxonomy loads with skeleton cards; combobox shows "Loading regions…" |
| Error | Taxonomy unavailable: "Could not load the list. You can set this up later." + continue |
| Permission-denied | Not applicable |
| Offline | Same as error; selections kept locally |
| Partial/stale | Search with no match: "Nothing found. You can continue without choosing." |

## Keyboard order and focus

Back → cards (one tab stop each) → search → combobox (arrow keys open list, Enter selects, Backspace removes last tag) → "I'll set this up later" → "Continue". On arrival focus is on H1 via `tabindex="-1"` (multi-step flow). After the last step: `/app` with focus on H1 "Overview".

## Responsive table behaviour

No tables.

## Locale keys

| Key | English |
|---|---|
| `onboarding.back` | Back |
| `onboarding.step` | Step {index} of {total} |
| `onboarding.buy.title` | What do you usually buy? *(wording from reference; editorial review)* |
| `onboarding.buy.subtitle` | We will suggest companies and materials that match your interests. |
| `onboarding.sell.title` | What do you offer? |
| `onboarding.sell.subtitle` | We will show requests and projects that match your profile. |
| `onboarding.industry.title` | Which topics interest you? |
| `onboarding.industry.subtitle` | We will collect news and articles on your topics. |
| `onboarding.multiDirectionsHint` | You can choose several areas. |
| `onboarding.directions` | Areas |
| `onboarding.directionsSearch` | Find an area, product or service |
| `onboarding.regions.buy` | Where do you need deliveries or works? |
| `onboarding.regions.sell` | Where do you work? |
| `onboarding.regions.placeholder` | Choose regions |
| `onboarding.regions.hint` | You can choose several regions or leave it unrestricted. |
| `onboarding.regions.loading` | Loading regions… |
| `onboarding.optional` | Optional |
| `onboarding.changeLater` | You can change your interests later. |
| `onboarding.setupLater` | I'll set this up later |
| `onboarding.taxonomyError` | Could not load the list. You can set this up later. |
| `onboarding.noMatches` | Nothing found. You can continue without choosing. |
| `taxonomy.materials` | Building materials |
| `taxonomy.equipment` | Equipment |
| `taxonomy.engineering` | Building services |
| `taxonomy.rawMaterials` | Raw materials and components |
| `taxonomy.works` | Construction works |
| `taxonomy.designServices` | Design and services |

Taxonomy labels are placeholders until O11 defines the localized catalogue; they must come from data, not hard-coded keys, once it exists.

## Open questions

- O11 taxonomy source and depth (top-level only in onboarding is proposed).
- Region list source (official subdivision list from the country pack vs custom) and licensing.
