# ADR 025 — Product decisions delegated by the owner, 2026-11-01

Date: 2026-11-01. Status: **Accepted**. The repository owner Dmitry Parshkov handed the open product questions to the conductor on 2026-11-01 (translated: "choose the decisions yourself and continue"). Claude, an AI agent acting as the Trustwork conductor for the owner, decided them as recorded here. The owner may override any line through a later ADR. Not legal advice.

## Scope and limits

- **Decided here:** product and policy defaults that the designs left to the owner (ADR 016, ADR 017, ADR 018, the console design, market research, launch countries, the bid desk, the agent-job interview programme).
- **Not decided here:**
  - questions for counsel, which stay open and keep blocking whatever depends on them;
  - real spending, provider accounts, deployment, launch switches and contact with people outside the project (operators, interviewees, companies), which still need a person to act;
  - any rule in AGENTS.md or the product specification, none of which changes.
- **Leaning:** where a question allowed a stricter or a looser answer, the stricter one was chosen when the design recommended it or when the looser one would need counsel first.

## Decisions

### Hub exchange (ADR 016, [design questions](../engine/hub-exchange-architecture.md))

1. ADR 016 is **accepted**: `trustwork-mesh/2` as a strict superset of version 1, with the schema registry, signed capability statements and usage policies. XCH-002 is unblocked.
2. Revenue sharing between hubs is allowed only by the operators' written agreement. It is disclosed on both hubs' price pages and never affects ranking, matching or delivery.
3. Cross-border consumer deals are off by default. They turn on only when both hubs enable them after counsel review.
4. Federated public search is opt-in per hub and off by default.
5. The compatibility period for a new protocol or schema major version is at least 12 months and two engine minor releases.
6. The US reference hub does not route deals with other hubs while it is demo-only. Demo peering uses a synthetic second node.
7. There is no shared mesh translation service: each hub uses its own providers.
8. Reading translations of deal messages is on by default where the hub has an approved provider and egress rule. Translations are labelled as machine translation, the original stays the authority, and each person has a switch.

### Outreach (ADR 017)

9. ADR 017 is **accepted** as the policy design: option A (strict) is the default in every hub, and option B (a single page notice) is the recommended first step. Each hub's move to B or C still needs a counsel approval record and a second person, as the ADR says.
10. The reference hub stays in **A** until counsel answers the US questions in the design (commercial message, data-broker status, article 14). This ADR does not move it.
11. Outreach goes to organisation and role addresses only. Named business contacts are not allowed in option C in the first release.
12. Sourced pages for sole proprietors are off by default. A notice about a quote invitation sent to a listed supplier is off by default.
13. Hand-over follows the design split: limited control at `claimed`, full control at `verified`.
14. An outreach coordinator staff role is added. It is narrow and holds no privacy-officer reads. OUTR-002 proposes its permissions together with `PROPOSED_OUTREACH_HUMAN_GATES`.

### The hub operating company (ADR 018, [design questions](../engine/hub-operating-company.md#12-questions-for-the-owner))

15. ADR 018 is **accepted**. A second person must still enable any real provider, so one person alone runs only a demo hub. There is no solo mode.
16. The preset monthly team caps (USD 0, 300, 800, 400, 1,200, 600 per city) are accepted as starting defaults. They are hub settings, not spending, and nothing is charged by this decision.
17. In the first release, no function role acts within limits beyond the analytics reporter's cohort reports and the operations monitor's incident paging.
18. A shadowing person may see how their practice decisions compare with the real ones. Only that person sees it; it is never shown to anyone else and never stored as an evaluation of the person.
19. Sales and editorial roles conflict in every hub that sells any paid placement or sponsorship, whatever the preset.
20. There are no award or recognition programmes in the first release (too close to a badge).
21. Referral programmes may give platform credits only, never cash, and need counsel review of the terms before a hub enables them.
22. A hub may advertise itself off the platform as operator marketing. On the platform there are no tracking pixels, and nothing the operator buys changes ranking.
23. In the first release, operators run their own hubs: the documentation does not support a master operator licensing city hubs (franchise law, counsel C5).

### Console design ([#372](https://github.com/Contribuda/trustwork/pull/372))

24. Operator agents never publish without a person's decision in the first release. Publication stays human, as the frozen contract says, and the editorial standing policies E2 to E7 stay off by default.
25. Translator and legal reviewer are labels on existing roles, not new roles. Custom roles only narrow engine roles.
26. Access review shows how often each permission was used per role, as counts. There is no per-person activity timeline (no employee monitoring). The review runs every 90 days for sensitive roles and every 180 days for the others.
27. There is no platform overview across nodes until federation is live.
28. Support may tell a person that their account is restricted and how to appeal. Support never shares a list, a match or a source.
29. Statistics retention: raw events 30 days, aggregates 24 months, exports 7 days. Aggregate readership is published only with cohorts of at least ten, and is off by default.

### Markets and launch countries ([#370](https://github.com/Contribuda/trustwork/pull/370), [#401](https://github.com/Contribuda/trustwork/pull/401), [#403](https://github.com/Contribuda/trustwork/pull/403))

30. The US reference hub comes first. No second reference hub is chosen before it reaches soft launch. South Africa is the 11th country (CTRY-ZA and the others stay priority 4), not a second reference hub.
31. Demo content leads with registered contractors and companies (business to business). Informal self-builders are not the lead audience.
32. For a future Cape Town hub, the language order is English, Afrikaans, isiXhosa, then isiZulu.
33. Planning order after the US: Peru, Philippines and Kenya, with Uzbekistan as a technical pilot in demo mode. This is a planning order, not a launch: every launch still follows ADR 012 decision 29 (QA-002, counsel, the owner's switch).
34. The country weighting stays as it is. Deep scans of Peru, the Philippines and Colombia are research packages without outreach.
35. Operators come through self-service playbooks only. Nobody in the project contacts potential operators on the project's behalf for now.
36. In hubs flagged as high fraud risk (Nigeria in the first wave), a company claim needs two reviewers from soft launch.
37. Messenger (Philippines) and Telegram (Uzbekistan) are separate channel packages under CHAN-001. They are off by default and the engine floor applies to them.

### Supplier bid desk ([#380](https://github.com/Contribuda/trustwork/pull/380))

38. The bid desk is its own module, shown as a "Tenders" tab under Sales.
39. The engine-default free tier is 3 active pursuits. This is a hub price setting.
40. A platform RFQ is marked as a formal tender only when the buyer declares a formal procedure.
41. A company may keep private notes on competitors' public awards. They are visible to that company only.
42. Joint ventures come later, after counsel. At launch the only public source is SAM.gov (US). Bid experts never charge success fees through the platform.

### Agent-job interviews (AGT-020)

43. The interview programme is **approved** on these terms, and AGT-020 is unblocked:
    - written, revocable consent; adults only;
    - at least two practitioners per participant type in the reference hub;
    - no incentive that depends on an answer: an optional token of thanks is the same for everyone;
    - recordings only with consent, deleted after a pseudonymised transcript is made, and transcripts kept for at most 12 months;
    - a person recruits and interviews; agents only prepare guides and analyse consented transcripts;
    - findings cite consented interviews only and invent no frequencies.

## Consequences

- ADR 016, 017 and 018 move from Proposed to Accepted, with the answers above.
- XCH-002 and AGT-020 move from `blocked` to `open`.
- Every counsel question in those ADRs and designs stays open, and whatever depends on them stays blocked.
- No hub's mode, provider, price or launch state changes. The strict outreach rule, human publication, the off-by-default reputation score and the real-provider and launch switches stay as they are.
