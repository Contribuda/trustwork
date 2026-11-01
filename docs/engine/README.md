# The Trustwork engine handbook and specification

Trustwork is created and maintained by [Contribuddha](https://contribuddha.com) together with its contributors.

Everything the engine does and is designed to do, current and future, in one place. Every chapter and every requirement carries an honest status: **Live** (implemented with tests), **Demo** (interface on synthetic data), **Contract** (frozen schemas), **Designed** (accepted design) or **Proposed** (new design open for review). Nothing marked Designed or Proposed works yet; the overview is [What works today](status.md).

## How this handbook is organised

| Layer | What it is | Where |
|---|---|---|
| **Narrative chapters** | Why a part of the engine works the way it does, with examples and the reasoning behind each rule | The chapters linked in the tables below |
| **Module specifications** | The normative requirements of every module, numbered (`PLN-F07`), each with a status and its work packages, user stories, agent capabilities, interface surfaces, console settings, data entities, country variations, privacy rules, metrics, edge cases and a flow diagram | [Module specifications](modules/README.md) |
| **Participants** | Every kind of participant, what they come for, which capabilities they use, their journeys end to end and what can never happen to them | [Participants and their journeys](participants/README.md) |
| **The hub console** | How an operator installs and runs a hub without code | [The hub console](hub-console/README.md) |
| **Decisions** | Owner and integrator decisions that every page follows | [ADRs](../adr/README.md), especially [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) and [ADR 012](../adr/012-integrator-decisions-2026-10-31.md) |
| **Plan** | Work packages, phases and dependencies | [Roadmap](roadmap.md), [work-packages.json](work-packages.json) |
| **Open items** | Ideas from research, and contradictions found while writing the specification | [Ideas ranked by impact](ideas.md), [Conflicts to resolve](conflicts-to-resolve.md) |

## Start here

| Chapter | For |
|---|---|
| [Vision](vision.md) | Why the engine exists, who it is for, the principles we keep and what we will never build |
| [What works today](status.md) | Status of every area |
| [Concepts and glossary](concepts.md) | The words we use precisely |
| [Participants and their journeys](participants/README.md) | Homeowners and clients, professionals, experts, companies, suppliers and manufacturers, authors and editors, organizers, educators, hub operators, contributors |
| [How it works for you](../guides/README.md) | Friendly step-by-step guides for every kind of participant, with the status of each step |
| [Module specifications](modules/README.md) | The template, the module index and the cross-cutting rules every module keeps |
| [Roadmap and work packages](roadmap.md) | Phases, dependencies and every work package |
| [Ideas ranked by impact](ideas.md) | Proposed ideas from the [worldwide competitive landscape](../research/competitive-landscape-2026-11.md) and the specification work |
| [Conflicts to resolve](conflicts-to-resolve.md) | Contradictions flagged for the owner and the integrator |
| [How to help](how-to-help.md) | Ways to contribute for developers, translators, lawyers, practitioners, designers, hub operators |
| [Onboarding for AI coding agents](agent-onboarding.md) | Rules, running, claiming work, coordination and handoff for agents and the people who run them |

## The agent at the center

Each person has one agent, their representative; every participant-facing capability is available through that agent and directly in the interface ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 23).

| Chapter | Specification | What it covers |
|---|---|---|
| [Your agent](agents.md) | [AGN](modules/agent.md) | Representation under mandates, detailed settings, goals, negotiation between agents, company representation, hub extensions, jurisdiction settings, safety |
| [The capability registry](capability-registry.md) | [AGN-F12](modules/agent.md) | One registry of operations used by the interface, the agent runtime, MCP and A2A; kinds, confirmations, parity report |
| [Agent catalogue](agent-catalog.md) | [AGN](modules/agent.md) | What the agent does for every participant type; modules, metering and hub pricing; flagship journeys; connecting your own agent over MCP and A2A |
| [The MCP server](mcp-server.md) | [API](modules/api-and-mcp.md) | Use the whole system from your own AI chat (Claude, ChatGPT, others): authorization, consent, scopes and data classes, the full tool catalogue mapped to every module, confirmation of commitments on the site, resources, prompts, public and admin surfaces, testing ([ADR 013](../adr/013-mcp-server.md), [guide](../guides/connect-your-ai-chat.md)) |
| [API and MCP](modules/api-and-mcp.md) | [API](modules/api-and-mcp.md) | The public API, webhooks, the MCP server for the person's own AI chat, the A2A gateway |

