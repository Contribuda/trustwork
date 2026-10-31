# Entity-relationship diagrams

Conceptual maps of the [data dictionary](model.md), one per domain plus a cross-domain overview. They show identity and main relationships, not every column, and they are not an authorization proof: participation rows and projection serializers qualify every arrow. Two arrows from a person and a company to the same entity mean **XOR ownership**, never two owners. Entities marked Live exist as tables today; everything else follows the status in the dictionary.

Notation: `||--o{` one to many, `||--||` one to one, `o|--o{` optional one to many, `}o--o{` many to many through a link record.

## Cross-domain overview

```mermaid
erDiagram
  NODE ||--o{ HUB : hosts
  HUB ||--o{ HUB_TERRITORY : declares
  HUB ||--o{ HUB_CONFIG_VERSION : configures
  PERSON ||--o{ MEMBERSHIP : holds
  COMPANY ||--o{ MEMBERSHIP : employs
  PERSON ||--o{ PROJECT : may_own
  COMPANY ||--o{ PROJECT : may_own
  PROJECT ||--|| PLAN : planned_by
  PLAN ||--o{ PLAN_VERSION : versions
  PLAN_VERSION ||--o{ PLAN_ITEM : contains
  PLAN_ITEM o|--o| RFQ : becomes
  PLAN_ITEM o|--o| CONSULTATION_REQUEST : becomes
  PLAN_ITEM o|--o| TASK_REQUEST : becomes
  PLAN_ITEM ||--o{ RECOMMENDATION_SET : recommended_for
  RFQ ||--o{ QUOTE : receives
  QUOTE ||--o{ AGREEMENT : accepted_as
  TASK_REQUEST ||--o{ TASK_OFFER : receives
  TASK_OFFER o|--o| AGREEMENT : accepted_as
  CONSULTATION_REQUEST ||--o{ CONSULTATION_BOOKING : booked_as
  CONSULTATION_BOOKING o|--o| AGREEMENT : accepted_as
  AGREEMENT ||--o{ ORDER : commits
  ORDER ||--o{ DELIVERY_CLAIM : fulfilled_by
  DELIVERY_CLAIM ||--o{ ASSERTION : asserts
  ASSERTION ||--o{ CONFIRMATION : confirmed_by
  ASSERTION ||--o{ REPUTATION_SNAPSHOT : feeds
  REPUTATION_SNAPSHOT ||--o{ PASSPORT_CREDENTIAL : attested_by
  PERSON ||--o{ MANDATE : delegates
  MANDATE ||--o{ ACTION_INTENT : authorizes
  ACTION_INTENT ||--o{ RESERVATION : funds
  BUDGET ||--o{ RESERVATION : caps
  HUB ||--o{ PUBLICATION : publishes
  PUBLICATION ||--|{ PUBLICATION_VERSION : versions
  HUB ||--o{ EVENT : lists
  HUB ||--o{ COURSE : offers
  HUB ||--o{ SOURCE : registers
  SOURCE ||--o{ PRODUCT_ENTRY : yields
  SOURCE ||--o{ LEARNING_RESOURCE : yields
  PUBLICATION_VERSION ||--o{ KNOWLEDGE_CHUNK : projected_into
  HUB ||--o{ PEERING_AGREEMENT : peers
  PEERING_AGREEMENT ||--o{ REPLICA : syndicates
  OBJECT_PARTICIPATION }o--|| PERSON : grants_person
  OBJECT_PARTICIPATION }o--|| COMPANY : grants_company
```

## Identity, people and access

```mermaid
erDiagram
  PERSON ||--o{ EMAIL_BINDING : owns
  PERSON ||--o{ CREDENTIAL : authenticates_with
  PERSON ||--o{ SESSION : signs_in
  PERSON ||--o{ AUTH_TOKEN : verifies
  PERSON ||--o| PERSON_PROFILE : presents
  PERSON ||--o| PERSON_PREFERENCE : prefers
  PERSON ||--o{ CONSENT_RECORD : consents
  PERSON ||--o| PORTRAIT : shows
  PORTRAIT }o--|| MEDIA_LICENCE : licensed_by
  PERSON ||--o{ EXPERIENCE_ENTRY : records
  PERSON ||--o{ FOLLOW : follows
  PERSON ||--o{ READING_PROGRESS : reads
  PERSON ||--o{ PERMISSION_GRANT : may_hold
  COMPANY ||--o{ PERMISSION_GRANT : may_hold
  PERSON ||--o{ OBJECT_PARTICIPATION : party_person
  COMPANY ||--o{ OBJECT_PARTICIPATION : party_company
  OBJECT_PARTICIPATION }o--o| CASE_ACCESS_GRANT : staff_case_ref
  PERSON ||--o{ RECOVERY_REVIEW : may_need
```

