# Jurisdiction authority (HUB-005)

Status: **implemented domain boundary and isolated adapters; package not accepted**. No production policy or deployment. All shipped country policies remain `UNKNOWN`. The architecture direction in ADR 022 was accepted by the conductor in [the maintainer decision](https://github.com/Contribuda/trustwork/pull/445#issuecomment-6552887365); PR #472 records that decision in the ADR. Architecture acceptance does not approve legal facts or counsel text.

## Source and legal authority

`JurisdictionSourceSchema` adds an optional, explicitly reviewed executable record to country agent-law facts. It requires jurisdiction and ancestors, effective dates, action applicability, a mandatory/advisory classification for every area, liability and consent identities, retention intervals, immutable source content digests and counsel evidence. Empty requirements are explicit reviewed statements. The reader never interprets prose, `recordYears`, a preferred country, locale or an address as executable law. Existing country files and verification assertions are unchanged.

`jurisdictionEvidence.importSource` and `attestApplicability` are owner-module maintenance ports. API users, staff commands and workers cannot call them or write/read their tables. The importing domain must establish reviewed applicability evidence, including its validity interval; an account's address alone is not such evidence. No automatic importer or country default is enabled. Immutable records and monotonic head revisions prevent a source/applicability round trip from reviving an old binding.

A configuration version binds exact source ID, digest and head revision. Disclosure, liability, consent and legal text identities bind immutable `agent_jurisdiction` legal document versions in every current hub language, their body digests and counsel approval IDs. Existing legal draft, counsel and second-person activation commands remain authoritative. Locale keys alone never count as legal approval. A replacement legal version invalidates a binding to its superseded predecessor.

## Database activation

The applied foundation migration `20261108100000_jurisdiction_authority.sql` is preserved unchanged. It creates five forced-RLS authority tables, validators, activation/profile triggers, a staff preflight, a narrow participant projection and a worker composition command. No existing migration is edited or renamed.

The existing `hubs_activate_config` keeps its permission, elevation, exact-digest second person, single-use approval and audit behavior. The new trigger enforces source and legal bindings for every writer, including a maintenance writer with a consumed approval. A v1 agent policy cannot activate, and once agent settings exist a legacy payload cannot remove them. Existing restriction-only hubs can still use HUB-001's add-only restricted-place domain.

Mandatory rules cannot be weakened: same-currency thresholds use integer comparisons; consent identities accumulate; retention intervals intersect; liability identities have no invented ordering. No FX or natural-language exception is inferred. Advisory rules are explicitly classified, never silently missing. Missing applicable actions refuse execution.

Policy/source/applicability/legal/profile writes and authority reads share a transaction advisory lock. Volatile validators read fresh `READ COMMITTED` snapshots after waiting; other isolation modes refuse. This conservative node-wide lock favors correctness over throughput and must never enclose provider I/O. Language, source and second-person approval races are tested in both lock orders with real PostgreSQL lock observation.

Executable jurisdiction configuration activation also receives the resolved request session through HUB-001's existing registered endpoint. Its narrow database wrapper locks the domain/version/approval, validates current exact session/epoch/role/elevation, invokes the original activation authority, and validates again after its waits. Other configuration domains retain their database activation rules. Tests cover both competing-connection orders for role, elevation and epoch changes; API language-completeness fixtures cover all seven configured engine languages with explicitly synthetic text.

## Runtime boundary

`jurisdictionAuthority.limits` accepts a quote ID and action only. It checks the actual seller permission, derives both parties and the project from the stored quote/RFQ, and requires current reviewed applicability for the acting person, both parties and the project. It expands reviewed ancestors and combines every applicable policy. Project/quote/RFQ revisions, applicability evidence/head revisions, exact configuration versions, source revisions and languages contribute to the binding. Public visibility, staff scope and a process hub default grant no access.

The projection returns restrictive limits, safe reason codes, configuration IDs/digests and the authoritative project hub. It omits party geography, source text, counsel identity, private project content and full configuration. A missing or conflicting source yields `UNKNOWN`, never a human override.

`intent-adapter.ts` composes the actual assistant `decide` and `actionIntents.record` APIs. It hashes the jurisdiction binding into the immutable action digest and persists an append-only binding; SQL recomputes that digest. Above-limit actions become real proposed intents even under a permissive confirmed mandate. A human-only rule refuses automated execution. Required consent refuses execution unless the current typed purpose/action/affected-person notice has an unrevoked exact receipt. Key-only legacy policies remain unavailable. Generic legal acceptance, profile consent and action approval never satisfy that gate. Positive country-law fixtures remain explicitly synthetic.

`requireCurrentJurisdiction` rechecks within the API action transaction. `jurisdictionWorker.beginAttempt` verifies the exact live job lease/fencing token, current party authority and the policy binding, then composes the existing `assistant_begin_attempt` in the same transaction. A changed/unavailable policy revokes before an attempt exists. No provider is called by these adapters or tests.

## Exact remaining integration seams

1. After the active AGT-003 worker merges and the conductor allocates the exact files, wire `recordJurisdictionIntent` into the assistant proposal path for supported quote actions, call `requireCurrentJurisdiction` before consuming an approval/effect, and replace the dispatch handler's `assistantWorker.beginAttempt` call with `jurisdictionWorker.beginAttempt(intentId, job.id, job.fencingToken)` using the actual leased token. The existing service, ports, models, billing and worker handler files were not edited here. Old unbound intents must remain refused through this path; do not silently backfill them.
2. The synthetic authenticated HUB source below now supplies the staged-evidence workflow. Operational legal producers and authoritative resolvers beyond supported quote contexts remain separate work. Missing attestations and unsupported contexts remain unavailable. The concrete adapter currently supports `send_quote` only; other existing mandate actions need their owning domain resolver and tests. No action vocabulary is extended.
3. The typed personal-party receipt/revocation API is implemented. A separately valid structured company-consent mandate, participant UI, owning retention/legal-hold execution and an actual OUTR-002 immutable template/runtime consumer remain absent. No unconsumed port completes these integrations.
4. Registered API/worker acceptance, domain permission and policy-change tests on the integrated LLM head, plus full exact-head CI and maintainer acceptance, are still required. AGT-022 and HUBC-007 dependencies stay closed. There is no UI in this repair.

## Verification

`tests/hubs/jurisdiction` uses embedded PostgreSQL with restricted API and worker logins, real hub/legal/approval commands, real projects/RFQs/invitations/quotes, confirmed mandates and durable intents. Fixtures are explicitly synthetic and establish no country's legal readiness. Source, approval and language races observe actual waiting database transactions. The module access inventory and schema mirror are registered without editing shared inline lists. PR #405 is the merged historical foundation. Current commands, counts and head are recorded separately in draft PR #511 and the conductor consent result report.

## Typed consent continuation

The registered `/v1/jurisdiction-consents/quotes/:quoteId` API returns only the authenticated affected person's current public counsel notice, with all configured languages. Granting binds the exact notice digest, purpose, action, person, quote actor, policy binding and immutable legal versions; revocation is a separate immutable fact. Generic legal acceptance, profile consent and action approval cannot substitute. Key-only policies and company consent without a separately scoped mandate remain unavailable. The current implementation supports personal buyer/seller quotes only. No real country consent scope is seeded.

The consent and applicability APIs disable `PrincipalService.runAs` stale-epoch refresh. The shared hub configuration activation command does the same before its immutable version determines the domain; it never retries under a refreshed request identity. The opt-out is additive and unrelated modules retain the existing default. Registered API regressions change the epoch after authentication and prove a conflict, unchanged RequestState and no command callback execution. This request boundary supplements the post-wait database checks.

The authority lock has a three-second acquisition timeout. Current session and identity epoch are checked after domain waits; row locks serialize the check against actual session and epoch updates. Transactions contain no provider I/O. Receipt storage does not define a retention duration or execute erasure/legal-hold policy; that remains an owning privacy authority integration. There is no receipt-history listing.

This is engineering groundwork, not complete HUB-005 acceptance. Registered assistant/dispatch integration awaits the conductor's allocation after AGT-003 merges; OUTR-002 has no runtime; broader owning applicability and company consent remain unavailable. No UI or native language/accessibility acceptance is claimed.

### Owning applicability review and source inventory

The registered `/v1/admin/jurisdiction-applicability` commands propose and independently activate an exact immutable evidence row staged by `jurisdictionEvidence.stageApplicability`. Only the maintenance/domain importer can stage evidence; HTTP cannot supply a hub, jurisdiction, subject, company or location. The two reviewers bind the evidence digest and current-head revision. Activation rechecks the exact recorded sessions, identity epochs, elevations and role assignments, including the proposer, after domain waits. An older head, a different approver session or replacement role cannot revive a stale review. The pre-existing trusted maintenance import remains available to owning modules; it is not an HTTP attestation path.

| Owning source | Current engineering result |
| --- | --- |
| Quote, published RFQ and project | The `send_quote` resolver derives actor, buyer, seller and project from stored owning rows and pins their revisions. Concrete rows are locked; caller scope is ignored. |
| Imported reviewed applicability evidence | Immutable staged records now have real two-person review/activation commands and current heads. Tests use explicitly synthetic importer evidence. |
| Person/company geography and project location | No registered immutable legal-applicability producer exists. Profile country, company address and mutable `project_location` are not converted into law. Missing reviewed evidence remains unavailable. |
| Other action contexts | No authoritative complete party/project resolver is registered; they remain unavailable. |
| Company consent | No separately scoped company-consent mandate contract/producer is registered. Ordinary action mandates and membership permissions do not substitute. |

### OUTR-002 handoff port

`jurisdictionDisclosure.current` loads only the current source-validated policy's public immutable counsel disclosure in every configured language, under an exact current elevated staff session. `validateJurisdictionTemplate` intersects that bundle with an owning immutable template port, requiring every language and locked operator, assistant, source, page, correction/removal and unsubscribe blocks. It binds the exact policy and template digests and refuses missing or edited disclosure.

OUTR-002 has no runtime or immutable template producer on this branch. The port is unconsumed, does not create an active template and proves neither campaign activation nor sending. Existing strict outreach remains unchanged. COMMS/MAIL/PRV implementations are untouched. No retention duration, legal hold execution or provider configuration is invented.

## Administration audit and current-authority conflicts

Applicability proposal and activation call the existing DATA-002 `admin_record` owning function in the same transaction as the immutable HUB decision, the current-head update, a minimal outbox event and API idempotency completion. Actor, permission, elevation and hub come from current staff authority and stored evidence, never a request override. Snapshot selection preserves ADM's non-break-glass role preference; the audit uses that exact locked assignment rather than resolving an alternate grant. The required reason and server request ID accompany the audit; the outbox uses that request ID for correlation and contains only the opaque review ID. It is not a public notification or a personal-consent notice.

The proposal audit hashes the exact inserted review row. Activation hashes the exact review, activation and current-head row images before and after the decision. Only those digests reach the shared audit. Source jurisdiction, affected person, legal evidence, stored authority snapshots and personal consent documents are not copied into audit/outbox payloads. The independent HUB review is not represented as a fabricated ADM `second_person_approval`; the existing immutable two-person checks remain authoritative. Audit readers retain the existing ADM scope/RLS rules.

Real inverse-order tests reproduced cycles against `admin_revoke_role` (assignment before elevation) and `second_factor_reset_execute` (elevation before session). HUB current-authority checks now acquire person, session, elevation and exact assignment/definition row locks with `NOWAIT`, and refuse a conflicting transaction with `hubs.authority_busy` / HTTP 409. The shared audit counter also uses conflict refusal. No automatic retry, session replacement or epoch refresh occurs; after-domain-wait `clock_timestamp()` expiry checks remain. The global jurisdiction lock retains its bounded three-second wait. This does not change the owning identity/admin revokers or claim an integrated AGT lock-order proof.

The disclosure port is not a registered console command or a private evidence reader: it returns only active, public counsel text in a launched hub, under current scoped staff authority. ADM's `AccessLogEntry` requires a real case grant for sensitive reads; this port has neither such a read nor an invented grant. Consent preview/grant/revocation remain personal operations with their own private immutable evidence. Policy configuration activation continues to use the original HUB-001/ADM audit inside its transaction.

Registered AGT/OUTR integration remains unavailable. In particular the unmerged 22 worker wrapper still invokes the obsolete three-argument assistant overload; reconcile it only after the actual AGT-003 PR385 merge and an allocated minimal integrated API/worker change. Do not add a compatibility overload or infer an origin. The later integration must preserve both `refreshStale: false` and PRV snapshot plumbing.


## Authenticated synthetic owning source

The additive 22 source migrations provide an actual HUB-owned producer: `importJurisdictionProof` verifies bounded Ed25519 envelopes against an independently activated immutable issuer registration and the installed verifier/contract digests. Runtime API and worker roles cannot call the importer, insert or read private source records, or substitute a verified-result callback. The database owner remains the installation trust root. No operational issuer, key, grant or legal fact is seeded. Normalized law/rule imports remain maintenance-only and synthetic; no production legal producer is claimed.

The signed record includes exact issuer/key/version, audience and origin hub, subject revision/identity epoch/digest, quote/RFQ/project context digest, complete jurisdiction coverage, competence and source-specific independence evidence, engine-subject linkage evidence and a bounded validity interval. An address, screening residence, signature alone or reviewer approval does not prove legal applicability. Source import atomically stages existing evidence and its immutable origin; independent human applicability activation remains a separate decision. Legacy global heads remain auditable but cannot authorize v2 consumption.

Synthetic authority also binds the actual current HUB modes version/digest with `dataMode=demo`. The owning modes lock serializes reads against real mode activation; absence, live mode, a replacement version or a return to demo invalidates old proofs. Modes authority remains HUB001's existing permission contract. Synthetic visibility fixtures that bypass lifecycle gates for public legal documents never establish operational launch acceptance.

| Command | Exact opt-in permission | Result |
| --- | --- | --- |
| `POST /v1/admin/jurisdiction-sources/issuers` | `admin.jurisdiction.issuers.propose` | Immutable scoped registration proposal |
| `POST /v1/admin/jurisdiction-sources/issuers/:id/activate` | `admin.jurisdiction.issuers.activate` | Distinct current human activates exact digest/version |
| `POST /v1/admin/jurisdiction-sources/:kind/:id/revoke` | `admin.jurisdiction.sources.revoke` | Immediate immutable issuer/source revocation |

These capabilities must be present in an explicitly released scoped role; generic staff, existing applicability-review roles and participant mandates do not imply them. No production role is upgraded. Both proposer and activator remain bound to their original current authority. Source-specific independence evidence is explicit; no blanket third-human rule is invented. Every command has atomic shared ADM digest audit, opaque correlated outbox and BE005 completion/crash replay.

Consumption requires the scoped hub/subject/action/context head and its authentic, unexpired, current origin. Source or issuer replacement/revocation, contradictions, identity epochs, owner revisions and post-wait expiry refuse with a safe unknown projection. Both revocation orders and real mode changes are tested on PostgreSQL. Source records and legal evidence never enter participant projections or shared audit/outbox payloads. The three new source commands and producer do not add a registered assistant dispatch integration; actual AGT385 integration remains separately allocated.
