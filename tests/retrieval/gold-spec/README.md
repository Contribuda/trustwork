# Retrieval gold-set specification (RAG-101)

Status: **DRAFT (RAG-101)**, 2026-10-27. Defines the schema and conventions for retrieval gold items used by the benchmark protocol (private repository record, not exported). Everything in `examples.json` is **synthetic**: entity ids reuse the vocabulary of `tests/retrieval/fixture.ts` (`shared`, `buyer-note`, `seller-floor`, `employer`, `public`, `rfq`; principals `buyer`, `seller`, `employee`, `stranger`, `other`). No real company, person, price or document is represented.

## Files

| File                    | Purpose                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gold-item.schema.json` | JSON Schema for one gold item (declared as draft 2020-12; validated so far only under draft-07 semantics with the repository's `ajv@6`, see Validation); `examples.json` and future gold files must validate against it |
| `examples.json`         | 11 synthetic items covering the strata; plumbing/validation only, not a quality benchmark                                                                                                                               |

## Item conventions

- `id`: stable, `gold-<stratum>-<nnn>`.
- `stratum`: exactly one primary stratum from corpus-inventory.md (private repository record, not exported) section 5; `tags` carry secondary aspects.
- `query.text` is Russian unless the stratum requires otherwise; `query.language` uses BCP-47 (`ru`, `en`, `mul` for mixed).
- `temporal` mirrors the contract `TemporalMode`: `{kind: "current"}` or `{kind: "versions", versionIds: [...], asOf: ISO-8601}`.
- `principal` is a fixture principal id plus the role list the adversarial matrix names; it is a test fixture, never a real account.
- `expected.sourceVersions` lists `{sourceId, versionId, grade, locator?, projectionId?}`; grades `0..3` (see protocol section 2.2). Items with `expected.abstention = true` must have no grade >= 2 entries.
- `mustNotReturn` lists source ids (any version) that constitute a leak if they appear at any stage for this principal.
- `requiredFilters` are mandatory typed constraints (region, standard ids, rfq version) a candidate must satisfy to score above grade 1.
- `citation.expectation` is `required` (a correct citation must be deliverable), `optional`, or `forbidden` (no citation may be exposed, e.g. abstention or revoked access).
- `injection.flag = true` marks items whose corpus chunks contain instructions; `injection.expectedMandateEffect` must be `none`.
- `completeDomain` marks items whose correct answer is a structured-resolver result (total, minimum, overdue set); retrieval alone must not answer them.
- `annotation` records annotator pseudonyms, dates and adjudication; synthetic items record `"synthetic": true`.

## Validation

What was validated: `examples.json` against `gold-item.schema.json` using the repository's transitive `ajv@6.15.0` in **draft-07 mode** (`$schema`/`$id` stripped, `format` not enforced because `ajv-formats` is not wired to ajv 6). The keywords used by the schema (`oneOf`, `const`, `if`/`then`, `not`, `additionalProperties`) have the same meaning in draft-07 and 2020-12, but strict 2020-12 validation requires an explicit `ajv@8` + `ajv-formats` devDependency, which is a root lockfile change and needs integrator review. No repository test was added by RAG-101.

## Checker rules not expressible in JSON Schema

A gold-file checker (future CI step) must enforce, in addition to the schema:

1. `locator.kind = "text"` implies `locator.start <= locator.end`.
2. No `sourceId` in `mustNotReturn` may appear in `expected.sourceVersions[*].sourceId` (an item cannot both expect and forbid a source).
3. Grades in `expected.sourceVersions` for an item with `expected.abstention = true` are at most 1 (also enforced by the schema).

Negative probes exercised in the review follow-up (all rejected): table locator without `row`; page locator with an extra `table` property; text locator with `start > end` (checker rule 1); `complete_domain` item without `structuredFact`/`completeDomain`; `access_adversarial` item with empty `mustNotReturn`; `injection` item with `flag: false` or empty `payloadSourceIds`; `abstention: true` with `citation.expectation: "required"`; `expectation: "forbidden"` together with `mustSupportClaim`; `mustNotReturn` overlapping an expected source (checker rule 2).
