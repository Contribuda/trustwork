# Jurisdiction authority (HUB-005)

Status: **implemented domain boundary and isolated adapters; package not accepted**. No production policy or deployment. All shipped country policies remain `UNKNOWN`. The architecture direction in ADR 022 was accepted by the conductor in [the maintainer decision](https://github.com/Contribuda/trustwork/pull/445#issuecomment-6552887365); PR #472 records that decision in the ADR. Architecture acceptance does not approve legal facts or counsel text.

## Source and legal authority

`JurisdictionSourceSchema` adds an optional, explicitly reviewed executable record to country agent-law facts. It requires jurisdiction and ancestors, effective dates, action applicability, a mandatory/advisory classification for every area, liability and consent identities, retention intervals, immutable source content digests and counsel evidence. Empty requirements are explicit reviewed statements. The reader never interprets prose, `recordYears`, a preferred country, locale or an address as executable law. Existing country files and verification assertions are unchanged.

`jurisdictionEvidence.importSource` and `attestApplicability` are owner-module maintenance ports. API users, staff commands and workers cannot call them or write/read their tables. The importing domain must establish reviewed applicability evidence, including its validity interval; an account's address alone is not such evidence. No automatic importer or country default is enabled. Immutable records and monotonic head revisions prevent a source/applicability round trip from reviving an old binding.

A configuration version binds exact source ID, digest and head revision. Disclosure, liability, consent and legal text identities bind immutable `agent_jurisdiction` legal document versions in every current hub language, their body digests and counsel approval IDs. Existing legal draft, counsel and second-person activation commands remain authoritative. Locale keys alone never count as legal approval. A replacement legal version invalidates a binding to its superseded predecessor.

## Database activation

Migration `20261108100000_jurisdiction_authority.sql` is additive. It creates five forced-RLS authority tables, validators, activation/profile triggers, a staff preflight, a narrow participant projection and a worker composition command. No existing migration is edited or renamed.

The existing `hubs_activate_config` keeps its permission, elevation, exact-digest second person, single-use approval and audit behavior. The new trigger enforces source and legal bindings for every writer, including a maintenance writer with a consumed approval. A v1 agent policy cannot activate, and once agent settings exist a legacy payload cannot remove them. Existing restriction-only hubs can still use HUB-001's add-only restricted-place domain.

Mandatory rules cannot be weakened: same-currency thresholds use integer comparisons; consent identities accumulate; retention intervals intersect; liability identities have no invented ordering. No FX or natural-language exception is inferred. Advisory rules are explicitly classified, never silently missing. Missing applicable actions refuse execution.

Policy/source/applicability/legal/profile writes and authority reads share a transaction advisory lock. Volatile validators read fresh `READ COMMITTED` snapshots after waiting; other isolation modes refuse. This conservative node-wide lock favors correctness over throughput and must never enclose provider I/O. Language, source and second-person approval races are tested in both lock orders with real PostgreSQL lock observation.

## Runtime boundary

`jurisdictionAuthority.limits` accepts a quote ID and action only. It checks the actual seller permission, derives both parties and the project from the stored quote/RFQ, and requires current reviewed applicability for the acting person, both parties and the project. It expands reviewed ancestors and combines every applicable policy. Project/quote/RFQ revisions, applicability evidence/head revisions, exact configuration versions, source revisions and languages contribute to the binding. Public visibility, staff scope and a process hub default grant no access.

The projection returns restrictive limits, safe reason codes, configuration IDs/digests and the authoritative project hub. It omits party geography, source text, counsel identity, private project content and full configuration. A missing or conflicting source yields `UNKNOWN`, never a human override.

`intent-adapter.ts` composes the actual assistant `decide` and `actionIntents.record` APIs. It hashes the jurisdiction binding into the immutable action digest and persists an append-only binding; SQL recomputes that digest. Above-limit actions become real proposed intents even under a permissive confirmed mandate. A human-only rule refuses automated execution. Required consent identities also refuse execution until a typed, purpose/action-specific consent evidence adapter exists; a generic legal acceptance or action approval is not silently treated as that consent. Explicit synthetic no-consent rules exercise the positive machinery only.

`requireCurrentJurisdiction` rechecks within the API action transaction. `jurisdictionWorker.beginAttempt` verifies the exact live job lease/fencing token, current party authority and the policy binding, then composes the existing `assistant_begin_attempt` in the same transaction. A changed/unavailable policy revokes before an attempt exists. No provider is called by these adapters or tests.

## Exact remaining integration seams

1. After the active LLM worker merges, the conductor must wire `recordJurisdictionIntent` into the assistant proposal path for supported quote actions, call `requireCurrentJurisdiction` before consuming an approval/effect, and replace the dispatch handler's `assistantWorker.beginAttempt` call with `jurisdictionWorker.beginAttempt(intentId, job.id, job.fencingToken)` using the actual leased token. The existing service, ports, models, billing and worker handler files were not edited here. Old unbound intents must remain refused through this path; do not silently backfill them.
2. The domain owners must connect reviewed applicability evidence to their real attestation workflows and add authoritative resolvers for actions/contexts beyond quotes with a project. Missing attestations and unsupported contexts remain unavailable. The concrete adapter currently supports `send_quote` only; other existing mandate actions need their owning domain resolver and tests. No action vocabulary is extended.
3. A typed consent receipt/revocation port must bind purpose, action, parties and exact legal versions before consent-bearing rules can execute. Retention enforcement and presenting the bound legal disclosures remain the owning domains' obligations; the projection alone does not perform those effects.
4. Registered API/worker acceptance, domain permission and policy-change tests on the integrated LLM head, plus full exact-head CI and maintainer acceptance, are still required. AGT-022 and HUBC-007 dependencies stay closed. There is no UI in this repair.

## Verification

`tests/hubs/jurisdiction` uses embedded PostgreSQL with restricted API and worker logins, real hub/legal/approval commands, real projects/RFQs/invitations/quotes, confirmed mandates and durable intents. Fixtures are explicitly synthetic and establish no country's legal readiness. Source, approval and language races observe actual waiting database transactions. The module access inventory and schema mirror are registered without editing shared inline lists. Exact commands, counts and head are recorded in draft PR #405 and the conductor result report.

## Typed consent continuation

The registered `/v1/jurisdiction-consents/quotes/:quoteId` API returns only the authenticated affected person's current public counsel notice, with all configured languages. Granting binds the exact notice digest, purpose, action, person, quote actor, policy binding and immutable legal versions; revocation is a separate immutable fact. Generic legal acceptance, profile consent and action approval cannot substitute. Key-only policies and company consent without a separately scoped mandate remain unavailable. The current implementation supports personal buyer/seller quotes only. No real country consent scope is seeded.

The authority lock has a three-second acquisition timeout. Current session and identity epoch are checked after domain waits; row locks serialize the check against actual session and epoch updates. Transactions contain no provider I/O. Receipt storage does not define a retention duration or execute erasure/legal-hold policy; that remains an owning privacy authority integration. There is no receipt-history listing.

This is engineering groundwork, not complete HUB-005 acceptance. Registered assistant/dispatch integration awaits the conductor's allocation after AGT-003 merges; OUTR-002 has no runtime; broader owning applicability and company consent remain unavailable. No UI or native language/accessibility acceptance is claimed.
