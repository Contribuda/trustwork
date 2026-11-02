# Datasets (MINE-001)

Local data mining: datasets with recorded legal flags, records with per-record provenance, links instead of merges, and people deciding what goes live. Design: [local data mining](../../../../../docs/engine/hub-console/data-mining.md), [discovery and outreach](../../../../../docs/engine/discovery-and-outreach.md) section 1, ADR 012 decision 4, [ADR 026](../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md). Contract: `DatasetSchema` in [`hub.ts`](../../../../../packages/contracts/src/hub.ts). Database: [`migrations/datasets`](../../../../../packages/data/migrations/datasets), repository [`datasets.ts`](../../../../../packages/data/src/repositories/datasets.ts).

Status: the database slice is **Live** (part 1). Routes, the worker refresh and entity resolution follow.

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

## Next

- Entity resolution: link proposals with evidence, confidence and scoring method version; mark-distinct pairs; reviewed batch decisions only for statutory identifier matches.
- Console routes, the worker refresh on the pipeline engine, crash cases.
- Outputs as reviewed imports into the receiving modules (directory sourced records, verification evidence, eligibility facts, opportunities, events, knowledge, news desk).
