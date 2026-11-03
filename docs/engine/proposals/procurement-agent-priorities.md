# Procurement and supplier-agent priorities

Proposal for maintainer discussion; not an accepted delivery commitment. Reference: Contribuda/trustwork at b29558519e68fb3ccc5ef485dba60de439418374, inspected 2026-11-04. Package statuses come from docs/engine/work-packages.json, not the older generated roadmap tables. This proposal does not claim implementation work or change package status, dependencies or ownership.

## Requested order

| Priority | Scope and packages | Current catalogue status | Acceptance requested |
|---|---|---|---|
| 1 | Complete procurement journey: COM-001, COM-002, WEB-002, FILE-001 | All four done | Demonstrate RFQ with five attachments, invitations, authorized supplier downloads, quotes, comparison and a final report. Verify the connected journey and remaining gaps, not reimplement the four packages. Our downstream fork has already implemented and tested invited-supplier attachment access; coordinate any upstream contribution separately. |
| 2 | Administration and staff: HUBC-007, ADM-004 | Both in_progress | Real API-backed hub configuration, invitations, scoped staff roles and approval flows, including negative authorization checks. Work alongside the procurement acceptance where owned paths permit. |
| 3 | Shared model and document groundwork: LLM-001, PRC-005, BID-002 | All open | Configurable eligible model provider, mandate-based permissions, spending limits and audit; extraction of positions and terms with source citations, uncertainty and human correction. No automatic authority from document contents. BID-002 also requires BID-001 and its dependency chain. |
| 4 | Buyer agent: selected AGT-024 capabilities with PRC dependencies | AGT-024 open | Draft RFQs, suggest suppliers, summarize and compare responses, prepare a report; external actions require the applicable mandate and confirmation. Request an explicit minimal slice; the full package also depends on AGT-008, PRC-023, PRC-004 and PRC-011. |
| 5 | Supplier agent: AGT-025 and required BID-001 through BID-008 capabilities | All open | Find permitted opportunities, draft quotes, assist clarification messages and produce an activity report. Preserve human submission and authorization requirements. AGT-025 also depends on AGT-007, AGT-008 and BID-009; do not omit these foundations. |
| 6 | Recurring work and external sources: PIPE-001, SRC-002, selected adapters | PIPE-001 done; SRC-002 in_progress | Reuse the scheduler; add only agreed sources with collection permission, backoff, deduplication and observable scheduled results. Do not recreate the scheduler. |

Priorities 1 and 2 may proceed in parallel where dependencies and owned paths allow. After shared foundations, buyer and supplier slices may proceed in parallel under the same rule. This is a requested delivery order, not permission to bypass package dependencies. Broader country/language expansion, payments, stock, accounting and other unrelated suite features are outside our immediate downstream requirements; this does not request removing them from the upstream roadmap.

## Maintainer decisions requested

1. Please assess this order, suggest changes where dependencies require them, and confirm the smallest deliverable scope for each priority and which existing work already satisfies it.
2. Identify remaining dependencies and any justified package split through normal integrator review.
3. State which items can be taken first, their responsible contributors and estimated delivery windows. No next-day delivery is assumed.
4. Agree the boundary: upstream owns shared capabilities; downstream owns deployment, Russian adaptation, provider configuration and scenario acceptance. Avoid duplicate implementations.

