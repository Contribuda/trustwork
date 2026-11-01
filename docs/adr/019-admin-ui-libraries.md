# ADR 019: administrative interface library boundary

Status: **Proposed**

Date: 2026-11-01

Agent: Codex CLI (OpenAI) for Parshkov

## Context

The stopped administrative redesign needs consistent navigation, dense operational tables, version reviews, permission explanations and recovery states. Six synthetic HTML prototypes explore these interactions. Copying each prototype into production would duplicate primitives and authorization paths. The existing [design system](../design/system/README.md) already chooses React Aria Components, CSS Modules and custom-property tokens, local fonts, Lucide, Storybook and Playwright. DS-003 owns the console primitive kit; DS-004 owns dark tokens.

ADR numbers 015 (editorial), 016 (exchange), 017 (outreach) and 018 (operating company) remain reserved for their respective designs. This proposal does not accept or supersede any of them.

## Proposed decision

1. Continue the existing component stack. Wrap existing accessible primitives in shared administrative compositions; do not introduce an independent vendor dashboard theme or replace the public/workspace system.
2. Keep native tables for read-only records. Use the existing DataTable/grid work from DS-003 for controlled sorting, pagination, selection and accessible editing. Do not install a new table, chart, form or editor library in this design PR.
3. If implementation demonstrates a missing capability, propose a bounded comparison with accessibility, locale support, bundle cost, maintenance, licence, SSR, offline behavior and migration evidence before adding a dependency. Library adoption is a separate reviewed implementation change; this ADR makes no claim about current third-party versions or comparative superiority.
4. Keep domain authority outside UI primitives. A visible or enabled button is never an authorization grant. Capabilities, projections, immutable versions, human gates, second-person review and reconciliation retain their accepted contracts.
5. Use shared locale dictionaries and repository brand overlays. Serve fonts and assets locally. Charts and maps require equivalent tables/lists; third-party map tiles, trackers and CDN assets are not part of the proposal.
6. Treat the standalone HTML files as disposable runtime environments with preserved source, not disposable design work. Carry their tested journeys and limitations into the implementation packages; preserve the original source inventory.

## Alternatives considered

- A full vendor admin framework: reduces some assembly work but creates a second visual and interaction system and does not supply the project's authority model. Not proposed.
- Handwritten production widgets copied from each prototype: preserves appearance quickly but duplicates keyboard, focus, locale and state logic. Not proposed.
- Existing primitives plus focused compositions: preserves current investment and keeps domain ownership clear. Proposed, subject to implementation evidence and maintainer review.

## Consequences

The names below are the requested draft package names. Registry publication is blocked on the owner's decision about the incompatible `ADM-UX-001` and `ADM-UX-002` IDs; this proposal does not register or rename them.

DS-005 covers shell/navigation compositions; DS-006 covers operational states and recovery. ADM-UX-001 applies the shell, and ADM-UX-002 connects completed domain journeys. Existing packages keep their scope and status. Their acceptance includes 375 px layouts, all seven locales, keyboard and screen-reader evidence, offline asset policy and real negative authorization/concurrency tests where authority is involved.

The prototype source can carry technical debt that must not cross into production: fixture scenario switches, in-memory state, simulated delays, fake credentials and illustrative model activity. Full application tests, human design acceptance and native translation review remain separate. No package is marked done by this ADR.

## Evidence and open decisions

- [Administrative guidelines](../design/admin-ui-guidelines.md)
- [Six prototypes and reproducible checks](../design/prototypes/README.md)
- [Console rules and component ownership](../engine/hub-console/console-design.md)

Owner review of the visual direction and maintainer acceptance of this proposal remain pending. Editorial standing policies, outreach modes and operating-company policy questions are outside this ADR; retain their restrictive defaults.
