# How it works for you

Short, friendly guides for the people a Trustwork hub serves. Each guide walks through a journey step by step and says honestly, for every step, whether you can try it today or whether it is still a design.

## Status labels

| Label | What it means for you |
|---|---|
| **Live** | Implemented in the engine's API with automated tests. The web app does not call the API yet (work packages WEB-006 and WEB-004), so in the browser you still see the demo. |
| **Demo** | You can click through it in the web app on synthetic data. Nothing is stored and nothing leaves your computer; buttons that would act for real say so. |
| **Contract** | The rules and data shapes are fixed in code (`packages/contracts`) and tested; there is no screen or storage yet. |
| **Designed** | An accepted design describes it; no code yet. |
| **Proposed** | A new design from the owner's decisions of 2026-10-30 and 2026-10-31, open for review; no code yet. |

Package IDs such as PLAN-001 point to the [work packages](../engine/roadmap.md) that will build a step. The overall picture is in [What works today](../engine/status.md).

## Try the demo

Nothing is deployed for real users yet, and no hosted hub accepts sign-ups. To see the demo on your own computer (Node 24.18.0 and npm 11.16.0):

```sh
npm ci
npm run dev:web    # http://localhost:3000, synthetic demo data
```

Add `?persona=reader`, `?persona=mixed` or `?persona=owner` to an address to see the site as a reader, as someone who buys and sells, or as a company owner. The demo data is synthetic and labelled; today it is set in Uzbekistan, and a United States demo hub is planned (DEMO-US). The examples in these guides use the United States reference hub that the project's owner decided on ([ADR 010](../adr/010-gathering-point-hubs-agents-and-mesh.md) decision 16); a hub in Toronto, Lyon, Nairobi or Pune works the same way, because everything country-specific is configuration ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decision 30).

## Guides

| Guide | For |
|---|---|
| [Homeowners and clients](homeowner.md) | Start a project, get a plan, book a consultation, hire for tasks, confirm the work |
| [Professionals and contractors](professional.md) | Profile, credentials, portfolio, answering requests, building your reputation |
| [Experts and mentors](expert.md) | Consultations, expert answers, mentoring and courses |
| [Companies](company.md) | Claim and verify your company, your team, the standing representative |
| [Suppliers and manufacturers](supplier-manufacturer.md) | Claim a sourced page, keep your catalogue, share training and guides |
| [Event organizers](event-organizer.md) | Host events, registration, tickets, check-in and partner meetings |
| [Authors and editors](author-editor.md) | Write, publish, correct, and run an editorial desk |
| [Hub operators](hub-operator.md) | Run Trustwork for your country or city |

## Promises that hold in every guide

- One person, one lifelong identity: your profile, publications and reputation stay yours when you change employer.
- Your agent acts only under mandates you can read, change and revoke; what you type in a chat never authorizes anything by itself.
- Private stays private: budgets, floors, negotiations and private projects are never shown to other parties, staff without a case grant, search, other hubs or agents.
- Nobody can buy a ranking, a recommendation, a badge or a reputation.
- Sourced, claimed and verified always look different; unknown is shown as unknown.
