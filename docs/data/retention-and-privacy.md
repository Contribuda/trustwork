# Retention, legal basis and privacy operations

**Status: Proposed (2026-10-31).** This document fixes how the [data model](model.md) classifies data, how long each class is kept, which legal-basis fields records carry, how a subject access export is composed and how erasure propagates to indexes, caches, peers and backups. It is an engineering design, not legal advice: retention periods, legal bases and deadlines are **country pack facts** and **hub decisions** reviewed by the operator's counsel (open decisions [O06 and O13](../product/open-decisions.md)). No compliance claim is made for any jurisdiction until a pack maintainer adds sourced facts and a hub's counsel approves its configuration.

Owner decision 2026-10-31: the reference deployment is a **United States** hub, so the worked example below is the US (federal rules plus state privacy laws such as CCPA/CPRA). Uzbekistan, Georgia, Armenia and Azerbaijan remain examples of other countries; the same mechanism serves any country without code changes.

## 1. Data classes

Every field belongs to one data class. The class decides the projection layers that may carry it, whether it may leave the node, which model routes may receive it and how erasure treats it. Classes extend the classification in [security](../quality/security.md#data-classification-and-retention) and the retrieval `DataClassSchema`.

| Data class | Examples | Layers | May leave the node | Model egress (default) |
|---|---|---|---|---|
| `public` | Published publications, public profiles, public company facts, released issues, public events, public projections of projects, open needs, reputation snapshots, certificate check records | P | Yes, under the federation data licence | Allowed per `model_route` |
| `public_sourced` | Records and items imported from sources (company registers, manufacturer sites, news feeds) | P with "from sources" label | Only if the source licence allows syndication | Only if the source allows `model_egress` |
| `shared_confidential` | RFQ and quote versions, agreements, obligations, shared milestones, threads, consultation bookings, task offers, execution evidence | S | Only to the nodes of the parties of that deal | `deal_party_private` route only |
| `party_private` | Budget ceilings, floor prices, margins, negotiation notes, agreement private records, task offer floors | PP | Never | Never by default |
| `personal_private` | Drafts, preferences, reading progress, bookmarks, enrollment and progress, conversation turns, private plans, diaries, saved answers | O | Only in the subject's own export | `person_private` route only, if the hub allows |
| `company_private` | Company internal notes, billing settings, company mandates, representative activity | O (members with permission) | Never | `company_private` route only |
| `restricted` | Credential hashes, token hashes, provider secrets references, payment and payout references, identity evidence, verification evidence, screening results | — or SC with exclusion | Never | Never |
| `operational` | Jobs, outbox, deliveries, receipts, admission leases, idempotency records | — | Never | Never |
| `audit` | Domain audit, admin audit, access log, revocation events, erasure ledger | SC (auditor) | Never | Never |
| `derived` | Projections, chunks, embeddings, recommendation sets, match runs, replicas | Inherit the intersection of their sources | Follows the sources | Follows the sources |

Rules: a record never mixes classes in one column; derived records carry the intersection of their sources' audiences; `staff_case` reads always exclude `negotiation_private`, `credentials` and `payment_refs` (`ALWAYS_EXCLUDED_FIELD_CLASSES`).

## 2. Retention classes

Every entity in the dictionary names one retention class. A class has an engine default, a **country pack hook** (the statutory or recommended period, with sources) and a **hub setting** inside the pack's bounds (`retention_policy.min_period`/`max_period`). The sweeper or the erasure executor acts when the period ends; a `legal_hold` suspends both.

| Class | Clock starts | Engine default | Pack hook (`facets.privacy.retention.*`) | End-of-life method |
|---|---|---|---|---|
| `ephemeral` | expiry or consumption | delete 7 days after | — | hard delete by sweeper |
| `session` | revocation or expiry | delete 90 days after | `session_logs` | hard delete by sweeper |
| `operational` | completion | delete 30 days after (dedupe receipts: at least the provider's replay window) | — | hard delete by sweeper |
| `account` | account closure or erasure | kept while the account exists | `account_after_closure` | delete or redact on closure plus the hub period |
| `published` | retraction, unpublication or erasure | kept while published | `media_archive` | tombstone; body removed; explanatory record kept for retractions |
| `commercial` | agreement end or RFQ/quote closure | 6 years | `commercial_records` (US example: per state statute of limitations for written contracts, often 4–10 years) | redact personal fields; keep accepted terms and digests |
| `accounting` | fiscal year end | 7 years | `accounting_records` (US example: IRS guidance commonly 3–7 years; state sales tax records per state) | redact personal fields after the period; ledger totals kept |
| `evidence` | last use by an open dispute, review window or reputation method window | method window + dispute and appeal periods | `construction_documents` (US example: state statutes of repose for construction defects, often 6–12 years) | redact or delete; assertion chain keeps digests and categories |
| `verification` | result expiry | expiry + 1 recheck cycle | `kyc_records`, `screening_records` | delete evidence; keep result category and date |
| `consent_proof` | withdrawal or end of processing | limitation period after last reliance | `consent_proof` | delete after the period |
| `case` | case closure | 3 years | `support_records` | redact; keep outcome category |
| `audit_long` | event time | 7 years | `audit_long` | delete after the period, sequence anchor kept |
| `audit_standard` | event time | 1 year | `audit_standard` | delete after the period, sequence anchor kept |
| `conversation` | turn time | 30 days unless the person keeps it | `assistant_conversations` | hard delete |
| `derived` | source change | follows sources | — | rebuilt or deleted with sources; tombstones block resurrection |
| `tombstone` | creation | kept while any backup or peer could resurrect the data | — | minimal metadata only, no content |
| `config` | supersession | kept for the hub's lifetime (history explains past decisions) | — | archived with the hub |

US figures above are **illustrative ranges** for the worked example, not facts; a `us` pack maintainer replaces them with sourced values per state.

### Country pack hook

Pack v2 (`facets.privacy`) gains a `retention` map and a `rights` map. Shape (proposed, values illustrative):

```json
{
  "privacy": {
    "retention": {
      "accounting_records": { "min": "P7Y", "max": null, "scope": "US", "sources": ["…"], "verification": "pending" },
      "commercial_records": { "min": "P4Y", "max": null, "scope": "US-CA", "sources": ["…"], "verification": "pending" },
      "construction_documents": { "min": "P10Y", "max": null, "scope": "US-CA", "sources": ["…"], "verification": "pending" }
    },
    "rights": [
      {
        "scope": "US-CA",
        "law": "CCPA as amended by CPRA",
        "rights": ["know", "delete", "correct", "portability", "opt_out_sale_share", "limit_sensitive_use", "non_discrimination"],
        "responseDeadline": "P45D",
        "extension": "P45D",
        "optOutSignals": ["global_privacy_control"],
        "authorizedAgents": true,
        "retentionDisclosureRequired": true,
        "dataBrokerRegistration": { "required": true, "authority": "…" },
        "sources": ["…"],
        "verification": "pending"
      }
    ],
    "breachNotification": [{ "scope": "US-CA", "authority": "…", "deadline": "…", "sources": [] }],
    "dataResidency": null,
    "minors": { "ageThreshold": null, "sources": [] }
  }
}
```

Scopes are jurisdiction codes, so a US pack carries one rights entry per state with a comprehensive privacy law, and the engine applies the entry for the subject's jurisdiction when known and the hub's strictest configured entry otherwise. The same keys hold Uzbekistan's data-residency rule (`dataResidency: { scope: "UZ", personalDataOfCitizens: "in_country" }`) or any other country's facts.

## 3. Legal basis fields

Every record that holds personal data **from a source other than the person themself**, and every processing that needs a basis beyond the contract with the user, carries legal-basis fields:

| Field | Type | Meaning |
|---|---|---|
| `legal_basis` | `enum(contract\|consent\|legitimate_interest\|legal_obligation\|vital_interest\|public_task\|publicly_available\|other_statutory)` | Neutral vocabulary; the pack maps local law to it |
| `basis_ref` | `uuid NULL` | `consent_record`, `legal_document_version`, `counsel_approval` or `legitimate_interest_assessment` reference |
| `purpose` | `text` (purpose code from hub config) | Why the data is processed (for example `company_directory`, `verification`, `event_registration`) |
| `notice_version_id` | `uuid NULL` | Privacy notice (or US notice at collection) version shown at collection |
| `collected_from` | `enum(subject\|counterparty\|source\|provider\|staff)` | Provenance class |
| `sensitive` | `bool` | Sensitive personal information under the applicable pack (for example precise geolocation, government identifiers) |
| `sale_or_share` | `bool` | Whether the processing would be a "sale" or "sharing" under the applicable law; the engine sets it `false` and refuses features that would make it `true` |

Records that carry these fields: `source`, `dataset`, `source_item`, `sourced_record_field` (people data), `verification_provider`, `verification_check`, `screening_result`, `registration` (event data shared with organizers), `consent_record`, `message` (inbound from non-users), `match_candidate` for sourced people, `model_route` (egress basis), `peering_agreement` (licence basis), `crawl_policy` (terms and robots basis).

## 4. Subject rights and the US worked example

| Right (neutral) | US state examples | Engine mechanism |
|---|---|---|
| Know / access | CCPA right to know | `privacy_request(kind=access)` → export (section 5) |
| Portability | CCPA portability | Same export in machine-readable JSON |
| Correction | CPRA right to correct | `privacy_request(kind=rectification)` → module commands; corrections of evidence append, never rewrite |
| Deletion | CCPA right to delete | `privacy_request(kind=erasure)` → erasure (section 6) with statutory exceptions recorded |
| Opt out of sale or sharing | CCPA/CPRA "Do Not Sell or Share" | `privacy_preference.opt_out_sale_share`; the engine never sells or shares for cross-context advertising; the flag still exists, is honoured and is shown |
| Limit use of sensitive information | CPRA | `privacy_preference.limit_sensitive_use`; sensitive fields limited to the purposes the pack lists |
| Opt-out preference signals | Global Privacy Control under CCPA regulations and other states | Request header recorded as `privacy_preference.source = gpc_signal`, `gpc_honoured_at` |
| Authorized agents | CCPA | `privacy_request.authorized_agent_ref` with proof |
| Non-discrimination | CCPA | No feature, price, ranking or reputation reads privacy preferences |
| Appeal of a denied request | Several state laws | `privacy_request(kind=appeal)` decided by a different person |
| Retention disclosure | CPRA notice at collection | `retention_policy.disclosure_text_key` rendered per category in the notice at collection |
| Data broker registration | California, Vermont, Texas, Oregon data broker laws | `data_broker_registration` per state when counsel decides that importing people data from sources makes the hub a data broker; people-directory sources stay off until decided |

Deadlines come from `rights[].responseDeadline` (for example 45 days plus a 45-day extension in the California example); `privacy_request.due_at` is computed at receipt and the console shows countdowns. Identity verification of requesters uses the existing login or, for non-users found in sources, a verification proportional to the data held, recorded as a `verification_check`.

## 5. Export composition (access and portability)

An export is composed by the privacy module asking every module's **exporter port** for the subject's data through the same projection serializers as API reads. The export is a ZIP of JSON files plus a manifest; each file lists entities, the projection used and a digest.

| Module | Included (subject's own layers) | Excluded |
|---|---|---|
| identity | person, profile, preferences, e-mail bindings, provider identities (provider and subject only), sessions (`SessionView`), consent records, legal acceptances, memberships | password hash, token hashes, login failure rows |
| projects | owned projects (O), participations (S as the subject sees them), plans, plan items, diaries authored | other parties' private records, other invitees |
| content | authored publications and versions, comments, follows, bookmarks, reading progress | editors' internal notes on others' work |
| events and learning | registrations, tickets, check-ins, meeting requests the subject sent or received, enrollments, progress, attempts, certificates | other attendees' data, organizers' private notes |
| matching, consultations, tasks | capability profile, open needs, introductions (own side), consultation requests and bookings, task requests and offers sent by the subject, mentoring relationships | other offerors' offers, counterparties' private constraints, match candidates computed for others |
| commerce | RFQs, quotes, agreements in the subject's S and PP layers | the counterparty's PP layer (budget, floors, plans) |
| trust | assertions, confirmations, reviews written and received (S/P), timeliness observations about the subject, passport, issued credentials | reviewers' identities where the hub policy hides them and the law allows |
| assistant | mandates and revisions, goals, runs and action intents (O), conversation turns still retained, assistant notes, saved answers | model provider internals; no chain-of-thought exists |
| channels | threads the subject participates in, messages they sent or received, notification history, channel grants (without credentials) | messages in threads the subject cannot see |
| billing | billing accounts the subject owns, invoices, payments (provider references masked), budgets and reservations they own | full payment instrument data (never stored) |
| platform-admin | support cases the subject opened, privacy requests, moderation decisions about the subject, access log entries for staff reads of the subject's data where the law allows | internal staff notes, other subjects, security-sensitive detection details |

The export is stored as an `evidence_artifact` with class `restricted`, delivered through a signed URL with a short TTL, deleted after `ephemeral` retention, and its manifest digest is recorded on the `privacy_export`.

## 6. Erasure propagation

Erasure is decided by the privacy officer and **executed by two people** (A+2 action `privacy.execute_erasure`). The executor writes the `erasure_ledger` first, then calls each module's erasure port inside the same orchestrated job with fencing; unknown outcomes reconcile.

| Target | Method |
|---|---|
| Account-class records (profile, preferences, follows, progress, conversation, notes, drafts) | Hard delete |
| Published content authored by the subject | Unpublish and tombstone; credit replaced by "former participant" when the publication is editorial or co-authored and the law allows keeping it |
| Shared commercial records other parties rely on (sent quotes, agreements, acceptance events, obligations) | **Redact** personal fields (names, contact details, free-text notes); keep ids, amounts, digests and timestamps; mark `redacted_at`; the digest still proves what was agreed but is no longer recomputable |
| Evidence and assertions | Redact personal content; keep categories, digests and dates while the evidence class lasts |
| Reviews written by the subject | Remove text and author link; exclude from future snapshots; recompute affected snapshots |
| Accounting records | Pseudonymize the person reference; keep amounts until the accounting period ends |
| Audit and access logs | Keep (legal obligation) with the person id; never exported to third parties |
| Consent proofs | Keep until the consent-proof period ends |
| Derived retrieval data | `retrieval_tombstone` written in the same transaction as the ledger entry; chunks, embeddings, lexical rows, answer dependencies and saved answers deleted by the indexer; tainted generations retire |
| Caches and decisions | Bump `authz_epoch` of the subject and affected companies; policy caches miss; admission scopes revoked |
| Notifications and outbox | Pending notifications to or about the subject cancelled; outbox payloads carry ids only |
| Federation | `federation_tombstone` (reason `erased`) to every peer holding replicas; `tombstone_application` tracks acknowledgement within the agreement period (default 72 hours); `federated_identity_link` revoked |
| Issued credentials | Revoked in the status list; the holder's copies stop verifying |
| Provider-held copies | Deletion request through each adapter that received the data (mail, model, verification providers) under their retention contracts; outcome reconciled |
| Backups | Not edited. The `erasure_ledger` lives outside the restorable snapshot; every restore replays the ledger (and the retrieval and federation tombstones) **before** serving traffic, as rehearsed in restore drills ([runbook](../operations/runbook.md)) |

**Exceptions** are explicit and recorded on the request: active `legal_hold`, statutory retention (accounting, commercial records, construction documents under the pack), open disputes, security and fraud prevention, and other parties' rights to the shared record. The subject is told which exception applies when the law allows. Hashes are never claimed to anonymize personal data.

## 7. Special cases

- **Sourced people data.** People found in sources (company officers, authors of imported items) are not users. Their data enters only through sources with a recorded legal basis and stays out of public people directories without consent; they can still exercise rights through a `privacy_request` with `subject_identifier_hash`.
- **Manufacturer and supplier crawls.** Only through `website_crawl` sources whose `crawl_policy` allows it; personal data on such pages (named staff, contact persons) is not imported unless the source purpose and legal basis cover it.
- **Knowledge sharing.** Knowledge items derived from projects need the owner's consent and each named participant's consent or anonymization; withdrawal unpublishes or re-anonymizes.
- **Minors.** Policy open (O06); the engine targets professionals and stores no age data by default.
- **No employee surveillance.** Learning progress, reading, assistant use and timeliness observations are never exposed to employers; there are no per-person behaviour analytics.
- **Data residency.** Where a pack requires in-country storage (Uzbekistan example), the hub's privacy configuration routes storage and blocks model routes and peers outside the jurisdiction for personal data classes.
