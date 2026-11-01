# ADR 017 — Outreach to people and companies who are not participants

Date: 2026-11-01. Status: **Proposed** (architect: Claude, an AI agent working for the repository owner Dmitry Parshkov, on the owner's request of 2026-11-01). Nothing here changes a rule until the owner accepts this ADR **and** counsel approves a hub's policy; until then the existing strict rule stays the default in every hub. Design: [Discovery, sourced pages, claims and outreach](../engine/discovery-and-outreach.md). Work: OUTR-001, OUTR-002, OUTR-003, ENT-001, OUTR-004 and amendments listed in that chapter. Not legal advice.

## Context

The owner (2026-11-01, translated): the system must fill the platform with local data, search for news, articles, events, companies and people, and after collecting it reach out to those companies and people; for example it creates a company page from public data and the hub's own databases and, when the page is ready, contacts the company's representatives and hands over management access. The same day the owner confirmed: "Yes, there must be a flexible system suitable for all countries."

The product today forbids exactly that contact:

- the interface says "Contact obtained from a public source; outreach without consent is not permitted" (`commerce.supplier.outreachNote`, from the COM-002 invitations work; procurement screen contract `supplier.outreachNotPermitted`);
- the handbook says sourced companies never receive bulk outreach ([partners and matching](../engine/partners-and-matching.md#external-candidates), [suppliers and manufacturers](../engine/participants/suppliers-and-manufacturers.md#what-can-never-happen), [agent catalogue](../engine/agent-catalog.md), CAT-F06, AGT-007 acceptance);
- people datasets never create public profiles (`DatasetSchema`).

Direct-marketing law differs sharply between countries. Some regimes allow business e-mail until the recipient objects (the US CAN-SPAM Act; the UK for corporate subscribers); others require prior consent even between businesses (Germany's UWG section 7, Canada's CASL unless implied consent applies, South Africa's POPIA section 69 for non-customers, Georgia, Kenya). Automated calls and texts need prior consent almost everywhere (in the US the TCPA, with AI-generated voices treated as artificial voices since FCC 24-17). Compiling business contacts about people may trigger notice duties (GDPR article 14) and, in some US states, data-broker registration. A single engine rule cannot be right for every hub.

## Decision drivers

1. Lawfulness in every country, decided by counsel per hub, expressed as data (ADR 010 decisions 6, 16 and 22; owner confirmation of 2026-11-01).
2. Honesty: sourced pages never look verified or endorsed; agents never pose as humans; no fake activity.
3. Respect for recipients: identification, the source of the data, an easy and immediate way to stop, and suppression across the whole platform.
4. Security of hand-over: management access only through verified claims, never because someone answered an e-mail.
5. The owner's goal: a hub that fills itself and invites the companies it describes.

## Options

| Option | What the hub may do | Pros | Cons |
|---|---|---|---|
| **A. Strict (status quo)** | No system-initiated contact with non-participants. Sourced pages exist, are labelled and can be claimed when the company finds them; participants contact sourced companies only through lawful channels they choose themselves | Lawful almost everywhere; no notice or broker questions triggered by outreach | Slow growth; companies may never learn their page exists; the owner's request is not met |
| **B. Notice only** | One informational page notice (what the page shows, where the data came from, how to correct, claim or remove it), optionally one reminder, by e-mail to organisation and role addresses the entity published, where the country-pack facts and counsel allow; carries the article 14-style notice where one is due; no promotional content beyond the invitation to claim | Meets most of the request; minimal intrusion; easy to explain; fits POPIA's single consent request and opt-out regimes | Still a commercial electronic message in some regimes (counsel); not lawful by e-mail in strict regimes such as Germany |
| **C. Governed outreach** | Per-country policies (option B plus claim invitations, RFQ invitation notices, event listing notices and partner invitations) with sequences of at most three touches, recipient classes including named business contacts where a legitimate-interest assessment or consent is recorded, run by the operator's agent team at the autonomy level the administrator sets | Full request; flexible per country | Highest legal and reputational risk; needs assessments, data-broker answers and deliverability discipline |
| **D. Growth automation** (rejected) | Contact enrichment from third-party databases, guessed addresses, multichannel automated cadences (calls, SMS, social messages), engagement scoring | Fastest growth | Unlawful in many places, violates platform terms, contradicts R14, R15 and the no-surveillance rule |

## Decision (proposed)

1. **Default: option A in every hub**, the reference hub included. The existing interface text and handbook rules stay as they are while a hub is in `strict` mode.
2. **A hub may move to option B or C** only through an `outreach` hub configuration version that (a) relies on `outreachLaw` country-pack facts for each jurisdiction it targets, (b) carries a counsel approval record naming the jurisdictions, recipient classes, channels and purposes, (c) is activated by the compliance officer and a second person (proposed human gate `outreach_policy_activation`), and (d) on the Contribuda-operated reference hub, carries the owner's approval. Each campaign version is a separate gate (`outreach_campaign_activation`).
3. **Recommended path**: B before C. C for named business contacts only after the data-broker and article 14 questions are answered for the target jurisdictions.
4. **Engine floor** (no pack, hub, grant or extension can lower it): no consumer outreach; no automated or prerecorded calls, AI-generated voice, SMS or messenger outreach without that person's recorded prior consent; no guessed or probe-verified addresses and no lists without per-record provenance; mandatory identification of the operator and its postal address, of the source of the data and of automated preparation; one-click unsubscribe and "stop" replies honoured immediately; the platform-wide suppression list checked at dispatch; no contact with restricted places or open screening matches; at most three touches per recipient per purpose; no open tracking or engagement scoring; first versions approved by a person.
5. **Hand-over is never a side effect of outreach.** A reply never claims or verifies anything; an invitation link proves mailbox access only and counts for the claimed level only when the address is on the company's own recorded domain; management access follows the hub's verification recipe with sanctions screening, dispute and takeover protection and an audit trail.
6. **Agents disclose themselves.** Every outreach message says it was prepared by the hub's automated assistant on behalf of the named operator, in the HUB-005 wording for the jurisdiction.

## How the old rule changes

Only as far as an approved hub policy allows. Where a hub's policy enables option B or C for a recipient class and channel, the interface replaces `commerce.supplier.outreachNote` for that page with a proposed key `commerce.supplier.outreachPolicyNote` ("Contact obtained from a public source; the hub may contact this company once under its published outreach policy"), and the handbook rules "sourced companies never receive bulk outreach" read "sourced companies receive only the contact the hub's approved outreach policy allows, never bulk outreach". Until then nothing changes. Participants' own outreach to sourced companies (a buyer, an agent under a mandate) stays under the strict rule; the only new path is the hub's own `rfq_invitation_notice`, off by default.

## Consequences

- New pack facet `outreachLaw` and hub configuration domain `outreach` (OUTR-001); new modules `sourced-pages` (ENT-001), `outreach` (OUTR-002), `lifecycle` (OUTR-003); console screens HC-55, HC-56 and HC-170 to HC-177 (HUBC-003, OUTR-004).
- Two proposed human gates (`outreach_policy_activation`, `outreach_campaign_activation`) are an additive change to the frozen console contract and need the integrator's agreement.
- `suppression_entry` (COMMS-001) gains scopes and reasons; a new context kind `outreach_contact` joins the communications contexts; both are additive and need the communications owner's agreement.
- If accepted, a requirement for governed outreach is added to the specification with its traceability, and the handbook pages quoted above gain a reference to this ADR.

## Questions for the owner

1. Accept option A as the default and B as the recommended first step?
2. Which mode for the reference hub at launch (this ADR recommends A until counsel answers the US questions)?
3. Restrict outreach to organisation and role addresses (recommended) or also allow named business contacts in option C?

## Questions for counsel

Listed per jurisdiction in [the design](../engine/discovery-and-outreach.md#owner-and-counsel-questions), starting with: whether a page notice is a commercial electronic message (CAN-SPAM, CASL, POPIA, PECR, UWG); whether the hub is a data broker in California, Vermont, Texas or Oregon; whether the privacy notice plus the sourced page satisfies article 14 where no outreach happens; and whether suppression may be shared with peer hubs.
