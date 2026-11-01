# Privacy implementation coverage

PRV-001 / issue #93. Status: **partial, pending conductor review and integration**. The work package is not complete. The continuation adds public marketing suppression, proof-bound unregistered support/source intake, exact append-only source correction and a local retained source-deactivation executor, configured fake DROP intake, two-person plan admission, owning export history, authenticated bounded file streams, durable propagation intents and local restore CLI integration. Whole-subject erasure, complete exports and remaining owning consumers are still engineering work, not owner-only permission blockers.

## Implemented runtime paths

Requests, preferences, export metadata, legal holds and replay receipts use PostgreSQL with forced RLS and narrow security-definer commands. The requester is the authenticated person; another person's id is refused. A company request requires a current administrator membership. Company data still passes through each existing module's finer permissions; administration is not a way to bypass a deal permission. A staff case grant never becomes a subject-export credential.

Exports are currently **partial** and say `complete: false`. The composition root invokes existing profile, project, catalogue, procurement, quote, agreement and company serializers in the real principal transaction. JSON and file delivery use one repeatable-read snapshot. The delivery route checks current authority, locks the person's authorization row, checks company membership and recomposes; possession of an export id grants nothing. Local FILE/blob storage verifies the generated JSON digest, then removes the temporary bytes. There are no signed download URLs, caller-supplied paths or provider calls. Billing and paid-plan state are not consulted. Personal participating projects are enumerated from live, unexpired subject grants and still pass through the owning shared projection. Personal supplier invitations include only their pinned shared RFQ versions. Employer participation and invitations are excluded from a personal export. Existing catalogue, quote and agreement readers already include their version/event history; coverage records that rather than inventing a second serializer. Tests demonstrate an unpaid person, an exactly ended paid subscription, counterparty private-budget exclusion and ownership revocation at delivery.

## Export and erasure inventory

| Implemented API module | Export status and scope | Subject deletion capability |
|---|---|---|
| approval-routes | partial: all own-company route versions and request decision cards, current delegations; person-only decision history pending | Unavailable; exact gap recorded in the plan |
| assistant | unsupported: requires owning-module exporter | Unavailable; exact gap recorded in the plan |
| assistant-goals | partial: own personal goals/progress, authored personal reports and job subscriptions; agent negotiation and employer internals excluded | Unavailable; exact gap recorded in the plan |
| billing | partial: own accounts, subscriptions, accepted prices, budgets and reservations; ledger and usage history pending | Unavailable; exact gap recorded in the plan |
| catalogue | partial: all own offerings and versions with owning private-knowledge projection; audit history pending | Unavailable; exact gap recorded in the plan |
| communications | partial: full project/agreement thread history, paginated own notifications, preferences and channels; other contexts pending | Unavailable; exact gap recorded in the plan |
| connections | partial: own connections and all consent history, without tokens, credentials or elevation ids | Unavailable; exact gap recorded in the plan |
| consultations | partial: own requests/bookings, all offerings, availability including closed windows and personal mentoring; internal reminder delivery records excluded | Unavailable; exact gap recorded in the plan |
| content | partial: all owned publication working views with published versions and corrections; comment, wall and editorial history pending | Unavailable; exact gap recorded in the plan |
| directory | partial: existing member projection; member directory not included | Unavailable; exact gap recorded in the plan |
| execution | partial: authorized confirmed agreement execution projections; full audit history pending | Unavailable; exact gap recorded in the plan |
| files | partial: own authorized metadata and clean local bytes with digest checks; bounded inline bytes plus authenticated streaming of larger files; streaming verifies size/hash before delivery and holds FILE authority through completion | Unavailable; exact gap recorded in the plan |
| hubs | partial: own legal-document acceptance history; operator records require separate owning projection | Unavailable; exact gap recorded in the plan |
| identity | partial: person, emails, provider identities, memberships and all session views without token hashes; account-change history pending | Unavailable; exact gap recorded in the plan |
| jurisdiction | unsupported: Owning exporter unavailable | Unavailable; exact gap recorded in the plan |
| models | unsupported: Owning exporter unavailable | Unavailable; exact gap recorded in the plan |
| plans | partial: owner plans, all versions/states/changes/timing/shares/locations/permits/diary plus current addressed shared-item projections; revoked private shares excluded | Unavailable; exact gap recorded in the plan |
| platform-admin | partial: own request and preference records | Unavailable; exact gap recorded in the plan |
| procurement | partial: own needs, all RFQ versions and invitations; personal supplier invitations and pinned shared RFQ versions; company invitation history pending | Unavailable; exact gap recorded in the plan |
| profiles | supported: owner profile, consents, licences, portraits, experience, preferences, follows, bookmarks and reading progress | Unavailable; exact gap recorded in the plan |
| projects | partial: owned and currently participating project projections; ownership-transfer and participation history pending | Unavailable; exact gap recorded in the plan |
| providers | unsupported: Owning exporter unavailable | Unavailable; exact gap recorded in the plan |
| reputation | partial: own reputation builder including superseded credentials/checks and confirmation inbox; historical computed snapshots unavailable | Unavailable; exact gap recorded in the plan |
| sales | partial: authorized buyer/seller quote versions, negotiation rounds and amendment requests; audit history pending | Unavailable; exact gap recorded in the plan |
| screening | partial: own minimal compliance status; sensitive match/reviewer internals excluded | Unavailable; exact gap recorded in the plan |
| screening-gates | unsupported: Owning exporter unavailable | Unavailable; exact gap recorded in the plan |
| sources | Subject-wide export unavailable: requires a safe subject discovery port | Exact field correction; local retained field deactivation only; immutable evidence retained |
| supplier-base | partial: all own-company supplier records, assessments and external counterparties; sharing history pending | Unavailable; exact gap recorded in the plan |
| support | partial: all own cases, requester-visible notes/diagnostics, all servicing actions and masked access history through owning projections | Unavailable; exact gap recorded in the plan |
| tasks | partial: all own requests/versions, offer groups/versions, assignments and invitations; historical private offer constraints limited to the current owning projection | Unavailable; exact gap recorded in the plan |
| transactions | partial: authorized agreement/order projections, acceptance events and order-change history; audit records pending | Unavailable; exact gap recorded in the plan |
| trust | partial: confirmed agreement reviews and responses; historical reputation snapshots pending | Unavailable; exact gap recorded in the plan |