## Companies and verification

```mermaid
erDiagram
  COMPANY ||--|| COMPANY_PRIVATE : private_part
  COMPANY ||--o| COMPANY_PROFILE : presents
  COMPANY ||--o{ COMPANY_IDENTIFIER : identified_by
  COMPANY ||--o{ COMPANY_REGISTRATION : registered_in
  COMPANY ||--o{ COMPANY_BRANCH : operates
  COMPANY ||--o{ MEMBERSHIP : employs
  PERSON ||--o{ MEMBERSHIP : holds
  COMPANY ||--o{ COMPANY_CLAIM : claimed_by
  PERSON ||--o{ COMPANY_CLAIM : submits
  COMPANY_CLAIM }o--|| VERIFICATION_RECIPE_VERSION : follows
  COMPANY ||--o{ COMPANY_VERIFICATION : badge_per_hub
  HUB ||--o{ COMPANY_VERIFICATION : grants
  VERIFICATION_RECIPE_VERSION ||--o{ VERIFICATION_CHECK : runs
  VERIFICATION_PROVIDER ||--o{ VERIFICATION_CHECK : performs
  VERIFICATION_CHECK }o--o| EVIDENCE_ARTIFACT : proves_with
  COMPANY ||--o{ TAX_REGISTRATION : registered_for_tax
  COMPANY ||--o{ PROFESSIONAL_CREDENTIAL : holds
  PERSON ||--o{ PROFESSIONAL_CREDENTIAL : holds
  PROFESSIONAL_CREDENTIAL }o--o| VERIFICATION_CHECK : checked_by
  COMPANY ||--o{ AUTHORITY_PROOF : authorizes
  COMPANY ||--o{ OWNERSHIP_DECLARATION : declares
  SCREENING_LIST ||--o{ SCREENING_LIST_VERSION : versions
  SCREENING_LIST_VERSION }o--o{ SCREENING_RESULT : screened_against
  SCREENING_RESULT ||--o| SCREENING_REVIEW_CASE : reviewed_in
```

## Projects and plans

```mermaid
erDiagram
  PROJECT ||--o{ OWNERSHIP_TRANSFER : transferred_by
  PROJECT ||--o{ LEADERSHIP_ASSIGNMENT : led_by
  PROJECT ||--o| PROJECT_LOCATION : located_at
  PROJECT ||--|| PLAN : has
  PLAN ||--o{ PLAN_VERSION : versions
  PLAN_VERSION ||--o{ PLAN_ITEM : contains
  PLAN_VERSION ||--o{ PLAN_DEPENDENCY : orders
  PLAN ||--o{ PLAN_ITEM_STATE : tracks
  PLAN ||--o{ PLAN_CHANGE : changed_by
  PLAN_CHANGE }o--o| AGREEMENT : covered_by
  PLAN ||--o{ PLAN_SHARE : shared_with
  PLAN_SHARE ||--|| OBJECT_PARTICIPATION : materialized_as
  PROJECT ||--o{ PERMIT_RECORD : requires
  PROJECT ||--o{ PROJECT_DIARY_ENTRY : journaled_in
  PROJECT ||--o{ PROJECT_PUBLIC_PARTICIPANT : shows
  PROJECT_TEMPLATE ||--o{ PLAN : seeds
```

## Consultations, tasks, mentoring and knowledge sharing

