# Federation: one worldwide mesh

Normative requirements: [Federation mesh](modules/federation-mesh.md). Participants: [who uses what](participants/README.md).

Requirement R39. Status: **Proposed**. Architecture decision: [ADR 011](../adr/011-federation-mesh.md).

Imagine a trade association that opens the engine for the United States, and a group of engineers who separately open it for Austin. With federation they do not compete for the same people; they complement each other. Austin's meetups appear in the national calendar, the national magazine reaches Austin readers, an Austin client can hire a Houston contractor, a supplier on a Mexico hub can answer a Texas request, and an engineer in Nairobi can read what a hub in Munich publishes on facade fire safety. Every deployment that joins makes every other one more useful. Together they form a mesh that can cover the world, with no central owner.

## Principles

1. **Independent nodes.** Every node has its own operator, database, law and community. Federation connects; it never subordinates.
2. **Public by default, private never.** Only public projections federate by default. Deal data travels only between the nodes of the parties. Private data never leaves its node.
3. **One writer per object.** The node where an object was created is its home; everyone else holds a read-only replica with provenance.
4. **Links, never merges.** Two records about the same company are linked, not merged.
5. **Authority stays home.** Reputation, verification and moderation decisions belong to the node that made them and are shown elsewhere with attribution.
6. **Corrections and deletions travel.** A correction is a new revision everyone receives; a deletion is a tombstone everyone must apply.
7. **Lawful everywhere.** Restricted places cannot join. Each node keeps its own legal responsibility.

## Node identity

Each node publishes a signed **manifest** at `https://<node>/.well-known/trustwork/manifest.json`:

| Field | Example |
|---|---|
| `node` | `build.example.org` |
| `protocol` | `["trustwork-mesh/1"]` |
| `engine` | Engine version and source repository URL (AGPL) |
| `operator` | Legal entity name, country, registration identifier, abuse and takedown contacts |
| `jurisdiction` | `US` |
| `hubs` | Hub IDs with territories (`US`, `US-TX`, `US-TX:austin`) and languages |
| `packs` | Country pack versions in use |
| `licences` | Licence per data class (publications, events, directory facts, profiles, issues) |
| `peeringPolicy` | Which levels it offers and on what terms |
| `keys` | Current Ed25519 public key and the signed rotation chain |

The manifest is signed with the node key. Key rotation is signed by the previous key, so peers can follow it.

## Global identifiers

Every federated object has a global identifier:

```text
trustwork://build.example.org/publication/7b0c…
trustwork://austin.example.org/event/2f91…
```

Local opaque IDs stay as they are inside the node. The global form is derived for federation and never parsed to authorize anything.

## Signed envelopes

Objects travel as envelopes:

```json
{
  "id": "trustwork://build.example.org/publication/7b0c…",
  "kind": "publication",
  "revision": 3,
  "homeNode": "build.example.org",
  "projection": "public",
  "payload": { "…": "the public projection, exactly as the home node serializes it" },
  "digest": { "algorithm": "trustwork-digest-1", "value": "64 hex" },
  "issuedAt": "2026-11-02T08:00:00Z",
  "syndication": "redisplay_with_attribution",
  "signature": "HTTP Message Signature by the node key"
}
```

`digest` is the same canonical SHA-256 scheme the engine uses for quotes and agreements, so any node can prove that what it shows is exactly what the home node published.

## How data moves

| Mechanism | Used for |
|---|---|
| **Pull feeds** `GET /federation/v1/feeds/<stream>?after=<cursor>` | Public streams: publications, issues, events, directory, open needs, reputation snapshots, certificates, tombstones |
| **Push inbox** `POST /federation/v1/inbox` | Deliveries to a specific party: introductions, RFQ invitations, quote versions, agreement events, agent envelopes, takedown notices |
| **Lookup** `GET /federation/v1/objects/<global id>` | Fetch one object by id, signed |

All requests are signed (HTTP Message Signatures, RFC 9421) and verified against the sender's manifest key. Pull is the default; push only for addressed deliveries. Feeds are paged with opaque cursors, like the rest of the API.

## What federates

