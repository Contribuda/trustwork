# How it works for hub operators

You want to run Trustwork for your country, state or city: as a trade association, a publisher, a chamber of commerce, a university or one determined engineer. This is an overview; the detailed design is the [hub console](../engine/hub-console/README.md).

Status labels are explained in the [guides index](README.md#status-labels). Almost everything on this page is **Proposed**: the console is a design with proposed contracts awaiting review (`packages/contracts/src/hub.ts`, HUBC-000), not working software. Today you can run the demo web app and the identity, company and project API locally ([agent onboarding, install and run](../engine/agent-onboarding.md#3-install-and-run)).

## Step by step

| # | Step | What happens | Status |
|---|---|---|---|
| 1 | **Check that you may** | Hubs cannot serve restricted places (see `NOTICE`), and you are responsible for compliance with the law of your territory. The engine gives you controls, audit and guard rails, not legal advice. | Restricted places are **Live** in code |
| 2 | **Install a node** | One command with Docker Compose starts PostgreSQL, object storage, migrations, the API, the web app and the worker, and prints a one-time setup address. | **Proposed** (INST-001, on OPS-002 images); today only a local database compose file and a web-only container exist |
| 3 | **Run the setup wizard** | Node identity, hub identity (a country is required; pick a country pack or the generic profile), territory, languages, currency and brand, your legal entity, the first administrator with a second factor, storage and data residency, providers (fake until you connect real ones), modes. | **Proposed** (HUB-004, ADM-002, HUBC-007) |
| 4 | **Configure your jurisdiction** | Agent disclosure wording, liability allocation, consent, record-keeping and per-action limits, with sourced defaults from the country pack. Your counsel reviews them. | **Proposed** (HUB-005) |
| 5 | **Connect keys and models** | Your own keys for mail, payments, models (direct providers, or OpenRouter as one option), registers and e-signatures; secrets are write-only; spending caps and kill switches. | **Proposed** (KEYS-001, HUBC-002) |
| 6 | **Fill the hub honestly** | Register news sources with licence flags, let the editorial office draft from them for your review, import licensed registers as "from sources", invite companies to claim their pages. No fake activity, ever. | **Proposed** (SRC-001, EDIT-001, MINE-001) |
| 7 | **Set prices and commissions** | Free minimum participation is guaranteed. Prices, plans and commissions (consultations, tasks, tickets, courses, agent capacity) are versioned settings, activated by a second person, with an effective date and public disclosure. Money never changes ranking, matching, recommendations or reputation, and Trustwork never holds participants' funds: only licensed payment providers do. | **Proposed** (BILL-001, BILL-003, PAY-001) |
| 8 | **Configure the agent product** | Which modules participants' agents may use, limits, metering, and extensions added through the governed extension registry (declared actions, safety tests, a fake adapter, second-person activation). Extensions can add actions but never bypass mandates, budgets, kill switches, privacy rules or restricted places. | **Proposed** (AGT-003, AGT-004, AGT-023, HUBC-005) |
| 9 | **Pass the launch checklist** | Legal texts approved by counsel, staff with separate roles and second factors, sources registered, verification and sanctions screening configured, every template complete in every hub language, a restore drill done. Only then can the hub go public. | **Proposed** (HUB-001, OPS-004) |
| 10 | **Peer with other hubs** | Join the worldwide mesh: find hubs on the world map and in the directory, list your own hub if you wish, request connections, decide per peer what is shared and received, and talk to other operators over a signed channel; public content, directories and events flow between hubs; private data never leaves its home node ([The hub network](../engine/hub-network.md)). | **Proposed** (FED-000 … FED-006, NET-000 … NET-004, HUBC-023) |

## The reference hub

The project's own reference hub is a **United States hub**, hosted on Railway in a US region and operated by Contribuda. It starts **demo-only with synthetic data**; real sign-ups open only after the platform release candidate (QA-002) passes, counsel has reviewed the US privacy and agreement questions, and the owner switches them on ([ADR 012](../adr/012-integrator-decisions-2026-10-31.md) decisions 26 and 28). It does not accept real users today.

## Learn more

[Hubs](../engine/hubs.md) · [Hub administration](../engine/hub-administration.md) · [The hub console](../engine/hub-console/README.md) · [Installation](../engine/hub-console/installation.md) · [Setup wizard](../engine/hub-console/setup-wizard.md) · [Country specifics](../engine/country-specifics.md)
