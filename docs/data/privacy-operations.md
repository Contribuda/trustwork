# Privacy implementation coverage

PRV-001 / issue #93. Status: **partial, pending conductor review and integration**. The work package is not complete. The operational contracts in `packages/contracts/src/privacy.ts` cover only the implemented intake and local journal shapes. New cross-module erasure rules and a production ledger writer remain proposals for the owning modules and maintainers; this document does not authorize them.

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

The independent local journal rejects changed decisions and corrupted content. Restore authorization reads the external journal every time, requires an applied fence, replays in the restore transaction and lifts the fence only after commit. The narrow synthetic drill restores old privacy correction rows and removes the database receipt; replay redacts them again and runtime RLS serves no erased privacy records. Missing or unsupported journal records prevent authorization. Existing restore reconciliation tests use an explicit separate empty fixture journal.

Whole-subject erasure, retrieval/federation tombstone dispatch, no-outreach/no-reimport acceptance, real two-person execution, cross-process journal writer freezing, production immutable storage and a full backup restore drill remain unmet. No production or provider action was performed.

## Coordination seams

- Active CONS paths: `packages/data/src/repositories/communications.ts`, `packages/data/src/repositories/mail.ts` and their workers need an atomic shared suppression lock/check at queued delivery and cancellation. A privacy-only mock queue would not prove the acceptance criterion.
- Active BILL/AST/LLM paths need their own authorized exporter adapters. No active owned code was edited.
- `packages/data/src/repositories/sources.ts` needs a verified nonparticipant identity tie, append-only correction command and refresh check of do-not-collect keys.
- Each completed owning module needs explicit retained/deleted/redacted fields and an idempotent command before a subject erasure plan can be approved. A broad maintenance dump or delete is not an adapter.

These seams were reported in issue #93 while independent privacy work continued. Worker completion is not acceptance.