| Data | Default | Notes |
|---|---|---|
| Published publications and corrections | Yes | Unless the item's source licence forbids syndication (`syndication: none`) |
| Released magazine issues | Yes | Items reference home publications |
| Public events | Yes | Registration happens on the home node |
| Public company and person profiles | Yes | People only with `profileVisibility: public` |
| Public projects and open needs | Yes | Never budgets or private fields |
| Public catalogue fields | Yes | Never private price knowledge |
| Reputation snapshots | Yes | With method version and samples; read-only |
| Certificates | Yes | Verifiable on the home node |
| Deal objects (RFQ invitations, quote versions, agreements) | Only to the parties' nodes | `shared_party` projection |
| Party-private and owner-private data | Never | |
| Staff case data, audit, credentials, sessions | Never | |

## Peering

Nodes federate through **bilateral peering agreements**, recorded on both sides:

| Level | Allows |
|---|---|
| `syndicate` | Pulling each other's public feeds and showing replicas with attribution |
| `trust-verifications` | Showing the peer's verification badges, labelled "verified by <hub>" |
| `deal-routing` | Accepting introductions, RFQ invitations, quotes and agent envelopes for local participants |
| `identity` | Accepting the peer's sign-in assertions so a person can register for an event or answer an RFQ without a second account |

Raising a peering level to `deal-routing` or `identity` needs a second approver in the hub console. Either side can lower or end peering at any time. **Defederation** stops feeds and new deliveries; it never rewrites history, and deals already in progress finish under their accepted terms.

A community-run **mesh directory** may list nodes that ask to be listed, with their territories and languages. It is a phone book for discovery, not an authority: nothing in the mesh depends on it.

## How country and city hubs complement each other

| Situation | What happens |
|---|---|
| A meetup is published on the Austin node | It appears in the United States node's event calendar under "Austin", labelled with its home hub |
| The national magazine releases issue 12 | Austin readers see it in their magazine section as "national issue", read on the home node or as a replica |
| A company registered on the national node joins the Austin community | The Austin node shows the national record as a replica and links any local record to it |
| An Austin client invites a Houston supplier to an RFQ | The invitation is delivered to the supplier's home node; the deal runs as described below |
| The national node verifies a company | The Austin node shows "verified by the United States hub" if it peers at `trust-verifications` |
| Two nodes in different countries (for example the United States and Mexico, or Germany and Kenya) | They peer at `syndicate`; their participants discover each other's public content and can raise to `deal-routing` for cross-border work |

## Entity links, never merges

When two nodes know the same company, the evidence for a link is a matching registration identifier (same pack kind and value) or a signed statement from an administrator of both records. A person links their accounts on two nodes by signing in to both and confirming. A link proposal goes to the data steward of each node; nothing merges automatically. The display chooses the record with the strongest claim status as canonical and shows provenance for every field.

## Authority stays home

- **Reputation** is computed only by the subject's home node. Replicas show it with the method version, samples and node name; nobody else recomputes or adjusts it.
- **Verification badges** belong to the node that granted them and show which checks were done.
- **Moderation** is local: a node may hide a replica on its own pages; it cannot change the home object. Reports can be forwarded to the home node's moderators through the inbox.
- **Reviews** stay on the subject's home node; a reviewer on another node submits through deal routing, tied to the federated transaction.

## Deals across nodes

```text
Client on node A                         Supplier on node B
RFQ v2 created on A  ── invitation ──▶   replica of RFQ v2 (shared_party) on B
                     ◀── quote v1 ────   quote v1 created on B, digest D1
compare on A (both digests verified)
agreement created on A over {quote v1, RFQ v2}, digest D2
buyer acceptance on A ── event(D2) ──▶   seller acceptance on B, event(D2)
both nodes hold identical accepted terms, proven by D2
```

- Each object is written only on its author's home node and replicated to the other party's node as `shared_party`.
- Both nodes verify every digest; the agreement digest is identical on both sides.
- Mandates, budgets, approvals and private constraints stay on each party's own node; node B can never authorize anything on node A.
- Each node screens the counterparty against sanctions lists before the first commercial message.
- Execution evidence and acceptance events follow the same pattern; reputation of each party is computed on its home node from what its home node can see.

## Agents across nodes

