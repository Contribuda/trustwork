# Concepts and glossary

The engine uses a small set of words precisely. When a document, a contract or a test uses one of these words, it means exactly this.

## The shape of the network

| Term | Meaning |
|---|---|
| **Engine** | Trustwork, the free software in this repository. |
| **Node** | One independently operated installation of the engine: its own database, web origin, operator and signing key. |
| **Hub** | A community served by a node for a **territory**: a country, a region inside it, or a city. A node may host several hubs. See [Hubs](hubs.md). |
| **Territory** | What a hub serves, as ISO 3166-1 / 3166-2 codes and optional named places. Descriptive and never exclusive: a country hub and a city hub can overlap. |
| **Hub operator** | The organisation or person who develops the platform for a territory and is responsible for its legal compliance. See [Hub administration](hub-administration.md). |
| **Mesh** | All nodes that federate with each other. See [Federation](federation.md). |
| **Home node** | The node where an object was created; the only node that can change it. Other nodes hold read-only replicas. |
| **Country pack** | Reviewed, sourced data about a country (identifiers, regions, currency, languages, legal facts) in `packages/country-packs/packs/<cc>.json`. See [Country specifics](country-specifics.md). |
| **Hub configuration** | Operator decisions stored in the database and versioned: enabled sources, verification providers, legal document versions, taxonomy extensions, policies. |
| **Restricted place** | A country or region under sanctions where nothing is built, hosted, served or federated. The list lives in code and cannot be changed from an admin screen. |
| **Brand overlay** | A deployment's own name, lettering and strings on top of the neutral engine (`apps/web/brand`). |

## People and organisations

| Term | Meaning |
|---|---|
| **Person** | One human, one lifelong identity. Profiles, publications and authorship survive changes of employer. |
| **Company** | An organisation with a page, people, catalogue, projects and reputation. |
| **Membership** | A person's employment link to a company. One active ordinary employer at a time; history is kept. |
| **Capability preference** | What a person wants to do (read, publish, buy, sell). Preferences are not roles and confer no rights. |
| **Sourced / claimed / verified** | A company record taken from a licensed public source; a record someone asserted control of; a record whose claim was confirmed with documentary evidence. Always shown distinctly. |
| **Principal** | Whoever is acting right now: a person, or a person's agent acting under a mandate. |

## Access and visibility

| Term | Meaning |
|---|---|
| **Participation** | A row that joins a resource (project, RFQ, quote, agreement, order, thread, publication) to a party with capabilities, side, audience and validity. |
| **Capability** | One of fifteen fixed verbs: `read.public`, `read.shared`, `read.party_private`, `read.owner_private`, `write.draft`, `publish`, `invite`, `negotiate`, `accept`, `commit_order`, `manage_participants`, `transfer_ownership`, `lead`, `export`, `staff.case_read`. |
| **Projection** | A fixed allowlist of fields for one audience. Five layers: `public`, `shared_party`, `party_private`, `owner_private`, `staff_case`. Every API read, search hit, export, notification and federation envelope goes through the same serializer. |
| **Disclosure rule** | If you are not allowed to know that something exists, you get "not found", never "forbidden". |
| **Case access grant** | The only way staff can see a customer's private object: scoped, at most 72 hours, approved by a second person, every read logged. |

## Content

| Term | Meaning |
|---|---|
| **Publication** | One store for news, articles, posts and announcements; personal, company or editorial authorship. |
| **Publication version** | An immutable edition of a publication. Corrections create new versions with a visible note. |
| **Wall** | A personal or company page section that references publication versions; never a copy. |
| **Issue** | A numbered, dated magazine edition that freezes an ordered list of publication versions. |
| **Source** | Where a news item or a directory fact came from, with licence, observed time and allowed uses. |

## Commerce

| Term | Meaning |
|---|---|
| **Need** | An intake of what someone wants, possibly vague, before it becomes a request. |
| **RFQ** | A request for quotes. Its published versions are immutable. |
| **Quote** | A seller's answer to one RFQ version, with immutable sent versions. |
| **Stale** | A quote pinned to an RFQ version that has since been amended. A flag, never a status. |
| **Digest** | `trustwork-digest-1`: SHA-256 over the RFC 8785 canonical bytes of a payload. Binds versions, acceptances and approvals. |
| **Agreement** | Accepted terms pinned by digest to exact quote and RFQ versions; buyer acceptance and seller acceptance are separate events. |
| **Order** | A commitment under an agreement, possible only with authority and a budget reservation. |
| **Catalogue offering** | A reusable, versioned description of goods, works or services. Changing the catalogue never changes a sent quote. |
| **Introduction** | A double-opt-in connection between two parties proposed by a person, an agent or the matching engine. See [Partners and matching](partners-and-matching.md). |

## Agents and authority

| Term | Meaning |
|---|---|
| **Your agent** | The single assistant that works for a person. Same thing as "the assistant"; there is no list of agents. |
| **Company representative** | A company's single standing agent, with a named accountable person, acting only under company mandates; suspends when no accountable person or confirmed mandate remains. |
| **Mandate** | A structured grant from a principal to their agent: allowed actions, contexts, limits, conditions, budgets, expiry, revision. Readable, changeable, revocable. |
| **Goal** | A proposed object that tells your agent what to achieve (for example "find three facade subcontractors in the Austin area before 1 December") with success criteria and allowed actions. |
| **Run** | One durable piece of agent work, made of steps with checkpoints. |
| **Action intent** | A proposed external effect with its digest, states and reservations. |
| **Approval** | A human decision bound to the exact action digest; any material change invalidates it. |
| **Budget** | A limit of money of one of two kinds: `transaction` (buying goods, works, services) or `platform` (paying the platform for generated deliverables). One never implies the other. |
| **Reservation** | Money set aside atomically for an action; settled or released only from evidence. |
| **Outcome unknown** | A provider call whose result is not known (timeout, crash). It keeps its reservation and goes to reconciliation; it is never retried blindly. |

## Trust

| Term | Meaning |
|---|---|
| **Assertion** | A claim that something happened (delivered, accepted, paid). Not a fact until confirmed. |
| **Evidence** | Files and records that support an assertion, with provenance. |
| **Dispute** | A challenge to an assertion; disputed observations are excluded or annotated in reputation until resolved. |
| **Reputation snapshot** | Scores per dimension (timing, quality, payment, cooperation, reviews) under a published method version, with sample counts and exclusions. |
| **Verification recipe** | A hub's configured set of checks (register lookup, licence lookup, sanctions screening, documents) that produce evidence types for a claim. See [Hub administration](hub-administration.md#counterparty-verification). |
