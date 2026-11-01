# Supplier base: records, external counterparties, cards and assessments (PRC-003)

A company's private list of the suppliers it works with or considers ([Procurement and supply, "The company's supplier base"](../../../../../docs/engine/procurement-and-supply.md#the-companys-supplier-base), [data model section 18a](../../../../../docs/data/model.md#18a-procurement-and-supply)). Contracts: the frozen supply contracts [`suppliers.ts`](../../../../../packages/contracts/src/supply/suppliers.ts) and [`commands.ts`](../../../../../packages/contracts/src/supply/commands.ts) (PRC-000). Storage: [`packages/data/migrations/supplier-base`](../../../../../packages/data/migrations/supplier-base), [`packages/data/src/repositories/supplier-base.ts`](../../../../../packages/data/src/repositories/supplier-base.ts).

Status: Live in the API with no interface yet (WEB-011). Nothing here contacts a supplier, publishes anything or moves money.

## Rules the module enforces

| Rule | Where |
|---|---|
| Every row is `party_private` of the buying company: members of that company read it; the linked supplier, other buyers, anonymous callers and staff without a maintenance session see nothing (`404` for existence) | Row-level security `supplier_base_member`, `FORCE ROW LEVEL SECURITY` on all three tables |
| Writes need `procurement.suppliers.manage`: company administrators hold every procurement permission, other members through a live company-scoped `permission_grant` given by an administrator or a member manager | `supplier_base_require_manager` in every command; the runtime role has no `INSERT`, `UPDATE` or `DELETE` on the tables |
| A record links exactly one supplier: a claimed or verified platform company, a sourced (unclaimed) directory record, or an external counterparty of the same buyer; one record per supplier and buyer; never the buyer itself | `supplier_record_one_link`, partial unique indexes, `supplier_base_create_record` |
| Linking reads only the supplier's public claim status and writes nothing to the supplier's company | `supplier_base_create_record`, `supplier_base_link_claimed` |
| A link moves only forward: from a sourced record (to that same company once it is claimed) or an external counterparty (to the claimed company the buyer chooses, remembered in `claimed_company_id`), never back | `supplier_record_guard`, `supplier_base_link_claimed` |
| Regions are ISO 3166 codes and never a restricted place (an unsynced restricted list refuses every region) | `supplier_base_check_regions` (`kernel_place_restricted`) |
| Screening and payee verification on the onboarding checklist are never marked done by the buyer: the card derives the screening item from SANC-003's port | `supplier_base_onboarding_ok`, `card.ts`, `screening.ts` |
| Records, counterparties and assessments are never deleted (archive a record with status `archived`); revisions are checked under a row lock, so concurrent changes resolve once | Guards, `supplier_base_lock_record`, `supplier_base_lock_counterparty` |
| Assessments are drafts until recorded, then frozen; `reputation_input` is `false` by constraint; sharing is the buyer's explicit choice at recording and needs a linked platform company; the supplier sees only the assessment (never the record's status, notes, terms or onboarding) and answers once (administrator or `company.deals.manage`) | `supplier_assessment_guard`, `supplier_base_record_assessment`, `supplier_base_shared_assessments`, `supplier_base_respond` |
| No command appends an outbox event, so no notification, feed, index, federation or statistic can learn that a supplier is listed; audit rows carry identifiers and the names of changed fields only | Migration, `SupplierBaseService` |

## Routes

All routes need a session; mutations carry CSRF metadata and an `Idempotency-Key` (commands whose frozen contract carries `idempotencyKey` in the body must repeat the header value) and complete in their request transaction (`in_transaction`, crash-tested in `tests/backend/idempotency/cases/supplier-base.ts`).

