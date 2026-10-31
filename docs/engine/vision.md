# Vision: a gathering point for the people who build

Construction is one of the oldest crafts we have and one of the most fragmented industries in the world. A facade is designed by one firm, fixed by a second, clad by a third, financed by a fourth and maintained for decades by someone who never met any of them. Knowledge lives in the heads of site foremen and in folders of scanned acceptance reports. Reputation travels by phone calls between people who already know each other. A good young contractor in a regional city can spend years being invisible to the client who needs exactly them.

Trustwork is an open engine for changing that, one territory at a time and then for the whole world at once.

## What we are building

A place people **want** to come back to, not because a dashboard demands it, but because it is useful:

| You come to… | Because the platform… |
|---|---|
| **Read** | publishes topical news with sources and dates, practical articles from practitioners, and a curated weekly magazine you can read on a phone or download as a properly laid-out PDF |
| **Meet** | lists industry events you can attend, and lets you host your own: a conference, a site visit, a webinar, a meetup of facade installers in Austin, Lyon or Nairobi |
| **Learn** | offers short practical courses and certificates anyone can check by number |
| **Be found** | gives every person a profile that belongs to them for life, and every company a page with its people, projects, catalogue and evidence-backed reputation |
| **Find partners** | helps you find the subcontractor, supplier, designer or client who fits, and explains *why* they fit |
| **Do business** | turns a vague need into a clear request, collects comparable quotes, keeps every sent version immutable, and records what was actually delivered and accepted |
| **Delegate** | gives you an agent that represents you in the industry, under your direction and within limits you set: it looks for partners, presents your services, negotiates and pursues your goals |

And a place anyone can **run**: a hub for their country or their city, configured for local law, local registers and local languages, connected to every other hub in one worldwide mesh.

## Flagship journeys

Three owner decisions of 2026-10-31 ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 17–19) say what the gathering point is for in everyday life. All three are **Proposed**: designed in the handbook, with work packages, and not implemented yet ([status](status.md)).

### From plan to people, and knowledge shared

Anyone launches a project, for example building a house on their lot near Austin. Their agent turns the idea into a clear **plan**: phases, tasks, the expertise and trades each step needs, materials, permits and inspections, budget ranges, a timeline, risks and the decisions ahead. The owner approves a plan version. Plan items then become requests to people on the platform: **consultations** with experts (an advice session, a review of drawings or quotes, a site visit) and scoped **tasks** for contractors and trades. The agents of both sides do the routine work (matching, quoting, scheduling, negotiating within their mandates, tracking progress, reporting) while people make the decisions. When the project is done, and only with the owner's consent, it becomes shared knowledge: a diary, lessons learned, checklists, templates, answers and mentoring. Experts earn reputation and income from the consultations and mentoring they give. Private plan data (budgets, floors, addresses, negotiations) stays private unless the owner publishes a redacted version.

