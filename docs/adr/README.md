# Architecture decisions

Decisions 001–007 are dated 2026-10-26; 008 and the amendments to 002/003 are dated 2026-10-27; 009 is dated 2026-10-29; 010 and 011 are dated 2026-10-30; 012 and 013 are dated 2026-10-31. “Selected for foundation” is an engineering decision in this bootstrap, pending coordinator review, not an assertion of production/human product acceptance. Any change requires evidence and consequences, with supersession rather than silent rewrite.

| ADR | Status | Decision |
|---|---|---|
| [001](001-independent-modular-monolith.md) | Selected for foundation | Independent TypeScript monorepo, Next/Nest/PostgreSQL, modular monolith |
| [002](002-identity-and-access.md) | Product constraints accepted; implementation planned; auth amendment accepted by integrator 2026-10-27 | Human identity, one ordinary employer, multi-party object access; opaque sessions, single origin, provider `(kind, subject)` identity |
| [003](003-snapshots-evidence-and-authority.md) | Selected for foundation; digest amendment accepted by integrator 2026-10-27 | Immutable commercial snapshots, evidence lineage, durable authority; `trustwork-digest-1` and `VersionRef` |
| [004](004-delivery-and-providers.md) | Selected for foundation | PostgreSQL outbox/jobs and neutral provider ports |
| [007](007-hybrid-retrieval.md) | Accepted | Hybrid retrieval over permitted facts and derived projections; permission intersection at delivery |
| [008](008-contracts-and-validation.md) | Accepted by integrator 2026-10-27 | Zod 4 contracts, JCS digest, Kysely + pg, error/idempotency/projection conventions |
| [009](009-international-engine-and-open-source.md) | Owner decisions 1-9 recorded | International engine, country packs, any country × any language, sanctions, Trustwork name and mark, AGPL-3.0-only, open-source export |
| [010](010-gathering-point-hubs-agents-and-mesh.md) | Owner decisions recorded 2026-10-30 | Gathering point, events, partners and matching, representative agents, hubs and hub operators, country specifics, worldwide mesh, documentation |
| [011](011-federation-mesh.md) | Proposed 2026-10-30 | Federation of independently operated nodes: signed manifests, global identifiers, public syndication, cross-node deals, links not merges |
| [012](012-integrator-decisions-2026-10-31.md) | Integrator decisions recorded 2026-10-31 | One deduplicated task graph from the wave-1 research and design; phase order; defaults (Spanish `es`, no default country, synthetic demo data, plan-version statuses, CC0 plan-step taxonomy, staff scopes, migration and locale layout, non-overlapping package paths); owner decision 30, international by default (language and country-pack roadmap, honest review status); questions left for the owner and counsel |
| [013](013-mcp-server.md) | Proposed 2026-10-31 | The Trustwork MCP server: every participant uses the whole system from their own AI chat through the same capability registry as the agent and the interface; three surfaces per hub (participant, public, admin); Streamable HTTP pinned to 2026-07-28; the hub's own OAuth 2.1 authorization server with Client ID Metadata Documents; consent per client with private data classes off; commitments confirmed on the site; untrusted content marked; no token passthrough |

Numbers 005 and 006 recorded the core team's former private delivery coordination and development-management integration; both were retired on 2026-10-31 when development moved into this repository (ADR 010 decision 15).
