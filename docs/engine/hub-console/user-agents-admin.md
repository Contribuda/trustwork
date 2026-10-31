# Agent product administration

Status: **Proposed**. Contract: `AgentModuleVersionSchema`, `MeteredPriceVersionSchema`, `unitMargin`, `meteredVersionsOverlap`, `AgentPlanVersionSchema`, `ExternalAgentClientSchema`, `AgentUsageStatSchema`, `suppressSmallCount`, `AGGREGATE_MIN_COHORT`, `KillSwitchSchema`, `ProviderBudgetSchema` in [`hub.ts`](../../../packages/contracts/src/hub.ts); mandates and actions in `assistant.ts`; offers, price versions and budgets in `billing.ts`. Screens HC-80…HC-84 in [screens](screens.md#agents). Backend: proposed AGTP-001 on top of AST-001 and BILL-001.

Every participant has **one** agent ([Your agent](../agents.md)); a company may have **one** standing representative. This section of the console configures the agent **product** in the hub: what the agent can do here, with which models, within which limits, at what price, and how outside agents may connect. It is not a place to manage anyone's agent, read their conversations or see their mandates. There is no list of bots, in the product or in the console.

## Modules: what agents can do in this hub

A **module** is a capability bundle of the participant's agent, versioned per hub (`AgentModuleVersionSchema`). Examples (the operator defines the real catalogue):

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

## Agent policy

Hub-wide rules on top of modules, from [Hub administration](../hub-administration.md#agents-policy): allowed actions in the territory (for example commitments only for verified companies, outreach only to platform participants), outreach quotas per person per week shared by people and their agents, which external channels are allowed, the **disclosure text** that labels agent-generated messages in every hub language, and the competition-law rules (agents of competing sellers never exchange pricing; the platform never relays one seller's quote to another).

For the plan-to-people flows ([modules](modules.md#plan-to-people)) the policy also sets how far agents may automate consultation and task requests: whether they may draft requests and offers, accept within a mandate (only with verified counterparties), and how many requests per week a participant's agent may send.

## Jurisdiction settings

ADR 010 decision 22: agent disclosure wording, liability allocation for agent commitments, consent and record-keeping rules, limits per action type and the legal texts are per-hub and, inside a hub, per-jurisdiction settings (the `jurisdiction` domain of the hub configuration, HUB-005). Each setting starts from the country pack's sourced default and shows it beside the hub's value; a hub may be stricter than a mandatory pack rule, never weaker; changes are versions activated by a second person, and the disclosure text must exist in every hub language. When two jurisdictions apply (for example a buyer in one state and a seller in another), the most protective setting wins. The wording itself is reviewed by the hub's counsel; the console never presents a default as legal advice.

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

Lifecycle `draft → tested → active → suspended → retired`; activation needs a second person and is a hub configuration version. An extension can add actions; it can never bypass mandates, budgets, approvals, kill switches, privacy rules, the restricted-places list or the rule that untrusted text never issues commands, and it never becomes a separate agent: participants see it as one more ability of their one agent, which they configure in their own detailed agent settings (AGT-022).

## Cost price and sale price

Every paid unit has two numbers the console always shows side by side:

- **Cost price**: what the unit costs the hub, per unit, from model pricing and measured averages (`costPricePerUnitMinor`, `costBasis`). For a run of `rfq_responder`, for example, the average tokens per run times the route's price per token.
- **Sale price**: what the participant pays per unit (`salePricePerUnitMinor`).

Both are exact decimals in minor units per unit (fractions of a cent are normal for token-based units); invoice totals round half-even to whole minor units. `unitMargin` shows the margin per unit; a negative margin (a subsidised unit) is allowed and highlighted. Price changes are **versions**: drafted by one person, activated by **another** (`commerce.activate_price_version`), never back-dated, never overlapping another active version of the same offer and unit. Participants accept a specific version with a specific acceptance text, as for every price in [billing](../billing.md).

US example: `rfq_responder` run, cost 3.25 cents (measured average), sale 10 cents, margin 6.75 cents; the first 30 runs a month are free. Samarkand example: the same module priced in UZS with a different cost basis because models are self-hosted in-country.

## Plans, tiers and trials

A **plan version** (`AgentPlanVersionSchema`) buys capacity: units per month per module, a trial length (0–90 days), payer kind (person, company, either). It has no field that could change ranking, matching, reputation or verification, by construction; the console says so on the plan editor. Free minimum participation stays free ([billing](../billing.md#free-to-participate-fair-to-pay)); trial lengths and tiers are each hub's decision (open question O03).

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

The console's **External agents** screen sets the policy (which protocols are on, default and maximum rate limits, which modules external clients may use, whether company representatives may use external clients) and shows **counts** of registered clients by protocol. Staff see no list of who connected what; a support case with a case grant can inspect one client registration if the participant asks for help.

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

`agent_module` (one module), `agent_action` (one verb across modules, for example all `place_order`), `hub_agent_dispatch` (every agent action in the hub), `external_agent_api` (MCP and A2A), plus the node-wide switch. Engaging is immediate; release needs a second person and an incident note. Participants see a clear message in their assistant that the hub paused the capability, never a silent failure.

## Acceptance (when implemented)

- An external client cannot perform any action its person's mandates do not allow (negative tests per scope).
- A module with commitment actions cannot be active for unverified companies or without a second person.
- Changing a plan, a price or a module status never changes any matching or ranking output (comparison test).
- Every statistics response suppresses counts below ten.
- A price version cannot be activated by its drafter, back-dated or overlapped.
