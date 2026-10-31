# How it works for homeowners and clients

You want something built or renovated: a new house on your lot near Austin, a new roof before storm season, a kitchen. You do not need a company account or any procurement experience. Your agent turns the idea into a clear plan, finds the right people for advice and for the work, and keeps the paperwork, while you make the decisions.

Status labels are explained in the [guides index](README.md#status-labels).

## Step by step

| # | Step | What happens | Status |
|---|---|---|---|
| 1 | **Create your account** | Sign up with e-mail and password (or Google or Apple), verify your e-mail, choose your language. One account for life. | Sign-up, verification, sign-in and recovery are **Live** in the API (verification e-mails go to a fake mailbox until MAIL-001); the screens are **Demo** |
| 2 | **Start a project** | "Build a 2,000 sq ft house on my lot." The project is private and owned by you personally; nobody else sees it. | **Live** in the API (create, owner, leader, participants); the workspace project pages are **Demo** |
| 3 | **Get a plan** | Your agent drafts phases, tasks, trades and expertise needed, materials, permits and inspections, budget ranges, a timeline, risks and the decisions you will face, in plain language. You review it and approve a version; an approved version is never edited, only superseded by the next one. | The plan tab with a baseline and changes is **Demo**; plans with versions (`draft`, `proposed`, `approved`, `superseded`) and the planner agent are **Proposed** (PLAN-000, PLAN-001, AGT-010) |
| 4 | **See what helps each step** | For each step you see explained suggestions: materials and products, guides, courses, events, consultants and contacts, and why each fits. Nothing in these suggestions is paid for. | **Proposed** (MAT-001, REC-001, AGT-021) |
| 5 | **Book a consultation** | For a step where advice helps (a drawing review by a structural engineer, a second opinion on quotes, a site visit), you request a consultation. The expert's agent proposes slots and the offer; you accept; the expert delivers a written note or marked-up drawings; you accept the deliverable. | **Proposed** (CONS-001; paid bookings CONS-002) |
| 6 | **Hire for tasks** | A plan item becomes a scoped task ("install a 200 A electrical service"). You choose who sees it and which fields (scope, drawings, schedule; your budget range only if you want). Contractors send offers that are frozen once sent; your agent compares them in plain language, including exclusions and taxes. You accept; your agent never commits for you. | **Proposed** (TASK-001, WEB-007); immutable quote versions and acceptance by digest are **Contract** |
| 7 | **Share only what you choose** | Your address and phone are revealed only after you accept an introduction or a booking. Other contractors never see each other's offers. | Projections are **Contract**; plan sharing (`plan_share`) is **Proposed** (PLAN-001) |
| 8 | **Follow progress and confirm the work** | Contractors record milestones with photos and documents. You confirm what was delivered, partially or fully, or dispute it with evidence. Your confirmation is a separate record from the contractor's claim. | Delivery claims and acceptance records are **Contract**; execution and disputes are **Designed** (EXE-001); confirmation requests are **Proposed** (REP-001) |
| 9 | **Pay** | Payments go through a licensed payment provider the hub configured, or outside the platform as you agreed. Trustwork never holds your money. | **Proposed** (PAY-001, PAY-002); the only payment screen in the demo (event tickets) is an imitation that charges nothing |
| 10 | **Review and give back** | You can review the people you worked with, tied to the real job. With your consent, field by field, your project can become a diary, lessons learned or a checklist for the next homeowner. The address never. | Reviews are **Designed** (EXE-001); shared knowledge is **Proposed** (KNOW-001) |

## What your agent will and will not do

- It drafts, compares, schedules and reminds under the mandates you set ([Your agent](../engine/agents.md)).
- As a private person you are protected by **consumer mode**: you always sign and pay yourself, a seller's agent must show the total with taxes, and nobody may pressure you with false urgency ([agent catalogue](../engine/agent-catalog.md#10-private-homeowner)).
- The plan is advice, not engineering or legal advice. Where your jurisdiction requires a licensed professional, the plan creates a consultation or a task for one.

## Learn more

[Projects](../engine/projects.md) · [From plan to people](../engine/agent-catalog.md#flagship-journey-from-plan-to-people) · [Execution and reputation](../engine/execution-and-reputation.md) · [Billing and payments](../engine/billing.md)
