# Hubs: the engine for your country or your city

Normative requirements: [Hubs and the hub console](modules/hubs-and-console.md). Participants: [who uses what](participants/README.md).

Requirement R36. Status: country selection, packs and localization are **Live** and **Demo**; the hub model, territories, hub lifecycle and launch checklist are **Proposed**; the United States reference hub (hosting, operator, demo-only start) is **decided** and not deployed.

The engine is not one website. It is something people run for a place they care about. A **hub** is the platform for one territory: a country, a region, or a city. Whoever runs it is the **hub operator**: an industry association, a trade publisher, a chamber of commerce, a university, an entrepreneur, a community of engineers. The operator brings local knowledge, legal responsibility and people; the engine brings everything else.

## Nodes and hubs

| | Node | Hub |
|---|---|---|
| What it is | One installation of the engine: database, web origin, signing key, operator | A community for a territory, hosted on a node |
| How many | As many as people choose to run | One or more per node |
| Example | `build.example.org` run by a trade association in Texas | "United States" hub and "Austin" hub on the same node |

A node can host a single country hub, or a country hub and several city hubs that share infrastructure and staff. Two different operators can also run a country hub and a city hub on **separate nodes**; the [mesh](federation.md) makes them complement each other.

## Territories

A hub declares its territory as data:

| Level | How it is identified | Example | Another example |
|---|---|---|---|
| Country | ISO 3166-1 alpha-2 | `US` | `DE` |
| Region | ISO 3166-2 | `US-TX` (Texas) | `DE-BY` (Bavaria) |
| City or named place | A place key from the country pack's places list, with optional Wikidata and OpenStreetMap references | `US-TX:austin` | `DE-BY:munich` |

Territories are **descriptive and never exclusive**. An Austin city hub and a United States country hub both cover Austin; content, events and needs located there appear on both, each with its home hub named. Nobody owns a city. A hub can never declare a restricted place as its territory, and the engine refuses to start a hub whose country is restricted.

## How country and city hubs complement each other

| Content or object | Created on | Appears on |
|---|---|---|
| City news, local events, local open needs | City hub | City hub, and the country hub's region and city views |
| National news, regulations, the national magazine | Country hub | Country hub, and city hubs as "from the national hub" |
| Company page | The hub where the company registered | Both, linked; the canonical display is the record with the strongest claim status |
| An RFQ from an Austin client to a supplier in Monterrey registered on a Mexico hub | The client's home hub | Shared with the supplier's hub for the deal only |
| Reputation of a company | Computed by the company's home node | Displayed with attribution everywhere |

Operators of overlapping hubs are encouraged to sign a short **cooperation agreement**: editorial exchange, shared event calendar, who verifies which companies, and how they split hub fees for cross-hub transactions if they charge any. The engine records the agreement's peering level; the commercial terms are theirs.

## What a hub has

