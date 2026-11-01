# Privacy implementation coverage

PRV-001 / issue #93. Status: **partial, pending conductor review and integration**. The work package is not complete. The operational contracts in `packages/contracts/src/privacy.ts` cover only the implemented intake and local journal shapes. Two-person erasure execution, module-owned suppression consumers, remaining exports and production journal integration remain implementation work. They are not owner-only permission blockers; this session is bounded to the journal/restore repair.

## Implemented runtime paths

Requests, preferences, export metadata, legal holds and replay receipts use PostgreSQL with forced RLS and narrow security-definer commands. The requester is the authenticated person; another person's id is refused. A company request requires a current administrator membership. Company data still passes through each existing module's finer permissions; administration is not a way to bypass a deal permission. A staff case grant never becomes a subject-export credential.

Exports are currently **partial** and say `complete: false`. The composition root invokes existing profile, project, catalogue, procurement, quote, agreement and company serializers in the real principal transaction. The delivery route checks current authority, locks the person's authorization row, checks company membership and recomposes; possession of an export id grants nothing. Local FILE/blob storage verifies the generated JSON digest, then removes the temporary bytes. There are no signed download URLs, caller-supplied paths or provider calls. Billing and paid-plan state are not consulted. Tests demonstrate an unpaid person and ownership revocation at delivery; an ended subscription fixture is not yet covered.

## Export and erasure inventory

| Module | Export in this slice | Erasure/replay in this slice |
|---|---|---|
| Agreements and orders | Current authorized buyer/seller projections, including shared records; history incomplete | Unsupported; immutable terms and lawful evidence require owner commands |
| Assistant and agent goals | Unsupported; active AST/LLM integration seam | Unsupported |
| Billing | Unsupported; active BILL integration seam | Unsupported |
| Catalogue | Current offering owner projection; historical versions incomplete | Unsupported |
| Communications and mail | Unsupported; active CONS integration seam | No queued-message cancellation or delivery barrier wired |
| Company | Existing member projection; directory and other company records incomplete | Unsupported |
| Content | Unsupported | Unsupported |
| Execution and trust | Unsupported | Unsupported |
| Files | Binary export not composed | Existing FILE commands and file journal remain intact; subject-wide composition not wired |
| Identity | Profile identity subset; e-mail/session/exportable identity records incomplete; secrets excluded | Unsupported; no account erasure executor |
| Plans | Unsupported | Unsupported |
| Privacy | Own request and preference records | Privacy-owned correction redaction, restrictive restored reads and suppression replay only |
| Procurement | Own needs and RFQ projections; invitation and historical coverage incomplete | Unsupported |
| Profiles | Existing owner profile, consent, licence, portrait, experience and private attention views | Unsupported |
| Projects | Owned project projections; participation-only enumeration incomplete | Unsupported |
| Reputation | Unsupported | Unsupported |
| Sales | Current authorized quote projections; history incomplete | Unsupported |
| Sources | Unsupported; nonparticipant proof and correction not wired | Do-not-collect keys are persisted, but refresh does not consult them yet |
| Support | Unsupported; requires case-specific export | Unsupported |
| Tasks | Unsupported | Unsupported |

This inventory is intentionally incomplete; empty fixture data is not evidence that an unsupported module is exported or erased.

## Country policy and rights

No actual country deadline, retention period or regulator schedule is invented. The privacy policy table requires a reviewed source for verified values. Every unconfigured country remains `UNKNOWN`; erasure cannot proceed. Existing illustrative handbook values are not loaded as law. Tests label their positive policy as synthetic (`ZZ`, `example.invalid`). Retention is stored from the policy, but there is no retention purge worker.

Correction intake stores a protected proposal; it does not mutate an owning module or rewrite provenance. GPC, sale/share opt-outs, sensitive-data limits and direct-marketing objections persist as data. Objections create minimal hashes of the subject's verified addresses; concurrent preference updates cannot clear them. Collection and delivery enforcement are not complete until their owning paths consume the barrier.

The `data_broker_registration` table is schema only. Fake DROP polling/intake, country-pack registry scheduling, public nonparticipant form/letter/e-mail proof and minimal identity-tie verification remain unimplemented. They are not described as live adapters.

## Erasure and restore limits

Legal holds are platform-scoped, elevated and audited with category reasons. They share a subject advisory lock with erasure readiness and replay. Readiness returns `legal_hold`, `country_policy_UNKNOWN` or `module_erasure_adapters_unavailable`; there is no successful erasure response. A tombstone schema rejects identical executor/approver ids, but this is not a runtime second-person approval protocol. The existing administration approval mechanism still needs a complete erasure plan/digest integration.

### Retained journal foundation (local proof only)

The old content-addressed bucket accepted an absent prefix as an empty journal. That implementation is replaced by an explicitly provisioned local journal and an **independently retained authority directory**. Neither is created by reading, recording or restoring. Provisioning refuses existing directories, including empty ones. There is no temporary-directory default and no environment-driven erasure enablement.

