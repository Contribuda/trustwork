# BILL-003 continuation: concrete engineering proposal

Agent: Codex CLI (OpenAI) for Parshkov.
Baseline: `fe3e58a19dbfff4ecc21b2faee7ecccd797e1653`, branch `work/BILL-003/continuation`.
Status: P1 allocated by conductor on 2026-11-01; P2-P5 proposed for conductor engineering review; BILL-003 remains in_progress. No new operational prices, legal text, provider activation or cross-domain mutations are authorized by this document.

## P1. Additive public coverage projection for the allocated screen

Current `packages/contracts/src/billing-fees.ts` exposes `PublicPricing { hubId, fees, prices, unavailable }`. Fee rows already carry exact hub, version, digest, kind/category, payer, currency, percentage/fixed minor amount, effective interval and acceptance-text version. Price rows carry id/version/kind/code/currency/amountMinor/effectiveFrom/effectiveTo/validity and an optional plan id/version. They do not carry a public display name, acceptance-text reference, meter, plan quotas or conditions.

`FeesService.publicPricing` in `apps/api/src/modules/billing/fees/fees.service.ts` currently marks empty fees/plans as unavailable. `feePricingReaders.hubAvailable` and `publishedPlans` in `packages/data/src/repositories/billing-fees.ts`, plus `catalogue.publishedPrices` in `packages/data/src/repositories/billing.ts`, are actual owning readers. Missing model/capability/credit validity readers are different from empty results. One rejected reader currently discards the whole response. A closed hub yields the same empty arrays as a functioning empty catalogue.

Proposed exact optional addition to `PublicPricingSchema`, retaining all existing fields:

```ts
coverage?: {
  generatedAt: string; // RFC3339 UTC, owning API clock
  sections: {
    fees: 'available' | 'unavailable' | 'error';
    plans: 'available' | 'unavailable' | 'error';
    services: 'available' | 'unavailable' | 'error';
    models: 'available' | 'unavailable' | 'error';
    capabilities: 'available' | 'unavailable' | 'error';
    credit_packs: 'available' | 'unavailable' | 'error';
  };
}
```

`available` is produced only after a functioning authorized reader succeeds, including zero rows. Current/future/expired classification uses the projection time and half-open intervals, never array emptiness or language. Missing readers remain unavailable; errors are explicit and successful sibling sections survive. No configured or publicly available serving hub returns `hubId: null` and unavailable coverage. A failure to determine hub availability fails the request, without publishing rows. Older responses without coverage are conservatively partial/unavailable, never complete or authoritative empty. A complete state is representable and testable with synthetic reader results, but is not reachable with today's missing readers. Sponsorship has no public offer/policy reader and is visibly disabled, not inferred from general configuration. Ticket/course fee rows may exist without ticket/course booking APIs; publishing such fee terms does not imply booking availability.

Additional proposed optional public price disclosure fields, all copied only from existing owning records:

```ts
disclosure?: {
  offerId: string;
  name: string; // existing offer.name, not a generated translation
  acceptanceTextVersion: string;
  plan: null | {
    payerKind: 'person' | 'company';
    moduleKeys: string[];
    includedQuota: { moduleKey: string; meter: string; units: string; window: string }[];
    connections: number;
    channels: number;
    representativeIncluded: boolean;
  };
}
```

No digest is invented for BILL-001 price rows: their existing schema does not define one. Plan payloads must parse the owning `SubscriptionPlanVersionSchema` and match row id/version/offer/price and active status before projection. Unknown period, price unit, overage, refund/cancellation/renewal terms and tax/provider total remain explicitly unknown. There is no purchase action on this read-only page. Existing `catalogue.offer` and `catalogue.planVersion` can supply the narrow allowlist in the fee service without changes to foreign storage. Runtime principal, approval, provider cost and payer-private records never enter this projection.

Requested P1 allocation: `packages/contracts/src/billing-fees.ts` only, plus already allocated fee API, localized pricing route, seven pricing dictionaries, narrow DataPort consumer and fee tests. No hub console frozen vocabulary change, migration, root config, new dependency or other worker file. If only coverage is approved, display names/plan content remain honestly unavailable.

## P2. Actual task/RFQ source and commercial category mapping

Actual task source: `task_request_version.payload.stepTerms` and `requiredSkills` are optional shared taxonomy fields (`packages/contracts/src/tasks.ts`, `TaskRequestPayloadSchema`); `task_request` pins `plan_version_id` and `plan_item_key` (`packages/data/src/schema/tasks.ts`). These are not one unambiguous commercial fee category. `billing_task_scope` in applied `packages/data/migrations/billing/20261111100003_task_fees.sql` currently creates `fee_kind='task', category_key=NULL`. The page's taxonomy labels in `pricing/categories.ts` are presentation only.