```mermaid
erDiagram
  OFFERING ||--o| CONSULTATION_OFFERING : consultation_profile
  OFFERING_VERSION ||--o{ CONSULTATION_BOOKING : pinned_by
  CONSULTATION_REQUEST ||--o{ CONSULTATION_BOOKING : results_in
  CONSULTATION_BOOKING ||--o{ CONSULTATION_SESSION : held_as
  CONSULTATION_BOOKING ||--o{ CONSULTATION_DELIVERABLE : delivers
  CONSULTATION_BOOKING ||--o| AGREEMENT : terms
  CONSULTATION_BOOKING ||--o| PAYMENT : paid_by
  TASK_REQUEST ||--|{ TASK_REQUEST_VERSION : versions
  TASK_REQUEST_VERSION ||--o{ TASK_OFFER : answered_by
  TASK_OFFER ||--o| TASK_OFFER_PRIVATE : private_floor
  TASK_OFFER ||--o| TASK_ASSIGNMENT : accepted_as
  TASK_ASSIGNMENT ||--|| AGREEMENT : terms
  AGREEMENT ||--o{ OBLIGATION : milestones
  MENTORING_RELATIONSHIP ||--o{ CONSULTATION_BOOKING : sessions
  PROJECT ||--o{ KNOWLEDGE_ITEM : source_of
  KNOWLEDGE_ITEM ||--|| PUBLICATION : published_as
  KNOWLEDGE_ITEM ||--o{ KNOWLEDGE_CONSENT : consented_by
  KNOWLEDGE_CONSENT }o--|| CONSENT_RECORD : records
  KNOWLEDGE_ITEM ||--o{ TEMPLATE_DERIVATION : generalized_into
  TEMPLATE_DERIVATION }o--|| PROJECT_TEMPLATE : produces
```

## Content and magazine

```mermaid
erDiagram
  HUB ||--o{ PUBLICATION : publishes
  PUBLICATION ||--|{ PUBLICATION_VERSION : versions
  PUBLICATION ||--|{ PUBLICATION_AUTHORSHIP : credited_to
  PUBLICATION ||--o{ PUBLICATION_TOPIC : about
  PUBLICATION_TOPIC }o--|| TAXONOMY_TERM : term
  PUBLICATION ||--o{ ENTITY_LINK : mentions
  PUBLICATION ||--o{ EDITION_LINK : translated_as
  PUBLICATION ||--o{ WALL_REFERENCE : appears_on
  PUBLICATION ||--o{ COMMENT : discussed_in
  PUBLICATION ||--o{ CORRECTION : corrected_by
  SOURCE_ITEM o|--o| PUBLICATION : drafted_into
  HUB ||--o{ ISSUE : releases
  ISSUE ||--|{ ISSUE_REVISION : editions
  ISSUE_REVISION ||--|{ ISSUE_ITEM : curates
  PUBLICATION_VERSION ||--o{ ISSUE_ITEM : pinned_by
  ISSUE_REVISION ||--o{ RENDER_ARTIFACT : rendered_as
```

## Events

```mermaid
erDiagram
  HUB ||--o{ EVENT : lists
  EVENT ||--o{ EVENT_CO_ORGANIZER : co_organized_by
  EVENT ||--o{ EVENT_SESSION : schedules
  EVENT_SESSION ||--o{ EVENT_SPEAKER : features
  EVENT_SPEAKER }o--o| CONSENT_RECORD : consented
  EVENT ||--o{ EVENT_SPONSOR : labelled_sponsors
  EVENT ||--o{ TICKET_TYPE : sells
  TICKET_TYPE ||--|{ TICKET_PRICE_VERSION : priced_by
  EVENT ||--o{ REGISTRATION_QUESTION : asks
  EVENT ||--o{ REGISTRATION : receives
  REGISTRATION }o--|| TICKET_PRICE_VERSION : sold_at
  REGISTRATION ||--o| PAYMENT : paid_by
  REGISTRATION ||--|{ TICKET : issues
  TICKET ||--o{ CHECK_IN : scanned
  EVENT ||--o{ WAITLIST_ENTRY : queues
  EVENT ||--o{ MEETING_PROFILE : opted_in
  EVENT ||--o{ MEETING_SLOT : offers
  MEETING_SLOT ||--o{ MEETING_REQUEST : booked_for
  EVENT ||--o{ EVENT_MATERIAL : publishes
  EVENT_MATERIAL }o--|| PUBLICATION : is
  EVENT ||--o{ EVENT_FEEDBACK : collects
```

## Learning

