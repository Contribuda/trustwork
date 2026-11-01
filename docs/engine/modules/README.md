# Module specifications

This folder is the **normative specification of every module** of the engine, current and future, written to one template so that implementers, reviewers, hub operators and the owner read them the same way. The narrative chapters of the handbook ([projects](../projects.md), [buying and selling](../commerce.md), [your agent](../agents.md) and the others) explain *why* a module works the way it does; the pages here state *what it must do*, as numbered requirements with an honest status and the work packages that build them.

Owner request of 2026-10-31: "the full and detailed functionality the system will have, including what is not implemented yet". Every requirement below therefore carries a status label, and nothing here claims that a Designed or Proposed capability works.

## How to read a module page

Every page has the same sections, in this order:

| Section | What it states |
|---|---|
| Header | Module code, status summary, work packages, narrative chapter, data-model section |
| Purpose | Why the module exists, in two or three sentences |
| Who uses it | Participant roles ([participants](../participants/README.md)) and staff roles |
| User stories | "As a … I want … so that …", each with a status |
| Functional requirements | Numbered `<CODE>-F<nn>`; one testable statement each, with status and packages |
| Agent capabilities | The module's entries in the [capability registry](../capability-registry.md): id, kind (`read`, `draft`, `commit`), mandate kind, default confirmation policy, interface surface |
| Interface surfaces | Pages, panels and dialogs, with routes where they exist |
| Hub console settings | What a hub administrator configures, with links to the [hub console](../hub-console/README.md) |
| Data entities | Links into the [data dictionary](../../data/model.md) |
| Country and jurisdiction variations | What comes from [country packs](../country-specifics.md) and hub configuration |
| Privacy rules | Projections, consent, retention and what never leaves its owner |
| Metrics | What the hub and the participant may measure, always as cohorts or own data |
| Edge cases | Failure modes, concurrency, abuse and what the engine does about each |
| Flow | At least one Mermaid diagram where the module has a flow |
| Open points | Questions and links to [conflicts to resolve](../conflicts-to-resolve.md) |

### Status labels

The same five labels as [What works today](../status.md), applied per requirement:

| Label | Meaning |
|---|---|
| **Live** | Implemented end to end on PostgreSQL with automated tests, including negative authorization tests |
| **Demo** | Interface exists on synthetic demo data; nothing is stored |
| **Contract** | Frozen Zod schemas and state machines in `packages/contracts` with tests; no storage or API |
| **Designed** | An accepted design document or ADR describes it; no code |
| **Proposed** | Designed in this handbook, open for review; includes the ideas added by the [full specification of 2026-10-31](../ideas.md) |

### Requirement identifiers

`<CODE>-F<nn>`, for example `PLN-F07`. The code is the module code below; numbers are never reused, and a withdrawn requirement keeps its number with the status **Withdrawn** and a reason. Requirement identifiers are deliberately different from work-package identifiers (`PLAN-001`) and from the product requirements of the [specification](../../product/specification.md) (`R41`), which map to them.

### Capability identifiers, kinds and confirmation

The "Agent capabilities" tables use the terms of the capability registry contract frozen by AGT-002 (`packages/contracts/src/agent-catalog.ts`, ADR 010 decision 23):

