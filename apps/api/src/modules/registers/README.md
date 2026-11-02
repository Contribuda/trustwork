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

## Next

- Staff and public routes, the fake run from the console, worker refresh and expiry jobs (REG-001 part 2).
- "How this is sourced" explanation and labels in every maintained language; notices for reminders through COMMS-001.
- Exposure to canonical entities (ENT-001) by identifier.
