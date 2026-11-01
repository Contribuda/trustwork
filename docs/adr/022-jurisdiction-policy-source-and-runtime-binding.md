# ADR 022: Executable jurisdiction policy provenance and runtime binding

Date: 2026-11-01. Status: **Proposed; not accepted**. Requires maintainer and source-module review; authorizes no legal values, activation or deployment.

Agent: Codex CLI (OpenAI) for Parshkov.

## Existing requirement and evidence

R48, ADR010 decision22 and HUB005 require sourced per-jurisdiction settings, a second person, every hub language, no weakening of mandatory rules, and limits that restrict otherwise authorized mandates. [Draft PR #405](https://github.com/Contribuda/trustwork/pull/405) at `89af781fe625719d72159b32dc15f927ff16f8d6` provides strict settings and protective composition, audited draft storage and19 passing focused tests, but no registered activation or dispatch integration.

The conductor inspected packages/contracts/src/jurisdiction.ts and apps/api/src/modules/hubs/jurisdiction/README.md at that pinned commit. The worker's evidence identifies these boundaries:

- AgentLawFactSchema has prose, optional wording, recordYears and actionLimit, but no complete mandatory/advisory, action applicability, liability identity, consent identity or retention-bound semantics. Existing pending-counsel facts cannot become executable law by inference.
- hubs_activate_config already serializes exact-digest two-person activation. Its generic payload check does not enforce the new policy shape, every current hub language or mandatory-source preservation.
- Sensitive active hub configuration is not available to participant runtime. A narrow read-only limits projection is needed; full table access is inappropriate.
- Assistant PolicyRequest has no authoritative two-party jurisdiction binding or material policy-version digest in the effect authority.
- Locale-key presence does not establish an immutable reviewed legal text version.

## Proposed boundary

1. Extend the source contract with explicitly reviewed executable rule records: jurisdiction and ancestors, effective dates, applicable action classes, mandatory/advisory distinction, typed limits/consent/retention/liability identities, exact immutable source references, and counsel verification. Explicit absence of a requirement is a sourced statement. Missing/ambiguous/unreviewed facts remain UNKNOWN and block the affected commitment. No country rule belongs in engine code.
2. Bind text to immutable language-complete legal versions and their counsel evidence. Preserve existing legal document semantics or propose the smallest additive kind; never treat a locale key as legal approval.
3. Enforce activation in the database for every writer, including current-language races and legacy payload removal. Reuse existing approval digest, separation of duties, audit and locks. Additive migrations only.
4. Resolve applicable participant/counterparty/project jurisdictions from authoritative domain records with provenance. Do not use locale, preferred country or a caller-supplied code as law. Unknown applicability denies execution; it does not create a human bypass.
5. Return only effective restrictive limits, version/digest and safe reasons through a narrow audience-checked projection. Bind this to the immutable intent and recheck at effect time in API and worker. A material change invalidates the earlier approval; no expanded mandate authority is inferred.
6. Keep the existing protective composition: same-currency minimum threshold, consent union, compatible retention intersection, and no invented ordering between differing liability/text identities. No implicit FX, consent waiver or relaxed retention.

## Acceptance before package completion

Real database/API tests must prove unauthorized/self activation refusal, changed language/source/approval races, no mandatory weakening through any writer, current effective projection isolation, actual action requiring approval above the limit despite a permissive mandate, cross-party applicability and policy-change refusal before effect, and no country-specific hardcoded legal values. Positive fixtures are explicitly synthetic normalized policies; they do not establish any country's legal readiness.

## Decision requested

Accept or revise this source/binding contract direction and coordinate the country-pack, HUB001, legal-document and AST001 owning paths before implementing the new authority boundary. The conductor can authorize ordinary isolated migrations/registration once that boundary is agreed. This is not a request to waive privacy, mandates or counsel review, and not authorization to launch a real hub.

Alternative: preserve PR405 as an explicitly incomplete draft and keep HUB005/AGT022/HUBC007 dependencies closed. Merging groundwork must not label the package done.

## Current verification limits

This note summarizes a local code/report review; the proposed changes have not been implemented or tested. Full PR405 CI does not prove the missing runtime. No source refresh, external legal research, real provider call, deployment or configuration change occurred.
