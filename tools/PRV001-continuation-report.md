# PRV-001 continuation acceptance report

Agent: Codex CLI (OpenAI) for Parshkov

Status: in_progress. This draft is not acceptance and unlocks no dependent package.
Foundation #471 was observed MERGED at 2026-11-01T05:12:47Z, merge commit `72f7c62c7c80f30b476b2e64a72c36c58bbe8cbb`.
The continuation branch starts at that actual main commit. The original branch and reviewed journal are preserved.
Existing issue #93 claim remains active; continuation heartbeat: https://github.com/Contribuda/trustwork/issues/93#issuecomment-6553808801.

## Acceptance matrix

| Criterion | Current implementation/evidence | Status |
|---|---|---|
| Unregistered unconditional marketing objection | Constant public acknowledgement, minimal MAIL-compatible hashes, no subject read/erasure oracle | Implemented; restricted-PG tests pass |
| Contact dispatch serialization | Worker transaction port; both race orders and rollback/retry; existing MAIL unsubscribe table populated | Real final-dispatch hook remains a coordinated SANC seam |
| Configured fake DROP | Typed fake, bounded intake, pack cadence/deadline, UNKNOWN/unavailable and concurrent polls | Implemented intake; proof still required |
| Full own-data export | Complete 32-module inventory; additional identity/sessions, billing, plans, communications, support, reputation, execution, trust, tasks, consultations, content, company approval routes/supplier base, personal agent reports, connections, legal acceptances, minimal screening status and clean local file bytes | Partial; complete remains false |
| Ended paid plan and authority boundaries | Exact ended paid subscription; counterparty budget/private fields excluded; company membership revoked before delivery | Restricted-PG/API tests pass |
| Nonparticipant source proof | Exact field/action/source digest, opaque capability, current human case grant and recorded internal verification note | Public capability submission implemented; issuer still requires an existing real support case/grant; no generic address erase authority |
| Source refresh | Actual SRC staging, previously staged batch activation and public provenance consult durable do-not-collect | Implemented; both collection orderings covered |
| Sourced correction/deletion | Proof-bound pending requests, source revision invalidation, immutable original provenance | Owning correction/deletion operation still missing |
| Two-person plan | Real ADM proposal/approval, exact inventory/digest, distinct humans, current case grants, authority fingerprint, hold/policy/subject locks | Execution admission implemented; every missing owning operation explicitly refused |
| Agent limitations | Existing service denies delegated principals; no decision/execute capability in Draft type | Operator-agent Draft runtime integration still missing |
| Retained journal | Independent identity/checkpoint preserved; withDecision now spans local DB callback; withRestore spans commit/fence lift; no TTL takeover or bootstrap | Focused cross-process/PG tests pass |
| Restore CLI/physical drill | Local wrapper requires independent provisioned binding; physical/PITR synthetic privacy fixture added to existing drill | Restricted-PG CLI tests pass; physical/PITR CI passed at 63146e0a; final-head rerun pending |
| Retrieval/federation | Typed durable intents in replay transaction; isolated idempotent consumers, unknown-before-effect, process death/reconciliation | Consumer tests pass; owning ID/revision mapping and runtime registration absent; no send success claimed |
| Exact-head full gate | 63146e0a physical/browser/stack passed; full check found three boundary violations, now corrected without weakening tests | Current-head CI pending |

The complete module-by-module inventory is maintained in `docs/data/privacy-operations.md` and enforced against all API module directories. No unavailable module is omitted or reported exported/deleted. No package object/status was marked done; no dependent package was unlocked.

## Commands and evidence

Prior implementation evidence at `63146e0adea973c9994378bf46e2e2bf1f36b36b` (not final-head acceptance):

| Command | Exit | Result |
|---|---:|---|
| `npm ci` | 0 | Node 24.18.0 / npm 11.16.0; lockfile/config unchanged |
| `node --import tsx --test --test-concurrency=1 tests/privacy/*.test.ts tests/data/access.test.ts` | 0 | 89 passed, 0 failed, 0 skipped; PostgreSQL 18.3 restricted API/worker roles |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | Current types |
| `xargs node node_modules/eslint/bin/eslint.js < /tmp/prv001-lint-files.txt` | 0 | Changed/new TypeScript only |
| `npm run validate:docs` | 0 | Links, 356 package objects, requirements/navigation |

The 89 focused tests include real process termination after a propagation effect, crash-before/response-loss idempotency on all nine privacy command routes, current staff/case revocation and hold races, journal corruption/rollback/independent pin checks, freeze races and post-commit/pre-fence-lift death. Synthetic policy is explicitly `ZZ`/`example.invalid`; it proves no real law.

Prior evidence, not promoted to current-head acceptance:

- Foundation `72f7c62c7c80f30b476b2e64a72c36c58bbe8cbb`: `npm test -- tests/privacy`, exit 0, 41 passed, 0 skipped.
- First continuation `ca29447a2b98bf2637a1f3165cd5c2ca6d73d143`: 8 focused tests, types/lint passed; GitHub full check, browser, physical restore, DCO, PR description, accessibility, dependency, stack and secret checks all succeeded. That physical run predates the new privacy fixture.
- Historical implementation/repair reports remain historical. No full local check, browser suite or physical restore was run under the LOAD RULE.