```mermaid
erDiagram
  HUB ||--o{ COURSE : offers
  COURSE ||--|{ COURSE_VERSION : versions
  COURSE_VERSION ||--o{ COURSE_LESSON : contains
  COURSE_VERSION ||--o{ ASSESSMENT : assesses
  COURSE ||--o{ COURSE_PRICE_VERSION : priced_by
  PERSON ||--o{ ENROLLMENT : enrolls
  ENROLLMENT }o--|| COURSE_VERSION : pinned_to
  ENROLLMENT ||--o{ LESSON_PROGRESS : tracks
  ENROLLMENT ||--o{ ASSESSMENT_ATTEMPT : attempts
  ASSESSMENT_ATTEMPT o|--o| CERTIFICATE : earns
  EVENT o|--o{ CERTIFICATE : attendance
  CERTIFICATE }o--o| ACCREDITATION : recognized_by
  CERTIFICATE ||--o| PASSPORT_CREDENTIAL : attested_by
  HUB ||--o{ LEARNING_RESOURCE : indexes
  SOURCE ||--o{ LEARNING_RESOURCE : yields
```

## Partners, matching and recommendations

```mermaid
erDiagram
  COMPANY ||--o| CAPABILITY_PROFILE : presents
  PERSON ||--o| CAPABILITY_PROFILE : presents
  HUB ||--o{ OPEN_NEED : boards
  OPEN_NEED ||--o{ NEED_INTEREST : receives
  OPEN_NEED o|--o| RFQ : may_publish
  HUB ||--o{ PARTNER_POST : boards
  MATCH_METHOD_VERSION ||--o{ MATCH_RUN : governs
  MATCH_RUN ||--o{ MATCH_CANDIDATE : ranks
  MATCH_CANDIDATE o|--o{ INTRODUCTION : may_lead_to
  INTRODUCTION o|--o| CONTEXT_THREAD : opens
  PERSON ||--o{ OUTREACH_QUOTA : limited_by
  PERSON ||--o{ ALERT_SUBSCRIPTION : subscribes
  PLAN_ITEM ||--o{ RECOMMENDATION_SET : receives
  RECOMMENDATION_METHOD_VERSION ||--o{ RECOMMENDATION_SET : governs
  RECOMMENDATION_SET ||--o{ RECOMMENDATION : lists
  RECOMMENDATION }o--o| PRODUCT_ENTRY : may_target
  RECOMMENDATION }o--o| LEARNING_RESOURCE : may_target
  RECOMMENDATION }o--o| CONSULTATION_OFFERING : may_target
  RECOMMENDATION }o--o| EVENT : may_target
  HUB ||--o{ SPONSORED_PLACEMENT : separate_labelled_slot
  TAXONOMY_TERM ||--o{ STEP_TERM_RELATION : relates
```

## Catalogue, procurement, sales and transactions

```mermaid
erDiagram
  OFFERING ||--|{ OFFERING_VERSION : versions
  OFFERING_VERSION ||--o| OFFERING_VERSION_PRIVATE : private_knowledge
  OFFERING_VERSION ||--o{ BUNDLE_COMPONENT : bundles
  PRODUCT_ENTRY o|--o| OFFERING : managed_as
  NEED ||--o{ NEED_LINE : lists
  NEED o|--o| RFQ : converted_to
  RFQ ||--|{ RFQ_VERSION : versions
  RFQ ||--o| RFQ_PRIVATE_CONSTRAINT : buyer_private
  RFQ_VERSION ||--o{ RFQ_INVITATION : pins
  RFQ_VERSION ||--o{ RFQ_CLARIFICATION : clarified_by
  RFQ ||--o{ SUPPLIER_CANDIDATE : discovers
  RFQ ||--o{ QUOTE : receives
  QUOTE ||--|{ QUOTE_VERSION : versions
  QUOTE ||--o| QUOTE_PRIVATE_CONSTRAINT : seller_private
  RFQ_VERSION ||--o{ QUOTE_VERSION : answered_by
  QUOTE_VERSION ||--|{ QUOTE_LINE : snapshots
  QUOTE_LINE ||--o| TAX_DETERMINATION : taxed_by
  OFFERING_VERSION o|--o{ QUOTE_LINE : provenance_only
  QUOTE_VERSION ||--o{ NEGOTIATION_ROUND : negotiated_in
  QUOTE_VERSION ||--o{ AMENDMENT_REQUEST : countered_by
  QUOTE_VERSION ||--o{ AGREEMENT : accepted_terms
  AGREEMENT ||--o| AGREEMENT_BUYER_PRIVATE : buyer_private
  AGREEMENT ||--o| AGREEMENT_SELLER_PRIVATE : seller_private
  AGREEMENT ||--o{ ACCEPTANCE_EVENT : exact_digest
  AGREEMENT ||--o{ ORDER : commits
  ORDER ||--o{ ORDER_CHANGE : amended_by
  AGREEMENT ||--o{ OBLIGATION : obliges
```