Where it is designed: [Projects](projects.md#plans-from-plan-to-people), the [agent catalogue](agent-catalog.md#flagship-journey-from-plan-to-people), the data model ([plans](../data/model.md#7-projects-and-plans), [consultations and tasks](../data/model.md#8-consultations-tasks-and-mentoring), [knowledge sharing](../data/model.md#9-knowledge-sharing)) and the console's [plan-to-people administration](hub-console/modules.md#plan-to-people). Packages: PLAN-000, PLAN-001, CONS-001, CONS-002, TASK-001, KNOW-001, AGT-010, WEB-007.

### Every participant builds and confirms their own reputation

Reputation is not the platform watching people. It is a toolkit every participant uses (worker, professional, expert, company, supplier, client, author, organizer): verified identity, licences, insurance and certificates; a portfolio of completed work backed by evidence and client confirmations; confirmations from counterparties tied to real transactions, consultations and tasks; knowledge contributions; timeliness signals; a portable, verifiable **reputation passport** that works across hubs; coaching from their own agent on what would strengthen the profile; and fair disputes and appeals. Every signal is explained and evidence-based, and none of it is for sale. Where it is designed: [Execution, evidence and reputation](execution-and-reputation.md#the-reputation-builder-toolkit), the [agent catalogue](agent-catalog.md#flagship-build-and-confirm-your-own-reputation) and the [data model](../data/model.md#20-reputation). Packages: REP-001, REP-002, AGT-005, WEB-008, CLM-001.

### Knowledge from manufacturers and suppliers on every plan step

Within the hub's legal basis and each source's licence and robots rules, the editorial office builds **sourced** pages for manufacturers and suppliers from their public sites, and indexes their catalogues, guides, training, technical articles and events. For each step of a plan, the system recommends the materials and products, articles and guides, courses, events, consultants and contacts that fit, and explains why. Sourced pages stay labelled until the company claims them; recommendations are never paid for, and sponsored content, if a hub switches it on at all, is labelled and kept out of ranking. Where it is designed: [Search and knowledge](search-and-knowledge.md#plan-step-recommendations-proposed), [News and articles](publishing.md#manufacturer-and-supplier-sources-proposed), the [autonomous editorial office](hub-console/autonomous-editorial.md#11-manufacturer-and-supplier-knowledge-adr-010-decision-19). Packages: MAT-001, REC-001, AGT-021, SRC-001, EDIT-001.

### Your agent has the whole system, and so does the interface

Owner decision of 2026-10-31 ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 23). Everything revolves around the person's own agent, their representative in the industry. Every participant-facing capability is available through that agent and directly in the interface, from one [capability registry](capability-registry.md) that the agent runtime, the person's own AI chat connected over MCP and the interface all use; a parity report in CI shows any gap. Commitments still need a confirmed mandate, a budget where money is involved and the person's confirmation; chat text never authorizes. Status: the registry contract is **Contract** (AGT-002); everything that uses it is **Proposed**.

How each kind of participant meets these journeys, step by step and with honest statuses, is in the guides [How it works for you](../guides/README.md); the specification of the same journeys, with every capability and its status, is in [Participants and their journeys](participants/README.md) and the [module specifications](modules/README.md).

## Who it is for

- **Practitioners**: engineers, site managers, architects, estimators, technologists, foremen and installers who want their work and knowledge to be visible and to belong to them, not to their current employer.
- **Companies of every size**: contractors, suppliers, manufacturers, design offices and developers who buy and sell at the same time and need one honest place for both.
- **Clients**: private homeowners, businesses and public bodies that want to find good contractors and understand what they are paying for.
- **Editors and authors**: industry journalists, experts and companies who publish.
- **Experts and mentors**: experienced practitioners who share what they know through consultations, answers, mentoring and courses, and earn reputation and income for it.
- **Manufacturers and suppliers** as knowledge partners: their guides, training and products appear on the plan steps where they help, because they fit, never because they paid.
- **Event organizers and teachers**: associations, training centres, manufacturers and communities.
- **Hub operators**: associations, publishers, chambers of commerce, entrepreneurs or communities who choose to develop the platform for their territory.
- **Builders of the engine**: developers, designers, translators, lawyers and researchers who want an open, well-made tool for an industry that deserves one.

## Principles we keep

These are not slogans. Each one is a rule written into the specification, the contracts and the tests, and a reason to refuse a feature that breaks it.

1. **People first.** Personal relief, professional agency and confidence come before efficiency dashboards. One human, one lifelong identity; your publications and profile survive a change of employer.
2. **Truth is labelled.** A record taken from a public source, a company that someone claimed, and a company whose claim was verified with evidence look different, and always will. Missing data is shown as unknown, never as failure.
3. **Reputation cannot be bought.** No payment, sponsorship, plan or staff action changes a ranking. Reputation is explained: method version, sample sizes, what was excluded and why, how to appeal.
4. **Private stays private.** A buyer's budget, a seller's floor, a negotiation thread and a private project are never visible to anyone without participation rights, including platform staff, search, notifications, exports, other hubs and agents.
5. **Agents work for you, not on you.** An agent acts only within structured mandates you can read, change and revoke. Chat text never authorizes anything. Money and commitments need budgets, and an ambiguous external outcome is reconciled, never retried blindly.
6. **No fakes.** No invented users, verified badges, ratings, reviews, traffic or interview results. Demo data is synthetic and labelled.
7. **Every language, every country.** Everything a reader sees follows their chosen language, including dates, currencies and demo content. Country differences are data, not hard-coded logic.
8. **Open and independent.** The engine is free software (AGPL-3.0-only). Every hub owns its data, infrastructure and identity. Federation connects hubs; it never subordinates them.
9. **Lawful by design.** Hub operators comply with local law; the engine gives them the controls, audit and guard rails. Sanctions and export controls apply to every deployment.
10. **Accessible and calm.** Keyboard, screen reader, small screens and slow networks are first-class. The interface is light and restrained; nothing reshuffles itself behind your back.

## What we will never build

- A pay-to-rank directory, "featured" placements tied to money, or staff controls that set scores.
- An employee surveillance or productivity dashboard.
- A "log in as user" switch for staff.
- A generic inbox detached from the work it belongs to.
- A multi-agent control panel where you manage a swarm of bots. You have one agent; it is yours. A company has at most one representative, always with an accountable person.
- Mass outreach to people who never agreed to hear from you.
- Fake social proof of any kind.

## How we will know it works

Not by vanity charts. The specification asks for research with consenting practitioners on personal relief, perceived control, confidence, useful completion, interruption burden and willingness to return. Product quality gates include completing a task without surprise external actions, correct permission denials and understandable explanations. Until that research happens, we do not claim the product is validated, and we say so.

## Who builds it

Trustwork is created and maintained by [Contribuddha](https://contribuddha.com), together with everyone who contributes. Contribuddha helps hub operators launch and run their hubs and builds products on the engine; the engine itself stays free software that anyone can run. Contribuddha does not provide services to persons in the places listed in `NOTICE`.

## Where to go next

- [What works today and what is designed](status.md)
- [How it works for you](../guides/README.md): step-by-step guides for every kind of participant
- [Concepts and glossary](concepts.md)
- [Hubs: running the engine for a country or a city](hubs.md)
- [The worldwide mesh](federation.md)
- [Representative agents](agents.md)
- [How to help](how-to-help.md)
