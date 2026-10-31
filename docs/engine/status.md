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
| [Accounts and sign-in](people-and-companies.md) | Sign-up with e-mail verification (live only with the in-memory fake mailbox: no mail transport exists, so a real person cannot receive the verification or recovery e-mail until MAIL-001), login, logout, recovery, step-up, sessions list and revoke, password and e-mail change, Google and Apple linking (with a fake provider for tests) | Login, sign-up, recovery and onboarding screens | Person, session, provider identity, auth commands, error codes | Microsoft and generic OIDC providers (designed) |
| [People and companies](people-and-companies.md) | Public reads of people and companies; company memberships: invite, accept, change, end, one active employer; company creation with a founding administrator (registered, unclaimed); public handles with redirects; keyset-paginated people, company and project directories and "my projects" (BE-003) | Directories, profiles, company page, "My page" with public profile editor | Membership, claims, legal identifiers from country packs | Claims and verification with hub evidence recipes (proposed) |
| [Projects](projects.md) | Create, read, assign leader, publish, ownership transfer with recipient consent, participants grant and revoke | Public project pages, workspace projects with tabs | Ownership XOR, milestones without budgets for participants | Plans with versions, changes and dependencies; plan items that become consultations and scoped tasks for invited experts and trades (proposed: plan to people, PLAN-001, CONS-001, TASK-001) |
| [News and articles](publishing.md) | — | News and articles with sources, rubrics, topics, RSS feeds | Publication, version, authorship, corrections | Sources registry and imports per hub (proposed) |
| [Magazine](magazine.md) | — | Numbered weekly issues, cover, reader, archive, rubrics, RSS | Issue, items pinned to publication versions, corrections | PDF layout pipeline (designed) |
| [Events](events.md) | — | Event list with filters, event page, registration, ticket, demo payment, calendar file | — | Organizer tools, check-in, partner meetings, payouts (proposed) |
| [Learning](learning.md) | — | Courses and certificates on "My page", public certificate check | — | Course authoring, assessments, accreditation per hub (proposed) |
| [Partners and matching](partners-and-matching.md) | — | Directories with filters | Discovery candidates, eligibility with evidence | Needs board, explainable matching, introductions (proposed) |
| [Buying and selling](commerce.md) | — | Procurement and sales lists, decisions on the overview | RFQ and quote versions with digests, staleness, agreements, acceptance, comparison | Full flows COM-001 (designed) |
| [Procurement and supply](procurement-and-supply.md) | — | — | — | Requisitions, approval routes, supplier base, bid levelling, AI document intake, cost control, receiving, stock, three-way match, payment proposals with payee protection, e-invoicing networks, analytics and agent parity (proposed: PRC-000 … PRC-023, WEB-011, WEB-012, HUBC-011, AGT-024) |
| [Execution and reputation](execution-and-reputation.md) | — | Project updates, published milestones | Delivery claims, acceptance records, assertions | Disputes, reviews, explainable reputation snapshots (designed); reputation-building tools and a portable verifiable passport (proposed: REP-001, REP-002) |
| [Your agent](agents.md) | — | Assistant page and overlay with mandates, approvals and runs from demo data | Mandate, approval, action states, external outcomes, reconciliation | Durable runtime AST-001 (designed); goals, agent-to-agent negotiation, the module catalogue, detailed participant settings and the governed extension registry (proposed: AGT-001, AGT-003, AGT-022, AGT-023) |
| [Search and knowledge](search-and-knowledge.md) | — | Keyword search over public demo cards | Retrieval generations, embedding config, citations | Governed hybrid retrieval with pgvector (designed) |
| [Communications](communications.md) | — | Notifications page and bell | — | Context threads, channel grants, templates (designed) |
| [Billing](billing.md) | — | Billing state in settings | Two budget kinds, price versions, acceptances | Offers, entitlements, payment adapters (designed); licensed payment providers only, Trustwork never holds funds; hub commissions as versioned, disclosed settings (proposed: PAY-001, BILL-003) |
| [Countries and languages](localization.md) | Country packs UZ, GE, AM, AZ; restricted places; any country with a generic profile | Country selector, six languages (en, ru, uz-Latn, ka, hy, az-Latn), every visible string localized including demo content | Pack schema v1 | Pack v2 facets, United States pack, Spanish, configuration over code (proposed: CTRY-002, INTL-US, LANG-ES, CFG-001); eleven more languages with right-to-left, CJK and Devanagari support and honest review status, an EU layer and fourteen more country packs (planned: ADR 012 decision 30, [languages and countries](localization.md#languages-and-countries)) |
| Manufacturer and supplier knowledge on plan steps | — | — | — | Sourced pages and explained, never-paid recommendations per plan step (proposed: MAT-001, REC-001) |
| [Hubs](hubs.md) | — | — | — | Hub model, territories, launch checklist (proposed); the United States reference hub on Railway, operated by Contribuda, demo-only until QA-002, counsel review and the owner's switch (decided, not deployed: [reference hub](hubs.md#the-reference-hub-united-states-decided)) |
| [Hub administration](hub-administration.md) | — | — | Admin permissions, audit events, case grants; hub console contract 1.0.0 in `hub.ts` (frozen by HUBC-000) | Hub console with setup wizard, keys and models, editorial office, data mining, jurisdiction settings (proposed); platform administration (designed) |
| [Country specifics](country-specifics.md) | Identifier formats, regions, currencies, residency notes in packs | — | — | Registers, licensing, codes, tax, signatures, payments (proposed) |
| [Federation](federation.md) | — | — | — | Mesh protocol (proposed, [ADR 011](../adr/011-federation-mesh.md)) |
| Sanctions | Restricted places in packs and compliance package; ownership declaration checks | Restricted places never offered | Screening adapter for the US Consolidated Screening List (needs a key) | Hub screening recipes (proposed) |
| Background worker | Outbox relay with SKIP LOCKED, durable jobs (lease, heartbeat, fencing token, backoff, dead letters, `outcome_unknown` parking, reconciliation command), scheduled sweep and monthly audit/outbox partitions, Prometheus metrics, own database role; no domain handlers yet (mail delivery is MAIL-001) | — | Retry policy, action states, reconciliation | Provider adapters per owning package (designed) |
| Design system | Accessible React components on React Aria, tokens, brand mark and localized wordmarks, Storybook. Its axe suite (`npm run test:a11y -w @trustwork/ui`) exists but no gate runs it: neither `npm run check` nor CI calls it until CI-001 (the web app's own axe checks do run in the CI browser job) | — | — | — |

## What this means if you try it

- `npm run dev:web` shows the whole public site and workspace on synthetic data set in Uzbekistan, in six languages; a synthetic United States demo hub replaces it in the platform phase (DEMO-US). Personas are chosen with `?persona=reader|mixed|owner`.
- `npm run dev:api` with the local database and the restricted runtime role printed by `npm run seed:dev -w @trustwork/api` runs the live identity, company and project API under `/v1/*` ([agent onboarding](agent-onboarding.md#3-install-and-run) has the exact commands).
- The web app does not yet call the live API; WEB-006 and WEB-004 in the platform phase of the [roadmap](roadmap.md) connect them.
- No payment, e-mail, model or registry provider is connected. Mail is an in-memory fake called from the request (no transport exists); Google and Apple sign-in have a fake mode and a live mode that needs keys nobody has configured; the sanctions screening adapter needs a key; payment, model, registry, storage and channel providers are designed ports with fakes.
- The worker (REL-001) relays the outbox and runs durable jobs and scheduled maintenance under its own database role, but no domain handler is registered yet: outbox events are marked published as unhandled, and mail still goes through the in-memory fake from the request until MAIL-001.
- What each kind of participant can try today, step by step: [How it works for you](../guides/README.md).

## Accuracy checked on 2026-10-31

The statements on this page, in [Architecture](architecture.md), in [API conventions](../architecture/api.md) and in `.env.example` were checked against the code at the head of `main` on 2026-10-31, closing the documentation-versus-code findings of the [architecture audit](../research/architecture-audit-2026-10.md#4-documentation-accuracy-versus-code):

| Finding | Checked against | Result |
|---|---|---|
| E-mail verification listed as Live | `apps/api/src/modules/identity/ports.ts` (only `FakeMailbox`), `auth.service.ts` | Live only through the fake mailbox; stated above |
| Design-system axe tests | Root `check` script, `.github/workflows/check.yml`, `packages/ui/package.json` | Suite exists, not gated until CI-001; stated above |
| "Next web work packages" | `work-packages.json` | Named: WEB-006 and WEB-004 |
| One transaction for change, audit and outbox | `auth.service.ts`, `provider.service.ts`, `membership.service.ts`, `projects.service.ts` | True for memberships, projects and grants; several identity audits and all mail are outside it; [Architecture](architecture.md#data-and-reliability) says so |
| Outbox feeding the worker | `apps/worker/src/relay.ts`, `apps/worker/src/runner.ts`, `tests/worker` | Since REL-001 the worker relays the outbox and runs jobs; no domain handler exists yet, so provider ports stay designed in the diagram |
| "Routes are not implemented" | `docs/architecture/api.md` | Reworded: routes not listed as implemented are contract only |
| Health contract | `packages/contracts/src/api.ts`, `apps/api/src/app.module.ts` | The controller reports `disabled`, `fake` or `live`; the frozen schema still says `disabled` (OPS-001 aligns it); documented in API conventions |
| `.env.example` | `apps/api/src/config.ts`, `apps/api/src/app.ts`, `packages/data/src/config.ts`, `apps/web` | Four unread variables removed; `API_DATABASE_URL`, `PUBLIC_ORIGIN`, `AUTH_FLOW_SECRET` and the other read variables added |
| Data boundary and fake auth comments | `apps/web/app/_lib/data/index.ts`, `apps/web/app/_lib/auth-fake.ts` | Comments now say the swap and the real auth proxy belong to WEB-006 and WEB-004 |
| Roadmap date and statuses | `work-packages.json` | Statuses and counts regenerated from the file on 2026-10-31 (UTC, the date convention of the repository) |

## What has not been validated

- No interviews with practitioners have taken place yet (open research O01).
- No real company, person, review or rating exists in the engine.
- Translations into Uzbek, Georgian, Armenian and Azerbaijani are machine drafts produced by the integrator and await review by native speakers.
- Country facts that cite only secondary sources are marked as pending official confirmation inside each pack.