## Execution, evidence and reputation

```mermaid
erDiagram
  ORDER ||--o{ DELIVERY_CLAIM : claims
  ORDER ||--o{ WORK_RECORD : records
  DELIVERY_CLAIM ||--o{ ACCEPTANCE_RECORD : accepted_by
  WORK_RECORD ||--o{ ACCEPTANCE_RECORD : accepted_by
  ORDER ||--o{ DEFECT : reveals
  DEFECT ||--o{ REMEDIATION : remedied_by
  EVIDENCE_ARTIFACT }o--o{ ASSERTION : supports
  SOURCE_RECORD ||--o{ ASSERTION : sourced_from
  ASSERTION ||--o{ CONFIRMATION : decided_by
  ASSERTION }o--o{ DISPUTE_CASE : challenged_in
  CONFIRMATION_REQUEST ||--|| ASSERTION : asks_about
  CONFIRMATION_REQUEST ||--o| CONFIRMATION_RESPONSE : answered_by
  CONFIRMATION_RESPONSE o|--o| CONFIRMATION : creates
  PORTFOLIO_ENTRY o|--o| CONFIRMATION_REQUEST : confirmed_through
  AGREEMENT ||--o{ REVIEW : reviewed_in
  REVIEW ||--o{ REVIEW_APPEAL : appealed_by
  TIMELINESS_OBSERVATION }o--|| PERFORMANCE_OBSERVATION : feeds_timing
  PERFORMANCE_OBSERVATION ||--o{ REPUTATION_EXCLUSION : excluded_by
  REPUTATION_METHOD_VERSION ||--o{ REPUTATION_SNAPSHOT : computes
  PERFORMANCE_OBSERVATION }o--o{ REPUTATION_SNAPSHOT : counted_in
  CONTRIBUTION_RECORD }o--o{ REPUTATION_PASSPORT : shown_in
  REPUTATION_SNAPSHOT ||--o{ REPUTATION_PASSPORT : shown_whole_in
  REPUTATION_PASSPORT ||--o{ PASSPORT_CREDENTIAL : packages
  PASSPORT_CREDENTIAL }o--|| CREDENTIAL_STATUS_LIST : status_in
```

## Assistant and agents

```mermaid
erDiagram
  PERSON ||--o{ MANDATE : principal
  MANDATE ||--o{ MANDATE_CONTEXT : scoped_to
  MANDATE ||--o{ MANDATE_REVISION : history
  PERSON ||--o{ CONVERSATION_TURN : converses
  PERSON ||--o{ GOAL : directs
  GOAL ||--o{ GOAL_PROGRESS : logs
  GOAL ||--o{ RUN : pursued_by
  MANDATE ||--o{ RUN : authorizes
  RUN ||--o{ RUN_STEP : checkpoints
  RUN ||--o{ ACTION_INTENT : proposes
  ACTION_INTENT ||--o{ APPROVAL : digest_bound
  ACTION_INTENT ||--o{ ACTION_ATTEMPT : attempts
  ACTION_ATTEMPT ||--o{ ACTION_OUTCOME : observes
  ACTION_OUTCOME ||--o| RECONCILIATION : resolved_by
  ACTION_INTENT ||--o| RESERVATION : funds
  COMPANY ||--o| COMPANY_REPRESENTATIVE : enables_one
  COMPANY_REPRESENTATIVE ||--o{ REPRESENTATIVE_ACCOUNTABILITY : accountable_history
  COMPANY ||--o{ COMPANY_MANDATE : grants
  COMPANY_MANDATE ||--|| MANDATE : wraps
  NEGOTIATION_SESSION ||--o{ AGENT_ENVELOPE : carries
  PERSON ||--o{ EXTERNAL_CONNECTION : connects_own_agent
  EXTERNAL_CONNECTION }o--o{ MANDATE : bound_to
  EXTERNAL_CONNECTION ||--o{ CONNECTION_TOKEN : authorized_by
  EXTERNAL_CONNECTION ||--o{ CONNECTION_CALL : audited_by
  PERSON ||--o{ JOB_SUBSCRIPTION : triggers
  PERSON ||--o{ AGENT_REPORT : receives
  AGENT_MODULE ||--o{ AGENT_MODULE_VERSION : versions
  AGENT_MODULE_VERSION }o--o{ HUB_CONFIG_VERSION : enabled_by_agent_policy
```

