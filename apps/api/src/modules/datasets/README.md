# Datasets (MINE-001)

Local data mining: datasets with recorded legal flags, records with per-record provenance, links instead of merges, and people deciding what goes live. Design: [local data mining](../../../../../docs/engine/hub-console/data-mining.md), [discovery and outreach](../../../../../docs/engine/discovery-and-outreach.md) section 1, ADR 012 decision 4, [ADR 026](../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md). Contract: `DatasetSchema` in [`hub.ts`](../../../../../packages/contracts/src/hub.ts). Database: [`migrations/datasets`](../../../../../packages/data/migrations/datasets), repository [`datasets.ts`](../../../../../packages/data/src/repositories/datasets.ts).

Status: datasets and entity resolution are **Live** in the database (parts 1 and 2). Routes and the worker refresh follow.

| Rule | Where it holds |
|---|---|
| Reputation is never an output | output vocabulary; `datasets_propose` refuses it by name |
| People datasets use consent or public professional data, never display publicly; court, debt and people datasets need an impact assessment | `dataset` constraints |
| Court and debt records about natural persons serve only as verification evidence and are never displayed | `dataset_court_debt_persons` |
| Activation is a person other than the proposer; personal-data datasets need a second person (`pipelines.activate_personal_data_dataset`), court and debt datasets too (`datasets.activate_court_or_debt`) | `datasets_activate` |
| A dataset under a contract needs an operator licence in force (supplier, agreement evidence, purposes, display, enrich, contact and syndicate uses, period) to activate and to receive records | `dataset_licence`, `datasets_store` |
| Every record carries provenance: source URL, observed time, method and the source's licence snapshot | `datasets_provenance_ok` |
| The do-not-collect list (digests of identifiers, domains, e-mails; never the values) is consulted before storage on every refresh; adding an entry buries matching records | `datasets_blocked`, `datasets_add_do_not_collect` |
| Contact points need the dataset's contact use (set by a person; under a contract only when the licence grants it), an organisation record and a person's mark; a changed record loses its mark | `datasets_set_contact_use`, `datasets_mark_contact`, `datasets_contact_points` |
| Records past retention, all records of a contract dataset whose licence ended, and the records of a retired dataset are deleted and leave tombstones with a digest of the key | `datasets_sweep`, `datasets_bury` |

## Entity resolution: links, never merges

| Rule | Where it holds |
|---|---|
| The resolver proposes identifier matches only (same kind, normalised value); a name alone never produces a proposal; a pair a person rejected is not proposed again by the resolver | `datasets_resolve_dataset` |
| Every proposal carries evidence (kind, detail, similarity as a decimal string), a confidence in [0, 1] (a matching measure, never a reputation score) and the scoring method version (`trustwork-resolve/1`); the effect is always `link` | `entity_link_proposal` |
| Statutory identifier evidence: the record came from an official register and the company holds the identifier | `datasets_statutory_match` |
| A person decides, never their own proposal; a person is linked only with their own confirmation or a signed statement | `datasets_decide_link`, `entity_link_proposal_person` |
| A pair marked distinct is withdrawn and never proposed again; an accepted link is not marked distinct | `datasets_mark_distinct` |
| A batch decision covers only open proposals with statutory identifier evidence proposed by someone else; the person names the sample they saw (at least five, or all) and the counts and scoring method are kept | `datasets_batch_decide`, `entity_link_batch` |
| A buried record withdraws its open proposals | `datasets_bury` |

## Next

- Console routes, the worker refresh and resolution on the pipeline engine, crash cases.
- Outputs as reviewed imports into the receiving modules (directory sourced records, verification evidence, eligibility facts, opportunities, events, knowledge, news desk).
