# The Trustwork engine handbook

Trustwork is created and maintained by [Contribuddha](https://contribuddha.com) together with its contributors.

Everything the engine does and is designed to do, in one place. Every chapter starts with an honest status line: **Live** (implemented with tests), **Demo** (interface on synthetic data), **Contract** (frozen schemas), **Designed** (accepted design) or **Proposed** (new design open for review). The overview is [What works today](status.md).

## Start here

| Chapter | For |
|---|---|
| [Vision](vision.md) | Why the engine exists, who it is for, the principles we keep and what we will never build |
| [What works today](status.md) | Status of every area |
| [How it works for you](../guides/README.md) | Step-by-step guides for every kind of participant and for hub operators, with the status of each step |
| [Concepts and glossary](concepts.md) | The words we use precisely |
| [Roadmap and work packages](roadmap.md) | Phases, dependencies and every work package |
| [How to help](how-to-help.md) | Ways to contribute for developers, translators, lawyers, practitioners, designers, hub operators |
| [Onboarding for AI coding agents](agent-onboarding.md) | Rules, running, claiming work, coordination and handoff for agents and the people who run them |

## The gathering point

| Chapter | What it covers |
|---|---|
| [People and companies](people-and-companies.md) | Lifelong personal identity, sign-in, profiles, companies, memberships, sourced / claimed / verified |
| [Projects](projects.md) | Ownership, participants, publication as a projection, transfers; plans with versions, sharing per item, consultations and tasks from plan items (from plan to people) |
| [News, articles and walls](publishing.md) | Publications, sources, corrections, editorial workflow, hub sources, multilingual publishing, community |
| [The weekly magazine](magazine.md) | Issues, reader, PDF, archive, cross-hub digests |
| [Events](events.md) | Attending and hosting, tickets, check-in, partner meetings |
| [Learning and certificates](learning.md) | Courses, assessments, verifiable certificates, accreditation |
| [Partners and matching](partners-and-matching.md) | Capability profiles, needs board, explainable matching, introductions |
| [Buying and selling](commerce.md) | Needs, RFQs, quotes, comparison, negotiation, agreements, orders, catalogue |
| [Execution, evidence and reputation](execution-and-reputation.md) | Claims and evidence, fair timing, explainable reputation; the reputation builder toolkit and the portable reputation passport |
| [Your agent](agents.md) | Representation under mandates, detailed settings, goals, negotiation between agents, company representation, hub extensions, jurisdiction settings, safety |
| [Agent catalogue](agent-catalog.md) | What the agent does for every participant type; modules, metering and hub pricing; flagship journeys "from plan to people" and "build and confirm your own reputation"; connecting your own agent over MCP and A2A |
| [Search and knowledge](search-and-knowledge.md) | Keyword search, structured filters, cited answers, governed retrieval; manufacturer and supplier knowledge and explained plan-step recommendations |
| [Communications](communications.md) | Context threads, external channels, notifications, templates |
| [Billing, plans and budgets](billing.md) | Free participation, two budget kinds, versioned prices; licensed payment providers only (Trustwork never holds money); commissions and fees as disclosed hub settings |

## Running the engine for a territory

| Chapter | What it covers |
|---|---|
| [Hubs](hubs.md) | Nodes and hubs, territories, how country and city hubs complement each other, launch checklist, growing a hub |
| [Hub administration](hub-administration.md) | The operator's console: legal, sources, counterparty verification, sanctions, editorial, commerce, agents policy, privacy, federation |
| [The hub console](hub-console/README.md) | Installing the engine and running a hub without code: setup wizard, keys and models, autonomous editorial office, data mining, scheduling, agent product, every module, support, operations, screen contracts |
| [Country specifics](country-specifics.md) | Facets of national difference, pack v2, shared layers such as the EU, starting points for the example countries |
| [Countries and languages](localization.md) | Any country with any language, how strings resolve, adding a language |
| [Federation: one worldwide mesh](federation.md) | Node identity, signed envelopes, peering, links not merges, deals across nodes |

## Building the engine

| Chapter | What it covers |
|---|---|
| [Architecture for contributors](architecture.md) | Processes, layout, modules, data and reliability, conventions, quality gates |
| [Security, trust and privacy](trust-safety-privacy.md) | Access decisions, hardening, integrity, trust and safety, privacy, AI safety, sanctions, incidents |

## Deeper references

- [Product specification](../product/specification.md) and [information architecture](../product/information-architecture.md)
- [Architecture decisions](../adr/README.md), including [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) (gathering point, hubs, agents, mesh) and [ADR 011](../adr/011-federation-mesh.md) (federation)
- [System architecture](../architecture/overview.md), [API conventions](../architecture/api.md), [retrieval](../architecture/retrieval.md)
- [Data dictionary](../data/model.md) and [lifecycles](../data/lifecycles.md)
- [Design system](../design/system/README.md)
- [Quality: security, accessibility, validation](../quality/validation.md)
- [Legal templates](../legal/templates/README.md) and [how to add a country](../country-packs/how-to-add-a-country.md)
