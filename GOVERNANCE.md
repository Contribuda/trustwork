# Governance

## Roles

- **Owner** (Dmitry Parshkov): holds the copyright and the brand, decides the licence (O17), the engine name (O18) and when to publish (O19); final say on product constraints recorded in `docs/product/specification.md` and the ADRs.
- **Maintaining organisation**: Contribuddha ([contribuddha.com](https://contribuddha.com)) creates and maintains the engine and hosts its public repository; the owner's decisions are carried out through it.
- **Integrator**: reviews and merges, keeps decisions, work packages and acceptance evidence coherent.
- **Maintainers**: people with merge rights for a scope (engine, design system, a country pack). Today the owner maintains every scope; maintainers who join are listed here.
- **Country-pack maintainers**: own one pack each; they are the source of truth for that country's facts and translations.
- **Hub operators**: run hubs of the engine for a territory and are responsible for local legal compliance; they decide their hub's configuration, prices and policies within the engine's invariants ([Hubs](docs/engine/hubs.md)).
- **Contributors and their agents**: anyone who submits work. A person who runs an AI coding agent is accountable for its contributions and signs them off ([agent onboarding](docs/engine/agent-onboarding.md)).

## Decisions

- Work is organised as public work packages (`docs/engine/work-packages.json`, `npm run work`) claimed in their GitHub issues; claims, questions and decisions are written in the issue or pull request, never only in private channels.
- Product and architecture decisions are ADRs under `docs/adr/`; proposals stay marked proposed until accepted.
- Changes to work packages, language policy, authority model, quote immutability, public projections, payments or reputation logic need integrator review.
- Disagreements are resolved by the owner after a written summary of both positions in the issue.

## People in restricted places

The owner is subject to United States sanctions and export-control law. The project therefore does not accept contributions from, grant collaborator or maintainer rights to, provide support to, or pay for work by persons located in or acting for the places listed in `NOTICE`, or persons on a United States sanctions list. We cannot reliably detect where people are and do not promise to; we act when we know. This is a rule of the project's own conduct, not a restriction in the licence. Counsel's review of the details is pending; this section will reference the written policy once it exists.

## Releases

The engine has no releases yet. Development happens in the open in this repository (ADR 010 decision 15): every change lands through a pull request with passing checks, `main` is never force-pushed, and releases will be tagged from `main` with release notes.