| Route | Result |
|---|---|
| `GET /v1/supplier-base/suppliers[?status=&limit=]`, `GET /v1/supplier-base/suppliers/:id` | The company's records (`audience: party_private`), a record with its counterparty |
| `POST /v1/supplier-base/suppliers` | `MaintainSupplierCommand` (+ details, `actor`): `supplierRecordId: null` adds a record; an id changes it (omitted details keep their value); a different `link` of kind `company` is the move to the claimed company |
| `GET /v1/supplier-base/suppliers/:id/card` | The supplier card: the record, figures from the buyer's own agreements and orders (read under the person's own row-level security), honest `coverage` per source, public facts (claim status, the latest public reputation snapshot) and the one screening fact a counterparty may know |
| `GET /v1/supplier-base/counterparties`, `GET /v1/supplier-base/counterparties/:id`, `POST /v1/supplier-base/counterparties`, `POST /v1/supplier-base/counterparties/:id` | External counterparties: name, country-pack identifiers, private contacts; one per normalized name in a base |
| `GET /v1/supplier-base/suppliers/:id/assessments`, `POST /v1/supplier-base/suppliers/:id/assessments` | Assessments of a record; drafting (`DraftSupplierAssessmentCommand` plus the scores) |
| `POST /v1/supplier-base/assessments/:id/record` | `RecordSupplierAssessmentCommand`: freezes the draft, optionally shares it with the linked platform company |
| `GET /v1/supplier-base/import/template`, `POST /v1/supplier-base/import` | CSV (text) or XLSX (base64) of existing suppliers within the 256 KiB body limit, up to 1,000 rows; `dryRun` previews. All or nothing: any row error creates nothing; names already in the base are skipped. Every row becomes one external counterparty (`source: import`) and one record, never a company, membership, claim, handle or public record |
| `GET /v1/supplier-base/shared-assessments`, `POST /v1/supplier-base/shared-assessments/:id/respond` | The supplier's side: assessments buyers chose to share with the caller's company (`audience: shared_party`) and the one answer |

Refusals use the contract codes: `access.forbidden` (`details.reason`: `not_authorised`, `row_security`), `access.not_found`, `access.mandate_scope` (`mandate_scope`, or `confirmation_required` for an agent asking to block a supplier), `validation.revision_conflict` (`revision_conflict`, `already_listed`, `name_taken`, `already_answered`, `invalid_transition`), `validation.schema` (`invalid_link`, `not_shareable`, `invalid_region`, `restricted_place`, `import_file`, `idempotency_key`) and `commercial.version_immutable` (`frozen`, `record_permanent`) (`errors.ts`).

## Screening

`screening.ts` reads SANC-003's gate port (`screeningAllowsMoney`) inside a savepoint. The buyer learns one fact: `clear`, `cannot_transact_now` (also for a company never screened), `not_screenable` (an external counterparty is not a platform subject; the hub screens a company when it joins) or `unavailable` (the state could not be read: fail closed, never clear). Reasons, matches and list entries never reach the buyer.

## Agents

`mandates.ts` (`SupplierBaseMandatePort`, wired to the AST-001 store with module key `procurement` in `app.module.ts`): maintaining records and counterparties, the import and recording an assessment need `maintain_records`; drafting an assessment needs `prepare`; the supplier's answer needs `communicate` for the supplier company. An agent request to block a supplier is refused (`confirmation_required`): the design asks the person to confirm each block. `capabilities.ts` maps every route to its PRC-000 registry entry and proposes the missing entries for PRC-023.

## Follow-ups

- Country-pack document types for the onboarding checklist and their expiry (PRC-012); prequalification passport sections shared by consent (PREQ-001); due-diligence packs (DD-001).
- Card figures for receipts, discrepancies, match exceptions, invoices and documents once PRC-008, PRC-010 and PRC-012 exist (`coverage` says `not_available` until then).
- Status changes through an approval route of subject kind `supplier_status` once PRC-001 is on main; a notification to the supplier when a buyer shares an assessment (COMMS-001), still without revealing status or notes.
- Imports larger than the API body limit through a FILE-001 file reference; the web screens (WEB-011) and the registry entries (PRC-023).

## Tests

`tests/supplier-base/database.test.ts` (runtime role: authority, links, regions, visibility, forward-only links, assessments, no outbox event, concurrent creates and changes), `api.test.ts` (HTTP journey and the three acceptance criteria: forbidden fields across projections, search, notifications and federation; imports create no directory member, claim or public record; assessments never change a reputation snapshot; card coverage and history; screening failing closed; agents), `import.test.ts` (CSV and XLSX readers, row mapping, parity of capability ids).
