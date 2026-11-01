# Security, trust and privacy

Normative requirements: [Trust, safety, privacy and compliance](modules/trust-safety-privacy-compliance.md), [Security architecture](modules/security-architecture.md). Participants: [who uses what](participants/README.md).

Requirements R13–R15, R28, R29 and ADR 002, 008, 009. Status: identity security, row-level security and projection serializers are **Live** for the identity, company and project slice; file storage with signed URLs, quarantine, classified attachments and tombstoned deletion is **Live** in the API and worker (FILE-001, no interface yet); privacy operations have a **partial API implementation** (PRV-001, [coverage and blockers](../data/privacy-operations.md)), with an isolated local retained-journal restore proof, not production restore integration or full erasure/export acceptance; moderation and incident tooling are **Designed**; hub-level privacy settings are **Proposed**. Deeper references: [security](../quality/security.md), [accessibility](../quality/accessibility.md), [validation](../quality/validation.md).

## How access is decided

1. **Deny by default.** Effective authority is the intersection of the principal's current rights, the object grant, action conditions, the current mandate (for agents) and the entitlement or budget when relevant.
2. **Every object checks participation.** There is no "current company" shortcut; a quote shared between two companies is authorized by each party's participation, not by tenancy.
3. **Projections are allowlists.** Five layers (`public`, `shared_party`, `party_private`, `owner_private`, `staff_case`), one serializer per layer, used by API reads, search, exports, notifications and federation alike. Tests assert that forbidden fields (budget ceilings, floor prices, margin targets, cost basis, token hashes, e-mail bindings, private files) are absent.
4. **Database defence in depth.** PostgreSQL row-level security is forced on the runtime role, which is distinct from the schema owner; the principal is set per transaction; security-definer functions are reviewed.
5. **Disclosure rule.** If you may not know that something exists, the answer is "not found"; counts, autocomplete and search follow the same rule.
6. **Caches carry authorization epochs.** Revoking a membership or a grant bumps an epoch; cached decisions and indexes are invalidated promptly.

## Web and API hardening

- One public origin; the API lives under `/v1/*` on the same origin; no CORS for first-party traffic.
- `__Host-` cookies; mutations require a custom header plus `Sec-Fetch-Site`/`Origin` checks; `SameSite=Lax` as defence in depth; GET never mutates.
- Strict schemas reject unknown fields, so mass assignment is impossible by construction.
- Every mutation carries an idempotency key scoped to principal, action and context; versioned edits send the expected revision.
- Passwords hashed with Argon2id; sessions are opaque random tokens stored as hashes; step-up for sensitive actions.

## Integrity of commerce and evidence

- Published RFQ versions and sent quote versions are immutable in the database.
- Agreements and approvals are bound by `trustwork-digest-1`; acceptance recomputes digests from stored payloads.
- Evidence, confirmations, disputes and corrections are append-only with source and observation times.
- Unknown external outcomes are reconciled, never retried blindly; reservations prevent double spending.

## Trust and safety of the public resource

| Threat | Response |
|---|---|
| Fake companies or impostor claims | Sourced, claimed and verified are distinct; claims need evidence from the hub's verification recipes; verification can be revoked |
| Fake or bought reviews | Reviews tied to real interactions; unconfirmed reviews excluded; spike locks route new reviews to "unconfirmed"; operational signals open cases, never automatic sanctions |
| Ranking manipulation | No payment, plan, sponsorship or staff control affects ranking; method versions are public |
| Defamation and harassment | Reports, moderation cases with published rule clauses, notification of the author with reasons, appeals decided by a different person |
| Spam and unwanted outreach | Double-opt-in introductions, quotas shared by people and their agents, labelled agent messages |
| Scam events or courses | Hosting policy per hub, review, organizer ownership declaration and screening when payments are involved |
| Staff misuse | No impersonation, no private reads without second-person case grants, conflict-of-interest declarations, full audit |

The sanction ladder: level 1 warning, level 2 temporary restriction, level 3 feature ban, level 4 account or company suspension (two people).

## Privacy

- **Data minimisation.** Sign-up asks for a name, an e-mail and a password. Onboarding is optional.
- **Residency.** Each hub records where personal data is stored and processed; providers that would receive personal data must comply (for example, a US hub records the US region it uses; an EU hub records its transfer basis under GDPR; the Uzbekistan pack notes that personal data of citizens must be stored in Uzbekistan, pending confirmation).
- **Subject rights.** Access requests produce exports through the same projection code (never counterparties' private fields); deletion and erasure are decided by the privacy officer and executed by two people; erasure tombstones are replayed after restores and propagated to federation peers.
- **Retention.** Classes per local law; lawful evidence preservation (for example accepted terms another party relies on) is reconciled with erasure, and hashes are never claimed to anonymise personal data.
- **No surveillance.** No employee productivity views, no per-person behaviour analytics, pseudonymous operational logs.
- **Minors.** Policy open (O06); the engine is for professionals and does not target minors.

## Agents and AI safety

- Agents act only through structured mandates; chat text never authorizes.
- Every external input (files, e-mail, web pages, other agents' notes) is untrusted.
- Tool access is allowlisted per action; no superuser channel.
- Model egress is decided per data class and provider by the hub, respecting residency.
- Kill switches exist per hub and per node.
- A person's own AI chat connected over MCP is another hand of their one agent: audience-bound short-lived tokens, consent per client on the hub's site, private data classes off by default, commitments confirmed on the site, untrusted text marked in every result, no token passthrough ([The MCP server](mcp-server.md)).
- Private chain-of-thought is not logged or shown; activity logs show actions and evidence.

## Sanctions and export controls

The engine's author is a US person. Restricted places (Russia, Crimea, Sevastopol, the Donetsk and Luhansk regions of Ukraine, Cuba, Iran, North Korea) are never offered, hosted, served or federated. Partners, organizers who take payments, hub operators and peering nodes sign an ownership declaration. The sanctions compliance engine ([ADR 014](../adr/014-sanctions-compliance-engine.md), owner decision 24 of [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md); module page [Sanctions compliance](modules/sanctions-compliance.md); proposed) refuses visitors in restricted places at every door and holds a signed-in person seen there; screens persons, companies, counterparties and payees against the baseline OFAC lists (always on) and the lists the hub adds; sends possible matches to human review with two people to clear; stops money and commitments while a match is open or the answer is unknown; and re-screens on every list update. The engine has no kill switch that locates its own server; our own services refuse restricted places on our side and the setup wizard records where the operator and the hosting are. The operator terms template carries a sanctions and export-controls section that every deployment keeps.

## Incidents

Incident records link kill switches, index taints, emergency content holds and account freezes; break-glass roles expire within hours; every emergency action requires a post-incident review. Backups are restored in drills with evidence before a hub goes public.

## Reporting vulnerabilities

See `SECURITY.md`: report privately to the security contact, never in a public issue. Coordinated disclosure is preferred.
