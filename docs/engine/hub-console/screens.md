# Console screens

Status: **Proposed**, no visual reference (`no reference` in the sense of the [screen contracts](../../design/screen-contracts/README.md)). This is the screen-by-screen contract for the UI agent: purpose, data shown, actions, states, mobile behaviour and locale namespace for every console screen. It extends the [platform administration contract](../../design/screen-contracts/workspace/administration.md) (shell, admin header band, return link) and follows its rules. Section and route map: [README](README.md#information-architecture-and-navigation). Permissions per section: [README](README.md#permission-model). Data: [data model view](data-model.md).

## Conventions for every screen

**Shell.** `AdminShell` with the band "Administration", the hub name and lifecycle stage, grouped navigation filtered by read permissions, return link to the workspace, Help in the same position on every page. Demo data, maintenance and engaged kill switches show as bands under the header on every page.

**Default states** (each screen lists only what differs):

| State | Default behaviour |
|---|---|
| Loading | Skeleton of the screen's layout; no layout shift when data arrives |
| Empty | `EmptyState` that teaches: what fills this screen and a link to the setting that starts it |
| Error | Inline error with the request id and Retry; the rest of the page keeps working |
| Denied | The section is absent from navigation; a direct address renders `EmptyState tone="denied"` inside the shell: "You do not have access to this section" with the role that grants it; private objects without a grant render **not found**, never "forbidden", so existence is not disclosed |
| Offline | Read-only with the shell's offline banner; mutations disabled with an explanation |
| Stale | "Updated {time}" on aggregates; a version changed by someone else since opening → "Changed by another staff member; refresh" and the form keeps the user's input |
| Demo | Fixture mode: every mutation shows "Demo: changes are not saved" |

**Mutations.** Every mutation form has a required `ReasonField` and the `AuditNote`. Second-person actions open `SecondPersonRequest` showing the exact change and its digest; the requester cannot approve. Confirmation dialogs focus Cancel.

**Tables.** `DataTable` with filters and saved views; below 768 px rows become cards with the three most important fields and a "Details" disclosure; on tablet a "Show columns" control.

**Mobile.** Supported for every screen: queues, approvals, kill switches, run history and alerts are first-class at 375 px; complex editors (egress matrix, step lists, template trees, calendar grid) show "More comfortable on a wide screen" and remain operable with list layouts.

**Keyboard and focus.** Skip link → band → navigation → page heading → filters → content. After navigation focus moves to the page `h1`; after a mutation to the toast and then back to the changed row. No drag-only interaction: reordering uses move up / move down buttons with announcements.

**Locale.** Every string under `admin.<section>` in `apps/web/locales/<locale>/admin.json` for every engine locale (English reference). Shared enums reuse `common.*`, `status.*`, `lifecycle.*`, `run.*`. Dates, numbers and money via `Intl`. Russian copy in this file is illustrative; locale owners finalize it.

**Screen ids.** `SW-*` setup wizard, `NC-*` node console, `HC-*` hub console.

## Setup wizard

Route `/admin/setup/[step]`; requires a valid setup token; after setup finishes every route returns not found. Shell: minimal (no navigation), `Stepper` with nine steps, "Save and continue later". Locale namespace `admin.setup.*`. Mobile: one column; the step list collapses to "Step 3 of 9" with a disclosure.

| Id | Step | Purpose and data | Actions | Specific states |
|---|---|---|---|---|
| SW-1 | Install check (`admin.setup.check`) | Results of address, database, object storage, worker, clock and secret-store checks | Re-run checks | Blocking failure: explanation and link to [installation](installation.md); no Continue |
| SW-2 | Node identity (`admin.setup.node`) | Node name, domain, jurisdiction (restricted places never offered), generated public key and fingerprint | Generate key, continue | Key generation failure: retry; never shows the private key |
| SW-3 | Hub identity (`admin.setup.hub`) | Starting point (country pack or generic profile with the "no pack yet" note), territories (country, regions, places), name per language, languages and default, currency, time zone, identifiers, brand overlay; "Start from an example" (US or Samarkand, marked as example) | Add region or place, add identifier definition, continue | Restricted code → inline error "This territory is not available" without listing why; incomplete language shows completeness percentage |
| SW-4 | Operator (`admin.setup.operator`) | Legal name, form, identifier, address, legal and abuse contacts, deployment-location attestation (entity country, hosting country and region, gate mode), ownership declaration, screening result (labelled "fake" when fake) | Attest, screen, continue | Potential match → "Review required" and continue in draft; cannot be cleared by the operator |
| SW-5 | First administrator (`admin.setup.admin`) | Name, e-mail, password, verification, second factor (TOTP or passkey), recovery codes shown once | Verify, enroll, confirm codes stored | Cannot continue without a second factor |
| SW-6 | Storage and residency (`admin.setup.residency`) | Residency country, service regions, privacy regime | Save | Region contradicting residency → warning with the service named |
| SW-7 | Providers (`admin.setup.providers`) | Each capability with fake / manual / later; e-mail may be prepared and tested | Test e-mail, continue | Test failure shows outcome code; live enabling explained as a later two-person step |
| SW-8 | Modes (`admin.setup.modes`) | Data mode, registration, modules with dependencies, moderation, automation | Save | Dependency missing → the module's switch explains which module it needs |
| SW-9 | Review (`admin.setup.review`) | Summary of every step with edit links; the "next five things" preview | Finish setup | Finish failure keeps the state and shows the failing step |

## Node console

Route `/admin/node/*`; node-scoped roles only. Locale namespace `admin.node.*`.

### NC-01 Node overview — `/admin/node`
- **Purpose**: state of the installation at a glance.
- **Data**: hubs with lifecycle stage; engine version and update availability; last backup and last passed drill; node health tiles; engaged node switches.
- **Actions**: open a hub's console; go to updates, backups, kill switches.
- **States**: no hubs → "Create your first hub" linking NC-02.
- **Mobile**: tiles stack; hubs as cards.
- **Locale**: `admin.node.overview.*`

### NC-02 Hubs — `/admin/node/hubs`
- **Purpose**: create and manage hubs on this node.
- **Data**: hubs (name, territories, languages, stage, staff count, created).
- **Actions**: create hub (runs SW-3, SW-4, SW-6, SW-8 for the new hub); request closing (second person; explains notifications, exports, tombstones).
- **States**: restricted territory refused as in SW-3.
- **Mobile**: cards; the create flow is the wizard layout.
- **Locale**: `admin.node.hubs.*`

### NC-03 Node staff — `/admin/node/staff`
- **Purpose**: node operators and node-scoped roles.
- **Data**: people, roles, second-factor state, elevation, last action time (no activity analytics).
- **Actions**: invite, assign (sensitive: second person), revoke.
- **States**: last node operator cannot be removed → explanation.
- **Mobile**: cards.
- **Locale**: `admin.node.staff.*`

### NC-04 Node providers — `/admin/node/providers`
- Same contract as HC-100 with node scope (object storage, e-mail relay, local model servers). Locale `admin.node.providers.*`.

### NC-05 Updates and migrations — `/admin/node/updates`
- **Purpose**: keep the engine current safely.
- **Data**: running version, available release with notes (security first), pending migrations by phase (expand, migrate, contract), last backup age, maintenance windows.
- **Actions**: schedule window; request apply (second person, refused without a fresh backup); view migration log.
- **States**: failed migration → previous version still serving, failure details, link to runbook.
- **Mobile**: read and approve; scheduling works as a form.
- **Locale**: `admin.node.updates.*`

### NC-06 Backups and restore — `/admin/node/backups`
- **Purpose**: prove the data can come back.
- **Data**: schedule, backup records (kind, time, size, encrypted, off-host, state), drills (date, checks, measured recovery time and data-loss window, performer, witness, outcome), targets (RPO/RTO as recorded, or "not set").
- **Actions**: edit schedule; start a drill in an isolated environment; record the drill; request restore (second person, maintenance mode, workers stay disconnected).
- **States**: no off-host copy → warning blocking the launch gate; failed drill → follow-up required.
- **Mobile**: records and drill results readable; starting a restore requires confirming on a wide screen note but is possible.
- **Locale**: `admin.node.backups.*`

### NC-07 Identity and keys — `/admin/node/identity`
- **Purpose**: node identity for federation and verifiable credentials.
- **Data**: manifest preview, current public key and fingerprint, rotation chain, where the key is used (manifest, envelopes, credentials).
- **Actions**: request key rotation (second person; previous key signs the new one).
- **States**: never shows private key material.
- **Mobile**: read-only comfortable; rotation request possible.
- **Locale**: `admin.node.identity.*`

### NC-08 Node kill switches — `/admin/node/kill-switches`
- Same contract as HC-105 with node-wide scope. Locale `admin.node.killSwitches.*`.

### NC-09 Restricted places — `/admin/node/restricted`
- **Purpose**: show the engine's restricted-places list (read-only, from code).
- **Data**: codes and names; a note that it cannot be edited and why.
- **Actions**: none.
- **Locale**: `admin.node.restricted.*`

## Home

Hub console routes below are relative to `/admin/hubs/[hub]`.

### HC-01 Overview — `/admin/hubs/[hub]`
- **Purpose**: what needs a person today, and is the hub healthy and lawful.
- **Data**: launch checklist progress (gates open/passed); queues the viewer can act on with counts (claims, review items, link proposals, reports, support cases, grant requests, privacy requests with nearest deadline, unknown outcomes, alerts); approvals waiting for the viewer; compliance status (legal documents due, screening list age, expiring source licences, fake providers in use); health tiles; spend against caps; "next five things" while draft or preparing.
- **Actions**: open any queue; engage a kill switch from the health panel (with reason).
- **States**: nothing waiting → "Nothing needs your decision today"; reduced SoD mode → permanent note asking for a second staff member.
- **Mobile**: queues first, then approvals, then health; checklist collapsed.
- **Locale**: `admin.overview.*`

### HC-02 Approvals — `/admin/hubs/[hub]/approvals`
- **Purpose**: second-person decisions.
- **Data**: requests for me (action, requester, reason, exact diff, digest, expiry), my pending requests, recent decisions.
- **Actions**: approve, decline with reason, ask a question in the request thread; withdraw my own request.
- **States**: own request → approve disabled with "You cannot approve your own request"; changed since request → void, "The action changed; a new request is required"; expired.
- **Mobile**: full support; diff shown as a list of changed fields.
- **Locale**: `admin.approvals.*`

### HC-03 Help — `/admin/hubs/[hub]/help`
- **Purpose**: learn the console.
- **Data**: role checklists, handbook links, glossary, status label meanings, keyboard shortcuts.
- **Actions**: mark checklist items done (personal preference only).
- **Locale**: `admin.help.*`

## Hub

### HC-10 Identity and territory — `/hub/identity`
- **Purpose**: who and where the hub is.
- **Data**: names per language, territories (country, regions, places with ids), languages and default with completeness, currency and secondary currencies, time zone, domain, brand overlay with contrast results.
- **Actions**: add or remove territories (restriction check), add a place (name per language, Wikidata, OSM), add or remove a language, change default, upload brand lettering; save as a new configuration version.
- **States**: removing a language with published content → explanation of what happens to linked editions; restricted code refused.
- **Mobile**: lists; brand preview stacked.
- **Locale**: `admin.hub.identity.*`

### HC-11 System modes — `/hub/modes`
- **Purpose**: how the hub behaves.
- **Data**: lifecycle stage with allowed next stages; data mode; registration; moderation strictness; automation level per domain with its human gates listed; indexing; maintenance; violations from `modesViolations`.
- **Actions**: change modes (new version); request lifecycle transition (second person; blocked by open gates with a list); raise a domain to supervised autonomy (second person, requires caps).
- **States**: demo data in a stage that forbids it → blocking explanation; transition blocked → gates listed with links.
- **Mobile**: one setting per row; full support.
- **Locale**: `admin.hub.modes.*`

### HC-12 Modules — `/hub/modules`
- **Purpose**: switch product modules on and off.
- **Data**: every module with status label, dependencies, what it needs before enabling (providers, policies, legal documents), and what disabling does to existing data.
- **Actions**: enable, disable (with consequences dialog).
- **States**: missing dependency → disabled switch with the reason.
- **Mobile**: cards.
- **Locale**: `admin.hub.modules.*`

### HC-13 Legal and operator — `/hub/legal`
- **Purpose**: the operator and the documents participants accept.
- **Data**: operator record and screening state; documents by kind and language with versions, status, counsel approval (who, firm, date, scope), effective date; imprint.
- **Actions**: draft a version from engine templates; record counsel approval; request activation (second person; blocked without counsel approval or a missing language).
- **States**: a language missing → activation blocked with the language named.
- **Mobile**: read and approve; editing long documents shows the wide-screen note.
- **Locale**: `admin.hub.legal.*`

### HC-14 Residency and sub-processors — `/hub/residency`
- **Purpose**: where personal data lives and who processes it.
- **Data**: residency decision and its version history; services and regions; contradictions; sub-processor register generated from enabled connections with descriptions.
- **Actions**: request residency change (second person); edit sub-processor descriptions.
- **States**: a connection outside residency allowed for private data → error-level warning linking HC-102.
- **Locale**: `admin.hub.residency.*`

### HC-15 Country base — `/hub/country`
- **Purpose**: the country facts the hub relies on.
- **Data**: pack binding and version, or generic profile; facts by facet with sources and verification levels; local additions (identifiers such as `US-EIN`, registers, licence categories, holidays, tax facts, units).
- **Actions**: upgrade pack version (diff shown); add or edit local additions; export additions as a pack change.
- **States**: newer pack available → notice with diff.
- **Mobile**: facets as accordions.
- **Locale**: `admin.hub.country.*`

### HC-16 Taxonomy and units — `/hub/taxonomy`
- **Purpose**: topics, categories, plan-step categories, units and local names.
- **Data**: `TaxonomyTree` per kind with versions; usage counts.
- **Actions**: add, rename (per language), move (buttons), deprecate; release a version.
- **States**: deprecating a used category → mapping required.
- **Mobile**: tree as nested lists.
- **Locale**: `admin.hub.taxonomy.*`

### HC-17 Launch checklist — `/hub/launch`
- **Purpose**: what stands between the hub and soft launch or public.
- **Data**: every gate (`LAUNCH_GATES`), state, evidence link, who checked and when, owner role; soft-launch subset marked.
- **Actions**: attach evidence and mark passed (where the gate is a manual check); request soft launch or public (second person).
- **States**: all passed → request button enabled; no waiver control exists.
- **Mobile**: list with progress.
- **Locale**: `admin.hub.launch.*`

## Participants

### HC-20 People — `/participants/people`
- **Purpose**: people in the hub, as the public sees them, plus account-state counts.
- **Data**: public profiles; counts by account state; consent and portrait problems.
- **Actions**: open the support account card (requires support permission and a case); flag a public profile for moderation.
- **States**: private profiles do not appear (not found).
- **Locale**: `admin.participants.people.*`

### HC-21 Companies — `/participants/companies`
- **Purpose**: the company directory as staff manage it.
- **Data**: companies with sourced / claimed / verified state, identifiers, verification date and categories, register re-check due, representative state; sourced manufacturer and supplier pages with their source.
- **Actions**: open claim, revoke verification (reason category), trigger re-check, open link proposals, suspend representative for safety.
- **States**: sourced record with a pending takedown → banner.
- **Locale**: `admin.participants.companies.*`

### HC-22 Claims — `/participants/claims`
- **Purpose**: decide claims with the recipe.
- **Data**: claim queue; per claim the recipe steps with results (register match, signatory tie, domain, call-back, screening), evidence list (categories, viewer under the claim review grant), conflicts of interest.
- **Actions**: record a manual check, approve to claimed or verified, ask for clarification, reject with reason; appeal routing to a different reviewer.
- **States**: potential sanctions match → cannot approve, review case linked; reviewer conflict → assignment blocked.
- **Mobile**: queue and decision support; evidence viewer full-screen.
- **Locale**: `admin.participants.claims.*`

### HC-23 Verification — `/participants/verification`
- **Purpose**: recipes, check providers and screening lists.
- **Data**: recipes (YAML-like steps rendered as a list, versions), check types with provider, mode, cost, quotas, retention and legal basis; screening lists with source and last update.
- **Actions**: edit recipe (new version); set provider mode (live needs second person); add screening list.
- **States**: baseline screening shown as always on, with no switch.
- **Locale**: `admin.participants.verification.*`

### HC-24 Credentials — `/participants/credentials`
- **Purpose**: verifiable credentials the hub issues.
- **Data**: credential types (claim, subject, recipe, validity, portable); issued credentials as counts by type and state; search by holder within a case; status list health; signing key in use.
- **Actions**: create or edit type (version); issue after a decision with evidence; revoke with reason category; suspend.
- **States**: type without recipe for a checked claim → cannot activate.
- **Locale**: `admin.participants.credentials.*`

### HC-25 Consents — `/participants/consents`
- **Purpose**: consent and portrait licence records.
- **Data**: records by kind, version, state; withdrawals pending unpublication.
- **Actions**: record consent with evidence; record portrait licence; process withdrawal.
- **Locale**: `admin.participants.consents.*`

## Support

### HC-30 Lookup — `/support`
- **Purpose**: find whom to help.
- **Data**: search by exact e-mail, name, company, identifier or id; results show name, masked e-mail, account state; each lookup asks for (or creates) the case it serves.
- **Actions**: open account card, open company card, create case.
- **States**: no result → "Nothing found" (same wording whether or not the account exists for non-support viewers, who cannot reach this screen anyway).
- **Mobile**: full support.
- **Locale**: `admin.support.lookup.*`

### HC-31 Account card — `/support/accounts/[person]`
- **Purpose**: diagnose and service an account without impersonation.
- **Data**: `SupportAccountSummary` (masked e-mail, state, second factor, session count, recovery, employer, entitlements and usage against quotas, consents, open cases); communications history as delivery metadata; servicing actions in progress with cooling-off end.
- **Actions**: resend verification, unlock, revoke all sessions, require password reset, request recovery rebind or second-factor reset (evidence, second person, 72 h cooling-off), open export or deletion request, send guided task, view public projection, open access explainer.
- **States**: own account → every action disabled "You cannot service your own account"; erased account → tombstone notice only.
- **Mobile**: card sections stacked; actions in a menu.
- **Locale**: `admin.support.account.*`

### HC-32 Company card — `/support/companies/[company]`
- **Purpose**: help a company.
- **Data**: public page data, claim and verification state, members who chose to appear, representative state and accountable person, open cases.
- **Actions**: open case, request case grant on named objects, open access explainer.
- **Locale**: `admin.support.company.*`

### HC-33 Cases — `/support/cases`, `/support/cases/[case]`
- **Purpose**: support cases and their grants.
- **Data**: list (subject, reason, state, age, assignee); detail with the thread with the person (inside the case context), diagnostic snapshots the person shared, grants (objects, projection class, expiry), access log for this case.
- **Actions**: reply, assign, request grant (objects, projection class, purpose, expiry ≤ 72 h), approve grant (different person), revoke grant, close case.
- **States**: grant expired → objects not found again; approval by requester blocked.
- **Mobile**: list and thread full support; grant form full support.
- **Locale**: `admin.support.cases.*`

### HC-34 Recovery escalations — `/support/recovery`
- **Purpose**: sign-in factor changes in progress.
- **Data**: requests with evidence status, approver, cooling-off end, notifications sent, objections.
- **Actions**: approve (different person), cancel, complete after cooling-off.
- **States**: objection from the account owner → automatically cancelled and flagged.
- **Locale**: `admin.support.recovery.*`

### HC-35 Access explainer — `/support/explain`
- **Purpose**: answer "why can't they see or do this".
- **Data**: chosen principal and object; decision `allow` or `deny` with reason codes and the rule each refers to; never object content.
- **Actions**: copy explanation into the case reply.
- **Locale**: `admin.support.explain.*`

## Editorial office

Amendments to HC-40 … HC-49 and the new editorial screens HC-170 … HC-191 (intake, story board, fact-check, legal, notices, corrections, glossary, translation memory, languages, media, channels, licences, collection jobs and the editorial agent team) are specified in [The editorial office](../editorial-office.md#11-screens) (Proposed).

### HC-40 Desk — `/editorial`
- **Purpose**: the newsroom's day.
- **Data**: review queue size by language, items scheduled today, calendar slots unfilled, pipeline health (last runs, alerts), cost per published item this week, corrections pending.
- **Actions**: open review, open calendar, run a pipeline now (assisted mode).
- **Locale**: `admin.editorial.desk.*`

### HC-41 Sources — `/editorial/sources`, `/editorial/sources/[source]`
- **Purpose**: the source registry, including manufacturers and suppliers.
- **Data**: list (name, kind, purposes, licence, status, last success, items accepted); detail with licence, robots and terms checks (dates, digests, reviewer), allowed uses, attribution template, takedown contact, owner, personal data and legal basis, schedule, request limits, auto-pause triggers, content-type mapping rules with dry-run preview, metrics.
- **Actions**: edit (allowed uses constrained by licence), re-run legal checks, pause, resume (after fresh checks), take down (tombstones), edit mapping and dry-run it.
- **States**: paused with reason badge; crawling kind without permitting checks → save blocked with the failing check named.
- **Mobile**: list and detail readable; mapping editor shows the wide-screen note.
- **Locale**: `admin.editorial.sources.*`

### HC-42 Discovery — `/editorial/discovery`
- **Purpose**: decide on sources the discovery pipeline proposed.
- **Data**: candidates with recorded checks, suggested purposes and allowed uses, sample items, why proposed.
- **Actions**: approve and activate (person), adjust then activate, reject with reason, mark "never propose again".
- **States**: terms "unclear" → crawling options disabled; feeds preferred banner.
- **Locale**: `admin.editorial.discovery.*`

### HC-43 Pipelines — `/editorial/pipelines`, `/editorial/pipelines/[pipeline]`
- **Purpose**: ingestion, drafting, translation and assembly pipelines.
- **Data**: list (kind, automation level, schedule, cap, last run, status); detail with versions, `StepListEditor` (steps, model routes per step, settings), sources, thresholds, cap, schedule link, metrics.
- **Actions**: create version, activate, pause, dry run (fakes or models), raise automation level (second person for supervised autonomy).
- **States**: invalid step order → contract error explained ("A rewrite must be followed by a similarity check"); no cap → cannot activate.
- **Mobile**: list; editor wide-screen note.
- **Locale**: `admin.editorial.pipelines.*`

### HC-44 Review — `/editorial/review`, `/editorial/review/[item]`
- **Purpose**: editors decide every publication.
- **Data**: queue filtered by language, treatment, source, assignee, age; workbench with draft beside sources, similarity meter and threshold, fact checks, AI steps used, image with label, attribution, topics, entity links, target languages, blockers.
- **Actions**: edit, approve (to approved or scheduled), return with note, reject, assign, request translation review.
- **States**: blockers → approve disabled with each blocker explained; item changed since opening → reload prompt.
- **Mobile**: queue and side-by-side as tabs (draft / sources / checks); approve possible.
- **Locale**: `admin.editorial.review.*`

### HC-45 Calendar — `/editorial/calendar`
- **Purpose**: plan and schedule.
- **Data**: slots, scheduled items, embargoes, issue dates, feeding pipelines; list view default, month grid on desktop.
- **Actions**: create recurring slot, assign approved item to slot, reschedule, unschedule.
- **Mobile**: agenda list only.
- **Locale**: `admin.editorial.calendar.*`

### HC-46 Publications — `/editorial/publications`
- **Purpose**: the publications board (existing editorial workflow).
- **Data**: publications by state, author type, format, topic, editor; corrections and retractions.
- **Actions**: correct with reader-visible note, retract with record, hold under moderation case, fix topics and entity links.
- **Locale**: `admin.editorial.publications.*`

### HC-47 Magazine — `/editorial/magazine`
- **Purpose**: issues from proposal to release.
- **Data**: issues by state; assembly proposals with rationale; table of contents; release checklist; render artifacts.
- **Actions**: accept proposal as draft, curate (move up / down), edit editor's letter, release (checklist complete), create corrected edition, re-render PDF.
- **States**: checklist incomplete → release disabled.
- **Locale**: `admin.editorial.magazine.*`

### HC-48 Translations — `/editorial/translations`
- **Purpose**: human review of linked editions.
- **Data**: editions per language waiting, machine-assisted label, original side by side.
- **Actions**: edit, approve edition, return.
- **Locale**: `admin.editorial.translations.*`

### HC-49 Editorial policy — `/editorial/policy`
- **Purpose**: newsroom rules.
- **Data**: review requirements per format and author type, languages needing human review, AI assistance and AI image label texts per language, similarity threshold, fact-check rules, image preference order.
- **Actions**: edit (new version).
- **Locale**: `admin.editorial.policy.*`

## Data

### HC-50 Datasets — `/data/datasets`, `/data/datasets/[dataset]`
- **Purpose**: lawful mining configuration.
- **Data**: subject, sources, purpose, legal basis, personal data categories, impact assessment, retention, outputs, public display, subject notice, schedule, status, last refresh counts.
- **Actions**: propose, edit (new version), activate (person; second person with personal data), pause, retire.
- **States**: subject rules violated → explained per rule (for example "Records about private individuals in court cases are not shown").
- **Locale**: `admin.data.datasets.*`

### HC-51 Import batches — `/data/batches`
- **Purpose**: review before activation.
- **Data**: batches with counts (new, changed, conflicting, skipped), sample records with field provenance.
- **Actions**: activate, reject, split.
- **Locale**: `admin.data.batches.*`

### HC-52 Links — `/data/links`
- **Purpose**: entity resolution decisions.
- **Data**: proposals with both records side by side, evidence with scores, confidence, proposer.
- **Actions**: accept link, reject; no merge control exists.
- **States**: person involved without their confirmation → accept disabled.
- **Locale**: `admin.data.links.*`

### HC-53 Knowledge — `/data/knowledge`
- **Purpose**: search and knowledge operations.
- **Data**: knowledge sources with licence flags, index generations with states, evaluation summaries, quarantine, erasure replays.
- **Actions**: build, activate, drain, taint, quarantine, reindex (existing retrieval permissions).
- **Locale**: `admin.data.knowledge.*`

### HC-54 Recommendations — `/data/recommendations`
- **Purpose**: plan-step recommendations and sponsored content.
- **Data**: plan-step category mapping; rules (kinds, counts, sourced allowed, signals); sponsored-content policy; quality metrics (coverage per step, sourced vs claimed share, freshness, complaints).
- **Actions**: edit rules and policy (versions); preview recommendations for a synthetic plan step with explanations.
- **States**: a signal list without region for people and firms → blocked; paid signals do not exist in the picker.
- **Locale**: `admin.data.recommendations.*`

## Modules

### HC-60 Projects — `/modules/projects`
- **Purpose**: project policy and disputes.
- **Data**: public projection policy, counts, reports, transfer disputes.
- **Actions**: edit policy (narrower only), hold published project, decide dispute under grant.
- **Locale**: `admin.modules.projects.*`

### HC-61 Planner — `/modules/planner`
- **Purpose**: plan templates per country and project type.
- **Data**: templates (country, project type, version, authors, reviewer, status), `TemplateTreeEditor`, references, usage counts.
- **Actions**: draft, submit for review, review and publish (not by an author), retire.
- **States**: cyclic dependency or missing item → blocked with the item named.
- **Mobile**: tree as nested list; editing shows the wide-screen note.
- **Locale**: `admin.modules.planner.*`

### HC-62 Marketplace — `/modules/marketplace`
- **Purpose**: consultation and task categories.
- **Data**: category rules, commission fee versions per category, open requests and engagements (counts), disputes, refunds, providers paused for expired licences.
- **Actions**: edit rule (version), draft a commission fee version (activation by another person, `billing.activate_fee_version`), decide refund, open dispute grant.
- **Locale**: `admin.modules.marketplace.*`

### HC-63 Shared knowledge — `/modules/knowledge-sharing`
- **Purpose**: publish consented project knowledge.
- **Data**: shares with kind, project (public title only), consent status per party, review status.
- **Actions**: review, return, publish, withdraw.
- **States**: missing consent → publish disabled with the party named ("No consent: company …").
- **Locale**: `admin.modules.knowledgeSharing.*`

### HC-64 Events — `/modules/events`
- **Purpose**: events policy and operations.
- **Data**: hosting policy, events in review, ticketing and fee price versions, registration and check-in counts, refunds, payout batches, organizer screening.
- **Actions**: edit policy, review, hold or cancel under moderation, decide refunds, request payout release (second person).
- **Locale**: `admin.modules.events.*`

### HC-65 Learning — `/modules/learning`
- **Purpose**: courses, certificates, accreditation.
- **Data**: courses in review, certificate counts, revocations, accreditation records.
- **Actions**: review, revoke certificate with reason category, record accreditation with source.
- **Locale**: `admin.modules.learning.*`

### HC-66 Matching — `/modules/matching`
- **Purpose**: needs board, introductions, method.
- **Data**: needs and posts (public), introduction counts, quotas, method versions with explanations.
- **Actions**: hold need or post, set quotas, release method version.
- **Locale**: `admin.modules.matching.*`

### HC-67 Commerce — `/modules/commerce`
- **Purpose**: commerce rules and health without private data.
- **Data**: category rules, flow counts and durations, unknown outcomes queue (ids and states).
- **Actions**: edit category rules, reconcile with evidence, request case grant.
- **States**: any private field requested without a grant → not found.
- **Locale**: `admin.modules.commerce.*`

### HC-68 Procurement and supply — `/modules/procurement`
- **Purpose**: configure the company-side procurement suite for the hub without seeing any company's contents ([Procurement and supply](../procurement-and-supply.md)).
- **Data**: approval route templates and versions; document types bound from the country pack and requirement-set templates; e-invoicing network, accounting, ERP, project-tool and extraction adapters with their modes (fake, manual, live) and metered costs; AI intake settings (allowed routes per data class, confidence thresholds, file retention, external OCR on or off); default match tolerances; fraud-control defaults (cooling-off, callback, risk-signal rules); benchmark and pooling policy with counsel sign-off; packaging unit conversions with sources; cohort counts (companies using the suite, documents processed, median cycle times across at least ten companies).
- **Actions**: draft and activate template versions (second person for fraud-control, benchmark and pooling policy); enable adapters (second person for live); switch benchmarks or pooling on only with a recorded counsel sign-off; reconcile unknown payment or e-document outcomes with evidence; request a case grant when a company asks for help.
- **States**: benchmarks and pooling off by default with an explanation; fraud-control values below the engine minimum rejected with the minimum shown; any company record requested without a grant → not found; demo hub banner "demo: no money moves".
- **Mobile**: lists and approvals work at 375 px; template editors say "more comfortable on a wide screen".
- **Locale**: `admin.modules.procurement.*`

## Trust and safety

### HC-70 Moderation — `/trust/moderation`
- **Purpose**: reports and cases.
- **Data**: reports, cases with clause, evidence, decision, appeal; clause library mapped to local law; sanction ladder.
- **Actions**: open case, decide, apply sanction levels 1–3, request level 4 (second person), emergency hold or freeze.
- **Locale**: `admin.trust.moderation.*`

### HC-71 Disputes — `/trust/disputes`
- **Purpose**: execution and review disputes.
- **Data**: disputes with assertion, evidence under the dispute grant, parties' statements.
- **Actions**: confirm or dispute observation with evidence, exclude pending resolution, decide.
- **Locale**: `admin.trust.disputes.*`

### HC-72 Reputation methods — `/trust/reputation`
- **Purpose**: explainable methods.
- **Data**: method versions, local parameters within bounds, explanation texts per language, recomputation jobs.
- **Actions**: draft, review, release (hub owner), publish explanation.
- **States**: no control edits a score; parameters outside bounds refused.
- **Locale**: `admin.trust.reputation.*`

### HC-73 Appeals — `/trust/appeals`
- **Purpose**: one queue for appeals.
- **Data**: appeals against claims, credentials, moderation and observations; original decider; deadline.
- **Actions**: decide (not by the original decider), request information.
- **Locale**: `admin.trust.appeals.*`

### HC-74 Screening — `/trust/screening`
- **Purpose**: sanctions compliance ([ADR 014](../../adr/014-sanctions-compliance-engine.md), [module](../modules/sanctions-compliance.md); SANC-006).
- **Data**: baseline lists (always on, no switch) and additional lists with mode, last version, publication date, entry count and freshness (fresh, warning, stale); the geolocation dataset, mode and age; the matches queue (one item per subject, late after the service level) with the list entry and the screened names side by side under the case; open jurisdiction holds with place, source, dataset and time; re-screen runs with progress; cohort metrics (refusals per place and day, holds, matches, not-same-person share).
- **Actions**: add a list from a pack fact (live mode needs a second person); confirm a match; propose "not the same person" (completed by a second person in Approvals); decide an appeal (not the original decider); clear a hold with reason and evidence category; start a manual re-screen.
- **States**: stale baseline → banner "Screening unavailable: payments and commitments are paused"; no control loosens matching, pauses a baseline list or clears without a reason.
- **Locale**: `admin.trust.screening.*`

### HC-75 Confirmations — `/trust/confirmations`
- **Purpose**: honest confirmation requests.
- **Data**: confirmation policy, flagged reciprocal patterns, request and acceptance counts.
- **Actions**: edit policy (version), open case on a flagged pattern.
- **Locale**: `admin.trust.confirmations.*`

## Agents

### HC-80 Agent modules — `/agents/modules`, `/agents/modules/[module]`
- **Purpose**: the agent product catalogue.
- **Data**: modules with status, actions, eligibility, capabilities with their on or off state per participant type and plan, defaults and hub maximums, offered job subscriptions, routes, limits, metering, current price version with cost and sale price and margin, usage cohort stats.
- **Actions**: create version, preview the effect (counts of affected mandates, subscriptions and connections, cohort-suppressed), activate (second person for commitment actions), retire, turn a capability off or on, draft price (activation by another person), engage module or capability kill switch.
- **States**: negative margin → warning; commitment action without verified-company requirement → blocked.
- **Locale**: `admin.agents.modules.*`

### HC-81 Agent policy — `/agents/policy`
- **Purpose**: hub-wide agent rules.
- **Data**: allowed actions, outreach quotas, channels, disclosure text per language, plan-to-people automation limits; per-jurisdiction disclosure, liability, consent, record-keeping and per-action limits with the country-pack default beside each value (HUB-005).
- **Actions**: edit (version).
- **Locale**: `admin.agents.policy.*`

### HC-85 Extensions — `/agents/extensions`, `/agents/extensions/[extension]`
- **Purpose**: the governed extension registry (ADR 010 decision 22).
- **Data**: extensions with status, declared actions and mandate kinds, inputs, data classes, side effects, endpoints, cost model, safety-suite result and date, activation history.
- **Actions**: draft version, run the safety suite on the fake adapter, request activation (second person), suspend (one person), retire.
- **States**: failing safety suite → activation blocked; endpoint in a restricted place → refused at registration.
- **Locale**: `admin.agents.extensions.*`

### HC-82 External agents — `/agents/external`
- **Purpose**: MCP and A2A access policy.
- **Data**: protocols on/off, default and maximum rate limits, modules available to external clients, registered client counts by protocol; for MCP the `McpHubPolicySchema` fields ([The MCP server](../mcp-server.md#per-hub-configuration-and-the-console)): endpoints, disabled tools, client trust and listed clients, dynamic registration, anonymous cited answers, token lifetimes, limits.
- **Actions**: edit policy, engage external API kill switch; turning the admin MCP surface on needs a second person (MCP-071).
- **States**: no list of individual clients outside a case grant.
- **Locale**: `admin.agents.external.*`

### HC-83 Usage — `/agents/usage`
- **Purpose**: is the agent product useful, safe and affordable.
- **Data**: per module and period: active principals, runs, actions succeeded, escalated to humans, outcome unknown, cost, revenue; `CohortCount` renders suppressed values as "fewer than 10".
- **Actions**: export aggregates.
- **Locale**: `admin.agents.usage.*`

### HC-84 Abuse — `/agents/abuse`
- **Purpose**: signals that open cases.
- **Data**: signals by kind, throttles active, cases opened.
- **Actions**: open case, adjust thresholds (version).
- **Locale**: `admin.agents.abuse.*`

## Billing

### HC-90 Offers and plans — `/billing/offers`
- **Data**: offers, plan versions (includes, trial days, payer), free minimum. **Actions**: draft, activate (another person). **Locale**: `admin.billing.offers.*`

### HC-91 Prices — `/billing/prices`
- **Data**: price versions and metered price versions (per module, capability or catalogue model; flat or markup materialized into a fixed sale price) with cost price, sale price, margin, effective dates, acceptance text versions, acceptance counts, notice status for existing payers. **Actions**: draft, preview the effect, request activation (second person), cancel draft; a cost change offers a draft new version, never an automatic price change. **States**: overlap or back-dating refused; activated versions read-only ("A published version cannot be changed; create a new one"). **Locale**: `admin.billing.prices.*`

### HC-92 Invoices — `/billing/invoices`
- **Data**: invoice runs, states, totals by offer; e-invoicing status. **Actions**: retry failed issuance. **Locale**: `admin.billing.invoices.*`

### HC-93 Payouts — `/billing/payouts`
- **Data**: payout batches to organizers, authors and experts with totals and states. **Actions**: request release (second person); reconcile unknown outcomes. **Locale**: `admin.billing.payouts.*`

### HC-94 Credits and refunds — `/billing/credits`
- **Data**: credits issued within caps, credit-pack versions with validity shown before purchase (never expiring silently, ADR 012 decision 33), refund policy versions. **Actions**: issue credit (within role cap, reason), edit refund policy. **Locale**: `admin.billing.credits.*`

### HC-95 Tax — `/billing/tax`
- **Data**: tax treatment of hub fees with sources (US: state rules recorded per state), e-invoicing settings. **Actions**: edit (version). **Locale**: `admin.billing.tax.*`

## Keys and models

### HC-100 Providers — `/integrations/providers`, `/integrations/providers/[connection]`
- **Purpose**: connect the operator's own services.
- **Data**: connections by capability with mode, status, hosting country, broker flag, retention and training flags, last test, secret reference (store, fingerprint, version, rotated, last used).
- **Actions**: add connection, `SecretField` submit or rotate or revoke, test connection, request enable (second person), disable, engage kill switch.
- **States**: secret present → only fingerprint shown, no reveal; test failed → outcome code explained; enable blocked without passing test.
- **Mobile**: list and detail; secret entry supported.
- **Locale**: `admin.integrations.providers.*`

### HC-101 Routing — `/integrations/routing`
- **Data**: job × scope (job, agent module, extension) × route table with primary and fallbacks (catalogue models with pinned revisions), allowed data classes, limits, cap, status, cost per unit, rollout stage. **Actions**: create version, reorder fallbacks (buttons), activate (second person if non-public classes), roll back to the previous pin. **States**: embeddings fallback refused; image route limited to public; model not enabled in the catalogue or limits above its context window refused. **Locale**: `admin.integrations.routing.*`

### HC-102 Egress — `/integrations/egress`
- **Purpose**: who may receive which data.
- **Data**: `EgressMatrix` (data classes × connections), each cell allow/deny with residency and retention requirements and the effective decision with reason; the "private data can reach" sentence.
- **Actions**: change a cell (allowing non-public data needs a second person); sign off the sentence for the launch gate.
- **States**: training vendor cell for private class shows deny with "This provider trains models on submitted data" and no allow option.
- **Mobile**: one connection at a time as a list of classes.
- **Locale**: `admin.integrations.egress.*`

### HC-103 Spending caps — `/integrations/budgets`
- **Data**: caps by scope with `BudgetMeter`, alerts, on-exhausted behaviour. **Actions**: create, edit. **Locale**: `admin.integrations.budgets.*`

### HC-104 Usage and costs — `/integrations/usage`
- **Data**: aggregates by day, job, model version, connection, pipeline, module and cohort (participant type, plan; counts under ten suppressed); latency median and 95th percentile; projections labelled as projections; error and fallback rates. **Actions**: change period and grouping; export aggregates. **Locale**: `admin.integrations.usage.*`

### HC-106 Model catalogue — `/integrations/models`, `/integrations/models/[model]`
- **Purpose**: which models the hub uses and how a new version reaches service (ADR 010 decision 25, MODEL-001).
- **Data**: catalogue entries with connection, description, capabilities, context window and size limits, processing regions, retention and training terms, cost price, status; pinned revisions per route; evaluation runs (safety suite and quality check on hub sample sets) with scores and thresholds; rollouts with stage, shares and both versions' error, latency, cost and safety-signal rates.
- **Actions**: add, describe, run evaluation, request enable (second person for non-public data), disable, retire, start or widen a rollout, roll back, engage the model kill switch, manage sample sets (public or synthetic data only).
- **States**: no passing evaluation → enable blocked; guard threshold crossed → rollout stopped with the reason; end-of-life announced → alert with the date; processing region in a restricted place → refused.
- **Locale**: `admin.integrations.models.*`

### HC-105 Kill switches — `/integrations/kill-switches`
- **Purpose**: stop things now.
- **Data**: every switch by scope with state, who engaged and why, release history.
- **Actions**: engage (reason), request release (second person, incident note).
- **Mobile**: first-class; engage is one tap plus reason.
- **Locale**: `admin.integrations.killSwitches.*`

## Automation

### HC-110 Schedules — `/automation/schedules`
- **Data**: schedules with plain-language cron, next five runs in schedule and viewer time zones, windows, quotas, retries, concurrency, alerts, paused state. **Actions**: edit (`CronField`, `WindowEditor`), pause with reason, resume (catch-up option). **Locale**: `admin.automation.schedules.*`

### HC-111 Runs — `/automation/runs`, `/automation/runs/[run]`
- **Data**: runs with state, trigger, version, counts, cost, duration; detail with step log and links to what was proposed. **Actions**: run now, dry run (fakes or models), backfill, cancel queued or running, retry failed (new run). **States**: dry run banner "Dry run: nothing was saved". **Mobile**: full support. **Locale**: `admin.automation.runs.*`

### HC-112 Alerts — `/automation/alerts`
- **Data**: open and acknowledged alerts with suggested action. **Actions**: acknowledge, resolve with note. **Locale**: `admin.automation.alerts.*`

## Communications

### HC-120 Senders — `/communications/senders`
- **Data**: sending domains with SPF, DKIM, DMARC state; reply-to; SMS sender registration (US 10DLC brand and campaign). **Actions**: add domain, re-check DNS. **Locale**: `admin.communications.senders.*`

### HC-121 Templates — `/communications/templates`
- **Data**: templates by category with versions and languages; preview with synthetic data. **Actions**: edit (editors), activate (ops); blocked when a hub language is missing. **Locale**: `admin.communications.templates.*`

### HC-122 Deliverability — `/communications/deliverability`
- **Data**: delivery, bounce, complaint rates per template and channel. **Actions**: pause a template. **Locale**: `admin.communications.deliverability.*`

### HC-123 Announcements — `/communications/announcements`
- **Data**: announcements to opted-in audiences, legal notices. **Actions**: draft, send (lawful basis shown). **Locale**: `admin.communications.announcements.*`

## Federation

### HC-130 Peers — `/federation/peers`
- **Data**: peers, levels, licences, dates, tombstone latency. **Actions**: propose, accept, raise (second person for `deal-routing`, `identity`), lower, end, defederate. **Locale**: `admin.federation.peers.*`

### HC-131 Licences — `/federation/licences`
- **Data**: manifest licences per data class against defaults. **Actions**: make stricter (never looser). **Locale**: `admin.federation.licences.*`

### HC-132 Tombstones — `/federation/tombstones`
- **Data**: outgoing and incoming tombstones and takedown notices with deadlines and peer compliance. **Actions**: re-send, escalate. **Locale**: `admin.federation.tombstones.*`

### HC-133 Incoming links — `/federation/links`
- Same contract as HC-52 for peer proposals. **Locale**: `admin.federation.links.*`

## Privacy

### HC-140 Requests — `/privacy/requests`
- **Data**: access, export, correction, deletion, opt-out and objection requests with deadlines (US example 45 days), state, legal holds. **Actions**: start export (delivered to the person), decide deletion, request erasure execution (second person), record opt-out. **Locale**: `admin.privacy.requests.*`

### HC-141 Retention and holds — `/privacy/retention`
- **Data**: retention classes mapped to law, legal holds. **Actions**: edit classes (version), place or lift hold. **Locale**: `admin.privacy.retention.*`

### HC-142 Privacy settings — `/privacy/settings`
- **Data**: notices per language, consent categories, "Do not sell or share" handling and Global Privacy Control, cookie policy, breach authority and contacts. **Actions**: edit (version). **Locale**: `admin.privacy.settings.*`

### HC-143 Breaches — `/privacy/breaches`
- **Data**: breach register with notification deadlines per jurisdiction. **Actions**: record, link incident, record notifications. **Locale**: `admin.privacy.breaches.*`

## Staff and audit

### HC-150 Staff — `/staff`
- **Data**: staff with roles, scope, second factor, elevation, conflicts; role definitions and SoD mode. **Actions**: invite, assign (second person for sensitive), revoke, declare conflict, request break-glass, switch SoD mode (second person). **Locale**: `admin.staff.*`

### HC-153 Audit — `/audit`
- **Data**: mutation audit and access log with filters, denied attempts, chain verification state. **Actions**: verify chain, signed export. **States**: sequence gap → error banner. **Locale**: `admin.audit.*`

## Operations

### HC-160 Health — `/ops/health`
- **Data**: readiness, queues, outbox age, leases, dead letters, unknown outcomes, providers, index freshness, certificates, storage, backup age. **Actions**: open the screen that fixes each. **Locale**: `admin.ops.health.*`

### HC-161 Jobs — `/ops/jobs`
- **Data**: jobs by state, dead letters, unknown outcomes. **Actions**: retry idempotent jobs, reconcile with evidence. **Locale**: `admin.ops.jobs.*`

### HC-162 Flags — `/ops/flags`
- **Data**: flags with owner, scope, expiry. **Actions**: toggle per hub. **States**: access-related flags do not exist. **Locale**: `admin.ops.flags.*`

### HC-163 Maintenance — `/ops/maintenance`
- **Data**: state, banner text per language. **Actions**: enter or leave read-only mode. **Locale**: `admin.ops.maintenance.*`

### HC-164 Incidents — `/ops/incidents`
- **Data**: incidents with linked switches, holds, freezes, taints, break-glass sessions; post-incident reviews. **Actions**: open, link, close with review. **Locale**: `admin.ops.incidents.*`

### HC-165 Locales — `/ops/locales`
- **Data**: completeness per hub language for strings, templates, legal documents, community rules, plan templates, credential titles; unreviewed machine translations. **Actions**: open the item to complete. **Locale**: `admin.ops.locales.*`

### HC-166 Accessibility — `/ops/accessibility`
- **Data**: brand overlay contrast per language, automated check results for the deployed version, manual checklist with dates. **Actions**: record manual check. **Locale**: `admin.ops.accessibility.*`

## Proposed locale keys (sample, English reference)

| Key | English |
|---|---|
| `admin.nav.home` | Home |
| `admin.nav.hub` | Hub |
| `admin.nav.participants` | Participants |
| `admin.nav.support` | Support |
| `admin.nav.editorial` | Editorial office |
| `admin.nav.data` | Data |
| `admin.nav.modules` | Modules |
| `admin.nav.trust` | Trust and safety |
| `admin.nav.agents` | Agents |
| `admin.nav.billing` | Plans and payments |
| `admin.nav.integrations` | Keys and models |
| `admin.nav.automation` | Automation |
| `admin.nav.communications` | Communications |
| `admin.nav.federation` | Federation |
| `admin.nav.privacy` | Privacy |
| `admin.nav.staff` | Staff and audit |
| `admin.nav.ops` | Operations |
| `admin.overview.nothingWaiting` | Nothing needs your decision today |
| `admin.approvals.ownRequest` | You cannot approve your own request |
| `admin.approvals.actionChanged` | The action changed; a new request is required |
| `admin.integrations.providers.secretSaved` | Key saved. Fingerprint: {fingerprint} |
| `admin.integrations.providers.noReveal` | Saved keys are never shown |
| `admin.integrations.egress.trainingDenied` | This provider trains models on submitted data; private data cannot be sent to it |
| `admin.automation.runs.dryRunBanner` | Dry run: nothing was saved |
| `admin.editorial.review.similarityBlocked` | Too close to the source: {overlap} against a threshold of {threshold} |
| `admin.editorial.review.aiImageLabel` | Illustration generated by AI |
| `admin.support.account.ownAccount` | You cannot service your own account |
| `admin.support.account.coolingOff` | Takes effect on {date}; the account owner has been notified |
| `admin.agents.usage.suppressed` | fewer than 10 |
| `admin.common.wideScreenNote` | More comfortable on a wide screen |
| `admin.common.demoNotSaved` | Demo: changes are not saved |
