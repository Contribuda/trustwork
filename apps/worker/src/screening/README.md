# Screening in the worker (SANC-003)

The worker side of the screening engine ([ADR 014](../../../../docs/adr/014-sanctions-compliance-engine.md) decisions 11 to 13; handbook [Sanctions compliance](../../../../docs/engine/modules/sanctions-compliance.md)). Status: **Live** for persons and companies at registration, sign-in, creation and rename; the delta re-screen on every new list version, the weekly full run and resumable runs are SANC-005 ([`../rescreen`](../rescreen/README.md)).

## What runs

| Name | Kind | What it does |
|---|---|---|
| `screening.on_identity_person_registered` | outbox handler | Screens a newly registered person |
| `screening.on_identity_session_started` | outbox handler | Screens at sign-in only when newer list versions are active or the names changed since the last screening |
| `screening.on_identity_name_changed` | outbox handler | Screens a renamed person (the database appends the event whenever a display name changes) |
| `screening.on_company_created`, `screening.on_company_renamed` | outbox handlers | Screens a new or renamed company |
| `screening.on_company_ownership_declaration_changed` | outbox handler | Screens a company whose ownership declaration changed (emitted once the declaration is persisted) |
| `screening.screen_subject` | transactional job | One screening, recorded in the job's transaction (`screen.ts`) |
| `screening.names_sweep` | daily task | The safety net: subjects never screened, renamed since, or whose last screening could not run |

A handler never enqueues a second job for a subject while one waits. A job that fails rolls back and retries; nothing is ever recorded as `clear` because something failed. With no usable baseline (missing or stale) the result is `not_screened` and money stays held.

## How a subject is screened

1. The subject's names are read from the database (`screening_subject_names`), never from the event payload.
2. Candidate entries of the active list versions are loaded: entries of the subject's types (persons: individuals; companies: entities, plus vessels and aircraft when enabled) that share a name-key token with the subject. Every engine-rule match shares one, so the prefilter never loses a match. With the fuzzy layer on, entries sharing a token initial are added.
3. The matcher (`packages/compliance/src/matching`) applies the engine rule and, when configured, the fuzzy layer, which only adds matches. A one-token name gives `insufficient_name`.
4. `screening_record_result` rechecks every match against the entry it names, keeps a decided entry from being flagged again unless its normalized names changed, refuses a `clear` that is not against the active baseline versions, and updates the state, the review queue (a notification that names nobody) and the subject's standing in the same transaction.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `SCREENING_FUZZY_THRESHOLD` | off | Jaro-Winkler threshold 0.85 to 0.99; only adds possible matches; off until the owner chooses (ADR 014 open question 3) |
| `SCREENING_VESSELS_AND_AIRCRAFT` | `0` | `1` also compares companies with vessel and aircraft entries |
| `SCREENING_SWEEP_BATCH` | 500 | Subjects enqueued per sweep run |

## Privacy

Log lines and metrics carry identifiers, triggers and outcomes only: never a name, a matched key or an entry. Outbox payloads of this module carry identifiers only.
