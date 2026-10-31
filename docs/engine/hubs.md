# Hubs: the engine for your country or your city

Requirement R36. Status: country selection, packs and localization are **Live** and **Demo**; the hub model, territories, hub lifecycle and launch checklist are **Proposed**.

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
| Identity | Name, brand overlay with localized lettering, domain, languages, default language |
| Legal | Operator legal entity, terms, privacy notice, sanctions section, imprint, data-residency choice |
| People | Hub staff roles, editorial team, trust reviewers, moderators, support |
| Country base | Country pack version, hub taxonomy extensions, units, holidays |
| Information sources | News feeds, registers, procurement portals, standards, statistics |
| Counterparty verification | Verification recipes and provider adapters, sanctions screening |
| Money | Currency, payment providers, e-invoicing, hub price versions |
| Content policy | Editorial policy, community rules, moderation clause library, comments on or off |
| Events and learning | Hosting policy, ticketing, accreditation records |
| Agents | Allowed actions in the territory, outreach quotas, model providers and egress, kill switch |
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

## Help with launching

You can launch a hub entirely on your own: the engine, the handbook and the console are free. If you want help with configuration, local registers, legal templates or federation, the team that maintains the engine, [Contribuddha](https://contribuddha.com), works with hub operators. Contribuddha does not provide services to persons in the places listed in `NOTICE`.

## Operator responsibilities

The operator is responsible for compliance with the law of their territory: privacy and data residency, consumer protection, media and advertising rules, electronic commerce and signatures, taxes, sanctions and export controls. The engine provides controls, audit, templates and guard rails; it does not provide legal advice. The licence (AGPL-3.0-only) requires publishing modifications of the engine when it is offered as a network service.