The inventory covers every implemented API module directory and is checked against the filesystem. Empty fixtures do not establish completeness. Local file export includes only currently authorized clean bytes, verifies their recorded digest and never exposes a storage key. Inline limits are 16 MiB per object and 64 MiB total; larger binaries explicitly require a future streaming export, and `complete` stays false.

Only the privacy-owned correction replay adapter exists; a receipt never means the whole subject was erased.

## Country policy and rights

No actual country deadline, retention period or regulator schedule is invented. The privacy policy table requires a reviewed source for verified values. Every unconfigured country remains `UNKNOWN`; erasure cannot proceed. Existing illustrative handbook values are not loaded as law. Tests label their positive policy as synthetic (`ZZ`, `example.invalid`). Retention is stored from the policy, but there is no retention purge worker.

Correction intake stores a protected proposal; it does not mutate an owning module or rewrite provenance. GPC, sale/share opt-outs, sensitive-data limits and direct-marketing objections persist as data. Objections create minimal hashes of the subject's verified addresses; concurrent preference updates cannot clear them. Collection and delivery enforcement are not complete until their owning paths consume the barrier.

A public marketing objection requires no registration and returns the same acknowledgement for known and unknown addresses. It writes only the existing MAIL namespaced hash and unsubscribe barrier. The worker contact-lock port is tested in both race orders; its final MAIL hook is still a coordinated SANC seam.

Nonparticipant source intake uses an opaque capability tied to a source-field digest, exact action, current case grant and an internal verification note authored by the human verifier. A generic address cannot obtain it. Correction/erasure requests remain pending owning resolution; an objection immediately records do-not-collect, and the actual SRC staging table refuses refresh/import of that record. A staged batch cannot activate after an objection; the existing public provenance projection also consults the barrier. Source history is not rewritten.

The typed fake DROP adapter and bounded registry intake use only configured pack polling intervals and deadlines, preserve UNKNOWN/unavailable states, serialize concurrent polling and reject conflicting external references. Registry receipt is intake requiring proof, never deletion authority. No scheduler contacts an external regulator.

## Erasure and restore limits

Legal holds are platform-scoped, elevated and audited with category reasons. They share a subject advisory lock with erasure readiness and replay. Readiness returns `legal_hold`, `country_policy_UNKNOWN` or `module_erasure_adapters_unavailable`; there is no successful erasure response. The subject-plan API now uses the existing administration second-person approval operation. It binds the complete module inventory, subject revision/authz epoch, privacy record versions, policy, holds and each reviewer's current authority/grant. Execute rechecks these under the same transaction locks. Changed inputs invalidate the plan. Missing owning operations return named gaps without consuming the approval or creating a deletion receipt. The plan is not a successful erasure executor; source/version inventories for unavailable owning modules are explicitly absent capabilities.

### Retained journal foundation (local proof only)

The old content-addressed bucket accepted an absent prefix as an empty journal. That implementation is replaced by an explicitly provisioned local journal and an **independently retained authority directory**. Neither is created by reading, recording or restoring. Provisioning refuses existing directories, including empty ones. There is no temporary-directory default and no environment-driven erasure enablement.

