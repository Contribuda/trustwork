# ADR 018 — The hub operating company: functions, accountable people and hand-over between agents and people

Date: 2026-11-01. Status: **Proposed** (architect: Claude, an AI agent working for the repository owner Dmitry Parshkov, on the owner's request of 2026-11-01). Nothing here changes a rule until the owner and the integrator accept it. Design: [The hub operating company](../engine/hub-operating-company.md). Work: TEAM-001 to TEAM-006, BOOK-001, PEOP-001, QUAL-001, GROW-001, CMTY-001 and amendments to AGT-030, HUBC-021, ADM-004 and others listed in that chapter. Not legal advice.

## Context

The owner (2026-11-01, translated): "The administrator's agents are not only for the editorial office but also for outreach, marketing, project management, commerce, accounting and so on. Think about what else is needed: the whole team needed for this business to work fully, anywhere in the world. A person becomes a hub: launches the whole company, configures everything, adds living people to the team as it grows, and develops the platform, the quality of work, the culture and so on in their region."

[ADR 010](010-gathering-point-hubs-agents-and-mesh.md) decision 26 gives the hub operator an internal team of operator agents with roles, operator grants, autonomy levels, budgets, an evaluation gate, kill switches and an accountable person per role. It does not say how the roles are organised into a business, how a single person starts with a complete team, how people join and take over work, or how responsibility is kept continuous while work moves between agents and people.

## Decision drivers

1. One person can start a complete hub company quickly, anywhere the law allows.
2. A named person is accountable for every part of the business at every moment.
3. Moving work from agents to people (and back) never leaves a gap and never becomes surveillance of the people.
4. Every guard rail of ADR 010 decisions 20 to 26 holds unchanged.
5. Country differences in employment, tax, advertising and franchise law stay configuration and counsel gates.

## Decision (proposed)

1. **Functions organise the team.** The engine ships a catalogue of 23 business functions (leadership, strategy, editorial, marketing and growth, outreach and partnerships, community, sales, support, trust and safety, compliance, finance, legal operations, people operations, quality and standards, culture and ethics, research, events and learning, localisation, data stewardship, IT and operations, procurement for the hub, analytics, federation). Every operator agent role belongs to one function. A hub enables, disables and renames functions; it cannot remove a function's reserved decisions.
2. **Exactly one accountable person per enabled function, always.** The operator is accountable for every function at the start; accountability moves only when a person accepts it; without an accountable person the function's agents suspend; offboarding cannot complete while a person still holds function accountability.
3. **Positions are separate from staff roles.** A position says what a person is responsible for; staff roles (ADM-001) say what they may do. A position grants nothing by itself.
4. **Hand-over has explicit coverage states**: agent-led, shadowing, supervised, human-led and retired, with a previewed diff, the function owner's confirmation, a second person when accountability moves for a sensitive function, an optional shadow period with practice decisions visible only to their author, and a cut-over that moves review items exactly as previewed. Hand-back restarts the agent at Draft after a fresh evaluation.
5. **Presets** (Solo founder, Founding pair, Small team, Association-run, Publisher-run, Regional operator) are versioned engine data applied as configuration drafts; every preset starts every role at Off, Observe or Draft, except the operations monitor's incident paging and the analytics reporter's cohort reports.
6. **One autonomy scale** (Off, Observe, Draft, Act with review, Act within limits) with a separate trigger (on request, scheduled, on event) is shown across the console; the editorial and automation vocabularies map onto it.
7. **Agents are never people for governance**: never function owners, position holders, approvers, reviewers, counted staff for launch gates or separation of duties.
8. **No automated decisions about people who work for the hub** and no per-person measures of staff or members, in every function.

## Consequences

- A single person can run a complete demo hub with a full agent team; a real hub needs at least two people, because real providers and soft launch already require a second person (an owner question asks whether to keep this; the recommendation is yes).
- Four additive staff roles (`finance-officer`, `growth-lead`, `people-officer`, `quality-lead`) and new permission domains are requested from the integrator; until then interim mappings apply.
- The console gains a Team section in the Users group (HC-200 to HC-212) and function dashboards.
- Employment, contractor classification, monitoring notices, hiring tools, franchise, referral, advertising and platform tax reporting become counsel gates recorded per hub.

## Alternatives considered

| Option | Why not |
|---|---|
| A flat roster of agent roles without functions (decision 26 as is) | Works for a few roles; at 60 or more roles nobody can see who is accountable for marketing or finance, and hand-over has nothing to attach to |
| Agents as accountable owners of routine functions | Contradicts decision 26 and the accountability principle; nobody answers for mistakes |
| Automatic transfer of accountability to the hub owner on departure | Silent assignment of responsibility; the owner may not know; rejected in favour of suspension plus an explicit acceptance |
| Measuring new staff against agents during hand-over | Surveillance of employees; rejected |
