# Open decisions and research register

No default here may silently become an accepted commercial, legal or UX claim. Owners are workstream lanes, not assigned people. Decisions need dated evidence, options, consequences, human review where product policy changes, and ADR updates.

| ID | Question / current boundary | Owner / blocking stage |
|---|---|---|
| O01 | Ten procurement interviews and personal-benefit hypotheses untested; collect consent, real stories, counterexamples | Research / before claiming validated needs or prioritizing by invented frequency |
| O02 | Personalized journal first sample, free repeat, paid recurrence, audience and cadence unresolved | Product-commercial / before paywall or subscription implementation |
| O03 | Prices, assistant trial duration, tiers, separate outcome pricing and currency markets unknown | Commercial / before billing activation |
| O04 | Former-employee residual history access and retention; explicit revocable read-only grants only as possible option | Product-security / before employment lifecycle launch |
| O05 | Company claiming/verification and spending authority proof; the registration identifier alone is insufficient | Identity/trust / before company verification badge |
| O06 | Jurisdiction, data residency, lawful processing, retention, minors policy, content/portrait licensing and international transfers | Human/legal / before external personal-data collection or production |
| O07 | Reputation weighting, dimensions, evidence confirmation/dispute process, appeal SLA and minimum sample display | Trust / before scored public rankings |
| O08 | Email/messenger/voice, model, object store, payment and hosting providers | Architecture/operations / before real product provider connector or deployment; fake-only now |
| O09 | Canonical editable logo and final workspace visual; missing detail/flow/mobile/state designs | Design/human / before visual acceptance |
| O10 | Auth library/session adapter, neutral provider (Google, Apple, Microsoft) verified linking and corporate-email recovery | Backend/security / before authentication implementation |
| O11 | Search scale thresholds, localized taxonomy and measurement-unit catalogue | Data/content / before normalized procurement comparison |
| O12 | Purchase/order binding semantics and jurisdiction-specific electronic agreement requirements | Product/legal / before real commitments |
| O13 | RPO/RTO, availability targets, retention and backup encryption/key custody | Operations/human / before production gate |
| O14 | ~~Development-management export~~ Retired 2026-10-31: the project is developed directly in `Contribuddha/trustwork` (ADR 010 decision 15) | Retired |
| O15 | Multiple simultaneous employers | Out of current scope; no latent switcher or required UX |
| O16 | ~~Agent tool entitlement~~ Retired 2026-10-31: contributors bring their own coding agents ([agent onboarding](../engine/agent-onboarding.md)) | Retired |
| O17 | ~~Open-source license~~ Decided 2026-10-29 by the owner: **AGPL-3.0-only** (hosted forks share their changes); `LICENSE` carries the full text, every package declares the SPDX identifier (ADR-009 decision 8) | Decided |
| O18 | ~~Neutral engine name~~ Decided 2026-10-29 by the owner: **Trustwork**, package scope `@trustwork/*`; Trustwork in every language, a Russian-language name and wordmark only in the Russian interface (ADR-009 decision 6, ADR 010 decision 14) | Decided |
| O19 | ~~Publication~~ Decided and done 2026-10-31: the engine is public as `Contribuddha/trustwork` (ADR 010 decisions 12 and 15) | Decided |

A task can research an open decision without implementing a guessed answer. Escalate only the decisions that block the concrete task; keep independent work moving.

## RAG decisions still open

RAG itself is required, not an optional future feature. Initial design is PostgreSQL + pgvector + lexical/exact retrieval. RAG-101 must resolve authorized corpus and volumes, rights/retention, measured Russian relevance, model revision/license/hardware and dimension/storage limits. FND-002 freezes schema and policy/fencing contracts. Region/provider retention/egress and approved cost ceilings remain UNKNOWN. Targets in the evaluation plan are proposals, not results; no external vector service or paid inference is authorized by this preparation.
