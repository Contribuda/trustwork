# Public prices, fees and commissions

Route: `/pricing`, with the engine's existing public language routing. Owner: BIZ-001 design; BILL-003 delivery, with BILL-001, PAY-001, BILL-002, BILL-004, AGT-004 and MODEL-001 owning their respective data and effects.

## Status and authority

**Designed** under [ADR 010](../../../adr/010-gathering-point-hubs-agents-and-mesh.md) decisions 20, 21 and 25 and [ADR 012](../../../adr/012-integrator-decisions-2026-10-31.md) decisions 23 and 33. The [business-model playbook](../../../engine/billing.md#hub-business-model-playbook) supplies the permissible revenue boundaries. This screen contract defines expected presentation and read completeness; it does not add a frozen API schema, select rates, enable providers or declare BILL-003 complete. Any required schema change follows the repository's contract/ADR process.

## Audience and access

Anonymous and authenticated visitors receive the same public catalogue for the resolved serving hub. A person's plan, account or company does not change prices or catalogue visibility. The public shell retains its existing sign-in/avatar behaviour; administration remains in the console.

The hub comes from the existing serving configuration, never browser language, IP-derived residence or a caller-supplied company. Keep restricted-place access gates. A language switch changes presentation, not selling hub, currency, scope or legal applicability. Offer all seven engine languages and use locale dictionaries and `Intl` for labels, dates, quantities and money.

## Public projection

Only the owning service's public projection may supply rows. Never serialize raw billing tables, staff records, acceptance records, mandates, payer usage, budgets, credits held by a person or provider secrets. Internal provider cost and margin are not participant sale prices.

| Information | Required meaning |
|---|---|
| Catalogue context | Serving hub identity, projection time and coverage of each expected section; no claim of a complete catalogue when a reader is absent |
| Offer and scope | Human-readable offer/capability/model/category name from its owning registry; exact scope identifier retained as inspectable detail. An unknown category is unavailable, not a guessed mapping. |
| Charge | Fixed amount or existing percentage representation, currency, unit/meter and whose applicable fee it is. Preserve integer minor units and existing rounding rules; do not calculate money with binary floats or convert currencies. |
| Included capacity | Plan period, included quantities and explicit limits/overage terms where the owning version supplies them; no invented unlimited allowance |
| Version | Exact immutable version identifier and existing digest where the owning contract defines one; effective start/end and the versioned acceptance text reference |
| Conditions | Current applicable published refund, cancellation, renewal and credit validity/expiry terms. Their absence blocks the relevant paid commitment; this page does not invent legal wording. |
| Other charges | Tax and provider fees only when supplied by their authorized owning determination. Distinguish a published base price from an unknown total; never imply that unknown tax or processing cost is zero. |

Expected sections cover capacity plans and deliverables; participant model/capability/meter prices; credit packs; consultation/task/category fees; event/course fees; and cost-recovery verification. These are coverage requirements, not permission to map an arbitrary marketplace category into an existing fee kind. Sponsorship remains visibly disabled unless a separately authorized public offer and placement policy exist. It is never displayed as a paid ranking product.

Show every currently effective, activated public price/fee version in its actual scope. A future activated version may appear separately with its effective date and cannot replace the current price early. Drafts, rejected proposals, approver identities and internal audit evidence never appear. Historical accepted terms remain available through the payer's authorized history; do not expose another person's acceptance on the public page.

## Layout and interaction

The page starts with the hub context, free participation floor and the invariant that payment never affects ranking, matching, recommendations, reputation or badges. Follow with a short section index, coverage state and the price sections. Use stable section and owning-category order; no personalised or revenue-maximising sort.

On desktop, compare rows with proper column and row headings. At 375 px, use labelled cards or a deliberately scrollable labelled table whose values remain readable; never hide a fee, unit, condition or currency to fit. Version/digest details may be expandable, while the amount, unit, scope and current availability stay visible. Keyboard focus and expanded state are announced, and loading/status changes use an appropriate live region. No amount or state relies on colour alone.

Reading, changing language, filtering a section and expanding version details have no side effect. A purchase link opens the owning first-party flow with the referenced offer/version; it is not acceptance, a reservation or payment. No default checkbox, chat text, page view or sponsor click grants financial authority.

## Required states

| State | Behaviour |
|---|---|
| Loading | Label loading without fabricated prices, counts or a successful empty catalogue. Preserve page structure. |
| Complete | Every expected reader reports a current authorized result. Render the actual effective versions and explicit disabled sections. |
| Confirmed empty | A functioning reader confirms no effective offers for that section. Describe the absence; do not call the service free or available for purchase. |
| Partial | Show the successful public sections and identify unavailable coverage. A fee-only reader cannot establish complete model, plan or credit pricing. |
| Error/unconfigured | Explain that prices cannot currently be obtained and provide a retry. Do not replace failure with demo data, zero prices or an authoritative empty array. |
| Explicit zero | Display zero only from a current activated version with the correct scope and unit. Missing and zero remain distinct. |
| Expired or changed version | Preserve the visitor's context but require the owning flow to reload and disclose applicable terms before a new commitment. Existing acceptances remain immutable. |
| Unknown category, tax or terms | Identify which applicable information is unavailable. Do not guess a category or total; the owning command refuses a commitment requiring that information. |
| Provider unavailable | Public versioned prices may remain readable. Charging is unavailable; no paid/success state or new provider retry is invented. |

## Disclosure and commitment boundary

The public page is informative. The real booking, task, purchase or subscription command resolves the current authoritative scope and exact immutable source/destination terms, presents both parties' applicable fees, then records the owning contract's acceptance. The server rechecks version, effective interval, payer/resource authority, current legal/screening policy and required second-person activation in its mutation boundary. A stale link or successful page fetch is never authority.

Each hub invoices only its own participant in a cross-hub transaction. The page does not sum another hub's unknown fees, convert currencies or charge a participant for the counterparty's obligations. The owning flow supplies the applicable combined disclosure where implemented. Existing mandates and private budget ceilings remain private and cannot be inferred from prices.

Charges, refunds and payouts use licensed providers and stable operation identities. Unknown provider outcomes remain pending reconciliation, without another charge or a fabricated receipt. Neither a budget reservation nor a provider acknowledgement means money moved. Trustwork and hub operators never hold participants' money.

## Acceptance evidence for implementation

- Anonymous and authenticated readers see identical authorized public versions; private payer data, drafts, staff identity and provider cost/credentials are absent.
- Complete, partial, confirmed-empty, unconfigured, error and explicit-zero cases have distinct assertions; failed readers never become free/empty success.
- Actual owning commands reject stale/wrong-hub/wrong-category/wrong-destination disclosures and prove the activation/withdrawal race boundary. Existing accepted amounts and terms do not change.
- All seven languages fit at 375 and 1280 px, including long names and large monetary values. Keyboard and screen-reader semantics, unknown states and a non-English visual review are recorded.
- Payment and plan changes leave matching, search/directory ranking, recommendations and reputation unchanged. No live provider, invented rate or fake activity is needed for these synthetic tests.

BIZ-001 acceptance is the reviewed design and documentation validation. These implementation tests, actual full catalogue coverage, native-language/manual accessibility review, legal values and provider activation remain separate; a design merge proves none of them.