Actual RFQ category: `ConvertNeedCommandSchema.rfq.category` and `SetRfqProjectionCommandSchema.category` in `packages/contracts/src/commerce.ts` are nullable free text, stored on mutable `rfq.category` (`packages/data/src/schema/commerce.ts`), outside the immutable `rfq_version.payload`. It cannot silently become digest-bound fee authority. Frozen `MarketplaceFeeKindSchema` in `packages/contracts/src/hub.ts` permits only consultation/task/ticket/course.

Minimal proposed source: a fee-owned immutable `commercial_category_assignment` referencing the actual source kind/id/version/digest, an explicit commercial category registry version/key, owning actor, source hub and assignment reason. The owning source publication command must validate the selected category against an independently activated hub mapping version. A display label, first taxonomy tag, mutable RFQ category or free text cannot choose it. Missing or ambiguous mapping refuses category-specific charging; generic task fees retain their explicit NULL scope only where the existing contract permits it. Existing immutable RFQ/task payloads and digests stay byte-identical; a new publication pins the relation before offers/commitments consume it. Exact registry/mapping shape and any generic RFQ policy require conductor contract review, not activation of operational rates.

Allocation requested after review: fee-owned mapping contract/repository/additive migration and narrow source-publication seams in procurement/tasks, with owners coordinated explicitly. Do not modify applied SQL. Introduce an explicit marketplace fee kind only through frozen-contract review; never relabel RFQ goods/services as task fees.

## P3. Actual model/capability/credit sale versions

`catalogue.publishedPrices` supplies active public plan/service/module price records; `feePricingReaders.publishedPlans` supplies active plan/price pairs. `SubscriptionPlanVersionSchema` in `packages/contracts/src/agent-catalog.ts` defines included quota and capacity; `MeterRateVersionSchema` defines meter/provider-class prices but no exact model revision/capability sale identity. `apps/api/src/modules/models/README.md` describes fake execution and private accounting, not a public participant-price authority. No current model or credit-pack validity reader exists on this baseline. Pending AGT PR385 is not imported; capability governance is not sale-price authority.

Propose extending BILL-owned price scope with an immutable reference to a real released model revision or capability/manifest version and meter/unit, reusing existing price activation rather than provider cost. Add credit-pack terms linked to the actual price version: units, unit currency/type, published validity/expiry and advance-notice/refund policy version. A separate activation validates the exact owning identities and published terms. Implement public allowlists in their owning service, then compose them into P1. No AGT004 runtime must be invented merely to store and publish an approved sale version; actual metered execution must consume those same versions when allocated. Conductor chooses exact contract/storage owner after checking actual merged AGT seams. Operational price amounts and real legal terms remain operator/counsel decisions.

## P4. Existing commerce command integration, both hubs

Actual consumers: `TransactionsService.acceptTerms`, `placeOrder`, `sellerAccept` and `decideChange` in `apps/api/src/modules/transactions/transactions.service.ts`, exposed by `transactions.controller.ts` at POST `/v1/agreements`, `/v1/agreements/:id/orders`, `/v1/agreements/:id/accept`, and order-change commands. They already validate RFQ/quote digests, current resource/mandate authority, electronic-record consent, screening and budget reservations. Existing consultation/task adapters live under `apps/api/src/modules/billing/fees/`; `bookingFees.disclose/confirm/bind` is in `packages/data/src/repositories/billing-fees.ts`.

Propose a fee-owned RFQ adapter consumed by these real commands, after P2 resolves category and the owning creation paths record authoritative source hubs. Add a resource-authorized disclosure endpoint for the exact sent quote/current RFQ pair; explicit fee confirmation remains separate from electronic-record consent. Both parties see both hub snapshots before confirmation. Buyer confirmation and seller confirmation bind their own local fee and the disclosed counterparty fee to the actual agreement/source digests in the owning transaction. Changes require fresh disclosure/confirmation for the new immutable versions. No body can choose a home hub, payer, destination or consent. Both source/hub bindings must be verified from the actual source records; no company address or current default is a historical substitute.

Reuse exact destination guards, ordered fee/domain locks, append-only bindings, current-role/elevation/expiry checks and the migration-time-only legacy snapshot discipline. Budget/mandate gross and net bounds include the appropriate fee; never expose private floors/ceilings. Test both serialization orders for authority changes and acceptance, exact wrong-source/destination/hub negatives, no consumed confirmation/audit on denial, crash rollback and single consumption. Own-participant obligations may feed PAY/BILL002 only through their approved seam; binding is not a charge, provider acknowledgement is not settlement and unknown outcomes keep the same operation. No PAY files touched without named allocation.

