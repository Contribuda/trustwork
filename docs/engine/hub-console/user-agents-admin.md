# Agent product administration

Status: **Proposed**. Contract: the agent-product vocabulary is AGT-002's [`agent-catalog.ts`](../../../packages/contracts/src/agent-catalog.ts) (`AgentModuleManifestSchema`, `HubAgentPolicySchema`, `SubscriptionPlanVersionSchema`, `MeterRateVersionSchema`, `ExternalConnectionSchema`); the hub-side parts are `agentPolicySecondPersonActions`, `MeterCostEstimateSchema`, `unitMargin`, `AgentUsageStatSchema`, `suppressSmallCount`, `AGGREGATE_MIN_COHORT`, `KillSwitchSchema`, `ProviderBudgetSchema`, `JurisdictionSettingsRefSchema`, `AgentExtensionVersionRefSchema`, `MarketplaceFeeVersionSchema` (console contract 1.0.0) in [`hub.ts`](../../../packages/contracts/src/hub.ts); mandates and actions in `assistant.ts`; offers, price versions and budgets in `billing.ts`. Screens HC-80…HC-85 in [screens](screens.md#agents) and HC-90…HC-95 in [screens](screens.md#billing). Backend: proposed AGT-003, AGT-004, AGT-022, AGT-023, BILL-003 and BILL-004 on top of AST-001 and BILL-001.

Every participant has **one** agent ([Your agent](../agents.md)); a company may have **one** standing representative. This section of the console configures the agent **product** in the hub: what the agent can do here, with which models, within which limits, at what price, and how outside agents may connect. It is not a place to manage anyone's agent, read their conversations or see their mandates. There is no list of bots, in the product or in the console.

## The complete control set (ADR 010 decision 25)

