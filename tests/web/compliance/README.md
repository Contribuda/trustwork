# SANC-007 implementation and acceptance report

Agent: Codex CLI (OpenAI) for Parshkov

Owner: Dmitry Parshkov. Conductor: Codex. Work package: SANC-007, [issue 327](https://github.com/Contribuda/trustwork/issues/327). Branch: `work/SANC-007/codex`. Worker completion is not maintainer acceptance.

## Scope and authority

The registry dependencies checked at implementation start were SANC-003, LANG-ES and MAIL-001, all done; SANC-006 is not a dependency. The owner's maintainer allocation permits ten active claims. Seven owner claims were active before this claim, and the bot accepted SANC-007 as the eighth: [claim](https://github.com/Contribuda/trustwork/issues/327#issuecomment-6553264909), [acceptance](https://github.com/Contribuda/trustwork/issues/327#issuecomment-6553280185). The accepted scope has no overlapping active claim.

The conductor explicitly authorized minimal distinct template, route and locale registration and an isolated additive migration only for a demonstrated missing notice/appeal seam. SANC-003 stores appeal decisions and forbids the original decider but had no recorded reviewer assignment; its screening and jurisdiction transitions had no personal mail intent. `20261110100000_screening_notices.sql` supplies those seams within the authorized range. It does not edit applied migrations, approved lists, permissions or the existing participant command. Shared deltas are registration, the settings link, a staff-only assignment read and schema/access inventories. No consultation delivery, reminder migration, `thread.message`, consultation source or SANC-006-owned screening dictionary is changed.

## Implemented behavior

- Account Compliance reads only the authenticated participant's existing SANC-003 projection, ignores subject ids in the page URL, and submits only their own appeal. It never calls the staff namespace. Suspended-account self service uses the existing narrow API allowance; restricted places remain denied.
- Missing legal disclosure configuration renders only generic contact text. No inferred clearance, suspension reason, payment state, review deadline or reviewer assignment is displayed. All new strings exist in en, es, ru, uz-Latn, ka, hy and az-Latn. Existing jurisdiction/screening keys are checked for parity without touching another worker's translations. There are no new dates/numbers to format or hard-coded brand strings.
- The appeal uses the real password step-up and idempotent SANC-003 command. Existing immutable decision history stores the explanation/evidence. The new append-only routing record references the original decision and excludes its decider, the subject, active company members, declared conflicts, held/suspended reviewers and break-glass assignments. No eligible reviewer produces null, never a fabricated assignment. Elevated staff can read the routing record through a distinct route; existing decision and second-person authority still governs action.
- Personal hold, cleared-hold, review, decision, appeal-received and appeal-outcome transitions atomically create existing mail-delivery/outbox intents. The subject's verified address and stored locale determine delivery. All six kinds deliberately use the same generic notice until authoritative law-dependent disclosure exists. Parameters accept only a known transition kind. No real mail is sent during validation.
- Privacy and terms additions are counsel drafts. They describe location processing, conditional dataset attribution, disclosure/retention decisions to supply and the independent appeal path without invented approval, contact details or service deadlines.

## Acceptance matrix

| Criterion | Implementation and evidence | Limits |
|---|---|---|
| Seven-language jurisdiction/screening coverage | `copy.test.ts` checks exact key parity in all seven locales; separate compliance and mail dictionaries | Native-speaker review is explicitly false, including the English reference; key parity is not linguistic acceptance |
| Truthful own status and refusal | Real own projection; safe generic text and appeal eligibility only; restricted-place API/browser denials | Detailed state wording requires the missing authoritative law-dependent disclosure policy, not a locale or visitor-selected country |
| No list, entry or other-person disclosure | Every mail kind in every locale is scanned; unknown/injected parameters and secrets are rejected; API and browser check subject/staff boundaries | These automated checks do not constitute counsel review |
| Actual transactional notices | Real PostgreSQL transitions, outbox, production worker registry, fake transport, rollback, replay and recipient scrubbing | Personal-account delivery only; no company-recipient policy is invented |
| Fresh step-up and stored appeal | Stale session and wrong password refused; real password step-up, concurrent same-key/replay, stored explanation and decision reference | Browser uses local synthetic identities and local test credentials only |
| Different reviewer and second person | Recorded independent assignment; original-decider action and assignment refusal; held-reviewer exclusion; reversal proposer cannot self-approve; wrong digest refused | No eligible reviewer stays explicitly unassigned; dynamic reassignment/claim workflow is not implemented |
| Non-English UI and accessibility | Russian desktop and 375 px captures, keyboard password submission/focus, axe WCAG A/AA scan | No native-language or manual screen-reader review; axe does not establish either |
| Legal additions | [Privacy draft](../../../docs/legal/templates/privacy-location-and-sanctions.md) and [terms draft](../../../docs/legal/templates/terms-sanctions-and-export-controls.md) | Neither approved nor activated; no jurisdiction-specific legal claim is invented |

## Verification commands and evidence accounting

Run only one real embedded PostgreSQL process at a time. `npm ci` was run once because dependencies were missing, exit 0. Node 24.18.0 and npm 11.16.0 were used. Earlier development runs are historical: the original screening suite had 5 passing tests; the initial copy/mail/locale set had 44 passing tests; the earlier API/access/migration set had 48 passing tests. These are not exact-head acceptance for the final changes.

The pull request records the exact final head, each final command's exit code and test count. Do not infer a final result from this command list:

```sh
TRUSTWORK_TEST_PG_BACKEND=embedded TRUSTWORK_REQUIRE_PG=1 node --import tsx --test --test-concurrency=1 tests/web/compliance/api.test.ts tests/data/access.test.ts tests/data/migrations.test.ts
node --import tsx --test tests/web/compliance/copy.test.ts tests/worker/mail/templates.test.ts tests/web/locales.test.ts tests/web/i18n/client-namespaces.test.ts
npm run typecheck
npm run validate:docs
NEXT_DIST_DIR=.next-sanc007 NEXT_TELEMETRY_DISABLED=1 TRUSTWORK_API_ORIGIN=http://127.0.0.1:3587 npm exec --workspace @trustwork/web -- next build --webpack
TRUSTWORK_TEST_PG_BACKEND=embedded TRUSTWORK_REQUIRE_PG=1 npx playwright test --config tests/web/compliance/playwright.config.ts
```

ESLint runs on the changed TypeScript/TSX files. The full local `npm run check` and full browser suite are intentionally not run, per conductor constraints. The PR full-gate checkbox stays unchecked until passing CI on its exact head. Build output is local and disposable; screenshot evidence is preserved.

Russian evidence, captured using a real local API and PostgreSQL with synthetic test identities, and visually inspected: [desktop](evidence/ru-desktop.png), [375 px form](evidence/ru-375.png), [375 px submission result](evidence/ru-375-submitted.png). No clipped text or horizontal overflow was observed. These are not public synthetic accounts or badges.

## Remaining engineering seams and review limits

SANC-007 remains `in_progress`. The safe generic fallback is implemented and tested; richer status/notice wording still needs an authoritative activated disclosure-policy projection with law-dependent permitted fields. This is a concrete missing engine seam, not an assumed approval or an owner-only blocker. Routing with no eligible reviewer remains unassigned; a future reassignment workflow must recheck current authority/conflicts and preserve its audit history. Company notices require an authoritative recipient policy before delivery can be extended to companies. None of these gaps is filled with guessed law, borrowed staff data or relaxed permissions.

Native-language review, manual screen-reader review, counsel approval and maintainer acceptance remain unverified. No deployment, account/provider setup, spending, external data acquisition, outreach, subagents, extra worktrees, merge or approval was performed.