- **Identifier** `<agent module key>.<operation>`, prefixed with the key of the agent module that packages it ([families and modules](../agent-catalog.md#families-and-modules)), for example `project_planner.propose_version`, `quoting.send_quote` or `core.stop_all`; capabilities that belong to no specialised module (account, security, decisions, mandates, preferences) use `core`. The domain module that owns the use case is the page the entry is listed on.
- **Kind**: `read` (returns data, no side effect), `draft` (inert, owner-private drafts and proposals), `commit` (moves shared state under a mandate) or `govern` (changes the person's own authority or account: confirm or revoke mandates, approve decisions, consent to a connection, security and membership changes; prepared by the agent, performed by the person on the first-party form, never by a mandate or a connection).
- **Mandate kind**: the action verb a commit needs (`prepare`, `research`, `communicate`, `send_quote`, `negotiate`, `place_order`, `accept_order`, `generate_deliverable`, `introduce`, `schedule`, `maintain_profile`, `publish`, `register`, `record_evidence`, `confirm_execution`); a draft may only name `prepare`, `research` or `generate_deliverable`; reads and governance name none (—).
- **Confirmation**: `none` for reads and drafts; `mandate` for commits that follow the mandate's approval policy, with the default policy the module's mandate template proposes in parentheses ([approval policies](../agent-catalog.md#mandate-notation): `ask_each`, `ask_first(n)`, `ask_above(amount)`, `pre_authorized`); `person_each` or `person_each_step_up` for commits a person confirms every time (human-only classes such as `confirm_execution`, reputation signals, and consumer commitments); `first_party_form` or `first_party_step_up` for governance.

Consumer mode and jurisdiction settings may raise a confirmation at run time (for example to `person_each`), never lower it.

## Module index

| Code | Module | Main status | Main packages |
|---|---|---|---|
| AGN | [The agent and its runtime](agent.md) | Demo surface; Contract mandates; Designed runtime; Proposed goals, modules, settings, extensions | AST-001, AGT-001 … AGT-023, LLM-001, EVAL-001 |
| IDN | [Identity and accounts](identity-and-accounts.md) | Live core; Designed providers; Proposed second factor, wallets | BE-001, BE-002, BE-004, MAIL-001, IDV-001 |
| PCO | [People and companies](people-and-companies.md) | Live memberships, company creation, handles and directories (API); Demo profiles; Proposed claims and credentials | BE-003 (done), PPL-001, CLM-001 |
| PLN | [Projects and plans](projects-and-plans.md) | Live projects; Demo plan tab; Proposed plans | PLAN-000, PLAN-001, PLAN-003, PRMT-001 |
| CNS | [Consultations](consultations.md) | Proposed | CONS-001, CONS-002 |
| TSK | [Tasks and mentoring](tasks-and-mentoring.md) | Proposed | TASK-001, CONS-001 |
| KNW | [Knowledge sharing](knowledge-sharing.md) | Proposed | KNOW-001 |
| PRC | [Procurement and supply](procurement-and-supply.md) | Demo lists; Contract RFQ and quote versions; Proposed suite | COM-001, COM-002, PRC-000 … PRC-023, WEB-011, WEB-012, HUBC-011, AGT-024 |
| SAL | [Sales](sales.md) | Demo lists; Contract quote versions; Designed flows | COM-001, COM-002, WEB-002 |
| CAT | [Catalogue and manufacturer knowledge](catalogue-and-manufacturer-knowledge.md) | Contract offerings; Proposed sourced pages | COM-001, MAT-001 |
| MCH | [Matching and partners](matching-and-partners.md) | Demo directories; Proposed matching | MATCH-001, MATCH-002, WEB-010, PROC-001 |
| REP | [Reputation builder and passport](reputation-and-passport.md) | Contract assertions; Designed snapshots; Proposed builder and passport | EXE-001, REP-001, REP-002, REV-001, CRED-001 |
| EXE | [Execution and field evidence](execution-and-field-evidence.md) | Contract claims; Designed execution; Proposed field objects | EXE-001, FIELD-001, DISP-001 |
| PAY | [Getting paid](getting-paid.md) | Proposed | PAY-001, PAY-002, FIN-001 |
| BIL | [Billing and commissions](billing-and-commissions.md) | Contract budgets and prices; Designed offers; Proposed commissions | BILL-001 … BILL-004 |
| EVT | [Events](events.md) | Demo attending; Proposed hosting | EVT-001, EVT-002 |
| LRN | [Learning and certificates](learning-and-certificates.md) | Demo; Proposed authoring and credentials | LRN-001 |
| PUB | [News, articles, magazine and the editorial office](publishing-and-editorial.md) | Demo reading; Contract publications; Proposed editorial office | CNT-001, CNT-003, SRC-001, EDIT-001, PROV-001 |
| SCH | [Search and cited answers](search-and-cited-answers.md) | Demo keyword search; Contract retrieval; Designed hybrid retrieval | RAG-201, RAG-301, WEB-003, RAG-401, REC-001 |
| MSG | [Communications and notifications](communications-and-notifications.md) | Demo bell; Designed threads; Proposed channels | MAIL-001, COMMS-001, CHAN-001 |
| HBC | [Hubs and the hub console](hubs-and-console.md) | Contract console schemas (1.0.0); Proposed console | HUBC-000 (done), HUB-001 … HUB-005, ADM-002, HUBC-002 … HUBC-011 |
| DMS | [Data mining and sources](data-mining-and-sources.md) | Proposed | SRC-001, PIPE-001, MINE-001, REG-001 |
| LOC | [Country packs and localization](country-packs-and-localization.md) | Live packs v1 and seven languages; Contract pack v2 schema; Proposed v2 facts and more languages | CTRY-*, LANG-*, INTL-* |
| MSH | [Federation mesh](federation-mesh.md) | Proposed | FED-000 … FED-006, NET-000 … NET-004, MAP-001, HUBC-023, HUBC-024 |
| TSP | [Trust, safety, privacy and compliance](trust-safety-privacy-compliance.md) | Live projections; Designed moderation and privacy operations | PRV-001, PRV-002, REV-001, RANK-001, DSA-001, WORD-001 |
| SNC | [Sanctions compliance](sanctions-compliance.md) | Live restricted places, the ownership declaration, the jurisdiction gate and holds (SANC-001) and the deployment-location attestation API (SANC-009); Proposed list screening, review, gates and re-screening (ADR 014) | INTL-SAN (done), SANC-001 … SANC-009 |
| SEC | [Security architecture](security-architecture.md) | Live identity hardening; Designed the rest | BE-002, BE-004, OPS-001, CI-001 |
| INT | [Integrations](integrations.md) | Proposed | INTEG-001, ESIG-001, BIM-001, PRC-012, PRC-013 |
| MOB | [Mobile and offline](mobile-and-offline.md) | Demo responsive web; Proposed offline | CHAN-001, MOB-001 |
| ACC | [Accessibility](accessibility.md) | Live design system checks; Proposed programme | DS-001, A11Y-001 |
| ANL | [Analytics](analytics.md) | Proposed | ANL-001, BENCH-001 |
| API | [API and MCP](api-and-mcp.md) | Live identity API; Proposed public API and MCP server | DOC-002, INTEG-001, AGT-016, AGT-017, MCP packages |
| OPR | [Operations](operations.md) | Live worker; Proposed operations console | REL-001, OPS-001 … OPS-004, INST-001 |
| OSS | [Open-source governance and contribution](open-source-governance.md) | Live process | CI-001, DOC-001 … DOC-004 |

## Cross-cutting rules every module keeps

These rules are stated once here and assumed by every page; a module page repeats one only where it adds detail.

1. **One person, one lifelong identity; one active employer; no switchers.** ([R01, R02](../../product/specification.md))
2. **One agent per person, one standing representative per company at most; no agent management UI.** ([ADR 010](../../adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 4 and 9)
3. **Full parity between the agent and the interface** through the [capability registry](../capability-registry.md); commitments need a confirmed mandate, a budget where money is involved and the person's confirmation; chat text never authorizes (decision 23).
4. **Untrusted input never issues commands**: files, e-mail, web pages, imported records and other agents' notes inform drafts only.
5. **Projections on every read**: `public`, `shared_party`, `party_private`, `owner_private`, `staff_case`, the same serializer for API reads, search hits, exports, notifications, agent context and federation envelopes.
6. **Sourced ≠ claimed ≠ verified**; unknown is shown as unknown, never as failure.
7. **Payment never changes ranking, matching, recommendations, reputation or badges**; sponsored content is off by default and kept out of ranking ([ADR 012](../../adr/012-integrator-decisions-2026-10-31.md) decision 3).
8. **Trustwork never holds participants' money**; only licensed providers configured per hub do (decision 20).
9. **Country behaviour is data or an adapter**, never engine code; the engine has no default country (ADR 012 decision 11).
10. **Restricted places are never offered, hosted, served or federated**; Russia is not a market; no Russian providers or payment rails.
11. **Every visible string in every engine language** through locale namespaces; dates and numbers through `Intl`.
12. **No surveillance**: no per-employee metrics, no "who viewed your profile", statistics about participants are cohorts of at least ten.
13. **No fakes**: no invented users, companies, reviews, ratings, badges or traffic; demo data is synthetic and labelled.