## Modules

| Module | Specification | Narrative chapter |
|---|---|---|
| Identity and accounts | [IDN](modules/identity-and-accounts.md) | [People and companies](people-and-companies.md#a-person-is-one-human-for-life) |
| People and companies | [PCO](modules/people-and-companies.md) | [People and companies](people-and-companies.md) |
| Projects and plans (from plan to people) | [PLN](modules/projects-and-plans.md) | [Projects](projects.md) |
| Consultations | [CNS](modules/consultations.md) | [Agent catalogue: consultation](agent-catalog.md#consultation) |
| Tasks and mentoring | [TSK](modules/tasks-and-mentoring.md) | [Agent catalogue: task marketplace](agent-catalog.md#task-marketplace) |
| Knowledge sharing | [KNW](modules/knowledge-sharing.md) | [Agent catalogue: knowledge sharing](agent-catalog.md#knowledge-sharing) |
| Procurement and supply (requisition to pay) | [PRC](modules/procurement-and-supply.md) | [Procurement and supply](procurement-and-supply.md), [Buying and selling](commerce.md) |
| Sales | [SAL](modules/sales.md) | [Buying and selling](commerce.md#the-sales-journey) |
| Catalogue and manufacturer knowledge | [CAT](modules/catalogue-and-manufacturer-knowledge.md) | [Buying and selling: catalogue](commerce.md#the-catalogue), [Search and knowledge](search-and-knowledge.md#manufacturer-and-supplier-knowledge-proposed) |
| Matching and partners | [MCH](modules/matching-and-partners.md) | [Partners and matching](partners-and-matching.md) |
| Reputation builder and passport | [REP](modules/reputation-and-passport.md) | [Execution, evidence and reputation](execution-and-reputation.md) |
| Execution and field evidence | [EXE](modules/execution-and-field-evidence.md) | [Execution, evidence and reputation](execution-and-reputation.md) |
| Getting paid | [PAY](modules/getting-paid.md) | [Billing: never holding money](billing.md#trustwork-never-holds-money) |
| Billing and commissions | [BIL](modules/billing-and-commissions.md) | [Billing, plans and budgets](billing.md) |
| Events | [EVT](modules/events.md) | [Events](events.md) |
| Learning and certificates | [LRN](modules/learning-and-certificates.md) | [Learning and certificates](learning.md) |
| News, articles, the magazine and the autonomous editorial office | [PUB](modules/publishing-and-editorial.md) | [News, articles and walls](publishing.md), [The weekly magazine](magazine.md), [Autonomous editorial office](hub-console/autonomous-editorial.md) |
| Search and cited answers (RAG) | [SCH](modules/search-and-cited-answers.md) | [Search and knowledge](search-and-knowledge.md) |
| Communications and notifications | [MSG](modules/communications-and-notifications.md) | [Communications](communications.md) |
| Hubs and the hub console | [HBC](modules/hubs-and-console.md) | [Hubs](hubs.md), [Hub administration](hub-administration.md), [The hub console](hub-console/README.md) |
| Data mining and sources | [DMS](modules/data-mining-and-sources.md) | [Local data mining](hub-console/data-mining.md), [Automation and scheduling](hub-console/automation-and-scheduling.md) |
| Country packs and localization | [LOC](modules/country-packs-and-localization.md) | [Countries and languages](localization.md), [Country specifics](country-specifics.md) |
| Federation mesh | [MSH](modules/federation-mesh.md) | [Federation: one worldwide mesh](federation.md) |
| Trust, safety, privacy and compliance | [TSP](modules/trust-safety-privacy-compliance.md) | [Security, trust and privacy](trust-safety-privacy.md) |
| Sanctions compliance | [SNC](modules/sanctions-compliance.md) | [Sanctions controls on our own services](../operations/sanctions-our-services.md), [ADR 014](../adr/014-sanctions-compliance-engine.md) |
| Security architecture | [SEC](modules/security-architecture.md) | [Architecture](architecture.md), [Security, trust and privacy](trust-safety-privacy.md) |
| Integrations | [INT](modules/integrations.md) | [Keys, providers and models](hub-console/providers-and-models.md) |
| Mobile and offline | [MOB](modules/mobile-and-offline.md) | [Communications](communications.md) |
| Accessibility | [ACC](modules/accessibility.md) | [Accessibility acceptance](../quality/accessibility.md) |
| Analytics | [ANL](modules/analytics.md) | [Vision: how we will know it works](vision.md#how-we-will-know-it-works) |
| Operations | [OPR](modules/operations.md) | [Runbook](../operations/runbook.md), [Console operations](hub-console/operations.md) |
| Open-source governance and contribution | [OSS](modules/open-source-governance.md) | [How to help](how-to-help.md), [GOVERNANCE.md](../../GOVERNANCE.md) |

## Running the engine for a territory

| Chapter | What it covers |
|---|---|
| [Hubs](hubs.md) | Nodes and hubs, territories, how country and city hubs complement each other, launch checklist, growing a hub, the San Diego reference hub |
| [Hub administration](hub-administration.md) | The operator's console: legal, sources, counterparty verification, sanctions, editorial, commerce, agents policy, privacy, federation |
| [The hub console](hub-console/README.md) | Installing the engine and running a hub without code: setup wizard, keys and models, autonomous editorial office, data mining, scheduling, agent product, every module, support, operations, screen contracts |
| [Country specifics](country-specifics.md) | Facets of national difference, pack v2, shared layers such as the EU, starting points for the example countries |
| [Countries and languages](localization.md) | Any country with any language, how strings resolve, adding a language |
| [Federation: one worldwide mesh](federation.md) | Node identity, signed envelopes, peering, links not merges, deals across nodes |
| [Mesh protocol `trustwork-mesh/1`](federation-protocol.md) | The wire protocol for implementers: manifest, keys, signatures, handshake, envelopes, feeds, inbox, tombstones, links, merge rule, conformance vectors |

## Building the engine

| Chapter | What it covers |
|---|---|
| [Architecture for contributors](architecture.md) | Processes, layout, modules, data and reliability, conventions, quality gates |
| [Security, trust and privacy](trust-safety-privacy.md) | Access decisions, hardening, integrity, trust and safety, privacy, AI safety, sanctions, incidents |
| [Onboarding for AI coding agents](agent-onboarding.md) | Running the engine, claiming work, shared registration files, the merge queue and handing work back |

## Operating and releasing

| Document | What it covers |
|---|---|
| [Operations, release and recovery runbook](../operations/runbook.md) | Releasing, operating and recovering a node |
| [Container images and the local stack](../operations/images.md) | The images and the compose stack that mirrors the production topology |
| [Backup and restore](../operations/backup-and-restore.md) | Encrypted backups, point-in-time restore and the drill |
| [Retrieval operations](../operations/retrieval.md) | Deletion and generation lifecycle of the retrieval runtime (design and runbook only) |
| [Sanctions controls on our own services](../operations/sanctions-our-services.md) | The shared admission check (Contract) and the designed controls on the services Contribuda runs |
| [Platform release candidate](../quality/release/platform.md) | The US demo hub on a deployable stack (QA-002), on synthetic data |
| [Deployment configuration](../country-packs/configuration.md) | Configuring a deployment without a default country, data-directory packs and dictionaries |

## In design

These chapters are being written in open pull requests and are not part of the handbook until they are merged:

- The editorial office and the editorial agent team (pull request #367)

## Deeper references

- [Product specification](../product/specification.md) (requirements R01 onwards) and [information architecture](../product/information-architecture.md)
- [Architecture decisions](../adr/README.md), including [ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) (gathering point, hubs, agents, mesh), [ADR 011](../adr/011-federation-mesh.md) (federation) and [ADR 012](../adr/012-integrator-decisions-2026-10-31.md) (integrator and owner decisions of 2026-10-31)
- [System architecture](../architecture/overview.md), [API conventions](../architecture/api.md), [retrieval](../architecture/retrieval.md)
- [Data dictionary](../data/model.md), [lifecycles](../data/lifecycles.md) and [retention and privacy](../data/retention-and-privacy.md)
- [Design system](../design/system/README.md) and [screen contracts](../design/screen-contracts/README.md)
- [Quality: security, accessibility, validation](../quality/validation.md)
- [Research notes](../research/README.md): architecture audit, US market scan, worldwide competitive landscape
- [Legal templates](../legal/templates/README.md) and [how to add a country](../country-packs/how-to-add-a-country.md)