Remote FED transport is currently absent and is not a circular prerequisite to two real configured hubs on one database. Signed remote ingestion remains uncovered until its owner exists. EVT/LRN have no owning booking runtime on this baseline; their absence must be recorded, not replaced by fake acceptance paths.

## P5. Referral terms, independent activation

The actual permission/action vocabulary in `packages/contracts/src/hub.ts` has fee activation but no `growth.activate_referral_terms`. `docs/engine/hub-operating-company.md` proposes that action, roles and GROW contracts; those proposals cannot grant authority to this worker or product agents.

Minimal proposal: a separate BILL-owned immutable referral-programme terms version, programme key/hub, effective interval, public localized terms, eligibility and exact reward definition, legal-policy reference, digest, drafter and independent activator. A dedicated human-only permission and second-person action bind that exact digest and hub, using existing scoped assignments/elevations/approval expiry and concurrency synchronization. Do not reuse the fee activation action or permit operator-agent activation. Public reader discloses activated effective terms; absent/disabled is explicit. This can be built independently of TEAM/GROW staffing and without reward execution. New rewards, cash/credit activation and actual programme legal text are operator decisions; engine versioning/permissions are conductor engineering allocations. No new schema or migration is implemented until approval.

## Original five-step matrix

| Original step | Current evidence | Remaining work / planned proof |
|---|---|---|
| 1. Versioned marketplace_fee_version, category, dates, no overlaps | Merged fee SQL and `tests/billing/fees/authority.test.ts` | Preserve regressions; P2 needed for actual task/RFQ commercial mapping |
| 2. Second-person activation/audit; acceptance pins shown version | Merged fee commands, consultation/task adapters and binding guards | P4 actual RFQ/order-change coverage; no fabricated absent bookings |
| 3. Accepted BIZ public price page and payment neutrality | BIZ PR509 merged; allocated continuation presentation | P1 explicit coverage; seven locales, 375/768/1280, actual API/browser, axe/keyboard |
| 4. Ranking/matching/recommendation/reputation comparisons | Existing neutrality tests over actual directory/comparison/reputation | Preserve tests; absent matching/recommendation runtime remains unproven |
| 5. Active agent plans/model/capability/credit versions and validity | Existing public plan/service reader | P3 missing owning sale and credit-term readers, not provider cost |

## Original seven-criterion matrix

| Criterion | Baseline status, not new acceptance | Continuation boundary |
|---|---|---|
| 1. Drafter cannot activate | Implemented in merged SQL and negative/race suites | Re-run focused security regressions on actual tested source |
| 2. Every booking/acceptance records disclosed version | Partial: real consultations/tasks only | P2/P4; absent EVT/LRN remain explicitly uncovered |
| 3. Every active public version in every hub language | Partial existing reader/page | Allocated BIZ screen and P1; full missing reader coverage not claimed |
| 4. Plans/model/capability/credit packs tested | Partial plan/service pairs | P3; unavailable never becomes empty or free |
| 5. No ranking/matching/recommendation/reputation influence | Strict schema and actual existing runtime comparisons | Preserve; future runtime comparison remains pending |
| 6. Both hubs disclose; charge only own participant | Partial two configured hubs, consultation/task bindings | P4 commerce; billing binding is not payment; remote federation unproven |
| 7. Referral terms versioned/public/second-person/neutral | Not implemented | P5 independent terms/governance; no proposed TEAM/GROW permission assumed |

## Review boundary

P1 is the smallest contract allocation needed for honest complete/partial/confirmed-empty/reader-error evidence. Presentation and exact money formatting can proceed independently against the existing response with conservative unknown states. P2-P5 are proposed engineering work, not requests for an operational price decision. Root alone accepts/allocates, readies, reviews, queues and merges. All prior security regressions and historical evidence remain preserved; the legacy adapter correction pending in AGT385 must wait for actual merge.

## P2-P5 source and contract refinement after P1 allocation

Rechecked against actual merged `109d028c00399082b5dbafc1b22e71026bf464ca`. No new authority below is implemented or allocated by this proposal.

