# Requirement traceability

All 39 accepted requirements are specified, not implemented end to end. [Machine-readable map](traceability.json) is checked for complete IDs and valid task references. Task briefs contain concrete evidence/tests; [ADRs](../adr/README.md) define engineering decisions.

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

R31 maps to RAG-000, RAG-101, FND-002, DATA-001, BE-001, RAG-201, RAG-301, AST-001, WEB-003, RAG-401 and QA-001. See [retrieval evaluation](../quality/retrieval-evaluation.md). Fake-vector checks are not semantic-model or database evidence.
