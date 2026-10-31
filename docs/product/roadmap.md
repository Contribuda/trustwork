# Phased roadmap

Phases sequence validated slices; they do not remove the full domain from the model. All production phases require explicit release authorization. See the machine-readable task graph for executable dependencies.

The executable plan is the [engine roadmap](../engine/roadmap.md) (phases 1–8 with package identifiers, ADR 012); this page keeps the original product-level gates, which still apply to those phases.

| Phase | Deliverable | Entry / exit gate |
|---|---|---|
| F0 Foundation (this bootstrap) | Decision baseline, inspected references, architecture/ADRs, model/contracts plan, runnable technical examples, atomic claims, task briefs | Local validation plus independent coordinator review; no production functionality claim |
| F1 Research and contracts | Personal-benefit interviews, access/ownership model, immutable commercial snapshots, auth/provider decisions, canonical tokens, approved screen contracts | Reviewed evidence and foundation/contracts freeze; no dependent implementation before acceptance |
| F2 First public and identity slice | Useful public news/articles/directories, classic account/recovery, personal identity and optional company link, initial magazine web/PDF proof | Consent/licensing policy, security and accessibility checks, explicit source/claim labels |
| F3 Paired procurement/sales slice | Manual/file needs, RFQs, versioned offers, comparison, shared accepted terms, contextual communications, goods/works/services | Buyer/seller isolation and concurrency verified; authority/budget rules; no fake automation |
| F4 Product assistant autonomy | Mandates, approval digest, durable runs, reservations, fake then approved real adapters, stop/revoke/reconcile | Prompt injection tests, idempotence under crash, unknown-outcome reconciliation, both budget kinds |
| F5 Execution and reputation | Plans/change baselines/dependencies, obligations, delivery/work/partial acceptance, disputes/reviews/explainable aggregates | Public/private boundary, causal attribution, moderation/appeal and evidence quality gates |
| F3b Procurement and supply suite (R53) | Requisitions and approval routes, private supplier base, bid levelling and awards, AI document intake with human review, cost control, receiving and stock, three-way match, payment proposals through licensed providers with payee protection, e-invoicing as pack data, analytics without surveillance; every operation also an agent capability ([engine phase 3b](../engine/roadmap.md#phase-3b-procurement-and-supply-suite)) | Approvals human and digest-bound; no account numbers stored; forbidden-field and per-person-metric negative tests; injection suite for documents; concurrency tests for allocations, call-offs and payments |
| F6 Commercial operations and scale | Versioned offers/prices/entitlements/usage, personalized journal only after policy resolution, performance/search/observability | Price acceptance, accounting reconciliation, restore drill, jurisdiction/provider decisions |

Content/magazine, design-system/accessibility and research can progress independently through contract-defined interfaces. Backend/domain/data and web frontend converge at versioned contracts; neither owns the other's inferred behavior. The original repeated backend lane is mapped naturally to backend, design system, and frontend, with assistant/content/QA lanes alongside. Production release is not scheduled by this document.

## Required standalone-to-management sequence

Current work is independent. QA-001 records tests, DEP-001 later records separately authorized public deployment, ACC-001 records the client's explicit approval of that version, and only then INT-001 may adopt an external development-management platform for continued development. No current attachment, adapter, registration, Orbit distribution or platform runner gate blocks independent implementation/release. Preserve independent runtime even after management connects.

## Mandatory retrieval track

RAG-000 prepares architecture/contracts/fixtures; RAG-101 specifies the authorized corpus and evaluates model/config choices before FND-002 freezes shared contracts. DATA-001 and BE-001 establish persistence/authorization. RAG-201 implements derived ingestion/index lifecycle; RAG-301 implements permission-aware hybrid queries and delivery fencing. AST-001 consumes this governed context; WEB-003 implements search/citation/freshness states. RAG-401 supplies real quality, adversarial and operational evidence before QA-001. Runtime work remains pending. Model download/provider use/spend needs applicable authorization; no paid fallback. Deployment and explicit client approval still precede adoption by an external development-management platform.
