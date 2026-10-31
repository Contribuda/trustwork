# Mesh protocol `trustwork-mesh/1`

Status: **Contract** (FED-000, 2026-10-31). Frozen as Zod contracts in [`packages/contracts/src/federation.ts`](../../packages/contracts/src/federation.ts) with conformance vectors in [`tests/federation/protocol/vectors`](../../tests/federation/protocol/vectors). No node implements it yet: node identity, peering and request signing are FED-001, syndication FED-002, links FED-003, cross-node deals FED-004, federated sign-in FED-005. Architecture: [ADR 011](../adr/011-federation-mesh.md). Narrative: [Federation: one worldwide mesh](federation.md). Requirements: [Federation mesh](modules/federation-mesh.md) (MSH-F01 to MSH-F20).

This document is written for implementers outside this repository. A node that follows it, and passes the vectors, can federate with any Trustwork node. The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Where this text and the Zod schemas disagree, the schemas win and this text is a bug.

## 1. Conventions

| Topic | Rule |
|---|---|
| Transport | HTTPS only, TLS 1.2 or later, to the node's DNS name on port 443. No transit: a node never forwards another node's deliveries. |
| Documents | UTF-8 JSON objects. Every object is strict: unknown members are refused, so a record cannot grow an address or a private field unnoticed. |
| Canonical JSON | RFC 8785 (JCS): keys sorted by UTF-16 code units, `JSON.stringify` escaping, no whitespace, finite numbers only. Strings are NFC-normalized at input, never during canonicalization. Money and quantities are strings. |
| Digest | `trustwork-digest-1`: lowercase hex SHA-256 of the UTF-8 bytes of the JCS form, written `{ "algorithm": "trustwork-digest-1", "value": "<64 hex>" }`. The same scheme binds quotes and agreements ([ADR 008](../adr/008-contracts-and-validation.md) decision 2). |
| Times | RFC 3339 UTC with a `Z` suffix (`2026-11-02T08:00:00.000Z`). |
| Binary | Keys and object signatures: base64url without padding. HTTP fields: RFC 8941 byte sequences (standard base64 between colons). |
| Signatures | Ed25519 (RFC 8032), pure, over the exact bytes defined below. |
| Errors | `{ protocol, code, message, requestId }` with an English machine code from section 17. No error ever echoes an address, a finding of the admission check or a private value. |

## 2. Node names and global identifiers

A **node** is named by its lowercase DNS name: no scheme, port, path or trailing dot, at least two labels. An IP literal is never a node name, so no record of this protocol can carry a network address in a node field.

Every federated object has a **global identifier**:

```text
trustwork://<node-host>/<kind>/<local-id>
```

`<kind>` is one of the object kinds of section 9 or `person`, `company`, `hub`, `tombstone`, `takedown_notice`, `link_proposal`, `moderation_report`. `<local-id>` is the home node's opaque identifier (`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`). The host of the identifier is the object's **home node**, its only writer. Identifiers are derived for routing and display and MUST NOT be parsed to authorize anything: authority comes from the home node's records.

## 3. Endpoints

| Endpoint | Method | Purpose | Signed |
|---|---|---|---|
| `/.well-known/trustwork/manifest.json` | GET | The node manifest (section 4) | Object signature inside the document |
| `/federation/v1/handshake` | POST | Start or refresh peering (section 7) | Request and response (section 6) |
| `/federation/v1/feeds/<stream>?after=<cursor>` | GET | Pull a page of public objects (section 12) | Request and response |
| `/federation/v1/inbox` | POST | Push one addressed delivery (section 13) | Request and response |
| `/federation/v1/objects/<global id>` | GET | Fetch one public object by identifier (URL-encoded) | Request and response |

Pull is the default. Push is used only for objects addressed to specific parties and for protocol notices.

## 4. The manifest

Served at `https://<node>/.well-known/trustwork/manifest.json`, signed with the node's current key (object signature, purpose `manifest`).