| Area | Configured in the [hub console](hub-administration.md) |
|---|---|
| Identity | Name, optional brand overlay (Trustwork in every language unless the hub registers its own overlay, ADR 010 decision 14), typography per script, domain, languages, default language |
| Legal | Operator legal entity, terms, privacy notice, sanctions section, imprint, data-residency choice; jurisdiction settings for agent disclosure, liability, consent, record-keeping and per-action limits (HUB-005) |
| People | Hub staff roles, editorial team, trust reviewers, moderators, support |
| Country base | Country pack version, hub taxonomy extensions, units, holidays |
| Information sources | News feeds, registers, procurement portals, standards, statistics |
| Counterparty verification | Verification recipes and provider adapters, sanctions screening |
| Money | Currency, licensed payment providers (the hub never holds participants' funds), e-invoicing, hub price versions, commissions and fees as versioned, disclosed settings ([Billing](billing.md#commissions-and-fees-are-hub-settings)) |
| Content policy | Editorial policy, community rules, moderation clause library, comments on or off |
| Events and learning | Hosting policy, ticketing, accreditation records |
| Agents | Allowed actions in the territory, modules, outreach quotas, model providers and egress, extensions through the governed registry ([Your agent](agents.md#extensions-capabilities-added-by-the-hub-proposed)), kill switch |
| Federation | Peering agreements, data licences per class, defederation list |

## Hub lifecycle

```text
draft → preparing → soft_launch (invite-only) → public → suspended → closing → closed
```

- **Draft and preparing**: the operator configures the hub; nothing is public.
- **Soft launch**: invited participants and editors fill the hub with real content and real companies who claimed their pages. No fake activity is ever seeded.
- **Public**: anyone may join. The launch checklist must be complete.
- **Suspended**: read-only with a banner (legal order, operator incident).
- **Closing and closed**: participants are notified in advance, can export their own data, and can move to another hub; federation peers receive tombstones or a handover notice naming the successor hub.

## Launch checklist (Proposed)

The console refuses to switch a hub to **public** until every gate is green:

1. Operator legal entity recorded; operator screened against sanctions lists.
2. Terms, privacy notice and sanctions section adapted with the operator's counsel; the counsel approval recorded with date and version.
3. Data-residency decision recorded (for example the US region a US hub uses, or in-country servers where a country requires local storage of citizens' personal data, as the Uzbekistan pack notes) and storage configured accordingly.
4. At least two staff with distinct roles (separation of duties), each with a second factor.
5. Editorial team with an editor-in-chief; editorial policy published.
6. Community rules published in every hub language; moderation clause library mapped to local law.
7. At least one information source registered with licence flags.
8. A company verification recipe enabled (real or explicitly "manual review only").
9. Sanctions screening configured (the engine's baseline list plus any national lists the operator must use).
10. Every template and dictionary complete in every hub language.
11. Backup and restore exercised once, with evidence.
12. Accessibility check of the brand overlay (contrast, lettering) passed.

## Growing a hub

The engine helps; people grow a community. A playbook distilled from the design:

1. **Content first.** Start the news desk and the magazine before asking anyone to register. Register sources, invite three practitioners to write.
2. **Real companies, honestly labelled.** Import a licensed register as "from sources", then invite companies to claim and verify their pages.
3. **One event a month.** Meetups and site visits make people come back; partner meetings make them stay.
4. **Local champions.** Give respected engineers editorial roles and expert answers.
5. **Useful matching early.** Publish open needs from real projects; every filled need is a story.
6. **Learn in public.** Short courses on local practice (hidden-works acceptance, winter concreting under local codes).
7. **Federate.** Peer with the national or neighbouring hubs so your participants see a bigger market from day one.
8. **Never fake it.** No invented members, reviews or traffic. Trust is the product.

## The reference hub: United States (decided)

The project's own reference and demo deployment is a **United States hub whose home territory is San Diego, California** ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 16; [ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decisions 26–28 and 31). It is the primary worked example of this handbook; every other country is configured the same way (ADR 012 decision 30).

| Question | Answer | Status |
|---|---|---|
| Home territory | San Diego, California; the hosted preview defaults visitors who have not chosen a country to the United States (`TRUSTWORK_DEFAULT_COUNTRY=US`); DEMO-US data is set in San Diego County | Decided (decision 31) |
| Where it runs | On Railway in a United States region, the same way as the current hosted preview | Decided (decision 26); no reference hub is deployed by any work package |
| Who operates it | Contribuda (public references keep contribuddha.com until the company completes its move to the new name) | Decided (decision 26) |
| Recovery targets | Recovery point objective 24 hours, recovery time objective 8 hours for the demo; OPS-003 may tighten them | Decided (decision 26) |
| Configuration | English by default with Spanish second, USD, US states and territories, EIN and state registrations, state contractor licensing, state sales tax, ESIGN/UETA, card and ACH through licensed providers, US federal holidays | Proposed (INTL-US, LANG-ES, DEMO-US, CFG-001) |
| Public URLs | English pages without a prefix; other languages under `/<lang>/` with `hreflang` alternates and a canonical URL; no country in public URLs ([Countries and languages](localization.md#public-urls-decided)) | Decided (decision 27); implemented by WEB-005 |
| Data and sign-ups | **Demo-only with synthetic, labelled data** (decision 12). Real sign-ups open only after the platform release candidate QA-002 passes, counsel has reviewed the US privacy and agreement questions, and the owner switches them on; the switch is a hub setting, not a code change | Decided (decision 28) |

Today no hub, including the reference hub, accepts real users; the demo web app runs on synthetic, labelled data: the San Diego dataset for visitors in the United States and, on a deployment that defaults to the United States, for every country without its own dataset; the original Uzbekistan dataset for the Uzbekistan, Georgia, Armenia and Azerbaijan examples (DEMO-US, `apps/web/fixtures/datasets.ts`; [status](status.md)).

## Help with launching

You can launch a hub entirely on your own: the engine, the handbook and the console are free. If you want help with configuration, local registers, legal templates or federation, the team that maintains the engine, [Contribuddha](https://contribuddha.com), works with hub operators. Contribuddha does not provide services to persons in the places listed in `NOTICE`.

## Operator responsibilities

The operator is responsible for compliance with the law of their territory: privacy and data residency, consumer protection, media and advertising rules, electronic commerce and signatures, taxes, sanctions and export controls. The engine provides controls, audit, templates and guard rails; it does not provide legal advice. The licence (AGPL-3.0-only) requires publishing modifications of the engine when it is offered as a network service.
