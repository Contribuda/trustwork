# ADR 026 — The discovery-to-claim engine in every country, and professional pages for people

Date: 2026-11-01. Status: **Accepted**.
- **Product goal:** set by the repository owner Dmitry Parshkov on 2026-11-01.
- **Rules:** decided by Claude, an AI agent acting as the Trustwork conductor, under the owner's delegation recorded in [ADR 025](025-owner-delegated-product-decisions-2026-11-01.md).
- **Amends:** ADR 025 decisions 11 and 12, and the people rules of [Discovery, sourced pages, claims and outreach](../engine/discovery-and-outreach.md#5-people-what-may-and-may-not-be-collected).
- Not legal advice.

## Context

The owner (2026-11-01, translated): "We must have a complete engine that can work in every country honestly and correctly. It must be able to find all companies, partners and people, prepare a personal page in our system for each of them, send invitations by the methods available, and give them the rights to run their page."

The designs cover this chain for companies:

| Step | Package |
|---|---|
| Lawful sources | SRC-001, SRC-002 |
| Datasets and entity resolution | MINE-001 |
| Register facts | REG-001 |
| Canonical entities and sourced page assembly | ENT-001 |
| Outreach | OUTR-001, OUTR-002 |
| Claims and verification | HUB-003, CLM-001 |

For **people** the chain stops early. The design rule "people datasets never create public profiles" (enforced by the `DatasetSchema` refinement of the data-mining contract) leaves natural persons only as staff-only business contacts. ADR 025 decisions 11 and 12, written earlier the same day, kept named contacts and sole-proprietor pages off engine-wide. Both block the owner's goal for people who work in the industry in their own name: licensed electricians, architects, engineers, sole traders.

## Decision

1. **The product goal is one engine for every country.** In every country, as far as that country's law allows, the engine:
   - finds companies, partners and professionals in lawful open sources: statutory registers, licence boards, open datasets, admitted websites, and datasets licensed to the hub with per-record provenance;
   - prepares one page for each, from cited facts only;
   - invites the subject by the channels that country allows;
   - hands management of the page to the subject through a claim.

   "Honestly and correctly" means the engine does exactly what the applicable law allows, and nothing where the law is unknown. The rules come from sourced country-pack facts and the hub's counsel-approved configuration, never from a global default.

2. **Professional pages for people.** A natural person may get a sourced page only when all of the following hold:
   - **Capacity:** the page is about the person's professional or business capacity (licensed trade or profession, sole proprietorship, registered professional).
   - **Source:** the facts come from a statutory public register or licence board that publishes that professional status, or from a dataset licensed to the hub whose record carries the person's consent or another recorded legal basis. A website mention, a social profile or an inference never suffices.
   - **Lawful basis:** the country pack's facts give a lawful basis for publication in the subject's jurisdiction and in the hub's, and the hub's configuration enables it for that jurisdiction with a counsel approval record and a second person (the ADR 017 mechanism, new hub configuration field `discovery.professionalPages`).
   - **Content:** the page shows register facts only: name as registered, trade or profession, licence or registration number and status with its date and source, and business locality at city level. It never shows a home address, a personal phone or e-mail, a photograph, an age or anything inferred.
   - **Notice and objection:** the page is labelled "Created from a public register; not confirmed by this person". It carries the notice required where data is not obtained from the person (GDPR article 14 and its equivalents) and a one-click objection. An objection removes the page and suppresses its re-creation on every hub of the node.

3. **Never.** These rules from the design stay unchanged:
   - no pages or contact for consumers, homeowners, or employees in non-public roles;
   - no sensitive categories, court or debt records about people;
   - officers and directors found in company registers serve only as claim evidence, never as pages.

4. **ADR 025 decisions 11 and 12 are amended.** Named business contacts and sole-proprietor pages are no longer off engine-wide. They are governed per jurisdiction by decision 2 and the outreach policy, and stay off in a hub until its counsel approves them for that jurisdiction. The US reference hub keeps them off until counsel answers the data-broker and article-14 questions.

5. **Invitations use the available methods.** For each recipient the outreach resolver allows only the channels that both jurisdictions permit for its recipient class. The engine floor of ADR 017 applies unchanged:
   - no consumer outreach;
   - no automated calls, AI voice, SMS or messengers without prior consent;
   - no contact forms or social messages;
   - identification in every message;
   - one-click opt-out;
   - at most three touches per purpose.

   An invitation link proves only access to the channel it was sent to.

6. **People claim their own page.** A person with a verified login claims a professional page with an identity tie:
   - a match against the licence board's own lookup;
   - a code sent to the business channel the register lists for that person;
   - or a reviewer's document check.

   After the claim the person may edit the descriptive fields, hide the page or delete it. Deletion suppresses re-creation. Disputes, cooling periods and audit follow the company claim rules.

7. **Countries without a pack.**
   - The generic country profile carries no lawful-basis facts, so the engine creates no people pages and sends no outreach there.
   - Company pages there come only from statutory registers whose terms allow reuse.
   - A contributed pack with sourced facts and counsel review unlocks more.

## Consequences

New work packages:
- **PPL-002** — sourced professional pages: a page kind, a contract change to the `DatasetSchema` refinement, and register-backed assembly with notice and objection.
- **CLM-002** — claims of professional pages by the person: identity ties, edit, hide or delete, disputes.

Packages and documents amended:
- **MINE-001, REG-001, ENT-001** — they treat professional records as a lawful subject only under decision 2.
- **OUTR-002** — invites only through the channels the resolver allows.
- **The design chapter** — its people rules point here.

The privacy invariant in AGENTS.md is untouched: private data never reaches other parties. Register facts that a statute publishes are public data, and the page shows nothing else.

No hub's configuration changes: every hub stays strict and without professional pages until counsel approves a jurisdiction.
