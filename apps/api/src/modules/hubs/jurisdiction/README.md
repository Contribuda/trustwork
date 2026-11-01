# Jurisdiction settings groundwork (HUB-005)

Status: **Blocked, partial implementation; not Live.** No controller, participant projection or dispatch hook is registered. No country has an executable mandatory baseline in this implementation. Nothing here asserts counsel approval or enables real commitments.

## Implemented and testable

- Additive `jurisdiction.ts` schemas for per-jurisdiction disclosure locale keys, opaque liability allocation identities, consent requirements, retention intervals, per-action approval thresholds and legal text keys, with pack fact references.
- Deterministic protective composition of an authoritative list of applicable jurisdictions. Country, subdivision and party applicability must be resolved by a trusted domain adapter, never a client string or preference.
- Mandatory-rule comparisons that reject weakening, missing mandatory references, or an incomparable change. Every hub language needs disclosure and legal text keys. Key presence is not proof that translated, counsel-reviewed text exists.
- A repository pack reader that returns source evidence with its recorded verification and counsel status. It reads files only, including region ancestors and declared layers; it never turns prose into executable policy. The current adapter always returns `unknown` because the mandatory baseline is not representable.
- Transaction-scoped draft storage and read-only preflight using existing HUB-001 repositories, permissions, RLS and audit. Preflight always reports the outstanding integration guards and is never an activation authorization.
- A pure restriction composer with the actual `evaluateMandateV2` result. A jurisdiction threshold can turn `allow` into `ask`; unknown applicability turns it into `deny`; nothing changes a mandate denial into permission. This is **not a runtime dispatch integration**.

All successful policy examples in tests are synthetic normalized baselines. They are not released pack facts or legal defaults. The real-PostgreSQL tests establish inherited storage authorization, second-person activation, audit and concurrent single consumption of an approval, and demonstrate that participant access to sensitive configuration is unavailable. They do not establish the missing HUB-005 activation/dispatch enforcement.

## Explicit comparisons

| Requirement | Composition | Refusal |
|---|---|---|
| Approval policy | `pre_authorized < ask_each < human_only` | A mandatory approval requirement cannot be lowered |
| Monetary threshold | Minimum integer minor units within each currency, using `BigInt`; equality remains within the threshold | No amount, negative amount, or a threshold in another currency denies evaluation; no implicit FX or numeric currency ordering |
| Multiple currencies | Retain a minimum for **each** currency | A single-currency action cannot satisfy a cross-currency comparison without a reviewed FX contract; no human approval bypass is inferred |
| Consent | Union of required consent identities | Removing a mandatory consent is refused; this resolver does not record or verify actual consents |
| Retention | Maximum lower bound and minimum upper bound for each record class | Empty intersection blocks. Calendar years are never approximated as days. This does not alter the retention worker |
| Liability | Exact allocation identity only | Different allocation identities block; neither is assumed more protective |
| Disclosure and legal text | Union of keys per locale, preserving both jurisdictions | Missing hub language blocks. Changing a mandatory disclosure identity is incomparable without a new pack decision |

Unknown is a denial, not implicit permission or a request that a human can approve around missing law. A resolved limit is only an additional restriction: mandates, budgets, sanctions, consent, access and digest-bound confirmation still apply.

## Dependencies and proposed decisions for the conductor

1. **Executable country-pack baseline (contract and counsel dependency).** `packages/country-packs/src/facets.ts`, `AgentLawFactSchema`, currently has `topic`, prose `summary`, optional `wording`, `recordYears`, `actionLimit` and `counselReview`. It has no mandatory/advisory distinction, action applicability, typed liability alternatives, consent identities, or minimum-versus-maximum retention meaning. `US-CA/ca-bot-disclosure`, `US/esign-electronic-agents` and `US/esign-record-retention` remain secondary with pending counsel. Proposal: pack maintainers define an explicit reviewed rule schema with these dimensions, provenance, effective scope/dates and explicit absence-of-requirement semantics. Do not interpret missing facts as no requirements. Counsel must supply the values; this PR changes no pack facts or pack schema.
2. **Database activation guard (migration agreement required).** `packages/data/migrations/hubs/20261102140000_hubs_core.sql`, `hubs_check_payload`, checks generic payload safety and add-only restrictions for the jurisdiction domain. It does not check these new settings. `hubs_activate_config` already provides permissions, exact-digest second-person approval, audit and serialization; reuse it, adding a database validation boundary that covers every writer and races with hub language changes. Also prevent removing existing agent settings through a legacy restriction-only payload. A TypeScript preflight alone cannot enforce those invariants, so this PR adds no activation method or API route.
3. **Minimal participant/runtime projection (migration agreement required).** RLS permits `hub_config_version` and `hub_config_current` reads only to staff. `hubs_public_config` refuses every domain except `identity`, `country` and `modes`; the application role cannot execute `hubs_active_payload`. Proposal: a reviewed, narrow read-only projection of active jurisdiction limits and version/digest, with an explicit audience and no access to other configuration domains. Do not grant participants access to whole sensitive configuration tables or use a maintenance connection in dispatch.
4. **Authoritative applicability and effect-time recheck (AST-001/domain contract dependency).** `apps/api/src/modules/assistant/policy.ts`, `PolicyRequest`, has person, action, context, amount and project, but no authoritative participant/counterparty jurisdiction binding. The existing action digest does not bind the jurisdiction configuration version. Proposal: resolve both parties and applicable jurisdiction ancestors from the domain object, retain the resolved policy version/digest with the intent, and recheck before the effect; a changed material policy must invalidate the earlier approval. The worker path must enforce the same check. This belongs in a bounded agreed integration, not a redesign of AGT-003 (#385).
5. **Counsel-reviewed locale text.** Locale keys alone do not prove the content, translations or counsel review. Proposal: agree how agent disclosure keys bind immutable localized legal text versions and their counsel evidence. The existing `legal_document_version` kinds do not include agent disclosure. No UI or fabricated legal copy is added here.

These are proposed decisions, not approved architecture changes. HUB-005 must not become `done` until the activation and dispatch acceptance criteria pass against the actual registered paths and the approved source/binding contracts exist.

## Verification

Run one test process at a time:

```sh
node --import tsx --test --test-concurrency=1 tests/contracts/jurisdiction.test.ts tests/hubs/jurisdiction/policy.test.ts
TRUSTWORK_TEST_PG_BACKEND=embedded TRUSTWORK_REQUIRE_PG=1 node --import tsx --test --test-concurrency=1 tests/hubs/jurisdiction/storage.test.ts
npx tsc --noEmit -p tsconfig.json
npx eslint packages/contracts/src/jurisdiction.ts apps/api/src/modules/hubs/jurisdiction tests/contracts/jurisdiction.test.ts tests/hubs/jurisdiction
npm run validate:docs
node scripts/work-packages.mjs validate
```

No interface changes: seven-locale coverage is exercised as configuration data. Browser builds, screenshots and a live-UI claim are not applicable. Full local `npm run check` is prohibited by the conductor's load rule; CI remains pending until verified on the exact PR head.
