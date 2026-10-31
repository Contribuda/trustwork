# Data model view of the console

Status: **Proposed** design over the frozen console contract 1.0.0 ([Frozen contract](README.md#frozen-contract)). This view maps every console section to the entities it **reads** and **writes** and the **projection layer** it may use. The project-wide data model is [`docs/data/model.md`](../../data/model.md) (being completed in a separate work stream); this view follows its conventions and does not redefine its entities:

- Tables are `snake_case`; contract fields are `camelCase` (`HubSourceSchema.allowedUses` ↔ `source.allowed_uses`).
- **Five projection layers** for customer data: `public`, `shared_party`, `party_private`, `owner_private`, `staff_case` (`ProjectionLayerSchema`). Staff use `public` and, only under a case or dispute grant, `staff_case` (a diagnostic subset ranked beside `shared_party`, never a superset). The console never uses `party_private` or `owner_private` for customer objects.
- **Party XOR**: every owner or payer is exactly one person or one company (`PartySchema`; database XOR over nullable foreign keys).
- **Versioned records** for configuration, prices and policies: a new row per version with `drafted_by`, `activated_by`, `approval_id`, `effective_from`; never edited in place once active.
- Console-owned configuration (providers, routes, pipelines, policies) is **staff configuration**: it contains no customer data and has no customer projection; it is read and written only through admin use cases with `admin.*` permissions and audit.
- Operational aggregates (counts, costs, durations) are computed views; any count about participants is a cohort of at least ten or suppressed.

## New entities proposed by the console

| Table | Contract | Key fields | Owner module |
|---|---|---|---|
| `hub` | `HubSchema` | node, slug, name per locale, lifecycle, country pack binding, default locale, locales, time zone, currency, brand overlay, revision | hubs |
| `hub_territory` | `HubTerritorySchema` | hub, level, code, wikidata, osm relation | hubs |
| `hub_config_version` | `HubConfigVersionSchema` | hub, domain, version, payload, payload digest, status, reason, drafted_by, activated_by, approval_id, effective_from; domains include `jurisdiction` (`JurisdictionSettingsRefSchema`, full payload HUB-005), `payments` (`HubPaymentSettingsSchema`), `agents` (`HubAgentPolicySchema`) and `agent_extensions` | hubs |
| `hub_modes_version` | `HubModesSchema` (payload of `hub_config_version` domain `modes`) | data mode, registration, modules, moderation, automation per domain, indexing, maintenance | hubs |
| `launch_gate` | `LaunchGateSchema` | hub, gate, state, evidence ref, checked_by, checked_at | hubs |
| `setup_state` | `SetupStateSchema` | node, completed steps, current, setup token hash, expiry, first admin | hubs |
| `staff_role_assignment` (scope extended) | `ScopedStaffRoleAssignmentSchema`, `ScopedStaffRoleDefinitionSchema` | person, role, scope (`platform`, `node` + node id, or `hub` + hub id), definition version, granted_by, approved_by, breakglass, incident ref, validity, revoked_at, revoked_by | platform-admin |
| `second_person_approval` (action set and scope extended) | `ConsoleSecondPersonApprovalSchema` | action from `CONSOLE_SECOND_PERSON_ACTIONS`, scope, action digest, requested_by, approved_by, approved_at, expires_at (at most 72 hours), revoked_at | platform-admin |
| `admin_audit_event` (console form) | `ConsoleAuditEventSchema` | sequence, actor, scoped role, scope, console permission, elevation, approver and approval digest, action, object, before/after digests, reason, outcome | platform-admin |
| `secret_ref` / `secret_version` | `SecretRefSchema` | store, ref, keyed fingerprint, version; ciphertext and wrapped data key in `secret_version` (never readable through any API) | providers |
| `provider_connection` | `ProviderConnectionSchema` | scope (node XOR hub), adapter, capabilities, mode, endpoint, secret ref, hosting, status, enabled_by, approval_id | providers |
| `connection_test` | `ConnectionTestResultSchema` | connection, at, by, outcome, latency, models listed, cost | providers |
| `model_pricing` | `ModelPricingSchema` | connection, model, currency, prices per unit (decimal), basis, observed_at | providers |
| `model_route` | `ModelRouteSchema` | hub, job, version, primary, fallbacks, allowed data classes, limits, budget, status, drafted_by, activated_by, approval_id | providers |
| `egress_rule` | `EgressRuleSchema` | hub, connection, data class, decision, residency and retention requirements, version, approval_id | providers |
| `provider_budget` | `ProviderBudgetSchema` | hub, scope, period, limit (minor units + currency), alerts, on exhausted | providers |
| `kill_switch` | `KillSwitchSchema` | scope, state, engaged_by, reason, released_by, release approval, incident note | providers / platform-admin |
| `usage_aggregate` | `UsageAggregateSchema` | hub, period, job, connection, model, pipeline, module, counts, cost | providers |
| `source` (extends the existing design) | `HubSourceSchema` | hub, kind, purposes, licence, robots check, terms check, allowed uses, attribution, takedown contact, owner, personal data, legal basis, proposed_by, status, activated_by, pause reason | sources |
| `content_type_mapping` | `ContentTypeMappingSchema` | source, version, rules, status | sources |
| `dataset` | `DatasetSchema` | hub, subject, sources, purpose, legal basis, personal data categories, impact assessment ref, retention, outputs, public display, subject notice, schedule, status, approval_id, version | data-mining |
| `link_proposal` | `LinkProposalSchema` | hub, left ref, right ref, evidence, confidence, proposed_by, status, decided_by; effect always `link` | data-mining (federation reuses it) |
| `schedule` | `ScheduleSchema` | hub, pipeline, cron, time zone, windows, jitter, quotas, retry policy, concurrency, alerts, paused | pipelines |
| `pipeline`, `pipeline_version` | `PipelineVersionSchema` | hub, kind, version, steps, sources, dataset, automation level, budget, schedule, status, drafted_by, activated_by | pipelines |
| `pipeline_run`, `pipeline_run_step` | `PipelineRunSchema` | pipeline version, trigger, dry run, state, attempt, triggered_by, times, counts, cost, effects committed, error code | pipelines |
| `pipeline_alert` | `AlertRuleSchema` (rule) | schedule, rule, first and last occurrence, acknowledged_by | pipelines |
| `editorial_item` | `EditorialItemSchema` | hub, run, sources with digests, languages, stage, treatment, AI flags, similarity, fact checks, image, attribution, editor, review, publication | editorial-office |
| `agent_module_version` | `AgentModuleVersionSchema` | hub, key, version, actions, eligibility, routes, limits, metering, status, drafted_by, activated_by, approval_id | agent-product |
| `metered_price_version` | `MeteredPriceVersionSchema` | hub, offer, module, unit, version, currency, cost price, cost basis, sale price, effective dates, acceptance text version, status, drafted_by, activated_by | billing |
| `agent_plan_version` | `AgentPlanVersionSchema` | hub, offer, version, payer kind, includes, trial days, status | billing |
| `marketplace_fee_version` | `MarketplaceFeeVersionSchema` | hub, kind (consultation, task, ticket, course, agent capacity), category, version, currency, basis points, fixed amount, payer, effective dates, disclosure, status, drafted_by, activated_by, approval_id | billing (BILL-003) |
| `agent_extension_version` (reference) | `AgentExtensionVersionRefSchema` | extension, hub, key, version, manifest digest, declared actions with mandate kinds, data classes read and sent, endpoints with country, adapter, safety suite result, status, drafted_by, approved_by, approval_id, activated config version | agent-extensions (AGT-023) |
| `external_agent_client` | `ExternalAgentClientSchema` | hub, acting person (+ optional party), protocol, scopes, private data classes (opt-in, empty by default), opt-in time, credential ref, rate limits, status | external-agents |
| `plan_template_version` | `PlanTemplateVersionSchema` | hub, key, version, country, project type, phases and items, references, authors, reviewed_by, status | planner |
| `marketplace_category_rule` | `MarketplaceCategoryRuleSchema` | hub, category, kind, who may offer, recipe, licence category, pricing, refunds, agent automation, version | marketplace |
| `knowledge_share` | `KnowledgeShareSchema` | hub, kind, project, owner party, named parties, consents, status, reviewed_by, publication | shared-knowledge |
| `procurement_template` | `ProcurementTemplateSchema` (payload of `hub_config_version` domain `procurement`) | hub, kind (approval route, document requirement set, match tolerance, fraud-control defaults, intake settings, benchmark policy, pooling rules), key, version, payload, counsel sign-off ref (benchmarks, pooling), status, drafted_by, activated_by | procurement (PRC-001, PRC-010, PRC-011, PRC-012, PRC-019, PRC-022) |
| `recommendation_rule` | `RecommendationRuleSchema` | hub, version, plan category, item kinds, recommends, signals, status | recommendations |
| `sponsored_content_policy` | `SponsoredContentPolicySchema` | hub, version, allowed, slots, exclusions | recommendations |
| `credential_type` | `CredentialTypeSchema` | hub, key, version, subject, claim, recipe, validity, portability, status | credentials |
| `issued_credential` | `IssuedCredentialSchema` | hub, type, holder party, evidence refs, decided_by, issued/expires, signing key id, digest, status list index, status, revocation | credentials |
| `confirmation_policy` | `ConfirmationPolicySchema` | hub, version, limits | credentials |
| `account_service_action` | `AccountServiceActionSchema` | hub, case, subject person, action, requested_by, approved_by, evidence, effective_at, state | support |
| `backup_record`, `restore_drill` | `BackupRecordSchema`, `RestoreDrillSchema` | node, kind, times, encryption, manifest digest; drill checks, measured times, performer, witness, outcome | operations |

Existing or already-designed entities the console uses (defined in [`docs/data/model.md`](../../data/model.md), [Hub administration](../hub-administration.md#data-model-proposed) and module chapters): `person`, `company`, `membership`, `company_claim`, `object_participation`, `case_access_grant`, `second_person_approval`, `admin_audit_event`, `access_log`, `staff_role_definition_version`, `moderation_case`, `deletion_request`, `erasure_tombstone`, `legal_document_version`, `counsel_approval`, `import_batch`, `verification_recipe`, `verification_check`, `screening_list`, `screening_result`, `peering_agreement`, `publication`, `publication_version`, `issue`, `issue_revision`, `render_artifact`, `event`, `ticket_type`, `ticket_price_version`, `registration`, `check_in`, `course`, `certificate`, `capability_profile`, `open_need`, `introduction`, `outreach_quota`, `match_run`, `rfq`, `quote`, `agreement`, `order`, `dispute`, `reputation_snapshot`, `method_version`, `offer`, `plan_version`, `price_version`, `price_acceptance`, `entitlement`, `usage_event`, `credit_ledger`, `invoice_ref`, `payout_batch`, `template_version`, `send_receipt`, `notification`, `index_generation`, `embedding_config`, `outbox_event`, `job`, `external_outcome`, `reconciliation`.

## Section map

"Writes" always means "through the owning module's use case". "Layer" is the projection used for customer data in that section; `config` means staff configuration without customer data; `aggregate` means computed counts with cohort suppression.

| Section | Reads | Writes | Layer |
|---|---|---|---|
| Overview | `launch_gate`, queue counts from every module, `second_person_approval`, `provider_budget` state, `kill_switch`, health aggregates | — | aggregate, config |
| Approvals | `second_person_approval` with the action payload digest and diff | `second_person_approval` | config |
| Hub: identity, modes, modules | `hub`, `hub_territory`, `hub_config_version` | `hub`, `hub_territory`, `hub_config_version` | config |
| Hub: legal | `legal_document_version`, `counsel_approval`, operator record, `screening_result` (operator) | same | config |
| Hub: residency | `hub_config_version` (residency), `provider_connection` hosting, sub-processor register (derived) | `hub_config_version` | config |
| Hub: country base, taxonomy | Country pack (code), local additions, taxonomy versions | local additions, taxonomy versions | config |
| Hub: launch | `launch_gate`, `restore_drill`, locale completeness | `launch_gate`, lifecycle transition request | config |
| Participants: people | `person` public projection, account state counts, consent records | consent and portrait licence records, flags | public, aggregate |
| Participants: companies | `company` public projection, sourced records with provenance, `company_claim`, representative state | claim decisions, verification revocation, import activation | public; `staff_case` for claim evidence under the claim review grant |
| Participants: claims, verification | `company_claim`, `verification_recipe`, `verification_check`, `screening_result` | decisions, recipes | `staff_case` (evidence class) |
| Participants: credentials | `credential_type`, `issued_credential` | both | public (credential status), `staff_case` for evidence |
| Support: lookup, account card, company card | `person`, `email_binding` (masked), `session` (count), `membership`, `entitlement`, consent records, support cases | `account_service_action`, support case | `staff_case` (`diagnostic`) for the card allowlist; public for company pages |
| Support: cases and grants | `case_access_grant`, `access_log`, granted objects | `case_access_grant`, case | `staff_case` only within the grant |
| Support: access explainer | policy decision for (principal, object) | — | reason codes only, no object content |
| Editorial: sources, discovery | `source`, `content_type_mapping`, checks | same | config (+ public source items) |
| Editorial: pipelines | `pipeline_version`, `schedule`, `model_route`, `provider_budget` | `pipeline_version` | config |
| Editorial: review, calendar, translations | `editorial_item`, source items, `publication_version` | `editorial_item` review, publication drafts and schedules | public (all editorial material is public-source or editorial) |
| Editorial: publications, magazine | `publication`, `publication_version`, `issue`, `issue_revision`, `render_artifact` | corrections, retractions, holds, issue curation and release | public; `staff_case` for holds on personal posts under a moderation case |
| Data: datasets, batches, links | `dataset`, `import_batch`, `link_proposal`, sourced records | same | public (sourced records), `staff_case` for subject objections |
| Data: knowledge | `index_generation`, `embedding_config`, evaluation summaries | generation transitions | config, aggregate |
| Data: recommendations | `recommendation_rule`, `sponsored_content_policy`, taxonomy mapping, quality aggregates | rules and policy versions | config, aggregate |
| Modules: projects | published project projections, counts, transfer disputes | holds, dispute decisions | public; `staff_case` under dispute grants |
| Modules: planner | `plan_template_version` | same | config (templates hold no customer data) |
| Modules: marketplace | `marketplace_category_rule`, request and engagement counts, payouts, disputes | rules, refund decisions, commission fee versions (`marketplace_fee_version`) | config, aggregate; `staff_case` under dispute grants |
| Modules: shared knowledge | `knowledge_share`, consent records, the draft publication | review decisions, publication | public after consent; drafts visible to reviewers as consented material |
| Modules: events | `event`, `ticket_type`, `ticket_price_version`, registration and check-in counts, payouts, refunds | reviews, holds, refunds, payout release requests | public, aggregate; `staff_case` for attendee data under a case |
| Modules: learning | `course` versions, `certificate`, accreditation records | reviews, revocations, accreditations | public |
| Modules: matching | `open_need`, `partner_post`, introduction counts, method versions | holds, quotas, method releases | public, aggregate |
| Modules: commerce | RFQ, quote, agreement and order **counts and states**, `external_outcome`, `reconciliation` | category rules, reconciliation records | aggregate; `staff_case` under case grants (`negotiation_private` always excluded) |
| Modules: procurement and supply | `hub_config_version` domain `procurement` (route templates, requirement-set templates, tolerance and fraud-control defaults, intake settings, benchmark and pooling policy), `procurement_template` rows, `provider_connection` for e-invoicing, accounting and extraction adapters, cohort counts of documents processed and cycle times | the same configuration records; never a company's routes, suppliers, budgets, invoices, stock or payments | config, aggregate (cohort of at least ten companies); `staff_case` under case grants only for reconciliation of unknown payment or e-document outcomes |
| Trust: moderation | `moderation_case`, reported public content | case decisions, sanctions | public; `staff_case` for reported private content under the case |
| Trust: disputes, reputation, appeals | `dispute`, evidence, `reputation_snapshot`, `method_version`, appeals | evidence decisions, exclusions, method releases, appeal decisions | `staff_case` (evidence) under dispute grants; public snapshots |
| Trust: screening, confirmations | `screening_list`, `screening_result`, `confirmation_policy` | lists, review decisions, policy versions | `staff_case` (evidence) |
| Agents | `agent_module_version`, `metered_price_version`, `agent_plan_version`, `external_agent_client` counts, `AgentUsageStat` aggregates, abuse cases | module and policy versions, kill switches | config, aggregate |
| Billing | `offer`, `plan_version`, `price_version`, `metered_price_version`, acceptance counts, invoice runs, `payout_batch`, `credit_ledger` | versions, credits, refund policy, payout release | config, aggregate (per billing account totals for invoicing only) |
| Keys and models | `provider_connection`, `secret_ref` (never `secret_version` content), `connection_test`, `model_pricing`, `model_route`, `egress_rule`, `provider_budget`, `usage_aggregate`, `kill_switch` | same, plus `secret_version` through the write-only command | config, aggregate |
| Automation | `schedule`, `pipeline_run`, `pipeline_run_step`, `pipeline_alert` | schedules, manual and dry runs, pauses, acknowledgements | config |
| Communications | sender identities, `template_version`, delivery aggregates | templates, activations, announcements | config, aggregate |
| Federation | `peering_agreement`, manifest licences, tombstones, incoming `link_proposal` | peering, licences, link decisions | public (replicas), config |
| Privacy | `deletion_request`, export requests, retention classes, legal holds, breach register | decisions, holds, retention versions | `staff_case` limited to request handling; exports go to the subject |
| Staff and audit | `hub_staff_assignment`, `staff_role_definition_version`, `admin_audit_event`, `access_log` | assignments, conflicts, exports | config (audit holds digests, not payloads) |
| Operations | health aggregates, `job`, `outbox_event` ages, `backup_record`, `restore_drill`, flags, incidents, locale completeness | flags, maintenance, incidents, drills | aggregate, config |
| Node console | `hub` list, node staff, node connections, updates, backups, node keys | same | config |
| Setup wizard | `setup_state` | `setup_state`, `hub`, `hub_territory`, `hub_config_version`, `launch_gate`, first `hub_staff_assignment` | config |

## Invariants the data model must carry

1. No console path reads `party_private` or `owner_private` customer data; `staff_case` reads require an active `case_access_grant` and produce `access_log` rows.
2. `secret_version` ciphertext is readable only by the provider adapter runtime; no view, API or export includes it.
3. Every versioned record (`hub_config_version`, `model_route`, `egress_rule`, `pipeline_version`, `agent_module_version`, `metered_price_version`, `plan_template_version`, `recommendation_rule`, …) is immutable once active; changes add a version.
4. `link_proposal.effect` is always `link`; no table supports merging two parties.
5. No table stores a score, rank or position set by staff; reputation snapshots are computed from evidence by a released method.
6. Aggregates about participants suppress cohorts under ten at the query layer, not only in the UI.

## Naming reconciliation (HUBC-000)

HUBC-000 compared the console contract with [`docs/data/model.md`](../../data/model.md) (snake_case tables, projection layers, Party XOR, versioned records). Conventions already agree: tables are snake_case and contract fields camelCase; owners and holders are `PartySchema`; configuration, prices and policies are versioned records with `drafted_by`, `activated_by`, `approval_id` and `effective_from`; console configuration is staff configuration with no customer projection. The differences below are recorded with their resolution. "Contract" means the console contract keeps its name and the data model row is updated by the package that writes the migration; "data model" means the contract was changed in HUBC-000.

| Contract | Data model | Difference | Resolution |
|---|---|---|---|
| `ScopedStaffRoleAssignmentSchema` (was `HubStaffAssignmentSchema`) | `staff_role_assignment` | Console had its own table name and only node or hub scope | Data model: one `staff_role_assignment` with scope `platform`, `node` or `hub` (ADR 012 decision 1); `breakglass`, `incidentRef`, `revokedBy` and `definitionVersion` added to the contract |
| `ConsoleSecondPersonApprovalSchema` | `second_person_approval` | Action enum limited to the frozen A+2 set; no scope | Contract: action set is `CONSOLE_SECOND_PERSON_ACTIONS`, plus a scope; the frozen `SecondPersonApprovalSchema` in `admin.ts` stays for the A+2 actions |
| `ConsoleAuditEventSchema` | `admin_audit_event` | Frozen audit schema accepts only `ADMIN_PERMISSIONS` and platform roles | Contract: the console form uses `ConsolePermissionSchema`, `HubStaffRoleSchema` and the scope; ADM-001 stores both forms in `admin_audit_event` |
| `HubSchema.slug`, `.lifecycle`, `.countryPack`, `.brandOverlay` | `hub.key`, `.status`, `pack_code` + `pack_version`, `brand_ref` | Names differ; `successor_hub_global_id` exists only in the data model | Contract names (`lifecycle` avoids one more generic `status`); HUB-001 names the columns after the contract; the successor id is added when hub closing is implemented |
| `HubTerritorySchema` level `place` | `hub_territory.level` `city` + `place_key` | Contract places cover cities, counties and districts; code grammar is `JurisdictionCodeSchema` | Contract |
| `LaunchGateSchema` states `open`, `passed`, `invalidated` | `launch_gate.state` `open`, `satisfied`, `invalidated` | Contract had no invalidation; names differ (`passed` and `satisfied`); 14 gates against "12 checklist gates" | Data model's `invalidated` adopted (with `invalidatedAt` and `invalidationReason`); contract keeps `passed` and the 14 gates (two proposed by the console) |
| `HUB_CONFIG_DOMAINS` | `hub_config_version.domain` | Data model has `events_learning`; contract splits `events` and `learning` and adds `modes`, `residency`, `country`, `screening`, `matching`, `providers`, `routing`, `egress`, `budgets` | Contract; HUBC-000 added the data model's `tax` and `jurisdiction` and the decision 20 and 22 domains `payments` and `agent_extensions` (`jurisdiction`, `payments` and `agent_extensions` are sensitive) |
| `SecretRefSchema` | `provider_credential_ref` (section 24), `secret_ref` / `secret_version` (this view) | Two names for the reference | Contract: `secret_ref` with `secret_version` ciphertext; `provider_connection.secret_ref` replaces `provider_credential_ref` (KEYS-001) |
| `ProviderBudgetSchema` | `provider_cost_budget` | `hard_stop bool` against `onExhausted` `pause` or `deny_new` | Contract (there is no overspend state, so no flag is needed); table `provider_budget` |
| `ModelRouteSchema` + `EgressRuleSchema` | `model_route` | The data model row mixes routing and the data-class decision | Contract: routing (job to models, fallbacks, limits) and egress (data class by connection, default deny) are separate records |
| `HubSourceSchema` | `source` + `crawl_policy` | Kind and purpose enums differ (`website_crawl` against `sitemap` and `web_page`; `news` against `news_desk`); robots and terms are embedded checks in the contract | Contract enums; SRC-001 stores the checks as the latest `crawl_policy` row and maps them into the read model |
| `DatasetSchema` | `dataset` | Data model has one `source_id` and a record `kind`; contract has `sourceIds`, `subject` and the legal flags | Contract |
| `LinkProposalSchema` | `record_link_proposal` (sources), `entity_link` (federation) | Evidence names differ (`subject_confirmation` against `person_confirmed`); proposer is a person or a pipeline run against `import`, `peer`, `person`; evidence `score` | Contract names; evidence `score` renamed `similarity` in HUBC-000 (a matching measure, never a reputation score) |
| `ScheduleSchema` | `pipeline_schedule` | Name | Data model table name; contract keeps `Schedule` |
| `PipelineRunSchema.trigger` | `pipeline_run.trigger` | `schedule`, `manual`, `dry_run`, `retry`, `backfill`, `event` against `scheduled`, `manual`, `retry` | Contract |
| `AgentModuleVersionSchema` | `agent_module_version` | Data model row is the engine manifest released by maintainers; contract is a hub's configured version (limits, metering, routes) | Open for AGT-003: the hub record pins the engine manifest version it configures |
| `AgentPlanVersionSchema` | `subscription_plan_version` | Renamed in the data model to avoid "plan" (project plans) | Data model table name; the contract name stays until BILL-001 freezes billing |
| `MeteredPriceVersionSchema` | `meter_rate_version` | Data model prices per thousand units by provider class; contract prices per metering unit with cost beside sale price | Open for AGT-004 and BILL-001 |
| `MarketplaceFeeVersionSchema` | `marketplace_fee_version` | Data model points at a `price_version`; kinds lack agent capacity | Contract: the fee version is itself the versioned price record (activation, approval, disclosure); kinds include `agent_capacity` (ADR 010 decision 21) |
| `MarketplaceCategoryRuleSchema.commissionOfferId` | none | Commission pointer on the rule | Removed in HUBC-000: commissions are fee versions keyed by category |
| `ExternalAgentClientSchema` | `external_connection` | Scope names (`read_public` against `read.public`); private data classes | Contract scope names; `privateDataClasses` with opt-in time added in HUBC-000 (ADR 012 decision 23) |
| `IssuedCredentialSchema` | `passport_credential` | Contract is the hub's issuance record (digest, status list index); the data model row is the credential document | Both: REP-002 owns the document; the console reads the issuance record |
| `KillSwitchScopeSchema` kinds | `kill_switch.scope` | Data model includes `person_stop`, `company_representative`, `federation`, `payments` | Contract covers the console's switches and adds `agent_extension`; the participant's own stop and the representative switch are product controls (assistant); federation and payment switches are added by their packages as a minor version |

