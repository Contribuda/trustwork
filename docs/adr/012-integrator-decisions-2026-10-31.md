# ADR 012 — Integrator decisions of 2026-10-31

Date: 2026-10-31. Status: **integrator decisions recorded 2026-10-31** (wave-3 integrator: Claude, an AI agent working for the repository owner Dmitry Parshkov, on the conductor's brief). These are engineering and planning defaults the integrator may take; the owner can override any of them, and the questions in the [last section](#questions-that-remain-for-the-owner-or-counsel) are explicitly **not** decided here. Nothing in this ADR claims that anything is implemented: statuses stay as in [status](../engine/status.md).

## Context

On 2026-10-31 the owner recorded ADR 010 decisions 16–22 (a configurable engine with a United States reference hub, plan to people, reputation-building tools, plan-step knowledge from manufacturers and suppliers, no held funds, hub commissions, detailed configuration for law, agents and capabilities). Five wave-1 documents then proposed about one hundred work packages in parallel:

| Source | Proposals |
|---|---|
| [Architecture audit](../research/architecture-audit-2026-10.md), section 8 | 16 new packages and 3 amendments, questions Q1–Q9 |
| [Market scan and ideas](../research/market-and-ideas-2026-10.md), proposed work packages | 28 packages |
| [Agent catalogue](../engine/agent-catalog.md), proposed work packages | 19 packages (AGT-002 … AGT-020), questions Q1–Q9 |
| [Data model](../data/model.md), section 31, and the [migration plan](../data/migration-plan.md) | 13 packages |
| [Hub console](../engine/hub-console/README.md), proposed work packages | 21 packages, 6 open questions |

Several used the same identifier for different work (PAY-001, PROV-001, OPS-001, AGT-002, INTL-US) or different identifiers for the same work (INTL-ES, I18N-001 and LANG-ES; DEMO-001 and DEMO-US; CRED-001, AGT-006 and REP-002). This ADR records how they became one graph in [work-packages.json](../engine/work-packages.json) and the defaults needed to make it claimable.

## Decisions taken by the conductor (recorded here)

1. **Staff roles are scoped** to the platform, a node or a hub (`staff_role_assignment.scope`); the frozen `platform` literal is extended, not replaced.
2. **OpenRouter** is offered by the setup wizard as one optional provider next to direct providers; it is an ordinary provider whose egress is limited to public data unless its routed vendors' retention terms are recorded.
3. **Sponsored content** is a per-hub option, **off by default**, always labelled, and never used for ranking, matching or recommendations.
4. **Court and debt datasets** are off by default in every hub; enabling one needs an impact assessment and a recorded legal basis.
5. **The reputation passport** uses W3C Verifiable Credentials 2.0, compatible with Open Badges 3.0, signed with node keys and with status lists for revocation.
6. **HUB-002 is the umbrella** of the console packages (HUBC-000, ADM-002, HUBC-002 … HUBC-010).
7. **Spanish is the seventh engine language** (LANG-ES).

## Decisions taken by the integrator

8. **One graph, deduplicated.** Existing identifiers are reused where the scope matches; colliding proposals are renamed rather than overwritten:

   | Proposal | Became |
   |---|---|
   | Audit INTL-ES, market I18N-001, console INTL-US (Spanish part) | LANG-ES |
   | Audit DEMO-001 | DEMO-US |
   | Audit INTL-US, console INTL-US (pack part) | INTL-US |
   | Audit amendments to BE-002, DATA-002, CTRY-002 | the same packages, amended; CTRY-002 split into the schema (CTRY-002) and the four example packs' facts (CTRY-003) |
   | Audit PAY-001 (payment port) and data-model BILL-002 | PAY-001 (provider port) and BILL-002 (invoices, tax, refunds, payouts) |
   | Market PAY-001 (pay applications, retainage, lien waivers) | PAY-002 |
   | Market and data-model PLAN-001 | PLAN-000 (open taxonomy) and PLAN-001 (plans) |
   | Market and data-model CONS-001, catalogue AGT-011 | CONS-001 (consultations and mentoring), CONS-002 (paid consultations), TASK-001 (scoped tasks) |
   | Market and data-model KNOW-001, catalogue AGT-012 (knowledge part), console PLAN-002 (knowledge shares) | KNOW-001 |
   | Market and data-model REP-001, catalogue AGT-005 (backend part) | REP-001; the agent side stays AGT-005 |
   | Market CRED-001, catalogue AGT-006, console REP-002 | REP-002 (portable passport) |
   | Market and data-model MAT-001, console REC-001, catalogue AGT-010 and AGT-012 (recommendation parts) | MAT-001 (sourced manufacturer and supplier pages), REC-001 (plan-step recommendations), AGT-021 (the companion module) |
   | Market and data-model SRC-001; data-model pipelines and datasets; console PIPE-001, MINE-001, EDIT-001; market CNT-002 | SRC-001, PIPE-001, MINE-001, EDIT-001 (story clusters included) |
   | Market AGT-002 (A2A and MCP), data-model AGT-002 (connection storage), console AGTP-001 | AGT-003 (modules), AGT-004 (metering and usage statistics), AGT-016 (MCP), AGT-017 (A2A) |
   | Catalogue AGT-019 and market EVAL-001 | EVAL-001 (harness for the core runtime) and AGT-019 (all modules, connections and extensions) |
   | Console OPS-001 (console operations) | OPS-004 (the audit's OPS-001 keeps its identifier) |
   | Console PROV-001 (providers and keys) | KEYS-001 (market PROV-001, AI provenance, keeps its identifier) |
   | Console HUBC-001 (shell, M1) | ADM-002, whose scope it matches; the earlier /admin MVP surface and its `apps/web/admin` path are superseded |
   | ADM-003 (deferred administration screens) | rejected as superseded by HUBC-002 … HUBC-006 |
   | Console PLAN-002 (planner and marketplace administration) | PLAN-003; marketplace commissions are BILL-003 |
   | Console INST-001 | INST-001, on top of the OPS-002 images |

   New packages that no proposal covered: DATA-004 (migration layout), INTL-004 (locale namespaces), WEB-006 (asynchronous data boundary), BE-004 (second factor and elevated sessions, needed by the console and the setup wizard), CNT-003 (magazine web and PDF, split from CNT-001), COM-002 (split from COM-001), EVT-002 (events web, split from EVT-001), WEB-007, WEB-008 and WEB-010 (user-facing screens), HUB-005 (jurisdiction settings, decision 22), AGT-022 (detailed participant agent settings, decision 22), AGT-023 (governed extension registry, decision 22), BILL-003 (hub commissions, decision 21), HUBC-007 … HUBC-010 (live wiring of the console) and QA-002 (platform release candidate).

9. **Phase order (audit Q3).** A platform phase comes first: connect the web to the API, worker and outbox, mail, production basics, containers, CI hardening, locale fixes, configuration over code, Spanish, the US pack and the US demo data, plus the staff and moderation basics that must exist before user-generated content goes public. Then plan to people, consultations, reputation building and shared knowledge, with the commerce core (COM-001, COM-002) as their prerequisite because tasks are RFQs and bookings are agreements; then payments; then the hub console; agents; events, learning and matching; search and retrieval; federation. Phases order priority; dependencies alone decide when a package can be claimed ([roadmap](../engine/roadmap.md)).
10. **Spanish is `es`** with regional formats derived from the country (`es` in a US hub formats as `es-US`; audit Q5, console question 5). The `Intl` tag is computed from language and country for every language (INTL-003). Machine-assisted translations are allowed, labelled as such, until a native speaker reviews them.
11. **No default country** (audit Q9). With nothing configured the engine has no default country: a visitor gets a neutral country choice and the setup wizard requires one before a hub exists. The US demo hub configures US explicitly (DEMO-US). `DEFAULT_COUNTRY = 'UZ'` is removed by CFG-001.
12. **The demo hub uses synthetic data only** (audit Q2, first half): every demo record is labelled synthetic, no real company, person, licence or identifier appears, domains are `example.invalid`. Whether the reference deployment also accepts real sign-ups stays with the owner (below).
13. **Plan versions** have the statuses `draft`, `proposed`, `approved` and `superseded`. A proposed version is frozen; only the plan owner (or a person the owner authorized) approves; an agent may only propose under a mandate; an approved version is never edited, it is superseded.
14. **The plan-step taxonomy is open data under CC0 1.0** (`data/taxonomy`, PLAN-000), with predecessor relations and crosswalk slots to IFC and ETIM. Proprietary classifications (for example MasterFormat or Uniclass mappings) are licensed hub data and never ship in the repository; the engine works without them.
15. **Migrations: one directory per module** (DATA-004). The runner reads the flat root (the twelve applied files stay put) and one level of `packages/data/migrations/<module>/` directories in global timestamp order; the schema mirror is split per module. This resolves the DATA-002 path that the flat runner silently ignored and the RAG-201 claim on all of `packages/data`. The integrator still assigns timestamps at merge.
16. **Locale files per feature namespace** (INTL-004): `apps/web/locales/<locale>/<namespace>.json`. A feature package adds its own namespace file in every engine language and never edits another feature's file.
17. **Package paths may not overlap** unless one package depends on the other, directly or transitively; `node scripts/work-packages.mjs validate` enforces it, so two packages that can be claimed at the same time never own the same path. Shared one-line registration files (the contracts barrel, `app.module.ts`) are owned by no package.
18. **Handles** (audit Q4, second half): people, companies and projects get public handles for URLs; UUIDs remain the stable identifiers; a changed handle leaves a redirect and is never reused for another subject (BE-003). Whether language and country appear in public paths stays with the owner; WEB-005 is blocked on it.
19. **Agreement kinds.** COM-002 adds `terms_kind` (`rfq_quote`, `task`, `consultation`) to agreements and includes it in the digest input, as the data model asked; consultation bookings and task assignments are agreements of those kinds.
20. **Retrieval is not a prerequisite** of the agent runtime, matching or recommendations. AST-001, MATCH-001 and REC-001 use structured data and a retrieval port with a fake; semantic recall arrives with RAG-301 and RAG-401 verifies the integration. This keeps the requested order (agents and matching before search).
21. **Retention mechanics** (audit Q6, mechanics only): audit and outbox tables are partitioned monthly by the worker; retention is hub configuration within country-pack bounds; partitions are detached and archived rather than deleted row by row; erasure redacts or pseudonymizes and is recorded in an erasure ledger kept outside the restorable snapshot. The actual periods are for the owner and each hub's counsel.
22. **Money in the US demo** (audit Q7): card, ACH and sales-tax flows appear in the demo only through fake providers and are labelled "demo: no money moves". Trustwork never holds participants' money (ADR 010 decision 20), so PAY-001 refuses configurations that route funds through an operator account.
23. **Agent catalogue questions** (catalogue Q1–Q9): a hub can only be more generous than the engine's free floor (Q1); introduction quotas are never purchasable (Q2); no outcome-based fees for agent work, and marketplace commissions are hub settings under decision 21 (Q3); tickets, courses and consultations are purchases from the transaction budget (Q4); external agents get no `read.private` data class by default, opt-in per class with a residency warning (Q5); anonymous A2A is limited to public read skills at low rate limits (Q6); the passport format is decision 5 above (Q8); budget ranges in plans use only cost datasets the hub licensed for display and model use (Q9). Q7 (liability and disclosure wording) is configuration under HUB-005, but the wording itself needs counsel (below).
24. **Decision 22 applies everywhere.** The agent catalogue's earlier rule that hubs "cannot create new action verbs" is superseded: modules are engine code, and administrators add capabilities only through the governed extension registry (AGT-023), which can add actions but never bypass mandates, budgets, kill switches, privacy rules, the restricted-places list or the untrusted-text rule. Jurisdiction settings (HUB-005) and detailed participant agent settings (AGT-022) are packages of their own.
25. **Per-object public assistants** (audit Q8), proposed default pending owner confirmation: the assistant on a public person, company or project page is the **visitor's own** agent working on public data; a company page may show the company's standing representative as a labelled contact point; there is no per-project agent.

## Questions that remain for the owner or counsel

| # | Question | Why it is not the integrator's | Blocks |
|---|---|---|---|
| 1 | Hosting region and the accountable operator entity of the US demo hub; RPO and RTO (audit Q1, O13) | Legal and commercial accountability | OPS-003 targets, MAIL and payment providers, privacy notices, any deployment |
| 2 | Does the reference deployment accept real sign-ups, or stay demo-only (audit Q2)? | Product and legal exposure | Real-user launch after QA-002 |
| 3 | Language (and country) in public URLs for caching and search engines (audit Q4) | Product and SEO direction | WEB-005 (blocked) |
| 4 | Retention periods, legal bases and erasure deadlines per hub (audit Q6, O06) | Counsel per jurisdiction | PRV-001 configuration, OPS-003 retention |
| 5 | Liability allocation for agent commitments and the agent disclosure wording per jurisdiction (catalogue Q7, O12) | Counsel per jurisdiction | Live use of HUB-005 defaults; commitment modules in any hub |
| 6 | Per-object public assistants: confirm decision 25 (audit Q8) | Product surface | AGT-018 public placement |
| 7 | Prices, trials, tiers and commission levels for the reference hub (O03) | Commercial | Activation of BILL-001 and BILL-003 versions |
| 8 | Reputation weights, windows and minimum samples (O07) | Trust policy | Public scores (EXE-001, REP-001) |
| 9 | Practitioner interview programme: consent, recruiting, incentives (O01) | Research ethics and budget | AGT-020 (blocked) |
| 10 | Whether importing people data from sources makes a US hub a data broker in some states | Counsel | People-directory sources (MINE-001) |
| 11 | Electronic agreement validity and consumer rules per state and country (O12) | Counsel | Live commitments (COM-002, AGT-008) |
| 12 | Payment, mail, model, storage and hosting providers for the reference hub (O08) | Commercial and legal | Any live adapter |

## Consequences

- [work-packages.json](../engine/work-packages.json) holds one graph of 150 packages (17 done, 130 open, 2 blocked, 1 rejected); `npm run work:next` starts with the platform phase.
- The [specification](../product/specification.md) gains R40–R50 and the [traceability](../product/traceability.json) maps them to packages.
- The [roadmap](../engine/roadmap.md) is rewritten as phases with package identifiers; the [status](../engine/status.md) labels are unchanged except where this ADR adds designed work.
- `node scripts/work-packages.mjs issue <ID>` renders the GitHub issue body for a package; the conductor syncs issues.