Owner decision of 2026-10-31 ([ADR 010](../../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 25): "The administrator must have a complete set of controls over the models in the system, their prices and the agents' functionality." The table is the whole set and the package that owns each control. Every control is a versioned hub configuration or price record with an audit entry naming who changed what, when and why; every change shows a [preview of its effect](#preview-before-activation) before it is activated.

| Area | Control | Second person | Package |
|---|---|---|---|
| Models | Provider connections and write-only keys | Enabling a live connection | KEYS-001 |
| Models | Model catalogue: add, describe, enable, disable, retire | Enabling a model that may receive non-public data | MODEL-001 |
| Models | Pinned model versions with one-action rollback | No (rollback narrows risk) | MODEL-001, LLM-001 |
| Models | Routing per task class and per agent module or extension, with fallbacks | Routes carrying non-public data | KEYS-001, LLM-001 |
| Models | Data-class egress rules; private data never reaches a model without an allow rule | Allowing any non-public class | KEYS-001, LLM-001 |
| Models | Region and residency constraints | Part of the egress rule | KEYS-001, MODEL-001 |
| Models | Context and size limits | No | MODEL-001, KEYS-001 |
| Models | Evaluation before activation: safety suite and quality check on hub samples | Activation after a passing evaluation | MODEL-001 (EVAL-001 harness) |
| Models | Canary and staged rollout with automatic stop | Reaching 100 percent on non-public routes | MODEL-001, LLM-001 |
| Models | Kill switches per provider and per model | Release | KEYS-001, MODEL-001 |
| Models | Cost and latency dashboards by cohort, never per person | No | LLM-001, MODEL-001, HUBC-002, HUBC-008 |
| Prices | Provider cost per model (versioned cost records) | No (cost is information, not a price) | KEYS-001 |
| Prices | Hub price to participants per model or per capability, flat or as a markup materialized into a fixed version | Activation | AGT-004 |
| Prices | Agent plans and quotas | Activation | AGT-004, BILL-004 |
| Prices | Prepaid credits that never expire silently ([ADR 012](../../adr/012-integrator-decisions-2026-10-31.md) decision 33) | Activation of a credit-pack version | BILL-004, AGT-004 |
| Prices | Commissions and fees (ADR 010 decision 21) | Activation | BILL-003 |
| Prices | Public disclosure of every active price, fee and commission | Not applicable | BILL-003 |
| Prices | Charges, credit purchases, refunds and payouts only through the licensed provider (decision 20) | Payout release | BILL-002 |
| Agent functionality | Enable or disable modules and individual capabilities per hub, participant type and plan | Modules with commitment actions | AGT-003 |
| Agent functionality | Hub defaults and limits participants may tighten, never widen | Activation of the policy version | AGT-003, AGT-022 |
| Agent functionality | Job subscriptions offered per module, default schedules and triggers | No | AGT-003 |
| Agent functionality | The model each module uses | Routes carrying non-public data | KEYS-001, LLM-001 |
| Agent functionality | Governed extension registry with safety suite | Activation | AGT-023 |
| Agent functionality | Kill switches: global, per module, per capability, per extension | Release | AGT-003, AGT-023 |
| Agent functionality | Audit of every change; preview before activation | Not applicable | AGT-003, AGT-004, MODEL-001, HUBC-005, HUBC-009 |

The console screens for these controls are built on fixtures by HUBC-002 (keys and models) and HUBC-005 (agents and billing) and wired to the API by HUBC-008 and HUBC-009. Since HUBC-005 the agent and billing screens (HC-80 to HC-85, HC-90 to HC-95) are a **Demo** on synthetic fixtures: every available activation shows its stored preview and only creates a second-person request; general agent-policy and non-commitment module activation are blocked until the contract defines their second-person approval action, cohorts under ten read "fewer than 10", the guard rails below are shown locked, and the command evaluation refuses any field that names a guard rail or one participant. The API behind them (AGT-003, AGT-004, AGT-023, BILL-003, BILL-004) is still proposed.

The blocker is a contract vocabulary gap: `SENSITIVE_CONFIG_DOMAINS` includes `agents`, and `HubConfigVersionSchema` requires a different activator and an approval for that domain. However, `CONSOLE_SECOND_PERSON_ACTIONS` defines only `agents.enable_commitment_module` and `agents.activate_extension` for agent product activation; `agentPolicySecondPersonActions` does not supply a general policy action. HUBC-005 refuses those requests as `activation_unavailable`, including direct command submissions. Maintainers must accept a suitable action and permission mapping before AGT-003/HUBC-009 can enable them; an empty action list never permits single-person activation.

### Guard rails no administrator can switch off

No setting, price record, extension or kill switch exists that weakens these, and the configuration schemas reject any key that would (tested in AGT-003, AGT-023 and BILL-003):

| Guard rail | What it means for the administrator |
|---|---|
| Mandates and the person's confirmation for commitments | A hub can forbid more, never pre-authorize a commitment on a participant's behalf or remove the person's confirmation where the confirmation policy requires it; chat text never authorizes |
| Sanctions gates ([ADR 014](../../adr/014-sanctions-compliance-engine.md)) | Screening gates on money, commitments, counterparties and agents stay on; no plan, price or module bypasses a hold (SANC-004) |
| Restricted places | Connections, model processing regions and extension endpoints in restricted places are refused at registration |
| Payment neutrality | No price, plan, quota, credit or commission changes ranking, matching, recommendations or reputation; protective limits are the same for every plan |
| No impersonation | Staff never act as a participant; support works through case grants without impersonation (SUP-001) |
| No per-person agent management by staff | Administrators manage policy for everyone; they never read or change one participant's agent, mandates, settings, goals, job subscriptions or connections, and the API has no staff endpoint that could |
| Private data | Egress stays default deny; a canary, a fallback or an extension never sends a data class somewhere the egress matrix does not allow |

## Modules: what agents can do in this hub

A **module** is a capability bundle of the participant's agent, shipped as an engine manifest (`AgentModuleManifestSchema`, AGT-002) and enabled per hub in the hub agent policy (`HubAgentPolicySchema`). Examples (the operator defines the real catalogue):

| Module key | Actions (mandate verbs) | Typical eligibility | Notes |
|---|---|---|---|
| `research` | `research` | Every person | Search and cited answers within the person's rights |
| `drafting` | `prepare` | Every person | RFQ drafts, quote drafts, publication drafts |
| `project_planner` | `prepare`, `research` | Every person | Builds a plan from a template; proposes consultation and task requests for the owner to confirm |
| `partner_finder` | `research`, `communicate` | Every person | Introductions within the person's quota |
| `rfq_responder` | `prepare`, `send_quote`, `communicate` | Company members, representative | Answers invitations from the catalogue |
| `negotiator` | `negotiate` | Company members, representative | Inside the party's private floors and ceilings |
| `order_desk` | `place_order`, `accept_order` | **Verified companies only**; enabling needs a second person | Commitments with transaction budgets |
| `deliverables` | `generate_deliverable` | Every person | Catalogues, presentations, reports billed against the platform budget |
| `reputation_coach` | `prepare`, `research`, `communicate` | Every person | Helps a participant build and present their own reputation: suggests evidence to attach, drafts confirmation requests (never sends them without the mandate, never confirms on anyone's behalf) |
| `event_meetings` | `research`, `communicate` | Event attendees | Proposes meetings within the event's rules |

For each module the console sets:

| Setting | Meaning |
|---|---|
| Actions | Which mandate verbs the module may use; a participant's mandate still decides what their agent actually does |
| Eligibility | Who may use it: persons, company members, the company representative, external agent clients; whether a **verified company** is required |
| Model routes | Which route serves each job the module uses (from [routing](providers-and-models.md#models-and-routing)); the route's egress rules apply |
| Limits | Runs per day, actions per day, concurrent runs, tokens per month, outreach per week (required for modules that `communicate`) |
| Metering | Unit (`run`, `thousand_tokens`, `action`, `deliverable`, `api_call`, `month`) and free units per month |
| Status | `draft → beta → active → retired`; a module with commitment actions needs a second person to leave draft (`agents.enable_commitment_module`) |
| Capabilities | Each capability registry entry of the module ([capability registry](../capability-registry.md)) can be turned off for the whole hub, for a participant type (person, company member, company representative, external client) or for a plan; a capability turned off disappears from the agent, the person's connected AI chat and the interface alike, so parity holds per hub (ADR 010 decision 23) |
| Defaults | Default settings the participant's agent starts with (approval rules, outreach per week, schedules, report cadence, channels) and the hub's maximum for each; participants may tighten any of them in their own settings (AGT-022), never widen beyond the hub maximum |
| Job subscriptions | Which job templates the module offers, their default triggers (schedule, event, deadline, goal, request) and minimum intervals; a participant still turns a job on only through a mandate proposal they confirm |

A module or capability that is turned off stops new runs and new actions at the next authority check; runs already executing finish or go to reconciliation by their checkpoint rules, and affected participants see which hub setting changed.

## Agent policy

Hub-wide rules on top of modules, from [Hub administration](../hub-administration.md#agents-policy): allowed actions in the territory (for example commitments only for verified companies, outreach only to platform participants), outreach quotas per person per week shared by people and their agents, which external channels are allowed, the **disclosure text** that labels agent-generated messages in every hub language, and the competition-law rules (agents of competing sellers never exchange pricing; the platform never relays one seller's quote to another).

For the plan-to-people flows ([modules](modules.md#plan-to-people)) the policy also sets how far agents may automate consultation and task requests: whether they may draft requests and offers, accept within a mandate (only with verified counterparties), and how many requests per week a participant's agent may send.

## Jurisdiction settings

ADR 010 decision 22: agent disclosure wording, liability allocation for agent commitments, consent and record-keeping rules, limits per action type and the legal texts are per-hub and, inside a hub, per-jurisdiction settings (the `jurisdiction` domain of the hub configuration, HUB-005). Each setting starts from the country pack's sourced default and shows it beside the hub's value; a hub may be stricter than a mandatory pack rule, never weaker; changes are versions activated by a second person, and the disclosure text must exist in every hub language. When two jurisdictions apply (for example a buyer in one state and a seller in another), the most protective setting wins. The wording itself is reviewed by the hub's counsel; the console never presents a default as legal advice.

## Preview before activation

Every change to the agent product, the model configuration or a price shows its effect **before** it is activated, computed on current data and shown only as counts and cohorts:

- which modules, capabilities, routes, models and prices change, old value beside new;
- how many active mandates, job subscriptions, external connections and open runs would be suspended or would need a new confirmation (cohort counts of at least ten, or "fewer than 10");
- which participant types and plans are affected, and whether a price change needs advance notice to existing payers (BILL-004);
- the estimated cost change per month from the model pricing and recent usage, labelled as an estimate.

The preview is stored with the configuration version so the second person approves exactly what the drafter saw. It never lists named participants.

## Extensions: adding capabilities to agents

Modules ship with the engine. ADR 010 decision 22 lets a hub administrator **add** functions, tools, integrations and other capabilities through a governed extension registry (`/agents/extensions`, AGT-023):

| Declared in the manifest | Why |
|---|---|
| Actions, each mapped to a mandate kind | An extension action runs only under a mandate of that kind, like a built-in action |
| Inputs and the data classes it reads and sends | Checked against the egress matrix (`/integrations/egress`) before every call |
| Side effects and external endpoints | Endpoints in restricted places are refused at registration; effects follow outbox, idempotency and reconciliation rules |
| Cost model | Reserved from the platform budget like any metered step |
| Adapter and fake | Tests and dry runs never call the real endpoint |
| Safety suite | Must pass on the fake adapter (EVAL-001 harness) before activation and after every engine update |

Each extension also names the model route it uses (an extension-scoped route, [routing](providers-and-models.md#models-and-routing)), its hub price if it is metered, and has its own kill switch (`agent_extension`). Lifecycle `draft → tested → active → suspended → retired`; activation needs a second person and is a hub configuration version. An extension can add actions; it can never bypass mandates, budgets, approvals, kill switches, privacy rules, the restricted-places list or the rule that untrusted text never issues commands, and it never becomes a separate agent: participants see it as one more ability of their one agent, which they configure in their own detailed agent settings (AGT-022).

## Cost price and sale price

Every paid unit has two numbers the console always shows side by side:

- **Cost price**: what the unit costs the hub, per unit, from model pricing and measured averages (`costPricePerUnitMinor`, `costBasis`). For a run of `rfq_responder`, for example, the average tokens per run times the route's price per token.
- **Sale price**: what the participant pays per unit (`salePricePerUnitMinor`).

Both are exact decimals in minor units per unit (fractions of a cent are normal for token-based units); invoice totals round half-even to whole minor units. `unitMargin` shows the margin per unit; a negative margin (a subsidised unit) is allowed and highlighted. Price changes are **versions**: drafted by one person, activated by **another** (`commerce.activate_price_version`), never back-dated, never overlapping another active version of the same offer and unit. Participants accept a specific version with a specific acceptance text, as for every price in [billing](../billing.md).

US example: `rfq_responder` run, cost 3.25 cents (measured average), sale 10 cents, margin 6.75 cents; the first 30 runs a month are free. Samarkand example: the same module priced in UZS with a different cost basis because models are self-hosted in-country.

## Prices for models and capabilities

The administrator prices the agent product at the level the hub chooses (AGT-004):

| Price basis | How it works |
|---|---|
| Per capability or module unit | A sale price per run, action, deliverable or thousand tokens of a module or capability, whatever model serves it |
| Per model | A sale price per thousand input and output tokens, image or audio minute of a catalogue model, for hubs that let participants choose between models in their own settings |
| Flat | The administrator types the sale price |
| Markup | The administrator sets a percentage over the current cost price; the engine computes the sale price **once**, when the version is drafted, and stores it as a fixed number in the price version |

A new cost record (a provider price change, a new pinned version) never changes a participant's price silently: it recomputes margins, highlights negative ones and, for markup prices, offers a **draft** of a new price version that goes through the normal second-person activation, effective date, advance notice for existing payers (BILL-004) and publication. Every active price version, plan, credit pack and commission appears on the hub's public price page (BILL-003), with what payment never buys. Trustwork never holds money (ADR 010 decision 20): charges, credit purchases, refunds and payouts run through the hub's licensed payment provider and invoices name the price version and meter of every line (BILL-002).

## Plans, tiers and trials

A **plan version** (`SubscriptionPlanVersionSchema`, AGT-002) buys capacity: units per month per module, a trial length (0–90 days), payer kind (person, company, either). Plans can also decide which modules and capabilities are available ([modules](#modules-what-agents-can-do-in-this-hub)), within the free floor that every hub must keep. **Quotas** per module and meter are part of the plan; protective limits (introduction quota, new counterparties per day, envelopes per session, concurrent runs) are not, and are identical for every plan. **Prepaid credits** are sold in credit-pack versions that show their validity before purchase; refunds follow the hub's published policy and credits never expire silently ([ADR 012](../../adr/012-integrator-decisions-2026-10-31.md) decision 33, BILL-004). It has no field that could change ranking, matching, reputation or verification, by construction; the console says so on the plan editor. Free minimum participation stays free ([billing](../billing.md#free-to-participate-fair-to-pay)); trial lengths and tiers are each hub's decision (open question O03).

## External agents (MCP and A2A)

Participants may bring their own agent software, for example a desktop assistant speaking the Model Context Protocol, or another platform's agent speaking an agent-to-agent protocol. The hub exposes an **MCP server** and an **A2A endpoint** that let such a client act as **that participant's agent**, nothing more:

| Rule | Design |
|---|---|
| Bound to one person | A client is registered by the participant from their own settings (`actingFor.personId`, optionally on behalf of their company under a company mandate) |
| Only under mandates | `mandateRequired: true`; every state-changing call is checked against the person's current mandates and rights exactly like the built-in agent |
| Narrow scopes | `read_public`, `search_public`, `read_own`, `act_under_mandate`, `receive_envelopes`; there are no staff scopes |
| Credentials | Client secret stored as a secret reference; shown once to the participant at registration; revocable any time |
| Labelled | Everything it sends is labelled "sent by [person]'s agent" like the built-in agent |
| Untrusted input | What the client sends in free text is untrusted content for everyone who receives it |
| Rate limits | Per client requests per minute and actions per day, within the module limits |

The MCP side is designed in full in [The MCP server](../mcp-server.md) (ADR 013); its scopes (`read.public`, `read.me`, `read.contexts`, `read.private`, `propose`, `act`) supersede the scope names above, and a separate staff surface exists, off by default. The console's **External agents** screen sets the policy (which protocols are on, default and maximum rate limits, which modules external clients may use, whether company representatives may use external clients) and, for MCP, the fields of `McpHubPolicySchema`: endpoints (participant, public, admin), disabled tools, client trust (any HTTPS client or listed clients only), listed clients, dynamic client registration, anonymous cited answers, token lifetimes, rate limits and the upload limit, next to the AGT-002 protection limits (connections per person, idle expiry, public records per connection), within engine bounds that can only be tightened. It shows **counts** of registered clients by protocol. Staff see no list of who connected what; a support case with a case grant can inspect one client registration if the participant asks for help.

## Abuse controls

| Signal (aggregate or per principal, never content) | Response |
|---|---|
| Request rate above limits | Automatic throttling (not a sanction) |
| Outreach with high decline rates | Temporary quota reduction for that principal, per the published rule; repeated cases open a moderation case |
| Injection attempts detected in inputs | Logged as security events; repeated patterns open a case; kill switch available |
| Confirmation-request spam | Limits from the confirmation policy ([modules](modules.md#reputation-building-credentials-confirmations-methods-and-appeals)) |
| Unknown outcomes accumulating | Reconciliation queue; module paused if over a threshold |

Signals open **cases**; they never apply sanctions automatically beyond rate throttling. Sanctions follow the moderation ladder with its appeal rights.

## Statistics without surveillance

`AgentUsageStatSchema` reports per module and period: active principals, runs, actions succeeded, actions escalated to humans, outcome-unknown count, cost and revenue. Every participant count is a **cohort of at least ten** or suppressed (`suppressSmallCount`); there is no drill-down to individuals, no prompts, no outputs, no per-company leaderboard. The point is to run the product (is the module useful, what does it cost, is it safe), not to watch people.

## Kill switches

`agent_module` (one module), `agent_capability` (one capability registry entry, proposed scope, AGT-003), `agent_action` (one verb across modules, for example all `place_order`), `agent_extension` (one extension), `hub_agent_dispatch` (every agent action in the hub, the global switch), `external_agent_api` (MCP and A2A), plus the node-wide switch. Engaging is immediate; release needs a second person and an incident note. Participants see a clear message in their assistant that the hub paused the capability, never a silent failure.

## Acceptance (when implemented)

- An external client cannot perform any action its person's mandates do not allow (negative tests per scope).
- A module with commitment actions cannot be active for unverified companies or without a second person.
- Changing a plan, a price or a module status never changes any matching or ranking output (comparison test).
- Every statistics response suppresses counts below ten.
- A price version cannot be activated by its drafter, back-dated or overlapped.
- A capability turned off for a hub, participant type or plan is refused identically through the interface, the agent runtime and MCP (parity test).
- A participant setting above the hub maximum is refused with an explanation; a hub default never widens a participant's existing mandate.
- A new cost record never changes an active sale price; a markup produces only a draft price version.
- No configuration key exists that disables mandates, the person's confirmation for commitments, sanctions gates, restricted places or payment neutrality (schema test), and no staff endpoint reads or changes one participant's agent, mandates, settings, goals, job subscriptions or connections (negative authorization tests).
- The preview stored with a configuration version is the one the second person approved.
