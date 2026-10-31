# Operations: staff, audit, backups, updates, health

Status: **Proposed**. Contract: `HubStaffAssignmentSchema`, `HUB_STAFF_ROLES`, `ConsolePermissionSchema`, `HUB_SECOND_PERSON_ACTIONS`, `consoleActionNeedsSecondPerson`, `BackupRecordSchema`, `RestoreDrillSchema`, `KillSwitchSchema`, `LaunchGateSchema` in [`hub.ts`](../../../packages/contracts/src/hub.ts); `StaffRoleDefinitionSchema`, `SecondPersonApprovalSchema`, `AdminAuditEventSchema`, `AccessLogEntrySchema`, `auditSequenceContinuous` in `admin.ts`. Screens HC-01…HC-03, HC-150…HC-166 and NC-01…NC-09 in [screens](screens.md). Backends: ADM-001, HUB-001, proposed OPS-001. The [operations runbook](../../operations/runbook.md) remains the release and recovery procedure; this chapter designs the console around it.

## Staff and roles

- **Roles** are scoped to one hub or to the node (`HubStaffAssignmentSchema`). A person keeps one identity; a staff role is not an employer and does not change their ordinary membership.
- **Joining**: invitation by a staff admin; the invitee must have a verified e-mail (or the setup-time invitation link), a **second factor**, and accept the staff terms. Sensitive roles need a second approver.
- **Elevated sessions**: the console opens only after step-up (password within ten minutes and second factor); elevation expires after inactivity (proposal: 30 minutes) and on closing the browser.
- **Conflicts of interest**: staff declare their employer and other interests; the console blocks them from deciding claims, disputes, moderation or support cases about their own company or close relations, and routes those to another person.
- **Break-glass**: a time-boxed elevated role (hours, not days) for incidents, requested with an incident reference, approved by a second person, every action marked break-glass and reviewed after the incident.
- **Separation-of-duties mode**: `reduced` below five staff (only actor ≠ approver), `full` from five (hard role conflicts too); switching is itself a two-person action.
- **Leaving**: revoking a role ends elevation and pending approvals by that person immediately; their past actions stay attributed.

## Approvals

The **Approvals** screen is the console's second most important page after the overview. A second-person request shows exactly what will change (a diff of the configuration version, the price version with cost and sale price, the restore target, the peering level), who asked and why, and binds the approval to the **digest of that exact action**: any change voids it (`approvalBindsAction`). Approvers can approve, decline with a reason, or ask a question in the request's thread. Requests expire (proposal: 7 days). The overview shows a count; staff can opt into e-mail notices.

## Audit

- **Mutation audit** (`AdminAuditEventSchema`): every console mutation, with actor, role, permission, elevation, case, second approver and approval digest, before and after digests (never payloads), reason code and text, outcome (`applied`, `denied`, `failed`), request id. Append-only with a monotonic sequence; gaps are detected (`auditSequenceContinuous`).
- **Access log** (`AccessLogEntrySchema`): every staff read under a case or dispute grant, with fields hash.
- **Browsing**: filters by actor, action, object, outcome, date; denied attempts are visible (they are often the interesting ones).
- **Verification**: a "verify chain" action checks sequence continuity (and anchors when implemented).
- **Export**: signed export for auditors and authorities, through an allowlist; exports are themselves audited.
- Who sees audit: auditors and the hub owner; other staff see their own actions.

## Backups and restore

| Item | Design |
|---|---|
| What is backed up | Database (full plus WAL for point-in-time recovery where chosen), object storage (versioned), the **tombstone ledger** (separately, so erasures can be replayed after a restore), configuration export |
| Schedule | Set in the node console; defaults proposed: nightly full, continuous WAL, weekly object snapshot; retention by the privacy settings |
| Protection | Always encrypted (`encrypted: true`); off-host copy required before soft launch; keys held by the operator, not in the same bucket |
| Restore drill | Restore to an **isolated environment** with **external adapters disabled**; verify schema checksums, quote and evidence digests, object restoration, permissions; **replay tombstones**; measure recovery time and data-loss window; record performer and witness (`RestoreDrillSchema`). A passed drill is the evidence for the `backup_restore_exercised` launch gate |
| Restore execution | Two people (`ops.execute_restore`); maintenance mode on; workers stay disconnected from live providers until unknown outcomes are reconciled and a person authorises reconnection |
| RPO and RTO | Recorded by the operator (open decision O13); the console shows measured values from drills next to the targets, never invented guarantees |