The installation binding pins the authority directory and journal UUID independently of both the restored database and the operator-selected journal path. `authorizeLocalPrivacyRestore` requires this retained-authority binding separately from the ledger object; a fully provisioned new ledger does not satisfy the old binding. The authority checkpoint records the UUID, monotonic sequence, hash-chain head and permanent restore seal. Journal identity, every sequence number, predecessor hash, content schema, unique request id, count and final hash must agree. Missing prefixes, wrong identities, missing authority, truncated journals and old copies fail closed, even against a database with no replay receipts.

Files and parent directories are fsynced. Records are created exclusively, then the checkpoint is replaced by fsynced temporary-file/rename/directory-sync. A crash between the two does not silently acknowledge a decision. Atomic `mkdir` of `operation.lock` in the retained authority serializes writers and restore across processes; moving the journal path does not move that lock. The lock spans verification, snapshot, replay, database commit and the actual fence lift. Authorization audit includes the exact UUID, sequence and chain head.

Restore writes a durable seal before replay. A writer that wins first must finish its checkpoint before restore can acquire the lock. A restore that wins first refuses all competing writers, and the seal rejects later appends after handover. **This is a finite, sealed local restore proof, not a live erasure executor.** Allowing later erasures requires the future executor to apply module changes under a complete serving-fence protocol; no reopen, reset, TTL or bypass option exists here.

A thrown operation before lock release, or process death while holding it, leaves the authority lock in place. A late unlock-directory sync failure can leave the operation outcome unknown after release; the verified checkpoint and durable seal still prevent a missing decision or a new unfenced append. There is no PID check, expiry or automatic stale-lock takeover: a process may have committed the database without lifting the fence. Tests kill real child processes after entry fsync, after checkpoint fsync, after snapshot/seal and after DB commit but before lift; new processes cannot authorize, and the real runtime login remains denied. Manual lock deletion is not a supported recovery procedure. A reconciled retained-authority recovery tool is unfinished; preserve the lock, checkpoint, journal and fence for investigation.

Local filesystem durability is a fake with explicit trust assumptions: the authority is retained independently, its provisioning binding is trusted, and it is never rolled back with the journal or database. This does not provide WORM storage, protection against an administrator replacing the authority itself, host-loss durability or multi-host storage consensus. If those assumptions cannot be established, this capability cannot be used. Production provisioning and restore integration remain unavailable, not implied by these local tests.

### Compatibility and irreversible retention boundary

The existing OPS-003 CLI and physical drill are preserved for installations that have **never enabled PRV-001 subject erasure**. This release has no runtime subject-erasure executor or activation path. The CLI no longer constructs a mandatory filesystem privacy ledger (which formerly rejected every production configuration). Its existing FILE-001 tombstone workflow is unchanged. A real PostgreSQL test runs the existing CLI with a production environment and no privacy storage, reconciles and lifts only that test's runtime fence.

The explicitly local `runLocalPrivacyRestoreCli` uses the existing CLI authorization flow with a binding supplied by independent provisioning. It never derives the pin from the journal, database, environment or operator flags. Missing authority refuses authorization. No flag selects a legacy fallback after privacy enablement. The default CLI is **not recovery for an erasure-enabled installation**; a database with no receipts cannot establish that an external journal never existed. Enabling production erasure remains blocked until an independently retained installation registry binds every normal start, writer and restore to the same authoritative journal. Out-of-tree or previously enabled erasure installations are unsupported and must stay fenced; this patch does not establish their compatibility.

Once a local journal has decisions, its authority, checkpoint, identity, records and seal must survive every database/object restore for as long as any backup or peer could resurrect data. Selecting a fresh directory, supplying a fresh ledger object, removing receipts or choosing a new UUID cannot satisfy the original binding. Missing or uncertain retained authority means no local restore authorization. Full production activation must make this lifetime obligation irreversible before any real erasure decision commits.

The existing version-1 `privacy` replay adapter provides: correction redaction, restrictive restored reads and suppression/do-not-collect replay. Unsupported modules, conflicting receipts and retained legal holds abort replay. The physical drill has an explicit synthetic privacy fixture, provisioned before backup, with a retained decision after the recovery point. It uses the local CLI for archive-end and earlier PITR authorization and checks redaction and restored suppression. A real synthetic sourced professional-credential field is visible through the owning public projection before backup; after replay that projection is empty, actual reimport is refused, and immutable evidence is preserved. Physical execution passed in CI at `63146e0adea973c9994378bf46e2e2bf1f36b36b`; subsequent head checks are recorded separately in the continuation report. It does not prove whole-subject erasure or every delivery/projection consumer. Existing export, legal-hold and UNKNOWN lawful-retention authority checks remain intact.

