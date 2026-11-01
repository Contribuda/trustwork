# Sources module: hub source registry, import review and takedown (SRC-001)

The hub's information sources with their licence flags, legal basis and legal checks, the human review queue for imported items, takedowns with tombstones and the per-hub sponsored content policy ([News, articles and walls: hub sources](../../../../../docs/engine/publishing.md#hub-sources-proposed), [autonomous editorial office sections 1 and 2](../../../../../docs/engine/hub-console/autonomous-editorial.md), [data model section 24](../../../../../docs/data/model.md#24-hubs-sources-and-verification); ADR 010 decision 19, ADR 012 decision 3). Contracts: [`sources.ts`](../../../../../packages/contracts/src/sources.ts), additive to the console contract `hub.ts`, whose `AllowedUsesSchema`, `HubSourceSchema`, `RobotsCheckSchema`, `TermsCheckSchema` and `SponsoredContentPolicySchema` it reuses. Storage: [`packages/data/migrations/sources`](../../../../../packages/data/migrations/sources), [`repositories/sources.ts`](../../../../../packages/data/src/repositories/sources.ts).

Status: **Live** as an API (not deployed; no console screen, no crawler and no pipeline are wired yet). Tests: `tests/contracts/sources.test.ts`, `tests/sources/*` and `tests/backend/idempotency/cases/sources.ts`, on real PostgreSQL under the runtime role.

## Rules the database enforces

- **One licence model.** A source holds the console's nine `AllowedUses` flags (display headline and link, display summary, store full text, index, send to model providers, translate, rewrite with attribution, reuse images, syndicate to peers): the same flags CNT-001 checks before it publishes. A source without a licence (all rights reserved, unknown) holds only headline, link, summary and indexing; rewriting needs the stored text; a source with personal data names a legal basis.
- **RSL 1.0 as a suggestion.** `parseRsl` (contracts) reads a site's RSL document into a ceiling and a suggestion; the registry stores both, narrows the flags at once when the terms are stricter, and refuses flags above the ceiling unless a publisher agreement is on record. A document it cannot read (malformed, a DTD, another namespace, an unknown element or usage token, larger than 64 KiB) or one without a `content` entry for the URL gives the most restrictive flags. Licences needing payment, restricting users to non-commercial use or restricting geography do not count.
- **Crawling preconditions.** A sitemap or web-page source is active only with a robots.txt check that allows its URL (latest `crawl_policy`, RFC 9309 evaluation in `evaluateRobots`) and a terms check, recorded by a person, that permits automated access. A changed robots.txt or terms digest pauses an active source; resuming needs a fresher check.
- **Separation of duties.** The person who last set a source's terms never activates it (widening the flags of an active source sends it back to `proposed`); the person who staged a batch never activates it and never decides its items; the proposer of a record link never decides it.
- **No imported item is published without a person's decision.** Items arrive in staged batches with a licence snapshot; a second person activates the batch; only then does an editor (`admin.publications.review`) turn an item into a CNT-001 editorial news draft (created in the same transaction, citing the item with its effective flags) or discard it. Nothing in this module publishes; CNT-001's own four-eyes review follows.
- **Egress.** `sources_item_egress` is the only way an item leaves for a model provider or a peer; it uses the stricter of the item's snapshot and the source's current flags, so a display-only source never reaches either, and a later narrowing applies to old copies. The summary drafter port is called only after that check. `sources_peer_export` (worker) lists only items whose licence allows syndication.
- **Takedown.** Deactivates the source (or one item), its items and sourced record fields, redacts stored text, withdraws open batches and link proposals, writes retrieval and federation tombstones (federation `applyBy` 72 hours) with identifiers-only outbox events, and records the reason, in one transaction. Publications drafted from the items are named in the result for the editor-in-chief's CNT-001 retraction.
- **Sponsored content.** Off by default (no policy row); switching it on consumes a second person's `sponsored.enable` approval of exactly that version (digest `sponsoredPolicyDigestInput`, recomputed by the database). Sponsored items are labelled, shown only in `sources_sponsored_slot`, and never returned by `sources_recommendable_items`, the registry's only input for ranking, matching and plan recommendations. Verified sponsors need CLM-001, so a policy requiring them refuses sponsored items for now.
- **Provenance.** Sourced record fields become public only after their batch is activated and while the source allows display, labelled `sourced` (until the company claims the record, CLM-001). Field names never carry a score, rank, badge or weight.

