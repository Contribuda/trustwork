# Keys, providers and models

Status: connections, write-only secrets, synthetic tests, egress, routes, caps, cost records, kill switches and the call gate are **Live** as an API (KEYS-001, [providers module](../../../apps/api/src/modules/providers/README.md), no console wiring yet, contract additions in [`providers.ts`](../../../packages/contracts/src/providers.ts)); the model catalogue, pins, evaluation, canaries and dashboards are **Proposed**. Contract: `ProviderConnectionSchema`, `SecretRefSchema`, `SecretSubmitCommandSchema`, `looksLikeSecretValue`, `ConnectionTestResultSchema`, `ModelPricingSchema`, `ModelRouteSchema`, `EgressRuleSchema`, `egressDecision`, `ProviderBudgetSchema`, `providerBudgetState`, `KillSwitchSchema`, `UsageAggregateSchema` in [`hub.ts`](../../../packages/contracts/src/hub.ts); retrieval egress vocabulary (`DataClassSchema`, `ProviderBindingSchema`, `EgressPermitSchema`) in `retrieval.ts`. Proposed for the model catalogue (MODEL-001, not yet in contracts): `ModelCatalogEntrySchema`, `ModelVersionPinSchema`, `ModelEvaluationRunSchema`, `ModelRolloutSchema` and a `model` kill-switch scope. Screens HC-100…HC-106 in [screens](screens.md#keys-and-models). Backend: KEYS-001 (live); LLM-001 and MODEL-001 proposed.

A hub operator brings their own accounts: their own model provider keys or local models, their own e-mail sender, payment provider, maps, register access. The console makes connecting them easy and makes misusing them hard. The engine itself never holds a shared key, never calls a paid API without an operator's connection, and never sends private data anywhere the operator has not explicitly allowed.

## The administrator's complete control set

Owner decision of 2026-10-31 ([ADR 010](../../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 25): "The administrator must have a complete set of controls over the models in the system, their prices and the agents' functionality." This chapter covers the **models** part; prices and agent functionality are in [agent product administration](user-agents-admin.md#the-complete-control-set-adr-010-decision-25), which also holds the full control matrix and the guard rails no administrator can switch off. Every model control is a versioned hub configuration record with an audit entry, and every change that can widen what data leaves the node needs a second person.

| Control | What the administrator does | Where in this chapter | Package |
|---|---|---|---|
| Provider connections and keys | Connect, test, enable (second person), rotate, revoke | [Provider connections](#provider-connections), [secret storage](#secret-storage) | KEYS-001 |
| Model catalogue | Add a model, describe it, enable, disable, retire | [Model catalogue](#model-catalogue) | MODEL-001 |
| Pinned versions and rollback | Pin an exact provider revision; roll back to the previous pin in one action | [Pinned versions](#pinned-versions-and-rollback) | MODEL-001, LLM-001 |
| Routing | Choose the model per task class and per agent module or extension, with ordered fallbacks | [Models and routing](#models-and-routing) | KEYS-001, LLM-001 |
| Data-class egress | Allow or deny each data class per connection; default deny | [Egress policy](#egress-policy) | KEYS-001, LLM-001 |
| Region and residency | Record where each connection and model processes data; refuse routes outside the hub's residency for private classes | [Hosting](#hosting-and-brokers), [catalogue](#model-catalogue) | KEYS-001, MODEL-001 |
| Context and size limits | Per-model context window and output limit; per-route token, file-size and time limits within them | [Catalogue](#model-catalogue), [routing](#models-and-routing) | MODEL-001, KEYS-001 |
| Evaluation before activation | Safety suite plus a quality check on hub-defined samples before a model version serves anyone | [Evaluation](#evaluation-before-activation) | MODEL-001 (EVAL-001 harness) |
| Canary and staged rollout | Send a small share of eligible calls to a new version, compare, then widen or roll back | [Rollout](#canary-and-staged-rollout) | MODEL-001, LLM-001 |
| Kill switches | Per provider connection, per model, per job, per module; two-person release | [Kill switches](#kill-switches) | KEYS-001, MODEL-001 |
| Spending caps | Caps per hub, job, pipeline, module and connection with hard stop | [Spending caps](#spending-caps-and-budgets) | KEYS-001 |
| Cost and latency dashboards | Cost, latency, error and fallback rates by model version and cohort, never per person | [Dashboards](#usage-and-cost-dashboards) | LLM-001, MODEL-001, HUBC-002 |

## Provider connections

A **connection** is one configured adapter: what it can do (capabilities), how it runs (mode), where it processes data (hosting), how it authenticates (a secret reference), and whether it is enabled.

| Capability | Examples of adapters (candidates; each is engine code with a fake) | US example | Samarkand example |
|---|---|---|---|
| `llm` | OpenRouter (optional broker), OpenAI, Anthropic, Google, Mistral, any OpenAI-compatible endpoint including local servers (Ollama, vLLM, llama.cpp) | A vendor with zero-retention terms for public work; a local server for private data | Local server in Uzbekistan for anything non-public |
| `embeddings`, `rerank` | Same vendors or self-hosted multilingual models | Self-hosted multilingual model | Self-hosted |
| `image_generation` | Vendor image models | For labelled illustrations only | Same |
| `translation` | LLM-based or a dedicated translation API | en ↔ es | uz ↔ ru ↔ en |
| `speech_to_text`, `text_to_speech`, `ocr` | Vendor or self-hosted | Site-visit voice notes (private: local) | Same |
| `web_search`, `web_fetch` | A search API; the engine's own fetcher (respects robots) | Source discovery | Source discovery |
| `email`, `sms`, `messenger` | SMTP relay or e-mail API; SMS gateway; messenger bots where terms allow | E-mail and SMS with 10DLC registration | E-mail; Telegram where its terms allow business use |
| `payments`, `payouts` | Card and bank-transfer processors | Card and ACH through a Stripe-style processor | A domestic processor from the pack's payment facet; never Russian rails or sanctioned banks |
| `tax_calculation`, `e_invoicing` | Sales tax engines; national e-invoicing systems | State and local sales tax calculation | e-Faktura (candidate, from the pack) |
| `e_signature` | Signature platforms; national schemes | ESIGN/UETA-compliant e-signature platform | E-IMZO (candidate) |
| `register_lookup` | Business registers, licence boards | State Secretary of State business search, state contractor licence boards, SAM.gov entity data | Tax committee services (candidate) |
| `sanctions_list` | Baseline OFAC SDN and consolidated non-SDN lists in `file` mode (cannot be disabled, no key); additional lists, including the Consolidated Screening List with a key ([ADR 014](../../adr/014-sanctions-compliance-engine.md)) | Baseline plus, if the operator decides, the Consolidated Screening List | UN Security Council list and national lists from the pack |
| `maps_geocoding` | OpenStreetMap-based geocoders by default | Same | Same |
| `object_storage` | S3-compatible stores (usually a node-level connection) | US region | In-country |

### Modes

| Mode | Meaning | Who may set it |
|---|---|---|
| `fake` | Deterministic engine fake; no secret, no network, labelled "fake" wherever its results appear | Any staff with `admin.providers.connection.edit` |
| `manual` | A person performs the operation and records the result with evidence (typical for register look-ups and call-backs) | Same |
| `live` | Real calls with the operator's credentials | Enabling needs a passing test and a **second person** (`providers.enable_non_fake`) |

### Hosting and brokers

Every connection records where it processes data (`ProviderHostingSchema`): self-hosted with a country, or a vendor with a processing country, whether it retains inputs (`zeroRetention`), whether it trains on inputs (`trainsOnInputs`) and whether it is a **broker**. OpenRouter is optional and is modelled as a broker: requests pass through it to another vendor, so both parties' terms apply. The console asks the operator to record the routed vendors' retention terms and, by default, allows brokers for the `public` data class only.

## Secret storage

Secrets are **write-only** in the console.

1. The operator pastes a key into a `SecretField` and gives a reason. The browser sends it once to the secret endpoint (`SecretSubmitCommandSchema`), over the same-origin API with CSRF protection and an elevated session.
2. The API encrypts it with a fresh data key (envelope encryption) and stores only ciphertext; the data key is wrapped by the node's key-encryption key (from the environment or a file at minimum; an external KMS or Vault adapter in production).
3. Every read model shows a `SecretRef` only: store, reference name, version, a **keyed fingerprint** (HMAC under a node key, truncated to 12 hex characters, so staff can see a rotation happened without learning anything about the value), created, rotated and last used times. There is no reveal button, no copy button, no export, and `looksLikeSecretValue` makes the contracts reject a reference that contains something key-shaped.
4. Plaintext exists only in the memory of the process that calls the adapter, for the duration of the call. Secrets never appear in logs, audit events (the audit records "secret version 3 written" with the fingerprint), outbox payloads, error messages, backups in plaintext, or federation.
5. **Rotation**: paste a new value; the old version stays usable for a grace period chosen by the operator (default 24 hours) and is then destroyed. **Revocation**: destroy immediately; the connection moves to `disabled`.

## Connection tests

"Test connection" sends **only engine-supplied synthetic input** (`syntheticInputOnly: true`): an authentication check, a model list where the API has one, and a tiny canned request (for an LLM, a fixed public sentence; for e-mail, a message to the tester's own verified address; for payments, a sandbox-mode call where the provider has one). The result records outcome, latency, models listed and the **cost of the test** where the provider reports it. Outcomes: `ok`, `auth_failed`, `unreachable`, `rate_limited`, `quota_exceeded`, `residency_mismatch` (the endpoint's declared or detected region contradicts the hub's residency), `model_missing`, `error`. A connection can be enabled only after an `ok` test.

## Model catalogue

A connection says **where** calls go; the **model catalogue** says **which models** of that connection the hub has decided to use (MODEL-001). Nothing can be routed to a model that is not an enabled catalogue entry.

| Field of a catalogue entry (`ModelCatalogEntrySchema`, proposed) | Meaning |
|---|---|
| Connection and provider model id | The adapter and the model name as the provider knows it |
| Description | What the hub uses it for, in the hub's languages (shown to staff and, in plain words, on the public AI disclosure page) |
| Capabilities | Jobs it may serve (`MODEL_JOBS`), modalities (text, image, audio), tool calling, structured output |
| Context window and output limit | Maximum input and output tokens the provider documents; route limits can never exceed them |
| Maximum file size and page count | For OCR, speech and document jobs |
| Processing regions | Countries where the provider processes and stores inputs for this model, with the source of that statement |
| Retention and training terms | Copied from the connection and overridable only to be stricter |
| Cost price | The current `ModelPricingSchema` record (see [prices](#models-and-routing)) |
| Status | `draft → evaluated → enabled → disabled → retired` |

- **Add** creates a draft from a model the connection test listed, or by hand for local servers. **Describe** is free text plus the structured fields above. **Enable** requires a passing evaluation (below) and, for any model that may receive a non-public data class, a second person. **Disable** stops new calls at once (routes that use it fall back or stop). **Retire** keeps the entry, its versions and its evaluation history for audit and refuses new use; a retired entry cannot be re-enabled, only re-added as a new draft.
- A provider that announces a model's end of life produces a console alert with the date; the administrator chooses a replacement through the normal evaluation and rollout, never by automatic substitution.
- The catalogue lists only models of connections whose hosting country is not a restricted place; such connections are refused at configuration time (LLM-001).

### Pinned versions and rollback

Every active route names an exact provider revision (`ModelRefSchema.modelRevision`, frozen in a `ModelVersionPinSchema` record), never a moving alias such as "latest". Where a provider offers only aliases, the hub records the alias and the date it was observed, and a change detected by the connection test is an alert, not a silent switch. Changing a pin is a new route version that goes through evaluation and, if chosen, a canary. **Rollback** reactivates the previous pin of the same route in one action by one person with a reason (it narrows risk, so no second person is needed), takes effect for the next call and is recorded; calls already running finish on the version they started with. Embedding routes are pinned per index generation and roll back only by reactivating the older generation ([search and knowledge](modules.md#search-and-knowledge)).

## Models and routing

The operator chooses **which model serves which job**. Jobs (`MODEL_JOBS`):

| Job | Used by | Default data classes allowed | Notes |
|---|---|---|---|
| `editorial_rewrite`, `summarisation` | Editorial office | `public` | Source licence must allow model use |
| `translation` | Editorial office, publications, templates; participants' own translations through their agent | `public` for editorial; private classes only on routes approved for them | |
| `fact_check_assist`, `classification`, `entity_resolution_assist` | Editorial office, data mining | `public` | |
| `agent_reasoning`, `agent_drafting` | Participants' agents | Whatever the operator approves; private classes need a second person | Usually a self-hosted or zero-retention in-residency route |
| `moderation_triage` | Moderation queues (suggestions only) | `public` plus reported content under the moderation case | Never decides |
| `embeddings`, `rerank` | Search and knowledge | Frozen per index generation | **No fallbacks** for embeddings: vectors from different models never mix |
| `image_generation` | Editorial illustrations | `public` only, enforced by the contract | Output always labelled AI-generated |
| `speech_to_text`, `text_to_speech`, `ocr` | Voice notes, accessibility, document intake | Private classes usually | Usually self-hosted |

Routes are chosen **per task class and per agent module**. A route's scope is a job (the task class), optionally narrowed to one agent module or one extension; the gateway resolves the most specific active route first (extension, then module, then job) and refuses the call if none exists. This is how the administrator sets the model each module uses (for example a self-hosted model for `negotiator` drafting and a zero-retention vendor model for `research` on public data), without touching the module's code (KEYS-001, LLM-001).

A **route** (`ModelRouteSchema`) names a primary model, up to three ordered **fallbacks** (used on `unreachable`, `rate_limited` or timeout, never to escape an egress denial: a fallback is used only if the egress decision allows it too), the data classes it may carry, token and time limits, and a spending cap. Routes are versioned; activating a route that may carry any non-public data class needs a second person (`models.activate_private_route`).

Every model in a route must be an enabled catalogue entry with a pinned revision, and the route's token, file-size and time limits must fit the entry's context window and size limits.

**Cost price per model** (`ModelPricingSchema`) records what the operator pays per million input and output tokens, per image or per audio minute, from the provider's list, a contract, or measured averages. It feeds cost dashboards and the cost price shown beside every sale price in the agent product ([agent product](user-agents-admin.md#cost-price-and-sale-price)). Cost records are versioned with the date and source of each figure; a new cost record never changes a participant's price by itself (see [prices](user-agents-admin.md#prices-for-models-and-capabilities)).

## Evaluation before activation

No model version serves participants or the editorial office until it has passed two checks on the hub's own configuration (MODEL-001):

1. **Safety.** The agent safety suite (EVAL-001 harness: prompt injection in files, mail, web pages and other agents' notes; mandate widening through chat; floor and budget leakage; competitor price relay; loops; egress) runs against the candidate on the route and data classes it would serve. Any failure blocks activation.
2. **Quality.** A quality check on **hub-defined samples**: the administrator keeps sample sets per job (for example twenty public news items for `summarisation`, thirty English and Spanish templates for `translation`) with expected properties and a pass threshold. Samples contain only `public` or synthetic data; private records are never copied into a sample set. Results are compared with the version currently in service and shown side by side.

An evaluation run (`ModelEvaluationRunSchema`, proposed) records the candidate, the route, the suite and sample-set versions, the scores, the threshold, who ran it and when. Results expire after an engine update or a provider revision change, and the safety suite re-runs on every engine release; a version that then fails is suspended and its routes fall back or stop, with an alert.

## Canary and staged rollout

A new model version can replace the old one at once (after evaluation and the second person where required) or in **stages**: a canary share (for example 5 percent of eligible calls), then wider shares (25, 50, 100 percent) chosen by the administrator (`ModelRolloutSchema`, proposed). Rules:

- A call joins the canary by a deterministic hash of the run or request id, never by choosing particular people, companies or cohorts for experimentation.
- The candidate must pass the same egress, residency and limit checks as the current version for every data class the route carries; a canary can never be a way to send a private class somewhere new.
- Each stage shows error, fallback, latency, cost and safety-signal rates for both versions; crossing a hub-set guard threshold (for example error rate twice the baseline) stops the rollout and returns all calls to the current version automatically, with an alert.
- Widening a stage is one person; reaching 100 percent of a route that carries non-public classes needs a second person; rollback is always one action.
- Embedding routes never canary (vectors from two models never mix); they switch by index generation.


## Egress policy

Before any data leaves the node for a provider, the engine computes `egressDecision` for the exact data class and connection. The console edits the matrix behind it: rows are data classes (`public`, `person_private`, `company_private`, `project_restricted`, `deal_party_private`), columns are enabled connections, and each cell is **allow** or **deny** (a missing cell is deny).

Rules that no cell can override:

- Default deny. A new connection carries nothing until a cell allows it.
- Allowing any non-public class needs a second person (`egress.allow_private_class`), **in-residency processing** and **zero retention** (`EgressRuleSchema` refinement).
- A vendor that trains on inputs never receives a non-public class, whatever the cell says (`reason: 'training'`).
- A disabled or killed connection receives nothing (`connection_not_enabled`).
- The source licence still applies on top: an item from a source that forbids model use is never sent, whatever its data class.
- Retrieval keeps its own four checkpoints (candidacy, hydration, egress, delivery); the matrix is the hub's policy input to the egress checkpoint ([retrieval](../../architecture/retrieval.md)).

Each denial is explained in the console with its reason code, and the overview shows a "private data can reach: …" sentence the hub owner signs off for the `ai_egress_policy_reviewed` launch gate. For the US example the default is: public data to the chosen vendor; every private class to the self-hosted server only. For Samarkand: everything non-public to the in-country server only; public data to a vendor if the operator allows it.

## Spending caps and budgets

Two different kinds of money are involved and the console never mixes them:

| | Operator spending caps (`ProviderBudgetSchema`) | Participants' platform budgets (`BudgetSchema` in `billing.ts`) |
|---|---|---|
| Whose money | The hub operator's provider bills | A participant's spending on platform services |
| Scope | Hub, job, pipeline, agent module, connection; per day or month | Person or company, project or employee scope |
| On exhaustion | `pause` (pipelines stop and resume next period) or `deny_new` (new paid calls refused); there is no overspend state | The action needing the budget is refused; the participant decides |

Alerts at chosen percentages (for example 50 and 80 percent) appear in the overview and, if configured, by e-mail to staff. Every active pipeline must name a cap (`PipelineVersionSchema`).

## Kill switches

Kill switches stop things immediately: a provider connection, a single model (every route that uses it falls back or stops; proposed `model` scope, MODEL-001), a model job, a pipeline, an agent module or action, all agent dispatch in the hub, external agent access, outbound messages, or (in the node console) the whole node. Engaging needs one person with `admin.providers.kill` or `admin.agents.kill` and a reason. Releasing needs **a second person and an incident note** (`KillSwitchSchema`, `kill_switch.release`). Engaged switches are shown on every console page as a band. Work stopped by a switch ends in `stopped_by_kill_switch`; anything whose external outcome is unknown goes to reconciliation, never to a blind retry.

## Usage and cost dashboards

`UsageAggregateSchema` rows aggregate calls, tokens, images, audio seconds and cost by day, job, connection, model, pipeline and agent module. The dashboards show:

- Spend this period against each cap, with the projection to period end (labelled as a projection).
- Cost by job and by model; cost per published editorial item; cost per agent run per module.
- Cost price against revenue for each agent module (from billing), with negative margins highlighted.
- Error and fallback rates per connection (operational health, not per-person data).
- Latency (median and 95th percentile) and cost per call by model version, route and stage, with the canary and the current version side by side.
- Cost and usage by **cohort**: participant type, plan and agent module; every participant count below ten is suppressed (`suppressSmallCount`).

They never show per-person usage, prompts or outputs. Per-billing-account usage needed for invoices lives in billing and is visible to commercial admins as invoice lines, not as activity timelines.

## Acceptance (when implemented)

- No API response, page, log line, audit event, outbox payload or export contains a secret value (automated scan with seeded canary secrets).
- Enabling a live connection without a passing test or without a second person fails.
- A non-public data class is refused for a connection without an allow cell, outside residency, with retention, or with training on inputs.
- An embeddings route with a fallback cannot be saved.
- An exhausted cap blocks the next paid call in the same second.
- Releasing a kill switch without a second person or an incident note fails.
- A route that names a model which is not an enabled catalogue entry, has no pinned revision, or exceeds the entry's context window cannot be activated.
- A model version without a passing safety suite and quality check cannot serve any call; a rollback restores the previous pin for the next call.
- A canary never carries a data class the current version may not carry, and crossing the guard threshold returns all calls to the current version.
- No dashboard response contains a row for one person.