| Slice | Exact minimal next contract/storage proposal | Actual consumer and authority boundary |
|---|---|---|
| P2 task mapping | `FeeCategoryMappingVersion { id, hubId, version, sourceKind, sourceTaxonomyVersion, sourceKey, commercialCategoryKey, effectiveFrom, effectiveTo, digest }` plus an independently activated row. `SourceFeeCategory { sourceKind, sourceVersionId, sourceDigest, sourceHubId, mappingVersionId, commercialCategoryKey }` is immutable and unique by source version. Source keys alone never authorize a mapping. | `TasksService` request publication pins the selection; the existing task fee scope adapter consumes it. Existing `TaskRequestPayloadSchema.stepTerms/requiredSkills` may be absent/multiple and cannot silently choose one category. No applied task digest rewrite. |
| P2 RFQ mapping | Same source relation for the immutable RFQ version, with a new reviewed commercial fee-kind contract (the four existing frozen kinds remain unchanged until that review). No mapping directly from mutable `rfq.category`. | `ProcurementService.convertNeed` and `publish` in `apps/api/src/modules/procurement/procurement.service.ts` create/publish the actual source. `rfqs.setProjection` in `packages/data/src/repositories/commerce.ts` only edits discoverability/category; it is not a publication or fee authority. |
| P3 sale identity | `PriceSaleScope { priceVersionId, kind, modelRevisionRef OR capabilityManifestRef, meter, unit }`, immutable and unique per price version; exact owning released identifiers must validate at activation. `CreditPackTerms { priceVersionId, version, units, unit, validFor OR expiresAt, policyVersion, acceptanceTextVersion, digest }` requires an independently activated published policy reference. | `PinnedCandidateSchema` in `packages/contracts/src/models.ts` pins executable provider/model revision, not a participant price. `MeterRateVersionSchema` is meter/provider-class billing. Reuse `catalogue.draftPriceVersion/activatePriceVersion` and introduce only the scoped owning BILL reader/activation validator. Actual credit consumption must later pin these terms; publication alone is not execution acceptance. |
| P4 home/source provenance | Immutable relation of source kind/version/id/digest to the server-derived serving hub at creation/publication; quote provenance is independently captured at its owning sent version. Neither `RfqTable` nor `QuoteVersionTable` currently stores these fee-home hubs. | Agreement/order rows in `packages/data/src/schema/transactions.ts` pin RFQ/quote ids/digests but not participant fee-home hubs. Never infer historical provenance from addresses, a process default or a body. Unknown old provenance needs an exact migration-time disposition, not timestamps/backfill exemption. |
| P4 confirmation commands | Proposed resource-authorized `POST /v1/billing/fees/quote-versions/:id/disclosures`; optional `feeConfirmation` becomes required only for the newly governed source subset in existing acceptance commands. Scope includes exact RFQ+quote versions, both authoritative hubs and local side. Existing agreement digest remains byte-identical; append-only bindings pin fee digests. | `TransactionsService.acceptTerms` checks buyer `accept`, exact current RFQ/sent quote and explicit electronic-record consent; `placeOrder` checks `commit_order` and currently rejects non-null `platformBudgetId` as `no_platform_charge`; `sellerAccept` requires the placed order; `decideChange` recomputes immutable terms and delta reservation. Those are exact integration points, not permission to silently begin charging. Proposed platform-budget/local-obligation semantics require coordinated BILL/PAY/transaction ownership. |
| P5 referral authority | `ReferralTermsVersion { id, hubId, programmeKey, version, effectiveFrom, effectiveTo, eligibility, rewardDefinition, publicTerms, legalPolicyRef, digest }`; immutable lifecycle metadata and independent activation. Proposed new permission `admin.billing.referrals.draft/activate` and exact second-person action `billing.activate_referral_terms`, human-only and hub-scoped. Names are proposals, not existing permissions. | `packages/contracts/src/hub.ts` frozen permission/action lists and the current admin scoped/elevated command framework need explicit allocation. `growth.activate_referral_terms` is proposed in operating-company designs, not executable authority. Public disclosure and versioning can be delivered independently of TEAM/GROW agents; reward issuance remains a separate owned consumer. |

Conductor choices needed for engineering: accepted fee-kind extension/source mapping semantics, exact storage/path owners and migration numbers, provenance capture seams, the BILL/PAY platform-budget boundary, and frozen referral action names. These are not operational-rate or provider gates. Actual programme legal eligibility/reward values, monetary rates and activation are later operator/legal decisions and are not required to write safe versioning/governance code. Current fee and booking guards must stay enforced through both serialization orders while these seams are added.

P1 approval source: conductor handoff `tools/BILL003-public-coverage-allocation.md` (2026-11-01T10:09Z). P1 does not authorize the P2-P5 contracts above. The five-step/seven-criterion matrices remain in_progress until all original criteria pass root review.