The runtime role holds SELECT only on every registry table (FORCE RLS: staff holding a registry permission at the hub). Every write is a `sources_*` SECURITY DEFINER command that writes the `admin_audit_event` row in the same transaction; refusals of authority leave a `denied` audit row.

## Routes

All staff routes: session, staff role, live elevation (`ElevationGuard`), CSRF header, `Idempotency-Key` restated in the console command body with a reason (completed in the request transaction, BE-005). Errors use the contract envelope with the database reason in `details.reason`; the console explains it from the `sources` locale namespace (`sources.refusal.<reason>`).

| Route | Permission | Result |
|---|---|---|
| `GET /v1/admin/hubs/:hubId/sources` (`?status`), `GET .../sources/:sourceId` | any registry permission | Sources in the console `HubSource` form plus registry fields; crawl policy history |
| `POST .../sources` | `admin.sources.manage` | A `proposed` source |
| `POST .../sources/:sourceId/terms`, `.../terms-check` | `admin.sources.manage` | Licence, flags, attribution, legal basis; the person's terms-of-use check |
| `POST .../sources/:sourceId/robots-check`, `.../rsl-check` | `admin.sources.manage` | Fetch through the adapter port and record (nothing is recorded when the site does not answer) |
| `POST .../sources/:sourceId/status` | `admin.sources.manage` | Activate (another person), pause, resume, reject, retire |
| `POST .../sources/:sourceId/takedown`, `.../source-items/:itemId/takedown`, `GET .../source-takedowns/:id` | `admin.sources.takedown` | Takedown with tombstones |
| `POST .../sources/:sourceId/batches`, `GET .../import-batches`, `GET .../import-batches/:id`, `POST .../import-batches/:id/decide` | `admin.sources.manage`; `admin.sources.import.activate` | Stage a file-drop batch (items, fields, link proposals); a second person activates or rejects |
| `GET .../source-items/queue`, `GET .../source-items/:itemId`, `POST .../source-items/:itemId/decide`, `.../assisted-summary` | `admin.publications.review` | The review queue; draft (CNT-001 draft) or discard; a labelled machine-assisted summary suggestion |
| `GET/POST .../record-links`, `POST .../record-links/:id/decide` | `admin.links.decide` or `admin.sources.dedupe.decide` | Links, never merges |
| `GET/POST .../sponsored-policy` | `admin.sponsored.policy.edit` | Policy versions; switching on answers `pending_second_person` until approved through `/v1/admin/approvals` |
| `GET /v1/hubs/:hubId/sourced-records/:kind/:id/provenance`, `GET /v1/hubs/:hubId/sponsored-slot` | anyone | Public provenance ("from sources") and the labelled sponsored slot |

## Adapters

`ports.ts` defines `SourcePolicyFetcher` (robots.txt and RSL documents) and `SummaryDrafter` (a model-assisted summary). Only deterministic synthetic fakes exist (`FakeSourcePolicyFetcher` keyed by host label and file name, `FakeSummaryDrafter` recording its calls); no crawler, network call or model route is wired. Calls are bounded to 5 seconds and read-only, so repeating one after an unknown outcome has no side effect.

## Deviations and follow-ups

- Retrieval and federation tombstones are rows of this module (`source_tombstone`) with outbox events; the signed `FederationTombstoneSchema` and the retrieval deny ledger are emitted by their own packages when they exist (KEYS-001, federation, RAG).
- Pipelines (PIPE-001, EDIT-001) will stage batches as a pipeline run; today a staff member stages a file drop. Discovery proposals by pipelines use the `proposed_by_kind = 'pipeline'` columns already present.
- Publications drafted from a taken-down item are named, not retracted: retraction stays the editor-in-chief's CNT-001 decision.
- Sponsor verification (CLM-001) and the sponsored slot on web pages are follow-ups; the hub console screens HC-41, HC-42, HC-51 and HC-52 are HUBC packages.
- The contracts are imported directly (`packages/contracts/src/sources.ts`); adding them to the contracts barrel and the repository to the data package entry is integrator bookkeeping.