Replay also writes typed retrieval/federation propagation intents in the same database transaction. The isolated consumers serialize by operation ID, commit outcome_unknown before any adapter effect, reconcile after process death, and accept only the exact digest receipt. No adapter is enabled by default. Owning index/federation ID/revision mapping, signing and runtime registration remain gaps; pending intents are not fabricated send success.

Whole-subject erasure, complete module exports, retrieval/federation runtime dispatch, production immutable storage and production restore integration are incomplete. PRV-001 stays `in_progress`; dependent work remains locked until full acceptance. No production or provider action was performed.

## Coordination seams

- After PR485 actually merged, the rebased final MAIL handler now checks the retained marketing barrier after the mail-row lock and before COMMS suppression locks. The lock spans transport, receipt and commit. Immutable SANC recipient/binding authority is unchanged. Both lock orders, late receipts and process death after the fake effect are tested; unknown outcomes remain parked without resend.
- Active BILL/AST/LLM paths retain their files. A new isolated billing-owned privacy port performs the payer projection under the existing transaction; no ranking or entitlement input was introduced. Remaining agent/model histories need owning projections.
- SRC consumes do-not-collect at staging, activation and public provenance. Verified external-subject cases bind the exact field digest, action, proposed-value digest, evidence and attesting human without creating a person/company. Existing grant request/approval authorizers remain mandatory. Source plans recheck both humans, case grants, source version, policy/retention and holds in the mutation transaction. Correction appends a new field and immutable resolution; the old evidence remains. Version-2 local retained decisions replay exact source deactivation, including into older snapshots without a plan. Runtime erasure stays blocked without retained authority; no subject-wide deletion is claimed.
- Each completed owning module needs explicit retained/deleted/redacted fields and an idempotent command before a subject erasure plan can be approved. A broad maintenance dump or delete is not an adapter.

These seams were reported in issue #93 while independent privacy work continued. Worker completion is not acceptance.

## Authenticated file attachments

`GET /v1/privacy/exports/:id/files/:fileId` rechecks the current export subject and the existing FILE owner authority. Only exact owned clean local files are available. A private temporary spool verifies every byte and the stored digest before HTTP delivery; 64 KiB reads keep memory bounded. The same transaction holds file and state locks through response completion, then removes the spool. The JSON manifest identifies separately downloadable files instead of calling a 16 MiB cutoff a complete export. External storage remains unavailable without an owning streaming adapter.

## Source resolution limits

The public intake accepts a capability previously bound by an elevated staff member to an exact external-subject case and verified evidence. It never treats an arbitrary contact address as deletion authority or discovers source records by identity search. Staff grant approval, case status and the exact source digest are rechecked. An ordinary support case remains valid for the inherited objection flow; mutation plans require the explicit external-subject case contract. Source-specific holds currently have an immutable placement port and no release workflow. Correction and deactivation preserve original lawful provenance. A corrected field carries a structured correction marker in the owning public projection; stale reimport requires a new review.

### Exact-session delivery and source-v2 recovery fixture

Privacy JSON and attachment delivery bind the originating session ID, person and token hash. Snapshot row locks check that the session was not revoked or changed after resolution; current idle and absolute expiry are checked again after composition or file verification. Person, company and membership locks use immediate conflict refusal to avoid reverse-order cycles with owning revocation writers. No principal refresh, session substitution or automatic delivery retry occurs. Locks remain through the HTTP response-consumption callback. Inline file content uses the same owning file lock as streamed attachments.

The isolated physical restore fixture now records an actual source-v2 deactivation through elevated exact case grants, independent human approval and the locally pinned retained executor after the recovery point. The older PITR image must lack the request and plan before replay. Replay verifies immutable field evidence, deactivation, the exact replay receipt, public suppression and rejected reimport. This extends fixture coverage; exact-head physical execution evidence is reported separately and is not implied by the implementation.

### Source hold release: concrete retained-contract gap

Source-specific holds remain immutable and effective. The existing subject-level `privacy_hold_release` mutates `legal_hold.released_at` under one `admin.privacy.hold` permission; it is not a suitable source release workflow requiring independent approval. The frozen ADM `SecondPersonActionSchema` has `privacy.execute_erasure` but no source-hold release action. Reusing an erasure approval would misstate what the reviewer authorized.

More fundamentally, `PrivacySourceTombstoneSchema` version 2 binds only the exact field evidence and decision. It carries neither hold-placement evidence nor independently approved release receipts, and the retained journal accepts only privacy/source deletion decisions. A release recorded only in the restorable database could disappear on an older restore; ignoring restored holds would instead erase a legal constraint. Execution and `sources_replay_privacy_erasure` therefore continue to refuse every existing source hold. Completing release requires an explicitly versioned retained hold/release record and replay ordering/conflict contract, plus the corresponding approved ADM action, before adding an append-only audited receipt under current exact case grants. No original hold is changed, timed out or implicitly released by this repair.