## Communications

```mermaid
erDiagram
  CONTEXT_THREAD ||--o{ MESSAGE : contains
  MESSAGE ||--o{ MESSAGE_LINK : discusses
  MESSAGE ||--o{ SEND_RECEIPT : evidenced_by
  CONTEXT_THREAD ||--o{ REPLY_TOKEN : matched_by
  PERSON ||--o{ CHANNEL_GRANT : connects
  CHANNEL_GRANT ||--o{ MESSAGE : carries
  PERSON ||--o{ NOTIFICATION : receives
  PERSON ||--o{ NOTIFICATION_PREFERENCE : chooses
  MESSAGE_TEMPLATE ||--|{ TEMPLATE_VERSION : versions
  TEMPLATE_VERSION ||--o{ NOTIFICATION : renders
  NOTIFICATION ||--o{ DELIVERY : delivered_by
  MESSAGE ||--o{ DELIVERY : delivered_by
  HUB ||--o{ SENDER_IDENTITY : sends_as
  HUB ||--o{ SUPPRESSION_ENTRY : suppresses
```

## Billing, budgets and payments

```mermaid
erDiagram
  BILLING_ACCOUNT ||--o{ SUBSCRIPTION : subscribes
  OFFER ||--o{ SUBSCRIPTION_PLAN_VERSION : includes
  OFFER ||--o{ PRICE_VERSION : priced_by
  PRICE_VERSION ||--o{ PRICE_ACCEPTANCE : accepted_as
  SUBSCRIPTION }o--|| PRICE_ACCEPTANCE : binds
  BILLING_ACCOUNT ||--o{ ENTITLEMENT : entitled_to
  ENTITLEMENT ||--o{ USAGE_RECORD : metered_by
  METER ||--o{ USAGE_RECORD : counts
  METER ||--o{ METER_RATE_VERSION : priced_by
  METER_RATE_VERSION ||--o{ USAGE_RECORD : rated_by
  HUB ||--o{ MARKETPLACE_FEE_VERSION : charges
  BUDGET ||--o{ RESERVATION : caps
  RESERVATION ||--o{ LEDGER_ENTRY : settles
  BILLING_ACCOUNT ||--o{ INVOICE : billed_by
  INVOICE ||--|{ INVOICE_LINE : lists
  INVOICE_LINE ||--o| TAX_DETERMINATION : taxed_by
  PAYMENT ||--o{ REFUND : refunded_by
  PAYMENT ||--o{ LEDGER_ENTRY : posts
  PAYOUT_ACCOUNT ||--o{ PAYOUT : receives
  PAYOUT ||--o{ LEDGER_ENTRY : posts
  BILLING_ACCOUNT ||--o{ CREDIT_GRANT : credited_by
```

## Hubs, sources and pipelines