| Member | Content |
|---|---|
| `protocol` | Offered versions; MUST include `trustwork-mesh/1` |
| `node` | The node's DNS name |
| `engine` | `{ version, source }`: semantic version and the public source URL (AGPL-3.0-only) |
| `operator` | `{ name, country, registration, abuseContact, takedownContact }`: legal entity, ISO country of the entity, registration identifier kind and value or null, and `mailto:` or `https:` contacts of roles (never a person's private contact) |
| `jurisdiction` | ISO 3166-1 country or 3166-2 subdivision where the operator answers legally |
| `hubs` | `[{ id, territories, languages }]`; a territory is `US`, `US-TX` or a city inside a subdivision, `US-TX:austin` |
| `packs` | Country pack versions in use: `[{ country, version }]` |
| `licences` | One syndication term per data class (section 10) |
| `licenceConditions` | `attributionVisible`, `noResaleOfPersonalData`, `noModelTrainingOutsideGovernedRetrieval`, `neverPresentedAsLocal` (all `true`) and `tombstoneHours` (1 to 72) |
| `peeringPolicy` | `offered` levels, `secondApproverFor: ["deal_routing", "identity"]`, `agentEnvelopesPerHour` accepted per peer |
| `keys` | `{ current, chain }`: the key chain, oldest first (section 5) |
| `deploymentAttestation` | The operator's published deployment-location attestation summary (SANC-009: operator entity and hosting country and region, gate mode, statement digest, validity, `basis: "operator_statement"`). It is the operator's statement, never a verification. |
| `issuedAt` | When this manifest version was signed |
| `signature` | Object signature by the current key |

A receiving node MUST refuse a manifest, before any signature or peering work, when it declares a **restricted place** in `jurisdiction`, `operator.country`, any hub territory (the part before `:`), any pack country, or the attested operator-entity or hosting location, or when a hosting or entity location in a country restricted only by region (Ukraine) omits its region. A subdivision of a country restricted as a whole is restricted (`RU-MOW` is `RU`). The list is the engine's authoritative `restricted.json` (RU, UA-43, UA-40, UA-14, UA-09, CU, IR, KP at the time of writing); a node never keeps its own copy and nothing can allowlist a place ([ADR 014](../adr/014-sanctions-compliance-engine.md) decision 2). The contract enforces this in `nodeManifestSchema(restrictedPlaces(...))`; there is deliberately no list-free manifest schema.

A manifest MUST also publish only the default or a stricter term for every data class, a valid key chain, a signature by `keys.current` and unique hub identifiers.

## 5. Keys, rotation and compromise

Each chain entry is `{ keyId, algorithm: "ed25519", publicKey, validFrom, retiredAt, revocation, rotation }`:

- the first key has `rotation: null`; it is trusted on first use through the TLS-authenticated well-known URL and, where the operators want more, confirmed out of band;
- every later key carries `rotation: { previousKeyId, signature }`, where the previous key signs (purpose `key_rotation`) the statement `{ protocol, statement: "key_rotation", node, previousKeyId, nextKeyId, nextPublicKey, rotatedAt }` with `rotatedAt` equal to the next key's `validFrom`;
- a key retires exactly when its successor becomes valid (`retiredAt` of one equals `validFrom` of the next); the current key is the last entry and is not retired.

Selecting the key for a signature created at time `t` with label `keyId`: the key MUST exist, `validFrom <= t`, `t < retiredAt` when retired, and `t < revocation.compromisedSince` when revoked. Signatures made by a retired key before its retirement remain valid, so stored replicas keep verifying. When a key leaks, the operator rotates and publishes `revocation: { compromisedSince, revokedAt }` on the leaked key; every signature at or after `compromisedSince` is refused (`federation.key_revoked`). If a peer ever sees two different successors signed by the same previous key, it MUST stop accepting the node's new signatures and lower peering until its operator confirms the chain out of band.

## 6. Signatures

### 6.1 Object signatures

Manifests, envelopes, tombstones, takedown notices, forwarded reports, link proposals and link decisions carry a detached signature `{ algorithm: "ed25519", keyId, value }`. The signed bytes are:

```text
UTF-8( "trustwork-mesh/1" LF <purpose> LF JCS(document with signature = { algorithm, keyId }) )
```

The document is taken exactly as it travels with its `signature` member replaced by the algorithm and key label alone, so the key choice is signed too. There is no trailing newline. Purposes: `manifest`, `envelope`, `tombstone`, `takedown_notice`, `key_rotation`, `link_proposal`, `link_decision`, `moderation_report`. Because the purpose is part of the bytes, a signature for one document type never verifies as another. Object signatures let a replica be re-verified long after the HTTP exchange that carried it.

### 6.2 HTTP message signatures (RFC 9421)

Every request and every response of section 3 (except the public manifest GET, which MAY be unsigned at the HTTP layer) is signed under the label `tw`:

| Message | Covered components |
|---|---|
| Request with a body | `"@method" "@target-uri" "content-digest" "content-type"` |
| Request without a body | `"@method" "@target-uri"` |
| Response | `"@status" "content-digest" "content-type"` |

Parameters, in this order: `created`, `expires` (at most 300 seconds after `created`), `keyid` (the label in the sender's manifest), `alg="ed25519"`, `nonce` (required on requests with a body, base64url, 16 to 64 bytes) and `tag="trustwork-mesh/1"`. Bodies carry `Content-Digest: sha-256=:<base64>:` (RFC 9530) over the exact body bytes; senders SHOULD send the JCS form. Receivers MUST check the content digest, the coverage, the window, a clock skew of at most 60 seconds, the key selection rules of section 5 and the signature, and MUST remember `(keyid, nonce)` until `expires` to refuse replays (`federation.replay`).

## 7. Handshake and admission

The initiator sends `POST /federation/v1/handshake`:

```json
{
  "protocol": "trustwork-mesh/1",
  "from": "build.example.org",
  "to": "austin.example.org",
  "manifest": { "...": "the initiator's full signed manifest" },
  "requestedLevel": "syndicate",
  "hubs": { "initiator": "us", "responder": "us-tx-austin" },
  "nonce": "aGFuZHNoYWtlLW5vbmNlLTAwMDE",
  "issuedAt": "2026-11-02T08:00:00.000Z"
}
```

The manifest MUST be the initiator's own, name the initiating hub and offer the requested level. The responder:

1. validates the manifest (section 4; a restricted place never parses), verifies its signature and key chain, and checks the HTTP signature against that manifest's current key;
2. runs its **admission check** on all three kinds of evidence, as `admitPeerAtHandshake` in `packages/compliance` does for Trustwork nodes (SANC-008): the declared places of the manifest, the published attestation summary inside it, and the place of the connection as the responder's own door observes it through its local geolocation port. The observed place is never sent by the initiator and never stored: decisions and refusal records carry the place, evidence source and dataset, never an address;
3. on refusal answers HTTP **451** with `{ outcome: "refused", code: "federation.peer_restricted" }`, writes no peering record, stores only the admission refusal record, and echoes no findings;
4. on admission answers `{ outcome: "admitted", manifestDigest, level, state }` where `level` is at most the requested one and `state` is `pending_approval` until a second approver confirms `deal_routing` or `identity`.

The check runs again whenever the peer's manifest or attestation changes and on every later request the responder admits. An expired attestation is refused like a restricted one.

## 8. Peering

Levels are ordered; each includes the rights before it:

| Level | Allows | Second approver |
|---|---|---|
| `syndicate` | Pull public feeds, look up public objects, show replicas with attribution | No |
| `trust_verifications` | Show the peer's verification badges, labelled with the granting node | No |
| `deal_routing` | Push `shared_party` envelopes, agent envelopes (rate-limited), review submissions | Yes |
| `identity` | Accept the peer's sign-in assertions (FED-005) | Yes |

Each side records a peering record: local and peer node and hub, level, state (`pending_approval`, `active`, `ended`), the agreed licence per data class (the stricter of the two manifests, `agreedLicences`), tombstone hours, the agent envelope rate, the peer's manifest digest and key label, the admission outcome (`admitted` on `declared`, `attested` and `observed`), the requesting staff member and a distinct second approver where required. It holds no address and no screening detail. Either side may lower or end peering at any time; **defederation** stops feeds and new deliveries and never rewrites history. Deals already accepted finish under their accepted terms.

## 9. Envelopes

Every object crosses as a signed envelope (purpose `envelope`):

| Member | Rule |
|---|---|
| `protocol` | `trustwork-mesh/1` |
| `id` | Global identifier; its kind equals `kind` and its host equals `homeNode` |
| `kind` | An object kind of the table below |
| `revision` | Positive integer, increased by the home node on every change |
| `homeNode` | The only writer |
| `projection` | `public` or `shared_party` only. **`party_private`, `owner_private` and `staff_case` are refused by the schema**; each kind carries exactly one projection |
| `dataClass` | One of the classes the kind may carry |
| `syndication` | The item's term (section 10); never `none` |
| `audience` | `{ kind: "public" }` for public envelopes; `{ kind: "parties", parties, nodes }` for `shared_party`, where `parties` are person or company identifiers and `nodes` are exactly their home nodes, including `homeNode` |
| `subject` | The person or company the object is about, or null |
| `consent` | `{ basis, recordedAt }`, required when the subject is a person, with a basis allowed for the kind |
| `agentGenerated` | True when an agent produced the content; required for `agent_envelope` |
| `payload` | The home node's own public or shared projection, exactly as its serializer produced it |
| `digest` | `trustwork-digest-1` of `payload` |
| `issuedAt` | Signing time |
| `signature` | Object signature by the home node |

Object kinds and what they may carry:

| Kind | Projection | Data classes | Stream | Person subject needs |
|---|---|---|---|---|
| `publication` | public | editorial, member or imported publications | `publications` | `published_by_subject` |
| `magazine_issue` | public | magazine issues | `issues` | (no person subject) |
| `event` | public | events | `events` | `published_by_subject` |
| `company_profile` | public | directory facts; subject is a company | `directory` | (no person subject) |
| `person_profile` | public | person profiles; subject is a person | `directory` | `profile_visibility_public` |
| `catalogue_item` | public | directory facts | `directory` | (no person subject) |
| `project` | public | open needs | `open_needs` | `published_by_subject` |
| `open_need` | public | open needs | `open_needs` | `published_by_subject` |
| `reputation_snapshot` | public | reputation snapshots | `reputation` | `profile_visibility_public` |
| `certificate` | public | certificates | `certificates` | `profile_visibility_public` or `credential_shared_by_subject` |
| `passport_credential` | public | certificates; subject is a person | `certificates` | `credential_shared_by_subject` |
| `introduction`, `rfq_invitation`, `rfq_version`, `quote_version`, `agreement`, `agreement_event`, `agent_envelope`, `review_submission` | shared_party | deal data | none: inbox only, to the parties' home nodes | `deal_participation` |

Reviews are not a kind: they never syndicate. A reviewer on another node submits a `review_submission` through deal routing, tied to the federated transaction. Commercial objects inside deal envelopes keep their own digests (RFQ, quote and agreement digests of ADR 008); the receiving node re-verifies them, so both nodes hold provably identical accepted terms.

### 9.1 Payload backstop

The home node's projection serializer is the primary control. In addition, both sides MUST refuse a payload that contains, at any depth: a key naming a network address, credential, budget, private constraint, price floor, mandate internal, screening result or private contact datum (the list is `FORBIDDEN_PAYLOAD_KEYS`); a `projection`, `audience`, `classification`, `layer`, `visibility` or `profileVisibility` member whose value is `party_private`, `owner_private`, `staff_case`, `restricted` or `private`; a string value that is an IP address literal; more than 32 levels of nesting; or more than 256 KiB of canonical bytes.

## 10. Data classes and licences

A manifest publishes one term per class. A node MAY choose a stricter term (further right), never a looser one. An item's own licence wins over the class default where the table allows it.

| Data class | Default term | Stricter terms a node may publish | Terms one item may carry |
|---|---|---|---|
| `directory_facts` | `open_data_with_attribution` | `redisplay_with_attribution`, `mesh_only_redisplay`, `link_only`, `none` | the same, except `none` |
| `person_profiles` | `mesh_only_redisplay` | `link_only`, `none` | `mesh_only_redisplay`, `link_only` |
| `editorial_publications` | `cc_by_4_0` | `headline_and_link`, `link_only`, `none` | `cc_by_4_0`, `headline_and_link`, `link_only` |
| `member_publications` | `headline_and_link` | `link_only`, `none` | `cc_by_4_0` (author's choice), `headline_and_link`, `link_only` |
| `imported_items` | `source_licence` | `none` | the source's term: `cc_by_4_0`, `redisplay_with_attribution`, `headline_and_link`, `link_only` |
| `magazine_issues` | `contents_and_links` | `link_only`, `none` | `contents_and_links`, `link_only` |
| `events` | `redisplay_with_attribution` | `link_only`, `none` | `redisplay_with_attribution`, `link_only` |
| `open_needs` | `redisplay_with_attribution` | `link_only`, `none` | `redisplay_with_attribution`, `link_only` |
| `reputation_snapshots` | `redisplay_unchanged` | `link_only`, `none` | `redisplay_unchanged`, `link_only` |
| `reviews` | `none` | (none) | (never federated) |
| `certificates` | `verification_record` | `link_only`, `none` | `verification_record`, `link_only` |
| `images` | `own_licence_only` | `none` | `own_licence_only` |
| `deal_data` | `parties_only` | (none) | `parties_only` |

Items marked `syndication: none` at home never leave the node. The conditions of every licence are fixed: attribution stays visible, tombstones are applied within the agreed hours (at most 72), federated personal data is never sold, never used to train models outside the receiving node's governed retrieval, and a replica is never presented as verified or authored by the receiving node. Rationale and wording: [Data licences](federation.md#data-licences).

## 11. Projections and audiences across nodes

- Only `public` and `shared_party` cross; everything else stays home ([ADR 011](../adr/011-federation-mesh.md) decision 5).
- A public replica may be read by anyone the receiving node serves. A `shared_party` replica may be read only by the parties in its audience; it never satisfies a write authorization and never enters search or retrieval except for those parties.
- Anything derived from several replicas (a search answer, a summary, an agent's context) inherits the **intersection** of their audiences (R31, `intersectReplicaAudiences`): public sources never widen a shared one, two deals share only their common parties, and an empty intersection is readable by nobody. Rights are rechecked at delivery.

## 12. Feeds

`GET /federation/v1/feeds/<stream>?after=<cursor>` returns:

```json
{ "protocol": "trustwork-mesh/1", "node": "build.example.org", "stream": "publications", "after": null, "items": [], "next": "c2", "generatedAt": "2026-11-02T08:00:00.000Z" }
```

Streams: `publications`, `issues`, `events`, `directory`, `open_needs`, `reputation`, `certificates`, `tombstones`. Items are `{ type: "envelope", envelope }` or `{ type: "tombstone", tombstone }`, at most 200 per page. A feed serves only the node's **own** objects (no re-serving of replicas), only public envelopes, only kinds of the stream; the `tombstones` stream carries tombstones of public kinds only (tombstones of deal objects go to the parties' inboxes). Cursors are opaque base64url tokens. A peer pulls at `syndicate` level or above.

## 13. Inbox

`POST /federation/v1/inbox` carries one delivery:

```json
{ "protocol": "trustwork-mesh/1", "deliveryId": "dlv-0001", "senderNode": "austin.example.org", "recipientNode": "build.example.org", "sentAt": "2026-11-02T08:00:00.000Z", "item": { "type": "envelope", "envelope": {} } }
```

Item types: `envelope` (only `shared_party` envelopes; public objects are pulled), `tombstone`, `takedown_notice`, `moderation_report`, `link_proposal`, `link_decision`. Rules:

- **No transit**: the sender is the origin of the item (the envelope's home node, the notice's issuer).
- A `shared_party` envelope goes only to a node in its audience; a report only to the target's home node; a link proposal only to the remote record's node; never to the sender itself.
- **Idempotency**: `(senderNode, deliveryId)` is unique at the receiver. The first delivery is `accepted`; the same delivery with the same body digest is a `duplicate` answered with the stored receipt and no second effect; a different body under the same identifier is `rejected` with `federation.delivery_conflict`. Receivers enforce this with a unique constraint so concurrent repeats resolve to one acceptance.
- The receipt is `{ protocol, deliveryId, state, code, receivedAt }`, with a code exactly when rejected.
- Everything received is untrusted until verified and authorized locally. Agent envelopes are labelled agent-generated, rate-limited per peering and treated as untrusted text by the receiving node and its agent; nothing received can authorize an action on the receiving node.

## 14. Tombstones, takedowns and reports

A **tombstone** (purpose `tombstone`) carries metadata only: `{ protocol, id, target, targetKind, homeNode, revision, reason, purge, issuedAt, applyBy }`. Reasons: `deleted`, `unpublished`, `erased`, `retracted`, `takedown`, `licence_ended`. `purge` is always `["replica", "search_index", "cache", "saved_answers"]`. `applyBy` is after `issuedAt` and at most 72 hours later (or the shorter period of the peering agreement). Only the home node tombstones its objects. A peer that does not honour tombstones is defederated.

A **takedown notice** names the target, the reason category (`legal_demand`, `licence_ended`, `rights_holder_request`, `court_order`, `privacy_request`) and optionally a public legal-basis reference; never the requester or private evidence. A **forwarded moderation report** names the target and the clause code; never the reporter. Moderation stays local: a node may hide a replica, never change the home object.

## 15. Entity links

A **link proposal** (purpose `link_proposal`) connects the proposer's own record (`local`) with a record of the same kind on another node (`remote`). Evidence:

- companies: `identifier_match` (same registration identifier kind and value from the same country pack) or `admin_signed_statement` (digest of a statement signed by an administrator of both records);
- people: only `person_confirmed`, after the person signed in on both nodes and confirmed. A person is never linked by e-mail address or any inferred match.

The data steward of the receiving node answers with a **link decision** `accepted`, `rejected` or `withdrawn`, without naming the steward. A link is never a merge: there is no merge decision, records keep their provenance, and display picks the record with the strongest claim status.

## 16. Replica merge rule `trustwork-merge-1`

The method version travels with every implementation from the first release (MSH-F19). For an incoming envelope or tombstone and the replica state held for its identifier:

| State held | Incoming | Action |
|---|---|---|
| none | envelope | store |
| none | tombstone | record the tombstone (a late envelope cannot resurrect the object) |
| replica at revision r | envelope with revision > r | replace |
| replica at r | envelope with revision < r | ignore as stale |
| replica at r | envelope with revision r and the same digest | ignore as duplicate |
| replica at r | envelope with revision r and another digest | refuse `federation.replica_conflict`, flag the home node (equivocation) |
| replica at r | tombstone with revision >= r | apply: purge replica, index entries, caches and saved answers |
| replica at r | tombstone with revision < r | ignore as stale |
| tombstoned (`erased` or `takedown`) | any envelope | refuse `federation.object_gone`; the identifier never returns |
| tombstoned (other reason) at t | envelope with revision > t | store (republished) |
| tombstoned (other reason) at t | envelope with revision <= t | refuse `federation.object_gone` |
| tombstoned (other reason) | tombstone `erased` or `takedown`, or a higher revision | apply (an erasure always escalates) |
| tombstoned | any other tombstone | ignore as duplicate |

The rule converges to the same state in any delivery order.

## 17. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `federation.peer_restricted` | 451 | Refused at handshake by the admission check |
| `federation.protocol_unsupported` | 400 | No common protocol version |
| `federation.manifest_invalid` | 422 | The manifest does not validate |
| `federation.signature_invalid` | 401 | Object or HTTP signature does not verify |
| `federation.key_unknown` | 401 | No key with that label was valid at the signing time |
| `federation.key_revoked` | 401 | Signed after retirement or after a compromise |
| `federation.clock_skew` | 401 | Outside the signature window |
| `federation.replay` | 409 | `(keyid, nonce)` already seen |
| `federation.digest_mismatch` | 422 | Payload or body does not match its digest |
| `federation.projection_forbidden` | 422 | A projection, kind or payload that may not cross |
| `federation.not_peered` | 403 | No active peering |
| `federation.level_insufficient` | 403 | Peering level too low for the item |
| `federation.not_addressed` | 421 | The receiving node is not in the audience |
| `federation.transit_forbidden` | 421 | The sender is not the origin of the item |
| `federation.delivery_conflict` | 409 | Same delivery identifier, different body |
| `federation.replica_conflict` | 409 | Same revision, different digest |
| `federation.object_gone` | 410 | The object was tombstoned |
| `federation.payload_too_large` | 413 | Over the payload limit |
| `federation.rate_limited` | 429 | Over the peering's rate |

## 18. Conformance

The vectors in [`tests/federation/protocol/vectors`](../../tests/federation/protocol/vectors) are normative examples:

- `digests.json`: JCS canonical forms and `trustwork-digest-1` values, including key ordering, escapes and non-ASCII text;
- `signatures.json`: object signing inputs, their SHA-256 and Ed25519 signatures for a key rotation, a manifest, a public envelope, a `shared_party` envelope and a tombstone;
- `http-signatures.json`: RFC 9421 signature bases, `Signature-Input` and `Signature` fields and RFC 9530 content digests for an inbox push, a feed pull and a feed response.

The keys are the published RFC 8032 section 7.1 test keys (TEST 1, 2 and 3): public test data that no node may use. Ed25519 is deterministic, so an implementation MUST reproduce every byte. The vectors are regenerated with `node --import tsx tests/federation/protocol/generate-vectors.ts`; a test fails when the committed files drift. A node may call itself compatible with `trustwork-mesh/1` when it reproduces the vectors and passes the schema rules of `tests/federation/protocol`. Conformance certifies protocol behaviour only: never data quality, never legal compliance, never a verification of the operator (MSH-F20).

## 19. Versioning

The protocol name carries its major version. A change that alters bytes on the wire (canonical form, signing input, digest, field names, enum values, the merge rule) is a new version introduced by an ADR with a compatibility period in which nodes offer both versions in `protocol`. A changed vector is a protocol change.

## 20. Refinements of ADR 011 made here

- ADR 011 decision 4 names one `signature` per envelope "signed with HTTP Message Signatures". This contract separates the two layers: the envelope carries a detached **object signature** (so a replica can be re-verified long after the exchange and across key rotations), and every exchange is additionally **RFC 9421**-signed.
- Peering levels use the data model's spelling (`trust_verifications`, `deal_routing`); the handbook's hyphenated names refer to the same levels.
- The handshake endpoint, the inbox item types, `trustwork-merge-1`, the consent bases and the per-kind table are introduced here; they implement ADR 011 decisions 3 to 13 without changing them.