The installation binding pins the authority directory and journal UUID independently of both the restored database and the operator-selected journal path. `authorizeLocalPrivacyRestore` requires this retained-authority binding separately from the ledger object; a fully provisioned new ledger does not satisfy the old binding. The authority checkpoint records the UUID, monotonic sequence, hash-chain head and permanent restore seal. Journal identity, every sequence number, predecessor hash, content schema, unique request id, count and final hash must agree. Missing prefixes, wrong identities, missing authority, truncated journals and old copies fail closed, even against a database with no replay receipts.

Files and parent directories are fsynced. Records are created exclusively, then the checkpoint is replaced by fsynced temporary-file/rename/directory-sync. A crash between the two does not silently acknowledge a decision. Atomic `mkdir` of `operation.lock` in the retained authority serializes writers and restore across processes; moving the journal path does not move that lock. The lock spans verification, snapshot, replay, database commit and the actual fence lift. Authorization audit includes the exact UUID, sequence and chain head.

Restore writes a durable seal before replay. A writer that wins first must finish its checkpoint before restore can acquire the lock. A restore that wins first refuses all competing writers, and the seal rejects later appends after handover. **This is a finite, sealed local restore proof, not a live erasure executor.** Allowing later erasures requires the future executor to apply module changes under a complete serving-fence protocol; no reopen, reset, TTL or bypass option exists here.

A thrown operation or process death leaves the authority lock in place. There is no PID check, expiry or automatic stale-lock takeover: a process may have committed the database without lifting the fence. Tests kill real child processes after entry fsync, after checkpoint fsync, after snapshot/seal and after DB commit but before lift; new processes cannot authorize, and the real runtime login remains denied. Manual lock deletion is not a supported recovery procedure. A reconciled retained-authority recovery tool is unfinished; preserve the lock, checkpoint, journal and fence for investigation.

Local filesystem durability is a fake with explicit trust assumptions: the authority is retained independently, its provisioning binding is trusted, and it is never rolled back with the journal or database. This does not provide WORM storage, protection against an administrator replacing the authority itself, host-loss durability or multi-host storage consensus. If those assumptions cannot be established, this capability cannot be used. Production provisioning and restore integration remain unavailable, not implied by these local tests.

### Compatibility and irreversible retention boundary

The existing OPS-003 CLI and physical drill are preserved for installations that have **never enabled PRV-001 subject erasure**. This release has no runtime subject-erasure executor or activation path. The CLI no longer constructs a mandatory filesystem privacy ledger (which formerly rejected every production configuration). Its existing FILE-001 tombstone workflow is unchanged. A real PostgreSQL test runs the existing CLI with a production environment and no privacy storage, reconciles and lifts only that test's runtime fence.

The local replay entry point is separate from the CLI. No flag selects a legacy fallback after privacy enablement. The default CLI is **not recovery for an erasure-enabled installation**; a database with no receipts cannot establish that an external journal never existed. Enabling production erasure remains blocked until an independently retained installation registry binds every normal start, writer and restore to the same authoritative journal. Out-of-tree or previously enabled erasure installations are unsupported and must stay fenced; this patch does not establish their compatibility.

Once a local journal has decisions, its authority, checkpoint, identity, records and seal must survive every database/object restore for as long as any backup or peer could resurrect data. Selecting a fresh directory, supplying a fresh ledger object, removing receipts or choosing a new UUID cannot satisfy the original binding. Missing or uncertain retained authority means no local restore authorization. Full production activation must make this lifetime obligation irreversible before any real erasure decision commits.

Only the `privacy` replay adapter exists: correction redaction, restrictive restored reads and suppression/do-not-collect replay. Unsupported modules, conflicting receipts and retained legal holds abort replay. The synthetic drill restores old privacy rows; it does not prove whole-subject erasure, no-outreach/no-reimport acceptance or a physical backup recovery. Existing export, legal-hold and UNKNOWN lawful-retention authority checks remain intact.

Whole-subject erasure, digest-bound two-person authorization/execution, suppression consumers, remaining module exports, retrieval/federation dispatch, production immutable storage and production restore integration are incomplete. PRV-001 stays `in_progress`; dependent work remains locked until full acceptance. No production or provider action was performed.

## Coordination seams

- Active CONS paths: `packages/data/src/repositories/communications.ts`, `packages/data/src/repositories/mail.ts` and their workers need an atomic shared suppression lock/check at queued delivery and cancellation. A privacy-only mock queue would not prove the acceptance criterion.
- Active BILL/AST/LLM paths need their own authorized exporter adapters. No active owned code was edited.
- `packages/data/src/repositories/sources.ts` needs a verified nonparticipant identity tie, append-only correction command and refresh check of do-not-collect keys.
- Each completed owning module needs explicit retained/deleted/redacted fields and an idempotent command before a subject erasure plan can be approved. A broad maintenance dump or delete is not an adapter.

These seams were reported in issue #93 while independent privacy work continued. Worker completion is not acceptance.
