# What works today, and what is designed

We would rather under-promise. This page says, area by area, what you can run today, what exists only as a demo on synthetic data, what is frozen as a contract, what is designed, and what this handbook proposes for the first time. It is updated whenever a work package is accepted.

## Status levels

| Level | Meaning |
|---|---|
| **Live** | Implemented end to end on PostgreSQL with automated tests, including negative authorization tests. Not yet deployed to production anywhere. |
| **Demo** | The user interface exists and is tested in a browser, but it runs on synthetic demo data (`apps/web/fixtures`). Nothing is stored; buttons that would act externally are imitations and say so. |
| **Contract** | The data shapes, state machines and invariants are frozen as Zod schemas in `packages/contracts` with tests. No storage or API yet. |
| **Designed** | An accepted design document or ADR describes it; no code yet. |
| **Proposed** | Designed in this handbook for the first time (owner decisions of 2026-10-30 and 2026-10-31). Open for review and discussion. Each proposed area has work packages in the [roadmap](roadmap.md). |

## By area

| Area | Live | Demo | Contract | Designed / proposed |
|---|---|---|---|---|
| [Accounts and sign-in](people-and-companies.md) | Sign-up with e-mail verification (delivered to a fake mailbox until MAIL-001), login, logout, recovery, step-up, sessions list and revoke, password and e-mail change, Google and Apple linking (with a fake provider for tests) | Login, sign-up, recovery and onboarding screens | Person, session, provider identity, auth commands, error codes | Microsoft and generic OIDC providers (designed) |
| [People and companies](people-and-companies.md) | Public reads of people and companies; company memberships: invite, accept, change, end, one active employer | Directories, profiles, company page, «Моя страница» with public profile editor | Membership, claims, legal identifiers from country packs | Claims and verification with hub evidence recipes (proposed) |
| [Projects](projects.md) | Create, read, assign leader, publish, ownership transfer with recipient consent, participants grant and revoke | Public project pages, workspace projects with tabs | Ownership XOR, milestones without budgets for participants | Plans with versions, changes and dependencies; plan items that become consultations and scoped tasks for invited experts and trades (proposed: plan to people, PLAN-001, CONS-001, TASK-001) |
| [News and articles](publishing.md) | — | News and articles with sources, rubrics, topics, RSS feeds | Publication, version, authorship, corrections | Sources registry and imports per hub (proposed) |
| [Magazine](magazine.md) | — | Numbered weekly issues, cover, reader, archive, rubrics, RSS | Issue, items pinned to publication versions, corrections | PDF layout pipeline (designed) |
| [Events](events.md) | — | Event list with filters, event page, registration, ticket, demo payment, calendar file | — | Organizer tools, check-in, partner meetings, payouts (proposed) |
| [Learning](learning.md) | — | Courses and certificates on «Моя страница», public certificate check | — | Course authoring, assessments, accreditation per hub (proposed) |
| [Partners and matching](partners-and-matching.md) | — | Directories with filters | Discovery candidates, eligibility with evidence | Needs board, explainable matching, introductions (proposed) |
| [Buying and selling](commerce.md) | — | Procurement and sales lists, decisions on the overview | RFQ and quote versions with digests, staleness, agreements, acceptance, comparison | Full flows COM-001 (designed) |
| [Execution and reputation](execution-and-reputation.md) | — | Project updates, published milestones | Delivery claims, acceptance records, assertions | Disputes, reviews, explainable reputation snapshots (designed); reputation-building tools and a portable verifiable passport (proposed: REP-001, REP-002) |
| [Your agent](agents.md) | — | Assistant page and overlay with mandates, approvals and runs from demo data | Mandate, approval, action states, external outcomes, reconciliation | Durable runtime AST-001 (designed); goals, agent-to-agent negotiation, the module catalogue, detailed participant settings and the governed extension registry (proposed: AGT-001, AGT-003, AGT-022, AGT-023) |
| [Search and knowledge](search-and-knowledge.md) | — | Keyword search over public demo cards | Retrieval generations, embedding config, citations | Governed hybrid retrieval with pgvector (designed) |
| [Communications](communications.md) | — | Notifications page and bell | — | Context threads, channel grants, templates (designed) |
| [Billing](billing.md) | — | Billing state in settings | Two budget kinds, price versions, acceptances | Offers, entitlements, payment adapters (designed); licensed payment providers only, Trustwork never holds funds; hub commissions as versioned, disclosed settings (proposed: PAY-001, BILL-003) |
| [Countries and languages](localization.md) | Country packs UZ, GE, AM, AZ; restricted places; any country with a generic profile | Country selector, six languages (en, ru, uz-Latn, ka, hy, az-Latn), every visible string localized including demo content | Pack schema v1 | Pack v2 facets, United States pack, Spanish, configuration over code (proposed: CTRY-002, INTL-US, LANG-ES, CFG-001) |
| Manufacturer and supplier knowledge on plan steps | — | — | — | Sourced pages and explained, never-paid recommendations per plan step (proposed: MAT-001, REC-001) |
| [Hubs](hubs.md) | — | — | — | Hub model, territories, launch checklist (proposed) |
| [Hub administration](hub-administration.md) | — | — | Admin permissions, audit events, case grants; hub console schemas in `hub.ts` (proposed, frozen by HUBC-000) | Hub console with setup wizard, keys and models, editorial office, data mining, jurisdiction settings (proposed); platform administration (designed) |
| [Country specifics](country-specifics.md) | Identifier formats, regions, currencies, residency notes in packs | — | — | Registers, licensing, codes, tax, signatures, payments (proposed) |
| [Federation](federation.md) | — | — | — | Mesh protocol (proposed, [ADR 011](../adr/011-federation-mesh.md)) |
| Sanctions | Restricted places in packs and compliance package; ownership declaration checks | Restricted places never offered | Screening adapter for the US Consolidated Screening List (needs a key) | Hub screening recipes (proposed) |
| Design system | Accessible React components on React Aria, tokens, brand mark and localized wordmarks, Storybook, axe tests (not yet run by CI; CI-001) | — | — | — |

## What this means if you try it

- `npm run dev:web` shows the whole public site and workspace on synthetic data from Uzbekistan, in six languages. Personas are chosen with `?persona=reader|mixed|owner`.
- `npm run dev:api` with the local database and the restricted runtime role printed by `npm run seed:dev -w @trustwork/api` runs the live identity, company and project API under `/v1/*` ([agent onboarding](agent-onboarding.md#3-install-and-run) has the exact commands).
- The web app does not yet call the live API; WEB-006 and WEB-004 in the platform phase of the [roadmap](roadmap.md) connect them.
- No payment, e-mail, model or registry provider is connected. Adapters exist as ports with fakes.

## What has not been validated

- No interviews with practitioners have taken place yet (open research O01).
- No real company, person, review or rating exists in the engine.
- Translations into Uzbek, Georgian, Armenian and Azerbaijani were produced by the integrator and await review by native speakers.
- Country facts that cite only secondary sources are marked as pending official confirmation inside each pack.