Agent envelopes ([Your agent](agents.md#agents-talking-to-agents)) are delivered to the counterparty's home node inbox, labelled as agent-generated, rate-limited per peering agreement and treated as untrusted content by the receiving node and its agent.

## Corrections, deletions and takedowns

- A correction is a new revision on the home node; peers update replicas on their next pull.
- A deletion, unpublication or erasure is a **signed tombstone**. Peers must apply it within the period stated in the peering agreement (for example 72 hours). Search indexes, caches and saved answers are purged.
- A takedown notice (legal demand, licence ended) is pushed to peers' inboxes with the reason category.
- A node that does not honour tombstones is defederated.

## Search across the mesh

Each node indexes the public replicas it receives as a separate source class with its licence flags and shows the home hub of every result. Private queries are never forwarded to peers. A future **federated query** protocol may let a node ask peers for public results directly; it is not needed for the first version.

## Sanctions and law

- A node whose manifest declares a restricted place as jurisdiction or territory is refused at handshake.
- Operators are screened like partners before peering.
- Deliveries are never routed through a third node; there is no transit.
- Each node remains responsible for its own legal compliance; peering does not transfer it.

## Data licences

Decided by the integrator on 2026-10-30 under the owner's delegation (ADR 010 decision 10). These are the defaults every node publishes in its manifest. A node may choose stricter terms; it can never loosen privacy rules, and an item's own licence (for example a news source that allows only headlines) always wins.

| Data class | Default licence for peers | Why |
|---|---|---|
| **Public directory facts** about companies: name, legal form, registration identifiers, region, categories, website, badge status with the granting hub | Open data, attribution to the home hub requested | Facts about businesses are useful to everyone and largely public already; the badge keeps its provenance |
| **Public person profiles** | Redisplay unchanged inside the mesh only, with attribution and a link to the home profile; no bulk export outside the mesh; no use for model training; tombstones applied within 72 hours | Personal data: people chose to be visible on the platform, not to be harvested |
| **Publications by the hub's editorial team** | CC BY 4.0: full text may be redisplayed with author credit, home link and the correction notice | Good journalism should travel; corrections travel with it |
| **Publications by people and companies** | Headline, lede, cover artwork, topics and a link to the home node by default; full text only if the author chose CC BY 4.0 when publishing | Authors keep control of their work |
| **Items imported from external sources** | The source licence decides; default `syndication: none` (they stay on the node that licensed them) | We cannot pass on rights we were not given |
| **Magazine issues** | Cover, contents and links; each item follows its publication's licence | An issue is a curated list of publications |
| **Events** | Full public event card with attribution; registration and payment only on the home node | Events want to be found |
| **Open needs and partner posts** | Redisplay with attribution; responses only through deal routing to the home node | Opportunities should reach the right people, privately answered |
| **Reputation snapshots** | Redisplay unchanged with method version, samples and home hub; no recomputation, no cross-node rankings built from them | Authority stays home; nobody re-weights someone else's reputation |
| **Individual reviews** | Not syndicated; replicas link to the home node | Reviews carry the most legal risk (defamation law differs by country) and belong with their evidence |
| **Certificates** | Verification record (number, course, version, date, status) with a link to the home check page | Anyone can verify; the home node remains the issuer |
| **Images** | Only images whose own licence permits redisplay; otherwise the receiving node shows a generated artwork | The engine ships no photographs it is not allowed to share |

Conditions attached to every licence: keep provenance and attribution visible, apply corrections and tombstones within 72 hours, never sell or resell federated personal data, never use it to train models outside the receiving node's governed retrieval, and never present a replica as if the receiving node had verified or authored it.

## Delivery plan

| Package | Delivers |
|---|---|
| FED-000 | Protocol specification and contracts (`packages/contracts/src/federation.ts`), conformance test vectors |
| FED-001 | Node identity: keys, manifest, signatures, key rotation, peering records |
| FED-002 | Public syndication: feeds, replicas, tombstones, attribution, licence flags |
| FED-003 | Directory federation and entity links |
| FED-004 | Cross-node deals and agent envelopes |
| FED-005 | Federated sign-in at `identity` level |

## Open questions

- Whether to offer an ActivityPub bridge for publications and events so the wider fediverse can follow hubs.
- How hubs share fees on cross-hub transactions, if they charge any (a matter for their cooperation agreements, not the protocol).
- Governance of the protocol itself: proposed as an open specification in this repository, changed by ADR with a compatibility period.
