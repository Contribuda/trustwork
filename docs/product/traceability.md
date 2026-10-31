# Requirement traceability

All 71 accepted requirements are specified, not implemented end to end (R01–R04 have live slices in the API; see [status](../engine/status.md)). [Machine-readable map](traceability.json) is checked for complete IDs and valid task references. Task briefs contain concrete evidence/tests; [ADRs](../adr/README.md) define engineering decisions.

| Requirements | Modules | Primary decisions |
|---|---|---|
| R01–04, R21–22, R28 | Identity/company/projects/access | ADR 002; data ownership and access matrix |
| R05–08 | Catalogue/procurement/sales/transactions/channels | ADR 003; immutable RFQ/quote versions |
| R09–11, R29 | Assistant/mandates/actions/budgets | ADR 003–004; persistent authority/outcome states |
| R12–14 | Execution/evidence/trust | ADR 003; causal plans/disputes/methodology |
| R15–18 | Content/publication/issue/personal journal | Product/IA and unresolved journal policy |
| R19–20 | Billing/commercial administration | ADR 003; two budget kinds and versioned prices |
| R23–26 | UI/navigation/design/i18n | Design manifest/status and accessibility contract |
| R27, R30 | Independent runtime/development workflow | ADR 001, 005, 006; exact client-approval lifecycle |
| R32–R35 | Events, learning, partners and matching, representative agents | ADR 010; [engine handbook](../engine/README.md) |
| R36–R38 | Hubs, hub administration, country specifics | ADR 009, ADR 010; handbook chapters on hubs, hub administration and country specifics |
| R39 | Worldwide mesh federation | ADR 011; handbook chapter on federation |
| R40 | Configurable engine with a United States reference hub | ADR 010 decision 16; ADR 012 decisions 11, 26–28; [hubs](../engine/hubs.md#the-reference-hub-united-states-decided) |
| R41–R43 | Plan to people, consultations and mentoring, shared knowledge | ADR 010 decision 17; ADR 012 decisions 13, 14, 19; [projects](../engine/projects.md#plans-from-plan-to-people) |
| R44 | Reputation building | ADR 010 decision 18; ADR 012 decision 5; [execution and reputation](../engine/execution-and-reputation.md#the-reputation-builder-toolkit) |
| R45 | Plan-step knowledge from manufacturers and suppliers | ADR 010 decision 19; ADR 012 decision 3; [search and knowledge](../engine/search-and-knowledge.md#plan-step-recommendations-proposed) |
| R46–R47 | No held funds; hub commissions | ADR 010 decisions 20–21; [billing](../engine/billing.md) |
| R48–R50 | Jurisdiction settings, detailed agent settings, agent extensions | ADR 010 decision 22; ADR 012 decision 24; [your agent](../engine/agents.md) |
| R51 | International by default: languages and country packs | ADR 012 decision 30; [countries and languages](../engine/localization.md) |
| R52 | Complete, accurate and visual documentation in English | Owner rule of 2026-10-31; `npm run validate:docs` |
| R53 | Procurement and supply suite with agent parity | Owner request of 2026-10-31; ADR 010 decision 23 (agent and interface parity); [procurement and supply](../engine/procurement-and-supply.md) |
| R55 | Normative module specifications | Owner request of 2026-10-31; [module specifications](../engine/modules/README.md), [conflicts to resolve](../engine/conflicts-to-resolve.md) |
| R56–R61 | Lead honesty, fair subscriptions, review integrity, ranking transparency, named performers, trust wording | [Competitive landscape](../research/competitive-landscape-2026-11.md), [ideas](../engine/ideas.md); modules [matching](../engine/modules/matching-and-partners.md), [billing](../engine/modules/billing-and-commissions.md), [reputation](../engine/modules/reputation-and-passport.md), [trust and safety](../engine/modules/trust-safety-privacy-compliance.md) |
| R62–R64 | Worker credential card, EU trader traceability, wallet-based identity | Modules [reputation](../engine/modules/reputation-and-passport.md), [trust and safety](../engine/modules/trust-safety-privacy-compliance.md), [identity](../engine/modules/identity-and-accounts.md) |
| R65–R67 | Public tenders worldwide, e-signatures and open BIM, mobile and offline | Modules [matching](../engine/modules/matching-and-partners.md), [integrations](../engine/modules/integrations.md), [mobile and offline](../engine/modules/mobile-and-offline.md) |
| R68–R71 | Accessibility evidence, analytics without surveillance, data-broker readiness, financing referrals | Modules [accessibility](../engine/modules/accessibility.md), [analytics](../engine/modules/analytics.md), [trust and safety](../engine/modules/trust-safety-privacy-compliance.md), [getting paid](../engine/modules/getting-paid.md) |
| R72 | Sanctions compliance engine: jurisdiction gate and holds, list screening, review, gates, re-screening, our own services, deployment attestation | [ADR 014](../adr/014-sanctions-compliance-engine.md), [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 24; module [sanctions compliance](../engine/modules/sanctions-compliance.md); SANC-001 … SANC-009 |

R31 maps to RAG-000, RAG-101, FND-002, DATA-001, BE-001, RAG-201, RAG-301, AST-001, WEB-003, RAG-401 and QA-001. See [retrieval evaluation](../quality/retrieval-evaluation.md). Fake-vector checks are not semantic-model or database evidence.
