# Registers (REG-001)

Public-register and licence-board facts as sourced records. Design: [discovery and outreach](../../../../../docs/engine/discovery-and-outreach.md) sections 3 and 6, [ADR 026](../../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md). Contract: [`sourced-facts.ts`](../../../../../packages/contracts/src/sourced-facts.ts). Database: [`migrations/registers`](../../../../../packages/data/migrations/registers), repository [`registers.ts`](../../../../../packages/data/src/repositories/registers.ts).

A fact says what an official register showed about an identifier at a moment. It is never the hub's own judgement.

| Rule | Where it holds |
|---|---|
| Adapters come from the engine catalogue and read an active official-register source of the hub | `registers_bind_adapter` |
| Every adapter runs as a deterministic fake until live mode consumes a second person's approval (`providers.enable_non_fake`) with a credential reference | `registers_go_live`; [`fakes.ts`](fakes.ts) |
| Facts are append-only; a changed observation supersedes the current one, an unchanged one adds nothing | `register_fact`, `registers_record` |
| A fact keeps the licence flags of its source at observation; the public page uses the stricter of that snapshot and the current licence | `registers_public_facts` |
| A fact links to a company only through an identifier the company holds; registers without identifiers (OSHA) need a reviewed link with a reason | `registers_company_fact_rows`, `registers_link_record` |
| Values have strict shapes: no person's name, address, phone or e-mail | `registers_value_ok`, `SourcedFactValueSchemas` |
| Public pages show facts about organisations only, with display allowed and the source not taken down; past `valid_until` a fact is stale | `registers_public_facts`, `factDisplay` |
| Claimed and verified companies are reminded 60, 30 and 7 days before a licence or registration lapses, once per step | `registers_run_expiry_watch`, `registers_own_reminders` |
| Facts never change reputation, ranking or matching | comparison test in `tests/registers/database.test.ts` |
| Wording never says "certified", "licensed by", "verified by", "approved by" | `wordingProblems` |

## Catalogue

| Adapter | Register (country pack fact) | Identifier | Facts | Refresh |
|---|---|---|---|---|
| `us_ca_cslb_licence_file` | CSLB public data portal (`ca-cslb-public-data`) | `US-CA-CSLB` | licence status | 7 days |
| `us_sam_entity` | SAM.gov entity registrations (`sam-entity-registrations`) | `US-UEI` | registration, exclusion | 30 days |
| `us_osha_inspections` | DOL OSHA enforcement data (not in the pack yet) | none: reviewed link | safety inspection | 30 days |
| `gleif_lei` | GLEIF Global LEI index | `XX-LEI` | LEI record | 30 days |

Live adapters are not written yet: the licence of each register is stated as what an operator must confirm, and no adapter calls out without a credential reference and a second person.

## Routes

Console routes under `/v1/admin/hubs/:hubId/registers` need a staff role at the hub and a live elevation; every command carries the console base (contract version, `Idempotency-Key` restated in the body, staff reason) and completes in the request transaction (BE-005).

| Route | What it does |
|---|---|
| `GET /` | The engine catalogue, the hub's adapters and reviewed links |
| `POST /adapters` | Bind a catalogue adapter to an active official-register source (fake mode) |
| `GET /adapters/:id/live-digest?credentialRefId` | The digest a second person approves (`providers.enable_non_fake`) |
| `POST /adapters/:id/live`, `POST /adapters/:id/retire` | Live mode with a credential and the approval; retire |
| `POST /adapters/:id/fake-runs` | Run the fake for named subjects (identifier values, or record references); a person never types a fact |
| `GET /adapters/:id/facts`, `GET /companies/:companyId/facts` | Current facts of an adapter, or about a company (before display rules) |
| `POST /links`, `POST /links/:id/end` | Reviewed links for registers without identifiers |

| Public and company route | What it does |
|---|---|
| `GET /v1/companies/:companyId/sourced-facts` | No session: what the served hub (`TRUSTWORK_HUB_ID`) may show, as `PublicSourcedFactSchema` rows |
| `GET /v1/companies/:companyId/register-reminders` | An active administrator of the company: its expiry reminders |

## Worker

[`apps/worker/src/registers/refresh.ts`](../../../../worker/src/registers/refresh.ts) runs every hour:
- **refresh**: due fake adapters re-observe the records they already hold (fake dates are anchored, so an unchanged record adds nothing); a due live adapter is reported once per cadence, never guessed;
- **expiry watch**: one reminder per step for claimed and verified companies.

## Company page

The public company page (`apps/web/app/(public)/[lang]/companies/[handle]/page.tsx`) shows the public projection as "From public registers" ([`RegisterFacts.tsx`](../../../../web/components/public/RegisterFacts.tsx); copy under `companyPage.registerFacts` in `apps/web/locales/<lang>/companies.json` for every maintained language). Each entry names the kind and the register's status, classes, grade or inspection details, the date the register was seen and its validity, a stale note past `validUntil` and a link to the register record (new tab, no referrer, nofollow); a "How this is sourced" explanation follows. Without facts the panel is absent.

## Next

- Reminder notices through COMMS-001 (a template there), so administrators hear about an expiring licence without opening the reminders route.
- Exposure to canonical entities (ENT-001) by identifier.
