# Your agent: representation under your direction

Requirements R09–R11, R29, R35. Status: the assistant page and the floating overlay with mandates, approvals and runs from demo data are **Demo**; mandates, approvals, action states, external outcomes and reconciliation are **Contract**; the durable runtime is **Designed** (AST-001); goals, agent-to-agent negotiation, company mandates and the standing company representative are **Proposed**.

Every participant keeps an agent that represents them in the industry. It looks for partners, presents their services, negotiates and pursues their goals, **under their direction and within limits they can read, change and revoke at any moment**. This chapter describes what the agent does, how its authority works, how agents of different participants deal with each other, and what keeps the whole thing safe.

The [agent catalogue](agent-catalog.md) (Proposed) details what the agent does for each kind of participant: jobs, mandates, triggers and reports per participant type; capability packaged as **modules** that a hub enables and prices; metering and quotas; the flagship journeys [from plan to people](agent-catalog.md#flagship-journey-from-plan-to-people) and [build and confirm your own reputation](agent-catalog.md#flagship-build-and-confirm-your-own-reputation); and how a participant connects their own external agent over [MCP and A2A](agent-catalog.md#connect-your-own-agent-mcp-and-a2a). Everything in this chapter applies to every job in the catalogue.

## One agent, one surface

- Each person has **one** agent, the same thing the interface calls «Помощник» (the assistant). A company may additionally enable **one** standing representative ([below](#company-representation)). There is no list of bots to manage and no agent marketplace inside the product.
- It lives on a full page and in an icon-only launcher in the bottom-right corner that opens a floating overlay. The overlay never shrinks or reflows the page; the full page and the overlay share one conversation and one state.
- Internally the agent may use specialised workers (research, drafting, comparison, negotiation). Those are implementation details and stay invisible.
- What the agent can do is packaged as **modules** ([catalogue](agent-catalog.md#the-module-system)). Modules are abilities of the one agent, never separate agents; the person sees them as jobs the agent offers and the mandates those jobs need.
- A participant may connect their own external agent (for example Claude, ChatGPT or a custom agent). A **connection** is another hand of the same agent, acting under the same mandates, labels and kill switches; it can propose and act only inside mandates confirmed on the first-party surface, and never approve ([Connect your own agent](agent-catalog.md#connect-your-own-agent-mcp-and-a2a)).

## What your agent can do for you

| Job | Examples | Typical authority |
|---|---|---|
| **Research** | Find facade subcontractors in Texas with a given state licence; summarise a market; compare three insulation test reports | `research` |
| **Prepare** | Turn an e-mail thread into an RFQ draft; draft a quote from your catalogue; prepare a company presentation; draft a publication | `prepare` (drafts only) |
| **Present your services** | Answer RFQ invitations with a draft quote; keep your capability profile current; propose talking points for an event meeting | `prepare`, `send_quote` |
| **Find partners** | Run a matching search for your open need; request introductions within your quota | `research`, `communicate` |
| **Communicate** | Reply to a counterparty in an RFQ thread; send an introduction request; schedule a meeting at an event | `communicate` on named contexts and channels |
| **Negotiate** | Propose a revised quote version inside your floor; counter a delivery date | `negotiate` |
| **Commit** | Place an order below a ceiling with required delivery terms; accept an order as a seller | `place_order`, `accept_order` + budget |
| **Deliver work products** | Generate a catalogue, a presentation or a report the platform bills for | `generate_deliverable` + platform budget |
| **Report and propose** | Weekly summary of what it did; proposals of useful next steps for your backlog | Always allowed; proposals become drafts |

The action vocabulary in the contracts is: `prepare`, `research`, `communicate`, `send_quote`, `negotiate`, `place_order`, `accept_order`, `generate_deliverable`. The catalogue proposes a v2 vocabulary that adds `introduce`, `schedule`, `maintain_profile`, `publish`, `register`, `record_evidence` and `confirm_execution` (never pre-authorizable), plus standing mandates over context selectors, structured conditions and approval policies ([Action vocabulary v2](agent-catalog.md#action-vocabulary-v2-proposed)).

## Authority: mandates

A **mandate** is a structured, inspectable grant from you to your agent:

| Field | Meaning |
|---|---|
| Actions | Which of the verbs above |
| Contexts | Which projects, RFQs, quotes or agreements it applies to |
| Limits | Amount ceilings, counterparties or categories allowed, delivery terms required |
| Conditions | For example "only suppliers with a verified badge", "only if delivery before 1 March" |
| Budgets | Which transaction budget and which platform budget it may reserve from |
| Approval policy | Which actions need your explicit approval and which are pre-authorized |
| Escalation | What to do when a condition is missing: ask you, ask a named colleague, or stop |
| Valid until | Expiry |
| Revision and status | `draft → active → suspended | revoked | expired` |

Rules that never bend:

1. **A mandate can never exceed your own current rights.** If you lose the right (you leave the company, your grant on the project is revoked), every dependent mandate stops in the same transaction.
2. **Chat text never authorizes anything.** Saying "go ahead" in the conversation does not create or widen a mandate; the agent turns it into a proposed mandate change you confirm in a structured form.
3. **Approvals bind an exact action digest.** If the agent asks "may I place this order?" and anything material changes (price, quantity, supplier, terms), the approval is void and it must ask again.
4. **Everything is rechecked just before the effect**: your current rights, the mandate revision, participant access, limits and both applicable budgets.
5. **No mandatory confirmation clicks when a sufficient mandate exists.** If you pre-authorized "accept orders under USD 5,000 from verified buyers for catalogue items", the agent does not interrupt you for each one.

## Goals (Proposed)

A **goal** tells your agent what to achieve rather than what to click:

```text
Goal: "Find three facade subcontractors in the Austin area for project Riverside School, start in March."
Success: three accepted introductions with subcontractors that pass eligibility.
Allowed: research, communicate (introductions only, up to 10 requests), no commitments.
Horizon: until 15 December.
Report: every Friday.
```

- When you create a goal, the agent checks whether the current mandates allow it and proposes the missing mandate changes in one structured screen ("To pursue this goal I need: introductions up to 10, research in categories Facade works").
- The agent keeps a plan, a progress log with evidence (which candidates, why, what happened) and asks for decisions in the «Нужно ваше решение» list.
- Goals can be paused, edited or closed with an outcome. The weekly report is a draft you can share with colleagues.

## Negotiation

Negotiation between participants, whether people or agents, always moves through **structured objects**:

| Step | Object |
|---|---|
| Ask for proposals | RFQ version, introduction request |
| Propose | Quote version (immutable once sent) |
| Counter | Amendment request referencing exact lines, or a new RFQ version |
| Clarify | Question and answer attached to the version |
| Accept | Acceptance event bound to the agreement digest |
| Withdraw or decline | Status change with reason code |

Your agent negotiates inside your private constraints: a seller's floor, a buyer's ceiling and private priorities live in party-private records and **never** enter the counterparty projection, the shared thread, logs visible to others or federation envelopes. The agent never misrepresents facts, never claims to be a human, and never invents competing offers.

### Agents talking to agents (Proposed)

When your agent deals with someone else's agent, each message is an **agent envelope**:

| Field | Purpose |
|---|---|
| `from` | The principal (person, and company when acting for it) |
| `actor` | `agent` and a stable label "Anna's agent" |
| `context` | The RFQ, quote, agreement, introduction or event it belongs to |
| `intent` | `request_proposal`, `propose`, `counter`, `clarify`, `answer`, `accept`, `decline`, `withdraw`, `schedule_meeting`, `introduce`; the catalogue proposes `propose_slots`, `request_confirmation`, `express_interest` and `step_question` ([interaction patterns](agent-catalog.md#how-agents-meet-interaction-patterns)) |
| `refs` | Exact object versions with digests |
| `note` | Optional human-readable text, **untrusted for the receiver** |
| `mandate_digest` | A digest that proves a mandate exists without revealing its content |
| `expires_at` | When the proposal lapses |

The receiving agent treats the note like any e-mail: it can read it, never obey it. Only the structured parts move state, and only after the receiver's own mandate checks. The receiver's human sees a clear label: "proposal from Anna's agent on behalf of Fasad-Primer".

Protections:

- **Rate limits and quotas** per principal and per hub; agents share their human's introduction quota.
- **Escalation points**: any intent outside the receiver's mandate goes to their human.
- **Competition law**: agents of competing sellers never exchange pricing information through the platform, and the platform never relays one seller's quote to another. Matching and negotiation use only the requester's data.
- **No loops**: a negotiation session has a maximum number of rounds and an expiry; deadlock escalates to humans.

## Company representation

A company is represented in two ways, and both keep the rule "authority comes only from structured mandates".

### Through its people's agents

Someone with company authority grants a **company mandate** to a colleague's agent (for example a sales lead grants "answer RFQ invitations in category Facade works with draft quotes; send quotes under EUR 10,000 from the catalogue price list"). Such a mandate is visible on the company page to members with the right to see it, names the person whose agent executes it, and stops automatically when that person's authority or membership ends.

### Through the company representative (Proposed, owner decision 2026-10-30)

A company may enable **one standing representative** that keeps answering when people go on holiday, change roles or leave. It is designed so that continuity never costs accountability:

| Rule | Design |
|---|---|
| One per company | Enabled in «Компания → Представитель» by a company administrator; there is no list of representatives and no agent management screen |
| Always an accountable human | A current member with company authority is named **accountable person**. If they leave or lose authority, the representative suspends until another authorized member accepts the role |
| Authority only from mandates | Company mandates granted by members with the authority to grant them. The representative's effective authority is the intersection of its mandates and the company's current grants; it never exceeds what the granting member could do |
| Continuity with re-confirmation | When the member who granted a mandate leaves, the mandate is not silently inherited: another authorized member must re-confirm it within 7 days, or it suspends |
| Labelled everywhere | Every message, quote and acceptance reads "Representative of Fasad-Primer (accountable: Anna Primerova)"; counterparties always know they deal with an agent |
| Company money only | Commitments reserve from company transaction budgets; its own platform usage is billed to the company's platform budget |
| Visible and stoppable | Members with the right see its activity, mandates and pending decisions on the company page; any company administrator can suspend it instantly; the hub kill switch applies |
| Decisions go to people | Actions outside its mandates, or marked "needs approval", appear in the «Нужно ваше решение» list of the members named as approvers, in their own assistant |

Typical jobs: keep the capability profile and catalogue presentation current, answer RFQ invitations and introduction requests, propose and schedule meetings at events, negotiate within the company's floors, accept orders within limits, and send a weekly report to the accountable person.

Contract additions: a principal kind `company_representative` acting for the company; `representative(company, accountable_person, status, revision)`; company mandates whose grantee is the representative; re-confirmation records; suspension reasons.

### Open questions

- Who is liable for an agent's commitment in each country, and what makes an electronically formed agreement binding (O12).
- How agent disclosure must be worded under each country's consumer and advertising law.

## External channels

Connecting e-mail or messengers is **per channel, per scope, revocable**: for example "read and send messages in threads linked to RFQ contexts from this mailbox". There is no blanket mailbox, screen or company access. Incoming messages and files are untrusted content: they can inform drafts, never authorize actions or send to extracted addresses on their own.

## Money and outcomes

- Commitments reserve from a **transaction budget**; paid platform deliverables from a **platform budget**; one grant never implies the other.
- The run persists every step and checkpoint; a crash never loses an authority check or a reservation.
- A timeout or crash after a possible external effect sets `outcome_unknown`: the reservation stays, the provider is queried or a person reconciles; nothing is retried blindly.
- Revocation stops future steps; already completed external commitments are explained, and compensation may be needed instead of deletion.

## Models and data

Agents use model providers through adapters with **egress policies per data class**. A hub decides which providers are allowed in its territory (for example only models hosted in-country when personal data is involved, or local models only). Private chain-of-thought is never shown or stored as a log; the activity log shows actions, evidence and results. Model costs are platform usage and follow the platform budget rules. Metering, quotas and how a hub prices modules are in the [catalogue](agent-catalog.md#metering-quotas-and-hub-pricing); payment buys capacity for the payer's own work, never reach, rank, earlier alerts, introductions or badges.

## What you see

- **Conversation** (page and overlay).
- **Decisions waiting for you**, each with the exact action and what will happen.
- **Goals**, **mandates** and **runs** with their states (`proposed, authorized, reserved, queued, executing, pending, succeeded, failed, outcome_unknown, reconciling, revoked`).
- **Backlog** of proposed work, separate from any software development backlog.
- A **stop** control: suspend all mandates and all external connections at once.
- What the agent can do (modules as abilities), plans of the person's projects, reputation building and connections; per-participant first cards are in the [catalogue](agent-catalog.md#one-assistant-surface-for-every-participant).

## Safety engineering

- Tool access is an allowlist per action type; the model never gets a raw database or superuser channel.
- Inputs from files, e-mails, web pages and other agents are marked untrusted; injection tests are part of the acceptance suite.
- Hub operators have a **kill switch** for all agent dispatch in their hub; the instance operator has one for all hubs. The catalogue adds switches per hub module, for external connections, for the company representative and per connection ([Kill switches](agent-catalog.md#kill-switches)).
- Every action has an audit record and an idempotency key.

## Data model additions (Proposed)

Zod-shaped proposals for these and the catalogue additions (mandate v2, modules, plans and metering, plans of projects, consultations, reputation passport, external connections, kill switches) are in the [catalogue](agent-catalog.md#data-model-and-contract-additions).

| Entity | Key fields |
|---|---|
| `goal` | principal, text, success criteria, allowed actions, horizon, report cadence, status, revision |
| `goal_progress` | goal, event kind, evidence refs, at |
| `agent_envelope` | from principal, actor label, context ref, intent, refs with digests, note, mandate digest, expires_at, delivery status |
| `company_mandate` | company, granted_by, executor (person or company representative), mandate ref, visibility, reconfirmed_by, reconfirmed_at |
| `company_representative` | company, accountable person, status (`active`, `suspended`), suspension reason, revision |
| `negotiation_session` | context, parties, max rounds, expires_at, status |
