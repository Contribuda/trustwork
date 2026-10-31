# How it works for companies

You run a general contractor, a subcontractor, a design office or a developer. Trustwork gives your company one honest page with its people, projects, catalogue and evidence-backed reputation, lets you buy and sell at the same time, and lets you keep one standing representative that answers when people are away, always with a named accountable person.

Status labels are explained in the [guides index](README.md#status-labels).

## Step by step

| # | Step | What happens | Status |
|---|---|---|---|
| 1 | **Find or create your company page** | Your company may already have a page built from public sources, labelled "from sources". Otherwise you create one. | Company pages with sourced / claimed / verified labels are **Demo**; company creation through the API is **Proposed** (BE-003) |
| 2 | **Claim it** | You assert that you act for the company. The page then says "claimed, awaiting verification". | **Proposed** (CLM-001) |
| 3 | **Verify it** | The hub runs its verification recipe: for a US hub, for example, a check of your state business registration, EIN evidence, state contractor licence where one exists, insurance, sanctions screening. The page shows which checks passed, when and by which hub. | **Proposed** (HUB-003, CLM-001); sanctions screening has a **Contract** adapter |
| 4 | **Bring your team** | Invite colleagues; each person has one active employer at a time; company administrators change roles and end memberships. When someone leaves, company-derived access ends at once and their own profile stays theirs. | Memberships are **Live** in the API; the company workspace is **Demo** |
| 5 | **Present your work** | Catalogue offerings (versioned; a sent quote never changes when the catalogue does), projects with the owner's consent, and a company wall of publications. | Company page tabs are **Demo**; the catalogue is **Designed** (COM-001) |
| 6 | **Buy and sell** | Turn a need into an RFQ, collect quotes that are frozen once sent, compare them honestly, negotiate and agree on terms both sides can prove are identical. | Lists and decisions are **Demo**; RFQ and quote versions and acceptance are **Contract**; the flows are **Designed** (COM-001, COM-002, WEB-002) |
| 7 | **Delegate to your people's agents** | Someone with company authority grants a company mandate to a colleague's agent (for example "answer RFQ invitations in category Framing with draft quotes"). It stops when that person's authority ends. | Mandates are **Contract**; company mandates are **Proposed** (AGT-001) |
| 8 | **Enable one standing representative** | One per company, with a named accountable person among your current members. It acts only under company mandates, labels every message, reserves only from company budgets, and suspends when no accountable person or confirmed mandate remains. Any company administrator can stop it instantly. | **Proposed** (AGT-001, ADR 010 decision 9) |
| 9 | **Build the company's reputation** | Confirmed deliveries, on-time completion against agreed plans, payment discipline towards subcontractors, licences and insurance kept current. | **Proposed** (REP-001); reputation snapshots **Designed** (EXE-001) |

## What the company can never do

- See or report on employees' activity: there is no surveillance dashboard.
- Keep using a former employee's personal profile or publications.
- Buy a better ranking, a badge or more visibility in matching or recommendations.
- Enable more than one representative or manage a "swarm" of agents.

## Learn more

[People and companies](../engine/people-and-companies.md) · [Company representation](../engine/agents.md#company-representation) · [Buying and selling](../engine/commerce.md) · [Hub administration: verification](../engine/hub-administration.md#counterparty-verification)
