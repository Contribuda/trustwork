# Onboarding: capabilities (optional multi-select)

Route: `/onboarding` (after signup or first provider login; reachable later from settings as "Interests").

## Status and evidence

`proposed (reference: accepted direction)` — `onboarding-capabilities.png` (private design archive), manifest `accepted_direction`: "Multi-select and skip; preferences confer no company authority." Spec R03, R22 ("Optional multi-select onboarding; optional categories/regions second step; skip; preferences confer no legal/company access"), journey 1; locale `onboarding` array (I buy / I supply / I take part in the industry).

## Audience and access policy

Authenticated users without recorded onboarding completion/skip. Selections are **preferences** that influence which overview panels are pinned by default; they are not roles, not company membership, not authority. Skipping is always allowed and leaves all defaults off (reader/author mode). The step can be revisited; the assistant never changes these.

## Data projection

Three options with `selected` boolean each; "skipped" flag; timestamp. No company fields.

## Primary tasks

1. Choose zero or more of the three capabilities.
2. Continue to the optional second step or skip to the workspace.

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Top bar: brand, "Go to the site ↗", circular avatar (initial letter). Centered column ~1200 px: success pill "Account created" (only right after signup), H1 "What are you interested in on the platform?", subline, hint "You can choose several options", three equal selectable cards (illustration, checkbox, title, description, two tag chips), note "You can change your choice at any time", primary "Continue", link "I'll look around first" |
| Tablet | Cards 3 columns to 900 px, then 1 column stacked (full width) |
| Mobile <768 | Cards stacked, illustration shrinks to 80 px height or hidden; sticky bottom bar with "Continue" and "I'll look around first" |

## Component inventory

OnboardingShell (top bar + centered column + footer links), SuccessPill, SelectableCard (checkbox semantics: `role="checkbox"` or native checkbox inside label; whole card clickable; visible focus ring on card; selected state with border + check, not colour alone), Button, Link, StickyActionBar (mobile).

## Interaction states

| State | Behaviour |
|---|---|
| Empty (zero selected) | "Continue" stays **enabled** and acts as skip (proposal; the reference disables it, which forces users toward the small link). "I'll look around first" remains as explicit skip |
| Loading | Saving spinner on button; cards disabled |
| Error | FormAlert "Could not save. You can continue and come back to this later." with "Continue without saving" |
| Permission-denied | Not applicable |
| Offline | Same as error; selections kept locally until retry |
| Partial/stale | Returning user sees current selections pre-checked and "Save" instead of "Continue" (previously entered choices are never asked again from scratch, WCAG 2.2 3.3.7) |

## Keyboard order and focus

Brand → "Go to the site" → avatar → card 1 → card 2 → card 3 (each one tab stop; Space toggles) → "Continue" → "I'll look around first". Page load: focus not moved; H1 is first heading. After continue: next step H1 announced.

## Responsive table behaviour

No tables.

## Locale keys

| Key | English |
|---|---|
| `onboarding.accountCreated` | Account created |
| `onboarding.toSite` | Go to the site |
| `onboarding.capabilities.title` | What interests you on the platform? *(wording from reference; editorial review)* |
| `onboarding.capabilities.subtitle` | We will set up the workspace for your tasks. |
| `onboarding.multiHint` | You can choose several options. |
| `onboarding.buy.description` | I look for suppliers, compare quotes and organize purchasing. |
| `onboarding.buy.tags` | Suppliers · Procurement |
| `onboarding.sell.description` | I offer goods, works or services and find clients. |
| `onboarding.sell.tags` | Company · Quotes |
| `onboarding.industry.description` | I read, publish articles and news, share experience and meet people. |
| `onboarding.industry.tags` | Publications · Community |
| `onboarding.changeAnytime` | You can change your choice at any time. |
| `onboarding.continue` | Continue |
| `onboarding.skip` | I'll look around first |
| `onboarding.save` | Save |
| `onboarding.saveError` | Could not save. You can continue and come back to this later. |
| `onboarding.continueWithoutSaving` | Continue without saving |
| `onboarding.noAuthorityNote` | These are only interest settings. They give no rights in a company and create no obligations. |

Existing keys reused: `onboarding[0..2]` for the three titles.

## Open questions

- Whether "Continue" is enabled with zero selection (proposal: yes) — human/UX decision.
- Whether the illustration set is created by DS-001 or dropped in favour of icons.