## Updates and migrations

The node console shows the running engine version, the latest release, its notes (security fixes first), and **pending migrations** with their kind (expand, migrate, contract). Applying an update: schedule a window, take and verify a backup, run migrations forward only, restart, check readiness. A production migration requested from the console needs a second person (`ops.apply_production_migration`) and is refused without a backup newer than the window start. Contract-phase migrations (removing old columns) are shown separately and never run in the same window as their expand phase. The console never edits an applied migration and has no "run SQL" box.

## Health

Readiness (database, schema version, object store, worker heartbeat), queue depths, outbox oldest age, job lease expirations, dead letters, unknown external outcomes awaiting reconciliation, provider states and error rates, index freshness, certificate expiry, storage use, backup age. All are **counts and ages**, never per-person data. Each tile links to the screen where a person can act.

## Jobs and reconciliation

Jobs by state; dead letters with retry (idempotent jobs only); **unknown outcomes** with the reconciliation flow: query the provider, or a person records the outcome with evidence; `unknown → final` only through a reconciliation record. Retrying blindly is not offered for effects.

## Feature flags

Flags turn experimental UI or behaviour on and off per hub. A flag has an owner, a description, an expiry date and a note on what it changes. **A flag can never widen access**: the flag registry rejects flags that touch authorization, projections, egress or ranking (reviewed in code; the console shows the flag's declared scope).

## Maintenance mode

Read-only mode with a banner in every hub language; sign-in still works; mutations return a clear, localized error; pipelines pause; scheduled publications wait. Used for restores and risky migrations.

## Incidents

Incident records link kill switches, emergency content holds, account freezes, index taints, break-glass sessions and communications; a timeline; a required **post-incident review** for every emergency action, with follow-ups. Breaches link to the privacy breach register and its notification deadlines (US: state breach-notification laws vary by state; recorded per hub with counsel).

## Locale completeness

For each hub language: missing interface strings (from the engine and the brand overlay), templates without that language (activation blocked), legal documents without that language (activation blocked), community rules, plan templates, credential type titles, and the share of machine-assisted translations not yet reviewed. This is the evidence for the `i18n_complete` gate. Spanish for the US demo depends on the proposed `es` engine locale.

## Accessibility

Brand overlay contrast and lettering checked for every hub language (gate `brand_accessibility_checked`); results of automated axe checks from the engine's test suite for the deployed version; a manual checklist (keyboard, screen reader, zoom, reduced motion) with dates and the person who checked. The console itself meets WCAG 2.2 AA.

## Onboarding help

- **Overview "next five things"** while the hub is in draft or preparing.
- **Help** page: guided checklists per role (first week as editor-in-chief, as data steward, as support lead), the handbook chapters, a glossary, and what each status label means.
- **Explain this** links on every complex control (egress matrix, automation levels, case grants) opening a short explanation with the rule it enforces.
- **Empty states that teach**: every empty queue says what fills it and links to the setting that starts it.
- Help sits in the same position on every page (WCAG 2.2 3.2.6 Consistent Help).

## Node console

Hubs on the node (create, close), node staff, node-level provider connections (object storage, e-mail relay, local model servers shared by hubs), updates and migrations, backups and restore, **node identity and keys** (manifest, signing keys, rotation with the previous key signing the new one, two-person `ops.rotate_node_key`; the same keys sign verifiable credentials and federation envelopes), node-wide kill switches, and the read-only restricted-places list from code.

## Acceptance (when implemented)

- No console action succeeds without an elevated session and a reason; every applied A+2 or hub second-person action records the approver and digest.
- A restore cannot reconnect workers to live providers before reconciliation and a person's authorisation.
- A production migration without a fresh backup is refused.
- No feature flag can change authorization, projections, egress or ranking.
- Audit sequence gaps are detected and reported.