```mermaid
erDiagram
  NODE ||--o{ HUB : hosts
  HUB ||--o{ HUB_TERRITORY : declares
  HUB_TERRITORY }o--|| JURISDICTION : code
  HUB ||--o{ HUB_CONFIG_VERSION : configures
  HUB ||--o{ LEGAL_DOCUMENT_VERSION : publishes
  LEGAL_DOCUMENT_VERSION }o--|| COUNSEL_APPROVAL : approved_by
  LEGAL_DOCUMENT_VERSION ||--o{ LEGAL_ACCEPTANCE : accepted_as
  HUB ||--o{ LAUNCH_GATE : gated_by
  HUB ||--o{ SOURCE : registers
  SOURCE ||--o| CRAWL_POLICY : crawled_under
  SOURCE ||--o{ DATASET : provides
  DATASET ||--o{ PIPELINE : processed_by
  PIPELINE ||--|{ PIPELINE_VERSION : versions
  PIPELINE ||--o{ PIPELINE_SCHEDULE : scheduled_by
  PIPELINE_VERSION ||--o{ PIPELINE_RUN : executes
  PIPELINE_RUN ||--o| IMPORT_BATCH : stages
  IMPORT_BATCH ||--o{ SOURCE_ITEM : contains
  IMPORT_BATCH ||--o{ SOURCED_RECORD_FIELD : provenance
  IMPORT_BATCH ||--o{ RECORD_LINK_PROPOSAL : proposes
  HUB ||--o{ VERIFICATION_PROVIDER : enables
  HUB ||--o{ PROVIDER_CREDENTIAL_REF : references_secrets
  HUB ||--o{ MODEL_ROUTE : routes
  HUB ||--o{ PROVIDER_COST_BUDGET : limits
  HUB ||--o{ RETENTION_POLICY : retains
```

## Search and knowledge

See [knowledge model](knowledge-model.md) for the retrieval diagram (source versions, projections, chunks, generations, embeddings, tombstones and answer dependencies); `SAVED_ANSWER` depends on `ANSWER_DEPENDENCY` rows and survives only while every dependency remains permitted.

## Federation

```mermaid
erDiagram
  NODE ||--o{ NODE_KEY : signs_with
  NODE ||--o{ PEER_NODE : knows
  HUB ||--o{ PEERING_AGREEMENT : peers
  PEER_NODE ||--o{ PEERING_AGREEMENT : party_to
  PEER_NODE ||--o{ FEED_CURSOR : pulled_by
  PEER_NODE ||--o{ REPLICA : home_of
  PEER_NODE ||--o{ FEDERATION_INBOX_ITEM : sends
  PEER_NODE ||--o{ FEDERATION_DELIVERY : receives
  REPLICA ||--o{ ENTITY_LINK : linked_by
  PERSON ||--o{ FEDERATED_IDENTITY_LINK : links
  FEDERATION_TOMBSTONE ||--o{ TOMBSTONE_APPLICATION : applied_by
  ERASURE_LEDGER ||--o{ FEDERATION_TOMBSTONE : emits
  PEER_NODE ||--o{ TAKEDOWN_NOTICE : notified
```

## Administration, support and privacy

```mermaid
erDiagram
  STAFF_ROLE_DEFINITION_VERSION ||--o{ STAFF_ROLE_ASSIGNMENT : defines
  PERSON ||--o{ STAFF_ROLE_ASSIGNMENT : holds
  PERSON ||--o{ STAFF_CONFLICT_DECLARATION : declares
  SESSION ||--o{ SESSION_ELEVATION : elevated_by
  SUPPORT_CASE ||--o{ SUPPORT_CASE_NOTE : notes
  SUPPORT_CASE ||--o{ CASE_ACCESS_GRANT : requests
  CASE_ACCESS_GRANT ||--o{ ACCESS_LOG_ENTRY : reads_logged
  SECOND_PERSON_APPROVAL ||--o{ ADMIN_AUDIT_EVENT : approves
  SESSION_ELEVATION ||--o{ ADMIN_AUDIT_EVENT : authorizes
  MODERATION_REPORT }o--|| MODERATION_CASE : grouped_in
  MODERATION_CASE ||--o{ SANCTION : decides
  SANCTION ||--o{ APPEAL : appealed_by
  PRIVACY_REQUEST ||--o| PRIVACY_EXPORT : produces
  PRIVACY_REQUEST ||--o{ ERASURE_LEDGER : executes
  ERASURE_LEDGER ||--o{ RETRIEVAL_TOMBSTONE : emits
  LEGAL_HOLD ||--o{ PRIVACY_REQUEST : may_suspend
  PERSON ||--o| PRIVACY_PREFERENCE : opts
  INCIDENT ||--o{ KILL_SWITCH : engages
  HUB ||--o{ FEATURE_FLAG : sets
  HUB ||--o{ DATA_BROKER_REGISTRATION : registers
```