## Concrete engineering seams and owner-only decisions

1. Active SANC: final MAIL dispatch transaction must call the worker contact barrier after the existing mail-row lock, holding it through transport/commit. Existing unknown-outcome reconciliation remains authoritative. Conductor was asked in issue #93; no response observed yet. No concurrent edits to those active files.
2. SRC/SUP: staging, activation and public projection barriers now operate on real paths. Actual append-only correction/deletion resolution remains an owning command gap. The public request needs no session, but the verifying staff issuer uses a real case/grant, and current support case creation requires an existing requester/subject. A fully unregistered case port must avoid creating fake persons.
3. Every owning module: complete export history/enumeration, authorized retention/redaction/pseudonymization operations and version fingerprints are required. Current safe gaps are explicit; no permissive substitute authorizer was created.
4. Retrieval/federation: owning adapter must map a retained instruction to actual canonical object/revision/signature semantics and register its consumer. Unconfigured intents remain pending; unknown results are reconciled, not resent blindly.
5. Operator-agent Draft integration needs the active operator-grant port. No human decision/execute method is exposed through a delegated principal.
6. Real jurisdiction law, retention and registry schedules remain UNKNOWN until an owning configured pack supplies reviewed data. Local engineering does not wait for those facts. Production retained authority/provisioning is outside authorization; no production enablement is claimed.

These are concrete integration gaps and excluded production activities, not invented owner decisions. No unresolved product-policy choice was escalated to Dmitry. No subagents, new worktrees, provider/account calls, spending, deployment, merges or approvals occurred.

## Repository and coordination

Draft continuation: https://github.com/Contribuda/trustwork/pull/502. Existing #93 claim/accepted heartbeat retained. New branch `work/PRV-001/continuation`; #471 is merged and receives no new commits. The original work branch is preserved.

Additive migration timestamps 20261114100000 through 20261114100500 sort after the latest migration on fetched main (20261106100000). No applied migration, root dependency/config/lockfile was changed. Three newer main commits contain documentation/prototype/package work; published continuation history was not rewritten. All upstream package objects are preserved by leaving the package JSON untouched and making a narrow privacy status-row change.

## Later continuation evidence

- Implementation commit `63146e0adea973c9994378bf46e2e2bf1f36b36b`: physical restore/PITR CI [run 41278022926](https://github.com/Contribuda/trustwork/actions/runs/41278022926), exit 0, 1 passed. Actual archive-end and earlier PITR both restored privacy correction redaction, minimal suppression, owning MAIL suppression and a denied worker contact barrier. Measured recovery 4.9 seconds, data-loss window 5.5 seconds. This is privacy-owned redaction, not whole-subject deletion.
- Full check on that commit: 2463 tests, 2456 passed, 3 failed, 4 expected opt-in skips. The failures were architecture boundaries for admin inventory, support composition and direct billing table reads. The follow-up moves inventory to contracts, supplies support through app.module.ts and creates an isolated billing-owned projection. Boundary tests are unchanged and pass (16 tests, exit 0).
- Further focused exporter/source/plan checks before the final architecture adjustment: 50 passed, exit 0; local binary/digest check set: 16 passed, exit 0. Follow-up combined checks on the implementation sources before commit: `node --import tsx --test --test-concurrency=1 tests/privacy/*.test.ts tests/data/access.test.ts tests/admin/boundaries.test.ts tests/billing/policy.test.ts tests/support/boundaries.test.ts`, exit 0, 110 passed, 0 failed/skipped. Root types, changed-file lint, docs and diff checks each exit 0. PostgreSQL backend was Docker 18.3, with one focused PRV runner; no local full gate. An initial run exposed a missing local sequential helper in the new billing projection; it was fixed before these passing checks.

Current export still excludes unavailable module histories and supports local binary payloads only up to 16 MiB per file / 64 MiB total; larger files carry streaming_export_required. No complete:true is emitted. The full CI checkbox remains unchecked until the final full SHA passes.

## Enumeration follow-up

Added current personal/company project participation enumeration and personal supplier invitations through the actual owning readers. Restricted-PG/API tests prove employer-only participation/invitations are excluded from a personal archive, private buyer constraints are absent, and actual grant revocation removes a participating project on the next download. Catalogue, sales and agreement coverage now accurately names version/round/acceptance-event history already supplied by their existing serializers.

`node --import tsx --test --test-concurrency=1 tests/privacy/privacy.test.ts`: exit 0, 18 passed, 0 failed/skipped on the follow-up source tree. This supplements the 110-test combined run at `e0b3ae0827f1680312d00a0aae5d3390aa9eb947`; it does not relabel that earlier run as the new head. Root types, two changed-file ESLint checks, docs and diff checks also exit 0. Full CI remains unchecked for the next SHA. Concrete conductor seams were posted at https://github.com/Contribuda/trustwork/issues/93#issuecomment-6554220484.
