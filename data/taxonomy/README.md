# Trustwork plan-step taxonomy

Version 1.0.0. Licence: [CC0 1.0](LICENSE) (public domain dedication). Work package PLAN-000; decision: [ADR 012](../../docs/adr/012-integrator-decisions-2026-10-31.md) decision 14; flagship journey: [ADR 010](../../docs/adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 17 and 19.

One shared, open vocabulary for the "plan to people" journey ([Projects](../../docs/engine/projects.md#plans-from-plan-to-people)): plan items, consultation offerings, task requests, capability profiles, products, learning resources and recommendations are tagged with the same codes, so a match between a plan step and a person, a product or a guide is made on codes and can be explained. Everything here is original work written for Trustwork; no text or code list of a proprietary classification is copied.

Status: **Contract** (data and validator). Nothing in the product reads it yet; PLAN-001 (plans), DATA-003 (`taxonomy_term`, `step_term_relation`) and REC-001 (recommendations) are the first consumers.

## Layout

| Path | Content |
|---|---|
| `manifest.json` | Version, licence, locales, schemes and their files, allowed values |
| `terms/*.json` | One file per scheme (below) |
| `crosswalks/schemes.json` | Registry of external classifications: open ones ship, licensed ones never do |
| `jurisdictions/<PACK>.json` | Per-country answers to the permit, inspection and licensing questions (`US.json`) |
| `examples/*.json` | Synthetic worked examples: a US new single-family house and a US whole-house renovation |
| `locales/<tag>.json` | Labels, questions, facet values and notices in every engine language |
| `releases/<version>.json` | Every code released in that version |
| `validate.mjs` | Loader and validator; `node data/taxonomy/validate.mjs` prints a summary |
| `LICENSE` | CC0 1.0 Universal legal code |

## Schemes

| Scheme (data model `taxonomy_term.scheme`) | Code prefix | Terms in 1.0.0 | What it names |
|---|---|---|---|
| `stage` | `stage` | 17 | Phases of a building project, from the brief to handover, with predecessors |
| `project_type` | `project` | 9 | Kinds of projects (new house, whole-house renovation, kitchen remodel, ...) |
| `work_type` | `work` | 93 | Plan steps people understand ("Wall framing", "Plumbing rough-in", "Final grading") |
| `trade` | `trade` | 50 | Trades and expertise a step needs (crafts, contractors, design professionals, advisors) |
| `material` | `material` | 83 | Material and product categories a step uses |
| `permit_type` | `permit` | 15 | Permits and approvals a step may need, asked as questions |
| `inspection_type` | `inspection` | 16 | Inspections (hold points) that follow work and belong to a permit |
| `decision` | `decision` | 7 | Decision points the owner takes (go ahead, approve the design, accept the work) |

Each scheme has one root term whose code is the prefix (`work`, `trade`, ...). Group terms (with children) organize the tree and carry no relations; relations live on leaves.

`permit_type`, `inspection_type` and `decision` are not yet in the `scheme` enum of `docs/data/model.md`; DATA-003 adds them (requested in the PLAN-000 pull request). A separate `skill` scheme is not part of 1.0.0: trades double as expertise.

## Codes and stability

- A code is lowercase ASCII, dot-separated, and starts with its scheme prefix: `work.envelope.roofing`. Codes are unique across all schemes.
- **Codes are stable once released.** `releases/1.0.0.json` lists every released code. A released code is never deleted, renamed or reused; to withdraw a term set `"status": "retired"` and keep it. Nothing may reference a retired term.
- New terms start as `"status": "draft"` (allowed without a release, not usable in examples), then a new release file (for example `releases/1.1.0.json` with the codes it adds) and a version bump in `manifest.json` release them. Terms without a `status` are `released`.
- Labels are not part of the code: the English label can be improved without a new code.

## Relations

| Field | On | Meaning | `step_term_relation` |
|---|---|---|---|
| `predecessors` | stages | Stage order | `precedes_stage` |
| `predecessors` | work types, permits, inspections, decisions | Typical **immediate** predecessors: when both steps are in a plan, the predecessor comes first | `precedes` (proposed addition) |
| `stage` | work types, permits, inspections, decisions | The stage a step belongs to | `in_stage` (proposed addition) |
| `trades` | work types | Who usually does or advises on the step | `requires_trade` |
| `materials` | work types | Material categories the step uses | `uses_material` |
| `permits` | work types, inspections | Permits that must be in hand before the work starts; for an inspection, the permit(s) it belongs to | `needs_permit_type` |
| `produces` | work types | Which plan requests the step can become: `consultation`, `task`, `rfq`, `purchase`, `self` | none (plan item kinds) |
| `kind` | trades | `advisor`, `professional`, `contractor` or `craft` | none |

`relations()` in `validate.mjs` emits these rows. Predecessors describe a typical order, not a schedule: no durations, lags or costs are in the taxonomy. Plans add their own dependencies (`plan_dependency`) on top.

## Crosswalks

Every work-type and material leaf carries open crosswalk slots:

- **IFC 4.3** (ISO 16739-1:2024) entity names, optionally with a predefined type (`IfcCovering.ROOFING`). Written by the taxonomy authors from the open schema and marked `proposed`: they still need review by an IFC practitioner.
- **ETIM** product classes on materials. The slots are empty in 1.0.0; class codes are added only after review against the ETIM classification and its terms of use. No ETIM code is claimed today.

**Proprietary classifications never ship here.** MasterFormat, UniFormat and OmniClass (and Uniclass, under its own terms) are registered in `crosswalks/schemes.json` as `hub_licensed`. A hub that holds a licence keeps its mapping as hub data, outside this repository, and validates it with `validateHubCrosswalk()`, which requires the licence holder, reference, expiry and permitted uses. The validator rejects a licensed key in any term file and any extra file under `crosswalks/`. The engine works fully without any licensed mapping.

## Permits, inspections and licensing: questions, not rulings

Permit, inspection and decision terms each have a **question** in the locale files (`questions.<code>`), for example "Does this work need a building permit here, and which office issues it?". The plan agent asks the question and points the owner to the local authority.

`jurisdictions/US.json` gives the United States answers as facets: `applicability` (`commonly_required`, `depends_on_scope`, `depends_on_location`, `unknown`), the usual `authority`, and for trades whether `licensing` varies by state. **Every facet in 1.0.0 is `unverified`** general guidance with no sources, shown with the notice `messages.unverified_notice`. A facet may become `secondary` or `verified` only with sources (https URL, what the source supports, accessed date); the validator enforces this, and facets have no field for code citations. Real requirements differ by state, county and city; overrides per subdivision belong to the US country pack, which does not exist yet.

## Worked examples

`examples/us-new-single-family-house.json` (96 steps) walks a new detached house with a basement on a suburban lot with public water and sewer, owner-led with a general contractor, from the brief through design, permits, bidding, site work, foundation, framing, enclosure, rough-ins and their inspections, insulation, finishes, final inspections and the certificate of occupancy to acceptance. `examples/us-whole-house-renovation.json` (62 steps) walks an older house in a homeowners association: hazardous materials testing and abatement before demolition, a structural opening, replacement windows, new services and finishes.

Both are **synthetic** (`"synthetic": true`, notice `messages.synthetic_example_notice`): no real project, no durations, prices or code citations. Steps reuse taxonomy codes, so their labels come from the locale files. The validator checks that each example is acyclic, has one start and one end, reaches every step, keeps every direct taxonomy predecessor and every needed permit before the step, and includes a permit for every inspection.

## Languages

`locales/en.json` is the reference. `es`, `ru`, `uz-Latn`, `ka`, `hy` and `az-Latn` translate every key and are marked `machine_draft`: drafted by an AI agent, native-speaker review outstanding. A reviewed file changes its `status` to `reviewed` and names the reviewer in `review`. Keys are the codes themselves (`labels.work.envelope.roofing`), so every term is translatable without extra key fields. The validator requires every key in every listed locale and rejects unknown, empty or placeholder entries.

## Changing the taxonomy

1. Add or change terms in `terms/*.json`; new terms as `draft`.
2. Add the label (and the question for permits, inspections and decisions) to every `locales/*.json`, and a facet for each new permit, inspection or trade to every `jurisdictions/*.json`.
3. Run `node data/taxonomy/validate.mjs` and `node scripts/run-tests.mjs tests/taxonomy`.
4. To release, list the new codes in a new `releases/<version>.json`, set their status to released and bump `manifest.json`.

Everything in this directory, data and validator, is dedicated to the public domain under CC0 1.0, and so are contributions to it.
