# Local data mining

Status: **Proposed**. Contract: `DatasetSchema`, `DatasetSubjectSchema`, `DatasetOutputSchema`, `LegalBasisSchema`, `PersonalDataCategorySchema`, `LinkProposalSchema`, `HubSourceSchema`, `PipelineVersionSchema` (`dataset_refresh`, `entity_resolution`) in [`hub.ts`](../../../packages/contracts/src/hub.ts). Screens HC-50…HC-53 in [screens](screens.md#data). Backend: proposed MINE-001 on the pipeline engine.

A hub becomes useful when it knows the local industry: which companies exist and are active, who holds which licence, which public tenders are open, which events are coming. Much of this is public, but "public" does not mean "free to use for anything". Data mining in the console is therefore built around **datasets with recorded legal flags**, **links instead of merges**, **people reviewing what goes live**, and **fixed purposes** for every output.

## Datasets

A dataset is a configured, versioned collection drawn from one or more registered sources for a declared purpose.

| Field | Meaning |
|---|---|
| Subject | `companies`, `licences_permits`, `court_cases`, `debts_tax_arrears`, `procurement_notices`, `events`, `articles`, `people` |
| Sources | Registered sources (with their own licence, robots and terms checks) |
| Purpose | One sentence, shown in the privacy notice where personal data is involved |
| Legal basis | `statutory_public_register`, `open_licence`, `contract`, `consent`, `legitimate_interest_assessed`, `public_professional_data` |
| Personal data | Present? Natural persons included? Categories (`name`, `professional_role`, `licence_number`, `business_contact`, `court_party`, `debt_record`) |
| Impact assessment | Reference to a recorded assessment; **required** for court, debt and people datasets |
| Retention | Class and days; records older than retention are deleted by the refresh pipeline and tombstoned |
| Outputs | Where results may go (below) |
| Public display | Whether any field is shown publicly |
| Subject notice | Whether subjects are informed and can reply or object |
| Refresh schedule | Link to a schedule |
| Status | `proposed → in_review → active → paused → retired`; activation by a person, with a **second person** when personal data is present (`pipelines.activate_personal_data_dataset`) |

### Rules by subject (enforced by the contract)

| Subject | US example (candidates) | Samarkand example | Rules |
|---|---|---|---|
| Companies | State business entity registers (Secretary of State searches or bulk data where offered), SAM.gov entity registrations (UEI, entity name, status) | Tax committee legal-entity status (candidate) | Field-level provenance; records arrive as **sourced**; identifiers never upgrade a badge |
| Licences and permits | State contractor licensing boards (for example the California CSLB licence look-up, the Texas TDLR licence data for trades it licenses), local building permit open data where cities publish it | Licensing authority register (pack facet, pending) | Natural persons often appear (sole proprietors): personal data flags apply; outputs typically verification evidence and matching eligibility |
| Court cases | Federal and state court records where lawfully accessible | Court portal where lawful | Impact assessment required. About **companies**: may appear as sourced facts with date and source link only if the hub's legal review enables display. About **natural persons**: never displayed, only reviewed verification evidence (`DatasetSchema` refinement) |
| Debts and tax arrears | State tax lien or delinquency lists where published | Published arrears lists where they exist | Same as court cases |
| Procurement notices | SAM.gov contract opportunities, state procurement portals | National e-procurement portal (candidate) | Become opportunities on the needs board labelled "public procurement notice"; the engine never submits bids |
| Events | Association and manufacturer event calendars | Regional events | Become **sourced events** labelled as such, never presented as hosted on the hub |
| Articles | Trade media, regulators | Same | Go to the editorial office as items, never directly to publications |
| People | Only `consent` or `public_professional_data` | Same | **Never creates public profiles.** Used to verify claims a person makes about themselves, and to suggest linking a person's own account when they confirm |

**Reputation is not an output.** No dataset feeds reputation scores: reputation changes only through evidence decisions and method releases ([execution and reputation](../execution-and-reputation.md)). A court case or a lien can become **evidence** in a trust reviewer's case, with the same appeal rights as any evidence.

## Outputs and how they feed the hub

| Output | Feeds | How |
|---|---|---|
| `directory_sourced_records` | Company directory | Import batch → review → activation by the data steward; each field shows its source and date; link proposals for matches |
| `verification_evidence` | Verification recipes and claims | Register matches, licence status and expiry become **evidence records** a trust reviewer uses; badges show categories, never documents ([Hub administration](../hub-administration.md#counterparty-verification)) |
| `matching_eligibility` | Matching and plan-step recommendations | Only company status and licence validity, as hard-eligibility facts ("licence valid: passed / failed / unknown") with their date |
| `opportunities_board` | Needs board | Procurement notices as labelled opportunities |
| `events_calendar` | Events | Sourced events labelled with their source |
| `knowledge_base` | Search and cited answers | Indexed with licence flags; answered with citations |
| `news_desk` | Editorial office | Items in the review queue |

Every output goes through the receiving module's use cases; data mining never writes another module's tables.

## Entity resolution: links, never merges

When a mined record seems to describe something the hub already knows (a company, a person, a peer's replica), the `entity_resolution` pipeline creates a **link proposal** (`LinkProposalSchema`) with evidence and a confidence between 0 and 1:

| Evidence kind | Example |
|---|---|
| `identifier_match` | Same EIN, same STIR, same UEI |
| `name_address_similarity` | Name and address normalised, transliteration variants, score |
| `register_officer_match` | Claimant's name matches an officer in the register |
| `signed_statement` | An administrator of both records signed a statement |
| `subject_confirmation` | The person confirmed both records are theirs |
| `peer_link` | A federation peer proposed the link |

The data steward accepts or rejects; the effect is always `link` (the contract has no merge). Links involving **people** require the person's own confirmation or a signed statement. The canonical display uses the record with the strongest claim status and shows provenance per field ([Federation](../federation.md#entity-links-never-merges)). Canonical entities, cited fields, page assembly and the entity review screen (link, split, mark distinct) are designed in [Discovery, sourced pages, claims and outreach](../discovery-and-outreach.md#2-entity-resolution-and-confidence).

## Review queues

| Queue | Who | Decides |
|---|---|---|
| Dataset proposals | Compliance officer, data steward | Legal basis, purpose, retention, outputs; activation (second person for personal data) |
| Import batches | Data steward | Activate, reject or split a batch; counts of new, changed, conflicting and skipped records |
| Link proposals | Data steward | Accept or reject each link |
| Conflicts | Data steward | When a sourced field conflicts with a claimed field, the claimed value stands and the conflict is shown to the company |
| Subject objections | Privacy officer | Objections and corrections from subjects of personal data |

## Refresh schedules

Each dataset names a schedule ([automation](automation-and-scheduling.md)): daily for procurement notices, weekly for licence boards, monthly for business registers, for example. A refresh re-checks expiries (a licence that expired downgrades the eligibility fact and triggers a re-check in the verification recipe), applies retention, and emits tombstones for removed records to indexes and peers.

## Acceptance (when implemented)

- A court or debt dataset about natural persons cannot be configured for display or for any output other than verification evidence.
- A people dataset cannot use a basis other than consent or public professional data, and never creates a public profile.
- No dataset can name reputation as an output.
- Accepting a link never merges records; links with people need their confirmation.
- Records past retention are deleted and tombstoned by the next refresh.
