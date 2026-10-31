# Market scan and ideas for Trustwork (October 2026, United States first)

Status: **Proposed**. Research input for the maintainers and the owner, not a decision. Nothing here changes the [vision](../engine/vision.md), the [product specification](../product/specification.md) or any ADR. Every idea that is adopted must go through a work package (see [proposed work packages](#proposed-work-packages)) or an ADR pull request.

Author: an AI research agent (Claude) working for the repository owner, 2026-10-30 and 2026-10-31. All web sources were accessed on **2026-10-30 or 2026-10-31**. Vendor prices change often and many vendors do not publish them; where a figure comes only from a third-party site it is marked *(secondary)*. Treat every number as indicative, never as a commitment or a quote. Nothing here is legal advice; every legal point is a question for the hub operator's counsel.

## Owner decisions that shaped this edition

| Date | Decision (owner, relayed by the conductor) | Effect on this document |
|---|---|---|
| 2026-10-31 | The engine stays open and quick to configure for any country and city; **our own reference and demo deployment is in the United States** (English, USD, states and territories, EIN, LLC and corporation forms, state contractor licensing, state sales tax, SAM.gov, ESIGN/UETA, card and ACH, state privacy laws, federal holidays; Spanish `es-US` as a likely second language) | Top ideas, business models and risks are US-first; the Central Asia and Caucasus material stays as the "other countries" view |
| 2026-10-31 | Flagship journey **"plan to people"**: a person launches a project, their agent builds a plan, plan items become consultations with experts and tasks for contractors, both sides' agents automate matching, quoting, scheduling and reporting, and finished projects become shared knowledge | New section [Flagship journey: plan to people](#2-flagship-journey-plan-to-people) |
| 2026-10-31 | Every participant gets tools to **build and confirm their own reputation**, never platform surveillance | New section [Reputation builder](#3-reputation-builder-evidence-you-own) |
| 2026-10-31 | Manufacturers' sites are parsed for catalogues, training, guides and articles, matched to each step of a user's plan (ADR 010 decision 19, as relayed) | New subsections [Manufacturer knowledge on plan steps](#manufacturer-knowledge-on-plan-steps) and [Plan-step taxonomy](#plan-step-taxonomy-recommendation) |
| 2026-10-31 | The conductor's list of sixteen candidate capabilities is to be evaluated against real products | New section [Missing high-value capabilities](#4-missing-high-value-capabilities) |

The US reference hub runs on **synthetic, labelled demo data** like every Trustwork demo. The importers proposed below (licence boards, SAM.gov, USAspending, OSHA) ship disabled; a hub operator enables each one only after recording its legal basis and licence, and real records then appear as "from a public source", never as members.

## Contents

- [Executive summary: the 15 most valuable ideas](#executive-summary-the-15-most-valuable-ideas)
- [The United States at a glance](#1-the-united-states-at-a-glance)
- [Flagship journey: plan to people](#2-flagship-journey-plan-to-people)
- [Reputation builder: evidence you own](#3-reputation-builder-evidence-you-own)
- [Missing high-value capabilities](#4-missing-high-value-capabilities)
- [Construction platforms and marketplaces](#5-construction-platforms-and-marketplaces)
- [B2B discovery, procurement and professional networks](#6-b2b-discovery-procurement-and-professional-networks)
- [Industry media and AI editorial](#7-industry-media-and-ai-editorial)
- [Company intelligence and due diligence](#8-company-intelligence-and-due-diligence)
- [The AI agents ecosystem](#9-the-ai-agents-ecosystem)
- [Federation and decentralized networks](#10-federation-and-decentralized-networks)
- [Events and learning](#11-events-and-learning)
- [Differentiators: what makes Trustwork uniquely better](#differentiators-what-makes-trustwork-uniquely-better)
- [Business-model options](#business-model-options)
- [Risks](#risks)
- [Proposed work packages](#proposed-work-packages)

## Executive summary: the 15 most valuable ideas

The US market splits into four camps that rarely meet: **project-management suites** that charge contractors by construction volume or seat (Procore, Autodesk, Buildertrend, Bluebeam); **lead marketplaces** that charge pros per lead or for advertising (Thumbtack, Angi, Houzz) and have drawn regulators' attention (FTC v. HomeAdvisor); **compliance and prequalification networks** that charge subcontractors to be qualified for each client (ISNetworld, Avetta, Highwire); and **data vendors** that sell project and company intelligence behind sales-led contracts (Dodge, ConstructConnect, Dun & Bradstreet). Expert advice and gig marketplaces (JustAnswer, Upwork, Fiverr) and community knowledge (Stack Exchange, Reddit) sit outside construction entirely.

None of them lets a person start from a plan, reach the right experts and contractors through an agent that works under their own mandate, keep evidence of what was done as reputation they own, and leave behind knowledge others can learn from, all with payment kept away from rank. That combination is Trustwork's opening; the ideas below make it concrete for a US hub.

Ranking: **impact** on people and on a hub's honest growth, divided by **effort** for this codebase as it stands (identity, company and project backend live; most other areas contract or design). I = impact, E = effort, each 1 (low) to 5 (high). "US" says how much the idea depends on the US reference hub (●●● built around US sources or law, ●○○ country-neutral).

| # | Idea | Learned from | I | E | US | Adopt / adapt |
|---|---|---|---|---|---|---|
| 1 | **Plan to people**: the agent turns a project goal into a plan whose items become consultations, needs, RFQs, permits and purchases; completed projects become diaries, templates and Q&A | Houzz, Angi/Thumbtack, JustAnswer, Upwork, Block Renovation, Stack Exchange | 5 | 4 | ●●○ | Adapt (flagship) |
| 2 | **Reputation builder**: an evidence wallet each person and company owns, attestations requested from real counterparties after verified work, an explainable profile, portable as verifiable credentials, never for sale | Upwork JSS, Houzz awards, LinkedIn, BBB, FTC fake-review rule, Open Badges 3.0 | 5 | 3 | ●○○ | Adapt |
| 3 | **Getting paid**: pay applications, retainage tracking, statutory lien-waiver exchange bound to actual payments, prompt-payment reminders, payment-timeliness evidence for both sides' reputation; funds only through licensed providers | Procore Pay and Levelset, Billd, state retainage and prompt-payment laws | 5 | 4 | ●●● | Adapt |
| 4 | **US public records as sourced facts**: state licence boards (CSLB, TDLR, DBPR downloads), SAM.gov entity and exclusion status, OSHA inspections, federal awards, shown with source and date, never blended into reputation | CSLB data portal, TDLR files, DOL open data, USAspending | 5 | 2 | ●●● | Adopt |
| 5 | **Prequalification passport**: licences, insurance certificates with expiry reminders, bonding capacity, safety record and references collected once, shared with each client by consent, free for subcontractors | ISNetworld, Avetta, Highwire, TradeTapp | 5 | 3 | ●●● | Adapt |
| 6 | **Public opportunities and awards**: SAM.gov notices and state or municipal bids as read-only open needs, a bid calendar, federal awards as sourced track record and an opt-in civic "where public money goes" view | SAM.gov, USAspending, BidNet, Dodge, ConstructConnect | 4 | 3 | ●●● | Adapt |
| 7 | **Honest economics**: never per lead, never per seat, a private client's request goes only to the pros they consent to, subscriptions without negative-option traps | FTC v. HomeAdvisor, FTC v. JustAnswer, Procore unlimited users | 5 | 1 | ●●○ | Adopt as rules |
| 8 | **Expert consultations** as scoped, priced or free objects with schedule, deliverable and refund terms, paid through a licensed provider | Clarity.fm, JustAnswer (what to avoid), Upwork fixed-price milestones | 4 | 3 | ●○○ | Adapt |
| 9 | **Field evidence objects**: RFIs, submittals, change orders, daily logs, punch lists and timestamped photos as versioned records that feed fair timing and reputation | Procore, Autodesk Build, Fieldwire | 4 | 4 | ●○○ | Adapt (evidence subset only) |
| 10 | **Field-first access**: Spanish (`es-US`), the agent over SMS and WhatsApp with voice notes, offline-capable mobile web for crews | BLS (35.4% of construction workers are Hispanic or Latino), 10DLC, WhatsApp Business Platform | 4 | 3 | ●●● | Adopt |
| 11 | **Shared knowledge**: project diaries, reusable plan templates, expert Q&A and mentoring, under an explicit content licence and with private data removed | Stack Exchange, Reddit, This Old House, MentorCruise | 4 | 3 | ●○○ | Adapt |
| 12 | **Home passport**: what was installed, by whom, with which warranty; maintenance reminders; warranty claims as structured requests; transferable when the home is sold | Block Renovation protections, Hover | 4 | 3 | ●●○ | Adapt |
| 13 | **Safe agents at known cost**: a model gateway that routes by data class and caps cost per mandate, plus an agent safety suite mapped to OWASP | OpenRouter, LiteLLM, OWASP LLM and Agentic Top 10 | 5 | 3 | ●○○ | Adapt |
| 14 | **Integrations**: public API and webhooks, CSV import that never creates fake members, calendars, QuickBooks Online and Xero adapters, Procore import of one's own projects | Intuit App Partner Program, Procore API | 4 | 3 | ●●○ | Adopt |
| 15 | **Sourced knowledge on every plan step**: manufacturer catalogues, installation guides, training and articles plus industry news, imported under licence or by the manufacturer's own feed, attributed, and matched to plan steps through an open taxonomy with crosswalks to MasterFormat, UniFormat, IFC and ETIM | GAF CARE, Simpson Strong-Tie training, BIMobject, Particle, RSL 1.0, C2PA | 4 | 3 | ●●○ | Adapt (ADR 010 decision 19) |

Just below the cut, still recommended: story clusters with AI provenance labels for the news desk, privacy-safe benchmarking for companies, the company-level due-diligence pack, a read-only hub MCP server and A2A card for the company representative, municipal permit data, materials price indices and EPD links, dispute evidence packages with mediation referral, and an outbound ActivityPub bridge. Deferred for legal reasons: an AI building-code assistant beyond citations and links, crew staffing and short-term hiring, and an equipment and surplus marketplace beyond catalogue offering kinds.

## 1. The United States at a glance

Facts a US hub must design for. Each line is a pointer for a country-pack fact or a hub setting, not a ruling.

### Market and workforce

- Construction employed about **12.1 million** people in 2025, of whom **35.4%** were Hispanic or Latino ([BLS CPS table 18, 2025 annual averages](https://www.bls.gov/cps/cpsaat18.htm); the 2025 averages exclude October). Spanish is a first-class need on site, not a nice-to-have.
- Associated Builders and Contractors estimates the industry must attract about **349,000** net new workers in 2026 ([ABC](https://www.abc.org/wfshortage)).
- Trade media and events: CONEXPO-CON/AGG (Las Vegas, March 2026, reported at more than 140,000 attendees *(secondary)*), World of Concrete, the NAHB International Builders' Show, regional shows such as New York Build, and vendor conferences; trade news from ENR, Construction Dive and For Construction Pros. A US hub's news desk and events calendar should start from these as registered sources, never by copying their content.

### Public procurement

| Source | Access | Use in Trustwork |
|---|---|---|
| SAM.gov contract opportunities | Public API with a free key issued through api.data.gov; role-based limits ([GSA](https://open.gsa.gov/api/get-opportunities-public-api/)) | Read-only open needs "from SAM.gov" with links |
| USAspending.gov | Free API, no key ([USAspending API](https://api.usaspending.gov/)) | Sourced award history for companies (by UEI), civic view |
| State and municipal portals | Each with its own terms; aggregators such as BidNet Direct offer a free limited tier and paid plans from about $599 per year *(secondary: [Civic IQ](https://civiciq.com/blog/civic-iq-bidnet-direct-review))* | Per-portal importers only where terms permit reuse |

### Licensing and verification

- Contractor licensing is **state by state** (and sometimes local); there is no national register. Some boards publish bulk data: California's CSLB offers a free master list and lists by classification and county ([CSLB data portal](https://www.cslb.ca.gov/onlineservices/dataportal/)); Texas TDLR publishes daily CSV files of its licence holders ([TDLR](https://www.tdlr.texas.gov/LicenseSearch/licfile.asp)) but does not license general contractors statewide; Florida DBPR offers public-records extract files *(secondary)*.
- OSHA inspection and violation data are public through the Department of Labor; the old enforcement site is being retired in favour of the DOL Open Data Portal ([DOL](https://enforcedata.dol.gov/)).
- OSHA does not verify individual 10- and 30-hour outreach cards; the card's QR code points to the training organisation that can confirm it ([OSHA FAQ via search](https://www.workyard.com/answers/construction-management-answers/quality-control-and-safety/how-to-get-osha-certified) *(secondary)*). A Trustwork credential should therefore record "confirmed by issuer X on date Y", not "verified by OSHA".
- The IRS TIN Matching programme is only for payers filing information returns and its results may be used only for that purpose ([IRS Revenue Procedure 2003-9](https://www.eitc.irs.gov/pub/irs-drop/rp-03-09.pdf)); it must not become a verification check in Trustwork.
- Federal court records are in PACER at $0.10 per page with a $3 cap per document and fees waived under $30 a quarter ([PACER](https://pacer.uscourts.gov/help/faqs/how-much-does-it-cost-access-documents-using-pacer)); CourtListener offers RECAP data and an API through memberships ([Free Law Project](https://free.law/2026/05/07/api-included-in-memberships/)). State courts differ widely.

### Payments, lien law and signatures

- **Lien waivers**: about a dozen states prescribe statutory forms; California has four (conditional and unconditional, progress and final, Civil Code §§ 8132–8138), and an unconditional waiver binds the claimant even if the payment fails *(secondary: [Siteline](https://www.siteline.com/lien-waiver/california))*. A platform must only release an unconditional waiver against evidence of cleared payment.
- **Retainage and prompt payment**: New York caps private-project retainage at 5% on contracts over $150,000, California extended a 5% cap to private works, and other states set different limits and deadlines ([JD Supra on New York](https://jdsupra.com/legalnews/new-york-caps-retainage-at-5-on-private-5574327); [Mondaq on California](https://www.mondaq.com/unitedstates/real-estate/1781626/california-expands-5-percent-retainage-cap-to-private-construction-projects)). These are country-pack facets per state, reviewed by counsel.
- **Holding funds is regulated**: California's Escrow Law covers escrow over the internet, and the DFPI lists licensed online escrow companies such as Upwork Escrow Inc. ([DFPI](https://dfpi.ca.gov/online-escrow-companies/)). Trustwork must never hold client money itself; staged payments go through a licensed payment or escrow provider behind an adapter.
- **Payment rails**: ACH debit through processors such as Stripe is about 0.8% capped at $5 *(secondary: [Dodo Payments](https://dodopayments.com/blogs/stripe-ach-fees/))*; cards cost more. Subcontractors routinely pre-fund materials (Billd reports 63% pay for materials before being paid *(secondary: [Construction Dive](https://www.constructiondive.com/news/procore-fintech-expansion-opportunities-construction-earnings/629352/))*).
- **E-signatures**: federal ESIGN plus UETA in almost every state; New York relies on its own ESRA ([Clifford Chance](https://www.cliffordchance.com/insights/resources/blogs/talking-tech/en/articles/2020/05/u-s--legal-framework-supporting-the-validity-of-electronic-signa.html)). Some instruments (notarised or recorded documents, some lien filings) need more than a simple e-signature.

### Privacy and consumer protection

- **CCPA/CPRA** applies above $26.625 million revenue, or 100,000 California consumers or households, or 50% of revenue from selling or sharing personal information ([Jackson Lewis](https://www.jacksonlewis.com/insights/navigating-california-consumer-privacy-act-30-essential-faqs-covered-businesses-including-clarifying-regulations-effective-1126)); about **twenty** states have comprehensive privacy laws in effect in 2026 *(secondary: [MultiState](https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026))*.
- **Data brokers**: under California's Delete Act, registered data brokers must process deletion requests from the state's DROP platform at least every 45 days from 1 August 2026 ([Fenwick](https://www.fenwick.com/insights/publications/dont-drop-ball-upcoming-changes-california-delete-act-five-key-steps-companies)). A hub that imports personal data of people it has no relationship with (for example licensees who are sole proprietors) and makes it available to others must check whether it becomes a data broker.
- **FCRA**: information used for employment, credit or insurance decisions about individuals can make a provider a consumer reporting agency. The CFPB withdrew its broader data-broker rule in May 2025 ([JD Supra](https://jdsupra.com/legalnews/cfpb-withdraws-proposed-fcra-data-1360411)), but the statute itself stands. Worker history and due-diligence features must be company-level or person-controlled, and never marketed for hiring or credit decisions about individuals.
- **Reviews**: the FTC's rule on fake reviews and testimonials (effective 21 October 2024) bans fake and AI-generated reviews, undisclosed insider reviews, review suppression and buying or selling reviews, with civil penalties ([FTC](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials)).
- **Subscriptions**: the FTC sued JustAnswer in January 2026 over a $1–$5 "join" offer that enrolled people into $28–$125 monthly memberships ([FTC](https://www.ftc.gov/node/327857)). Any hub plan must show the recurring price up front and cancel as easily as it signs up.
- **Texting**: business SMS over ordinary numbers requires A2P 10DLC brand and campaign registration, and marketing texts need TCPA-grade consent; WhatsApp charges per delivered template message since 1 July 2025 ([Meta](https://developers.facebook.com/docs/whatsapp/pricing)).

### Building codes

The model codes (IBC, IRC) are copyrighted by the ICC, which offers a limited free read-only view and paid premium access ([ICC](https://support.iccsafe.org/ht_kb/codes-faq/where-can-i-view-the-codes-for-free)). A district court found UpCodes' use of codes adopted into law to be fair use, and litigation continued on other claims ([BD+C](https://www.bdcnetwork.com/codes-and-standards/news/55163898/court-ruling-gives-upcodes-upper-hand-in-fight-over-building-codes-database)). Trustwork should cite sections and link to official sources, not host code text.

### Accounting and integrations

QuickBooks Online integrations moved to Intuit's App Partner Program on 28 July 2025: a free Builder tier and paid tiers, with "CorePlus" API calls metered beyond included credits ([Intuit FAQ](https://developer.intuit.com/app/developer/qbo/docs/get-started/partner-faq)). An accounting adapter must count its calls and let the hub see the cost.

## 2. Flagship journey: plan to people

### Comparables

| Service | What works | What fails or what to avoid | Model |
|---|---|---|---|
| [Houzz](https://www.houzz.com/magazine/how-to-create-and-use-ideabooks-stsetivw-vs~19764256) | Ideabooks: homeowners collect photos, products and pros and share them with a pro as a brief | Visibility sold next to the directory (advertising from $499/month, [pricing](https://www.houzz.com/houzz-pro/pricing)); "Best of Houzz" Innovator award reserved for winners who use paid Houzz Pro tools ([Floor Trends](https://www.floortrendsmag.com/articles/113289-houzz-unveils-2025-awards-adds-innovation-category-for-home-design-pros)) | Pro subscriptions, advertising |
| Angi, HomeAdvisor, Thumbtack | Simple job request; instant reach | Pros pay per lead whether or not they are hired; the FTC found HomeAdvisor misrepresented lead quality and origin ([FTC](https://www.ftc.gov/node/80884)) | Lead sales, advertising |
| JustAnswer | Fast access to an expert by chat | Cheap "join" offer that enrolled people into recurring memberships; FTC lawsuit in 2026 ([FTC](https://www.ftc.gov/node/327857)) | Membership |
| [Clarity.fm](https://clarity.fm/help/articles/23/how-are-rates-for-experts-determined-on-clarity) | Experts set an hourly rate; calls billed per minute with a pre-authorised estimate adjusted after the call | Little structure beyond the call itself | Commission, about 15% *(secondary)* |
| Upwork | Fixed-price contracts in funded milestones; funds held by a licensed internet escrow agent ([DFPI list](https://dfpi.ca.gov/online-escrow-companies/)); a success score | Fee changes are hard to predict (variable freelancer fee since 2025 *(secondary)*); "Connects" make bidding cost money | Fees on both sides |
| Fiverr | Productised, fixed-scope offers; a resolution centre for cancellations ([help](https://help.fiverr.com/hc/en-us/articles/37552956376977-How-cancellations-work-for-clients)) | 20% seller commission *(secondary)*; scope creep outside the package | Fees on both sides |
| [Block Renovation](https://www.blockrenovation.com/block-protections) | Free AI planner from photos; expert review of contractor scopes; homeowner pays the platform, which releases funds to the contractor in stages; contractor gives a one-year workmanship warranty | Block earns when the homeowner hires through it, so its directory is not neutral | Take on completed jobs |
| [Hover](https://hover.to/product) | Measured 3D model from a few smartphone photos for estimating | Specialist tool, not a plan | Subscription |
| Stack Exchange (Home Improvement) | Q&A with votes, accepted answers and edits; content under CC BY-SA 4.0 | Restricted the data dump in 2024 after AI scraping, which the community saw as contrary to the licence ([DevClass](https://devclass.com/2024/07/30/stack-exchange-restricts-access-to-dump-of-user-contributed-data-as-critics-complain-license-permits-reuse-for-any-purpose)) | Advertising, enterprise, data licensing |
| Reddit r/HomeImprovement, This Old House | Large, candid communities; long-form show-and-tell of whole projects | Forums lose the structured link between a question, the project and the people who did the work | Advertising, media |
| [MentorCruise](https://help.mentorcruise.com/articles/what-fees-does-mentorcruise-take/) | Long-term mentoring subscriptions with transparent fee mechanics (around 16.6% average take); free mentoring allowed | Fee added on top can surprise mentees on small plans | Commission |

### Lessons

1. **Plans beat requests.** Houzz ideabooks and Block's planner show that people want help shaping the project before anyone quotes. A plan also makes a request specific enough that fewer, better pros need to see it.
2. **Never sell the same request to many pros.** That is the core harm the FTC found in the lead model; it also wastes pros' money and floods clients with calls.
3. **Price and recurring terms up front.** JustAnswer shows the legal cost of hiding a subscription behind a cheap first step.
4. **Staged payment needs a licensed holder of funds.** Upwork and Block both hold money between client and provider; Upwork does it through a licensed escrow entity. Trustwork should orchestrate milestones and evidence, and let a licensed provider hold the money.
5. **Knowledge needs a licence and a structure.** Stack Exchange's licence fight shows that contributors care what happens to their answers; forums show that knowledge is more useful when tied to a real project.
6. **Platform-owned awards tied to paid tools are pay-to-rank by another name.** Avoid any badge that requires buying a product.

### Recommended model for Trustwork

```text
Goal ("renovate the kitchen of a 1960s house in Austin, budget range, start in spring")
  → Plan (agent draft; the person edits and owns it)
     items: decide layout · structural check · permit · electrical · cabinets · countertops · finishing · inspection
  → Each item becomes the right object
     consultation (paid or free, scoped, scheduled) · open need · RFQ · catalogue purchase · permit task · self-done step
  → Agents on both sides work under mandates
     find candidates (explainable, never paid), propose consultations, request quotes, schedule visits, draft weekly reports
  → Execution evidence
     milestones, change orders, photos, lien waivers bound to payments, acceptance
  → Completion
     home passport for the owner · reputation evidence for every party · optional project diary, template and Q&A answers shared under the author's chosen licence
```

Rules that keep it honest:

- The plan is **private** to the person and those they invite. Publishing a need from a plan item is an explicit act, with the fan-out limited to the pros the person consents to (idea 7).
- **Consultations** are first-class objects: expert, scope, duration, price or "free", schedule, deliverable (a written note, a marked-up drawing, a site visit report), cancellation and refund terms, and the licence of the deliverable. Paid ones go through a licensed payment provider; Trustwork never stores card or bank data.
- **The agent proposes; the person decides.** Plan generation, candidate lists and schedules are drafts; commitments and payments need a mandate, a budget and, where configured, a digest-bound approval.
- **Licensed work stays with licensed people.** The plan marks items that the state requires a licensed contractor, engineer or architect for (from the country pack and hub configuration) and never suggests an unlicensed shortcut.
- **Estimates are ranges with sources.** Budget ranges cite where they come from (public cost indices, the person's own quotes, anonymised aggregates with sample size) and say "estimate".
- **Knowledge belongs to its author.** A diary or template is published only by its author, under a licence they choose (for example CC BY-SA 4.0 or "all rights reserved"), with addresses, faces, prices and names of others removed unless those people agreed. Expert answers are publications with authorship, corrections and the [existing expert-answer design](../engine/publishing.md#community-around-publications-proposed).
- **Mentoring** is a long-running consultation series (free or paid) and an event format, never a ranking signal.

### Manufacturer knowledge on plan steps

Owner direction (ADR 010 decision 19, as relayed on 2026-10-31): manufacturers' sites are parsed for catalogues, training, guides and articles, and these are matched to each step of a person's plan. The US market shows both why this is valuable and where the legal edges are.

| Source of knowledge | Example | What it offers | Relationship to pros |
|---|---|---|---|
| Manufacturer academies | [GAF CARE](https://www.gaf.com/en-us/for-pros/care-training): online, webinar and in-person roofing courses from installation to selling and financing; FORTIFIED training with IBHS | Installation know-how, certification paths | Feeds manufacturer contractor tiers (Master Elite) |
| Free accredited training | [Simpson Strong-Tie](https://training.strongtie.com/customer/footer/faq/index.html): free workshops, webinars and online courses; AIA and IACET provider; some courses approved by state contractor boards (Oregon CCB, Oklahoma CIB) | Continuing-education credit that licensing bodies may accept | Neutral |
| Manufacturer contractor programmes | [James Hardie Contractor Alliance](https://www.jlconline.com/products-tools/james-hardie-introduces-contractor-alliance-program_o) (GuildQuality surveys, annual volume of Hardie jobs); Owens Corning Platinum Preferred (invitation, years in business, insurance) *(secondary)* | Warranty upgrades, referrals | **Status depends on purchase volume** |
| Retail pro networks | Home Depot Pro Referral: shoppers matched to pros, who pay for leads with loyalty points earned on purchases *(secondary: [Behr](https://www.behr.com/pro/onthejob/blog/pro-referral-program/))* | Reach | Leads tied to spending |
| Product content platforms | BIMobject and BIM&CO host manufacturer BIM objects; BIM&CO adopted the free ETIM classification ([PBC Today](https://www.pbctoday.co.uk/news/digital-construction-news/bim-news/bimco-adds-etim-to-its-classification-systems-and-communications-standards/38093/)) | Structured product data | Manufacturer-paid listings |
| Inspiration to product | Houzz ideabooks save photos, products and pros together | Context for decisions | Advertising and pro subscriptions |

**Adopt.** Attach to each plan step the manufacturer's installation guide, data sheet, warranty conditions and relevant free training, with the manufacturer named and the link to the original. Training with state-board or AIA credit is valuable to pros and can flow into their evidence wallet as "completed, per issuer" when the issuer confirms it.

**Adapt.** Manufacturer contractor programmes are legitimate evidence of training and inspection, but several depend on purchase volume. Show them as **"programme membership, per manufacturer, criteria include purchase volume"**; never let them influence Trustwork matching or reputation.

**Avoid.** Retail-style lead routing paid with purchase points, and any placement of a manufacturer's product in a plan because the manufacturer paid. A plan step may list several manufacturers' guides; the order is by relevance and the person's own choices, and sponsored content, if a hub allows it, is labelled and never displaces neutral results.

#### Legal limits of collecting manufacturer content in the US

| Question | Current position (not legal advice) | Design consequence |
|---|---|---|
| Computer Fraud and Abuse Act | In *hiQ v. LinkedIn* the Ninth Circuit held that scraping public pages is unlikely to be "without authorization"; the case still ended with an injunction and settlement because hiQ breached LinkedIn's user agreement, including through fake accounts ([Eric Goldman blog](https://blog.ericgoldman.org/archives/2023/03/after-hiq-labs-is-scraping-public-data-legal-guest-blog-post.htm)) | Never log in, never create accounts, never bypass technical barriers |
| Terms of service | In *Meta v. Bright Data* (N.D. Cal., January 2024) logged-off scraping of public data was held not to breach Meta's terms ([Farella Braun + Martel](https://www.fbm.com/business-litigation/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/)); terms a crawler has accepted (a logged-in account, a clickwrap) still bind | Collect only logged-off public pages; record the site's terms at collection time; honour robots.txt and RSL even where not strictly required |
| Copyright | Facts (dimensions, ratings, compatibility) are not protected; text, photos, drawings, videos and PDFs are. Fair use is case by case | Store structured facts and short attributed excerpts; link to and, where licensed, embed original documents; do not republish full guides, photos or videos without permission |
| Model egress and training | Licences and RSL terms may forbid AI use | The [source registry](../engine/publishing.md#hub-sources-proposed) flag "send to a model provider" defaults to off for manufacturer content until the manufacturer allows it |
| Takedown | The DMCA notice-and-takedown safe harbour requires a designated agent registered with the US Copyright Office | A US hub registers its agent; takedowns propagate as tombstones across the mesh |

**Recommended collection order:** (1) the manufacturer's own feed or a claimed manufacturer page where it uploads catalogues and guides under an explicit licence; (2) open feeds and sitemaps the manufacturer publishes; (3) logged-off crawling of public pages, respecting robots.txt and RSL, storing facts plus links; (4) never anything behind a login, paywall or technical barrier. Items arrive as drafts for an editor, as for news.

### Plan-step taxonomy recommendation

| Option | Licence | Fit for plan steps |
|---|---|---|
| CSI MasterFormat (work results by specification section) and UniFormat (elements) | Proprietary; OmniClass tables incorporate them and organisational licences are quoted by CSI ([CSI](https://www.csiresources.org/thriveupgrade/standards/omniclass)) | The US industry's lingua franca for specifications and estimating; too technical for homeowners; licence needed to embed |
| OmniClass (tables for work results, elements, phases, roles, materials) | Licence terms at omniclass.org; enterprise licences by quote | Rich, but the same licensing question |
| IFC (ISO 16739-1:2024, IFC 4.3) | Open schema by buildingSMART | Describes building elements and spaces, not the order of work |
| ETIM | Free to use; membership only to take part in development | Products (about 1,400 building-materials classes *(secondary)*), not work steps |
| Uniclass (UK) | Free under its own terms (general knowledge, not re-verified here) | Good structure, UK-centred |

**Recommendation.** Define an **open Trustwork plan-step taxonomy** (CC0, in the repository, localised in every engine language) that people understand ("demolition", "framing", "roof covering", "rough electrical", "inspection: rough-in"), each step carrying:

- a stable key, parent and typical predecessors (so the agent can order a plan);
- the licence or permit question it may raise, answered per state by the country pack;
- **crosswalks** to IFC entity types and ETIM classes (open), and to MasterFormat, UniFormat or OmniClass codes **only where the hub holds a licence**; a hub without one still works;
- the kinds of objects a step can produce (consultation, need, RFQ, purchase, inspection, self-done).

This keeps the engine free of proprietary dependencies while letting US professionals see the codes they use. Manufacturer content, training and pros' capability profiles are tagged with the same keys, which is what makes matching a guide or a pro to a plan step explainable.

## 3. Reputation builder: evidence you own

### What the best systems do and where they fail

| System | Mechanism | Strength | Failure or risk |
|---|---|---|---|
| [Upwork Job Success Score and Top Rated](https://support.upwork.com/hc/en-us/articles/38437362753171-What-is-a-Job-Success-Score) | Score from contract outcomes and client feedback, including private feedback; "Top Rated" for scores of 90% and above over time | Tied to real paid contracts | Opaque weights; freelancers fear single bad contracts; Top Rated members may ask to remove feedback *(secondary)* |
| LinkedIn endorsements and assessments | One-click skill endorsements; skill assessments **retired** in favour of skills tied to jobs, projects and credentials ([LinkedIn](https://www.linkedin.com/help/learning/answer/a1690529)) | Identity and workplace verification are free ([LinkedIn verification](https://www.linkedin.com/help/linkedin/answer/140551)) | Endorsements from people who never saw the work became noise |
| [Houzz awards](https://www.houzz.com/pro-learn/blog/best-of-houzz---a-guidebook) | Service award from client reviews entered by clients themselves; employees and family excluded | Clear rules against self-reviews | New Innovator award requires paid Houzz Pro tools |
| Better Business Bureau | Letter grades and paid accreditation | Familiar to consumers | 2010 investigations alleged grades followed payment; the BBB removed accreditation from the rating formula ([Wikipedia summary](https://en.wikipedia.org/wiki/Better_Business_Bureau)) |
| Google and Yelp reviews | Open reviews from anyone with an account | Volume and reach | Google blocked or removed over 292 million policy-violating reviews in 2025 ([Search Engine Roundtable](https://www.seroundtable.com/google-maps-spam-fighting-2025-41176.html)); review gating and quotas are banned; the FTC rule makes fake and bought reviews unlawful |
| Angi "certified pros" | Platform label | Simple | Vermont settlement: the word implied a state certification that does not exist ([Vermont AG](https://ago.vermont.gov/ago/blog/2025/10/13/attorney-general-clark-settles-dispute-angi-over-misleading-marketing-practice)) |
| ISNetworld, Avetta, Highwire | Prequalification questionnaires, insurance and safety documents reviewed per client | Structured, evidence-based | Subcontractors pay hundreds to thousands of dollars a year per network and repeat the work for each client *(secondary: [Billy](https://billyforinsurance.com/resources/billy-vs-isnetworld-vs-avetta-subcontractor-prequalification/))* |
| State licence lookups | Authoritative status from the board | The source of truth for licensing | Fifty different systems; status changes without notice |
| W3C Verifiable Credentials and Open Badges 3.0 | Signed, self-contained credentials the holder keeps ([1EdTech](https://www.imsglobal.org/spec/ob/v3p0)) | Portable, checkable offline | Only as good as the issuer; wallets are still unfamiliar |

### Recommended model

A **reputation builder** on «My page» and on the company page, made of things the participant can do, not things the platform watches:

1. **Evidence wallet.** Licences (sourced from the board, with status and date), insurance certificates (uploaded, then confirmed by the broker or insurer where possible, with expiry reminders), certificates and course completions, safety programme documents, completed projects with photos and acceptance records. Each item is labelled sourced, claimed or verified.
2. **Attestations from real counterparties, only after real work.** When an agreement on Trustwork reaches acceptance (or a project the person participated in is closed), each party may give a structured attestation (on time, as specified, paid on time, cooperative) plus an optional written review. No attestations without a recorded relationship; no endorsements of skills by strangers; no reviews from employees or family; no incentives for reviews. A person can also **import** a past project by inviting the former client to confirm it, which creates evidence only if the client confirms.
3. **Explainable profile.** The [reputation snapshot](../engine/execution-and-reputation.md) shows each dimension with sample size, period, method version, exclusions and disputes. "New, no history yet" is neutral. Single bad outcomes are shown in context; the subject may respond publicly once per item.
4. **Disputes and appeals, not deletions.** A participant cannot buy or request removal of a negative attestation; they can dispute it with evidence and get a decision from a reviewer who did not handle the original case.
5. **Portable.** Every certificate, verified badge and confirmed project can be exported as a signed credential (Open Badges 3.0 or a W3C VC) that names the issuing hub, so the reputation follows the person across hubs and employers. A Trustwork credential never claims to be a state licence; it says "licence record observed at the board on date".
6. **Never for sale.** No plan, fee, sponsorship or paid tool changes a score, a badge or a position. Tests compare snapshots and rankings with and without entitlements.
7. **Not surveillance.** Inputs are agreements, acceptances, payments, attestations and documents the participant chose to add. No activity tracking, no per-employee productivity, no "who viewed you".

This model needs one new package (REP-001) and reuses EXE-001, CRED-001, REG-001 and PREQ-001.

## 4. Missing high-value capabilities

The conductor's sixteen candidates, evaluated against real products and US law. Verdict: **Keep** (own package), **Merge** (into another package), **Defer** (wait for a dependency or legal clarity) or **Drop**.

| # | Capability | Verdict | I | E | US relevance | Precedent | Legal and privacy notes |
|---|---|---|---|---|---|---|---|
| 1 | Getting paid: milestones, retainage, lien waivers, prompt-payment reminders, timeliness evidence, financing partners | **Keep** (PAY-001), top 3 | 5 | 4 | High | Procore Pay with lien-waiver exchange ([Procore](https://v2.support.procore.com/product-manuals/procore-pay)), Levelset, Billd | Funds only through licensed providers (escrow and money transmission); statutory waiver forms per state reviewed by counsel; unconditional waivers only after cleared payment; reminders are information, not legal advice; financing partners labelled, referral fees disclosed, never affect ranking; no consumer lending to homeowners |
| 2 | Subcontractor prequalification passport | **Keep** (PREQ-001), top 5 | 5 | 3 | High | ISNetworld, Avetta, Highwire ([Highwire](https://www.highwire.com/prequalification)), TradeTapp | Free for subcontractors; shared per client by consent with expiry; EMR is self-declared with an insurer document; OSHA data cited from DOL; business-level data, but sole proprietors are people under state privacy laws |
| 3 | Bid intelligence: public opportunities, bid calendar, AI takeoff, bid leveling | **Keep** opportunities and calendar (PROC-001); **Merge** leveling into the existing quote comparison; **Defer** AI takeoff | 4 | 3 | High | SAM.gov, BidNet, DESTINI Bid Day, Togal.AI (from about $1,999 per user per year *(secondary)*) | Portal terms differ; takeoff accuracy creates liability, so integrate specialist tools by adapter rather than build |
| 4 | Field objects: RFIs, submittals, change orders, daily logs, punch lists, photo evidence | **Keep** (FIELD-001), evidence-focused | 4 | 4 | Medium | Procore, Autodesk Build, Fieldwire | Photo location data removed from public views; daily logs record work, never per-worker productivity; versions digest-bound like quotes |
| 5 | Trades workforce: portable work history, OSHA and trade credentials, crew availability, EN/ES | **Keep** history and credentials (REP-001, CRED-001) and Spanish (I18N-001); **Drop** crew staffing for now | 4 | 3 | High | LinkedIn verifications, Open Badges | FCRA if history is used for hiring decisions by others: keep it person-controlled and never sell it; staffing raises joint-employer, wage and misclassification law |
| 6 | Field-first channels: WhatsApp, SMS, Telegram, voice notes, offline mobile web | **Keep** (CHAN-001) | 4 | 3 | High | WhatsApp Business Platform, 10DLC | 10DLC registration and TCPA consent; inbound messages and transcribed voice notes are untrusted input; no action without a structured confirmation |
| 7 | Materials: price indices, lead times, approved-equal assistant, data sheets, EPDs | **Keep** a small slice (MAT-001) | 3 | 2 | Medium | BLS producer price indices, Building Transparency EC3 (free web app; commercial API paid *(secondary)*) | Only public or licensed data; lead-time signals only from aggregates with minimum sample size; "approved equal" always needs the designer's approval |
| 8 | Permits and inspections: municipal open data, reminders, zoning | **Keep** permits as sourced data (PRMT-001); **Defer** zoning | 3 | 3 | High | City open-data portals; commercial aggregators such as Shovels (1,800+ jurisdictions *(secondary)*) | Permits name owners and addresses: link only to companies, never publish homeowners' names |
| 9 | Homeowners: AI scoping from photos, budget ranges, verified matching, milestone payments, home passport | **Keep** (HOME-001 plus PLAN-001) | 4 | 3 | High | Block Renovation, Hover | State home-improvement contract rules (down-payment limits, cancellation rights) belong in the pack; estimates labelled as estimates |
| 10 | Equipment rental and surplus exchange | **Merge** into catalogue offering kinds (`rental`, `surplus`); no logistics | 2 | 1 | Low | Equipment rental marketplaces | Insurance and damage liability stay between the parties |
| 11 | Structured disputes with evidence packages and mediation | **Keep** (DISP-001), extends EXE-001 | 4 | 2 | High | AAA Construction Industry Rules, fast track up to $150,000 since 2024 ([Cozen](https://www.cozen.com/news-resources/publications/2024/aaa-updates-its-construction-industry-arbitration-rules-and-mediation-procedures)) | Trustwork packages evidence and refers to mediators; it never arbitrates; outcomes recorded only with consent |
| 12 | AI code and standards assistant | **Defer**; allow citation and links only | 3 | 4 | High | ICC Digital Codes, UpCodes | Code text is copyrighted; host nothing without a licence; never present an answer as a compliance determination |
| 13 | Verifiable credentials for licences, certificates and projects | **Merge** into CRED-001 and REP-001 | 4 | 3 | Medium | Open Badges 3.0, W3C VC 2.0 | The board issues licences; Trustwork attests only to what it observed |
| 14 | Integrations: QuickBooks, Xero, Procore import, calendars, webhooks, API, CSV | **Keep** (INTEG-001) | 4 | 3 | High | Intuit App Partner Program, Procore API | CSV imports create private contact lists of the importer, never directory members; metered APIs shown to the hub |
| 15 | Privacy-safe benchmarking for companies | **Keep** (BENCH-001) | 3 | 2 | Medium | Coupa community benchmarks (pooled spend) | Own metrics vs peer aggregates only with a minimum group size; no per-employee metrics; no pooled private prices |
| 16 | Civic transparency for public projects | **Merge** into PROC-001 as an opt-in hub view | 3 | 1 | High | USAspending, Open Contracting | Public data only; neutral presentation |

## 5. Construction platforms and marketplaces

### Project and field management suites

| Service | What they do well | Business model |
|---|---|---|
| [Procore](https://www.procore.com/pricing) | One system of record for the project; owners, subs and vendors join at no seat cost | Annual fee per product based on **Annual Construction Volume**; "We'll never charge you for adding more users"; field productivity priced per FTE. Real amounts are quote-only; third parties estimate roughly 0.1–0.2% of volume *(secondary)* |
| [Procore Construction Network](https://support.procore.com/faq/what-is-the-procore-construction-network) | Free business pages for subs and suppliers, approved within 24–48 hours, searchable by location and trade, invitable to bids | Free; feeds Procore's paid bidding tool |
| [Autodesk Construction Cloud / BuildingConnected](https://construction.autodesk.com/products/buildingconnected/) | Bid board for subs (Bid Board Pro), large GC/owner network, **TradeTapp** qualification with AI extraction of financial statements | Seat subscriptions; Autodesk Build around $1,600+ per user per year *(secondary)*. PlanGrid is no longer sold to new customers ([migration FAQ](https://construction.autodesk.com/resources/article-cta-workaround/faq-transition-to-acc/)) |
| [Buildertrend](https://buildertrend.com/) | Residential builders: schedules, selections, client portal, unlimited users | Tiers reported at roughly $339–$1,099 per month; no longer published *(secondary)* |
| [Bluebeam](https://bluebeam.com/pricing) | PDF markup standard of the industry; the new "Max" tier adds AI drawing review and **AI integration via MCP** | Per user per year: Basics $260, Core $330, Complete $440, Max $590 introductory |
| [Fieldwire (Hilti)](https://help.fieldwire.com/hc/en-us/articles/202634054) | Field tasks on plans; generous free plan (3 projects, 100 sheets, 5 users) | Free tier; paid per user per month |
| [Houzz Pro](https://www.houzz.com/houzz-pro/pricing) | Design and remodelling pros: estimates, 3D plans, client CRM, a large homeowner audience | Pro $199/month, Teams from $399/month; **advertising package from $499/month** sold alongside the directory |

**Adopt.** Procore's "unlimited users" is the right instinct for a gathering point: a company should never think twice before inviting a colleague, a subcontractor or a client. Trustwork already offers free participation ([billing](../engine/billing.md)); make "no per-seat charges for participation" an explicit, published rule of the reference price catalogue (idea 7). The Procore Construction Network shows that a free, approved directory page is the hook for everything else.

**Adapt.** TradeTapp's qualification view (financial statements, safety, insurance, capacity) maps to the [capability profile](../engine/partners-and-matching.md) and [verification recipes](../engine/hub-administration.md#counterparty-verification). Trustwork should present qualification as **evidence with sources and expiry**, not as an opaque risk score; an AI extractor may draft the structured fields from an uploaded document, but uploaded documents are untrusted input and only a reviewer or a register adapter can turn them into verified evidence.

**Adapt.** Bluebeam shipping MCP in its top tier confirms that construction professionals will bring their own assistants. A read-only hub MCP server over the public projection (below the cut) lets those assistants cite Trustwork instead of scraping it.

**Avoid.** Pricing tied to construction volume needs revenue data Trustwork must not collect from participants for billing; and Houzz-style advertising next to a directory blurs the line between paid and earned visibility. Trustwork may carry labelled sponsorship on editorial surfaces, never in directories, matching or search ([R14](../product/specification.md)).

### Contractor matching for private clients

| Service | Model | What went wrong or right |
|---|---|---|
| Thumbtack | Free to join; pros pay per lead they access, even without a hire; prices vary by job and market *(secondary)*. "Top Pro" status requires recent verified reviews and good handling of problems ([Pro Center](https://pro-center.thumbtack.com/?p=21959)) | Pros complain about rising lead prices and paying for leads that never convert ([community](https://community.thumbtack.com/discussion/comment/887)) |
| HomeAdvisor / Angi | Lead sales and advertising | The FTC's 2023 final order required HomeAdvisor to pay up to $7.2 million for misrepresenting lead quality and origin ([FTC](https://www.ftc.gov/node/80884)); Vermont's Attorney General settled in 2025 over the "certified pros" wording where the state only registers contractors ([Vermont AG](https://ago.vermont.gov/ago/blog/2025/10/13/attorney-general-clark-settles-dispute-angi-over-misleading-marketing-practice)) |

**Adopt as a rule (idea 7).** Per-lead charging creates exactly the incentives the regulators punished: sell the same request to many pros, overstate intent, blur the source. Trustwork should state in the billing chapter that **a hub never charges for a lead, an introduction or a received RFQ**, and that a private client's need reaches only the pros the client chose or explicitly consented to, with a hub-configurable cap. The double-opt-in introduction already designed in [partners and matching](../engine/partners-and-matching.md#introductions) is the right primitive.

**Adopt (wording).** Never call a Trustwork badge "certified" or "licensed". The engine already distinguishes sourced, claimed and verified; the Vermont settlement shows that the words on the badge matter legally, not only ethically.

**Adapt.** Thumbtack's Top Pro criteria (recent verified reviews, problem handling, responsiveness) are a reasonable shape for an explainable **responsiveness** dimension, but only with sample sizes shown and with "new, no reviews yet" treated as unknown, not bad.

### Project-lead intelligence

[Dodge Construction Network](https://www.construction.com/what-is-dodge-construction-network-the-dodge-report-explained/) and [ConstructConnect](https://www.constructconnect.com/dodge-alternative-google) sell early project intelligence and bid documents through sales-led subscriptions (ConstructConnect starter tiers around $129–$199 per month *(secondary)*). Their raw material is largely public: permits, planning approvals and public tenders.

**Adapt (idea 6).** For the US reference hub the most valuable public project data is SAM.gov, USAspending and state or municipal bid portals ([section 1](#public-procurement)). In the other launch countries it is also **public procurement**. Uzbekistan runs general e-procurement on the commodity exchange (xarid.uzex.uz) and a separate construction e-tendering platform (tender.mc.uz) under a 2022 regulation ([ADB presentation](https://events.development.asia/sites/default/files/materials/2024/08/202408-e-procurement-system-uzbekistan.pdf)); Armenia's ARMEPS publishes plans and contracts as CSV and Excel ([OGP commitment](https://www.opengovpartnership.org/members/armenia/commitments/AM0053/)); Georgia's State Procurement Agency has offered an open API and bulk downloads ([Open Contracting registry](https://data.open-contracting.org/en/publication/24)). The [Open Contracting Data Standard](https://standard.open-contracting.org/latest/en/primer/what/) gives one shape for all of them. Imported tenders become read-only **open needs** labelled "from a public source"; awards become **sourced project history** of the winning company. Hubs must confirm each portal's terms of reuse before enabling the importer.

### Other countries: Central Asia and the Caucasus

| Market | What exists | Note |
|---|---|---|
| Uzbekistan | Ustabor.uz (repair and construction services matching, since 2016), material shops such as stroyka.uz and 24stroy.uz ([Dealroom](https://app.dealroom.co/companies/ustabor_uz)); the **state contractor rating** "Shaffof qurilish" at reyting.mc.uz, calculated automatically from data of about ten agencies under Cabinet Resolution No. 699 of 2020 and covering over 36,000 organisations ([Ministry of Construction, 21 Nov 2025](https://gov.uz/en/mc/news/view/116701); [Kun.uz](https://kun.uz/en/news/2021/01/23/online-ranking-of-construction-companies-launched)) | No independent B2B gathering point found |
| Kazakhstan | State-backed building-materials marketplace material.kz with over 280 manufacturers ([KHC](https://khc.kz/en/press-center/news/695/)) and STROYKA.KZ ([Kazbuild](https://kazbuild.kz/en/press-center/news/news-blog/2321-stroyka-digital-platform-kz)) | Not a launch country; a possible future hub |
| Georgia | Startups such as boq.ge for announcements, tenders and budgeting ([CBW](https://cbw.ge/startup/boqge-new-startup-for-construction-sector-in-georgia)); trade fairs (Caucasus Build Expo) | Fragmented |
| Armenia, Azerbaijan | No dedicated construction B2B marketplace found in this scan | Public e-procurement portals are the main digital channel |

**Adopt (idea 4).** The Uzbek rating is a public, explainable government signal that local clients already use. Showing it on the company page as a **sourced fact** ("Official rating, Ministry of Construction, as of …, link") is high value and low effort, and it demonstrates that Trustwork labels truth instead of competing with it. It must never be mixed into Trustwork's own reputation snapshot, whose method is published separately ([execution and reputation](../engine/execution-and-reputation.md)).

**Avoid.** Do not position a hub as a materials e-shop. State-backed marketplaces exist in Kazakhstan, and logistics and payments are not the engine's strength; the [catalogue and immutable quotes](../engine/commerce.md) are enough.

## 6. B2B discovery, procurement and professional networks

| Service | What they do well | Business model |
|---|---|---|
| [Alibaba.com](https://activities.alibaba.com/alibaba/buyer/ab/safety_security/products/verification_services.php) | **Verified Supplier** assessed by third-party inspectors (Bureau Veritas, TÜV Rheinland) with downloadable reports; Trade Assurance escrow-like protection for orders paid on-platform | Supplier memberships; transaction fees; buyer-paid inspections ($150–$400 per inspection *(secondary)*) |
| Thomasnet | Industrial supplier directory; free basic listing; "Registered" and "Verified" programs built by an analyst team; buyers filter by badge | Advertising, paid programs, performance-based listings *(secondary)* |
| [IndiaMART](https://help.indiamart.com/knowledge-base/trustseal-pro/) | Huge SME supply base; **TrustSEAL** with document checks, GST validation and a video verification call | Supplier subscriptions that bundle a number of "BuyLeads" per week and the TrustSEAL |
| [SAP Business Network Discovery](https://learning.sap.com/courses/overview-of-sap-business-network/describing-the-sap-ariba-discovery-functionality_de47d9e6-98d2-415c-8844-d1e3148bd7cf) | Buyers post sourcing opportunities free; matched to suppliers | Free standard supplier accounts with a few free private-sector responses; paid tiers; transaction fees on enterprise accounts ([pricing](https://www.sap.com/bulgaria/products/business-network/suppliers/pricing.html)) |
| [Coupa](https://www.coupa.com/newsworthy/press-releases/coupas-new-communityai-rapidly-transforms-business-insights-actions) | Supplier portal free for suppliers; "community intelligence" benchmarks from anonymised spend across customers | Buyer-side subscriptions |
| [Tradeshift](https://tradeshift.com/about/) | E-invoicing network, Peppol access point, compliance in dozens of countries | Network and compliance fees |
| [LinkedIn](https://www.linkedin.com/help/linkedin/answer/140551) | Lifelong personal profiles; free identity verification through partners; **workplace verification** by work e-mail or employer-provided signals; company-page badges. [Services marketplace](https://www.linkedin.com/help/lms/answer/a550345): RFPs to providers, replies gated by Premium | Premium subscriptions, recruiting and advertising |

**Adopt.** LinkedIn's workplace verification by a code to the company domain is exactly the "domain tie" in Trustwork's [reference recipes](../engine/hub-administration.md#reference-recipes-for-the-example-countries). Keep it, and keep the rule that free e-mail domains cannot satisfy it.

**Adopt.** Alibaba's practice of letting the buyer **download the inspection report behind a badge** is a good transparency pattern, adapted to Trustwork's privacy rule: the badge shows evidence *categories*, the date and the issuing node publicly; the documents themselves stay private and are shown only to parties of a deal with consent.

**Avoid.** IndiaMART bundles its trust seal with paid packages, and LinkedIn gates RFP replies behind Premium. Both make verification or participation look purchasable. In Trustwork, verification may carry a **cost-recovery fee** for manual review where checks have real cost (already allowed in [billing](../engine/billing.md)), but it must be available independently of any plan, priced the same for everyone, and waivable by the hub; replying to an RFQ is always free.

**Adapt.** Coupa's community benchmarks show the value of pooled data, but pooling procurement prices across buyers conflicts with Trustwork's privacy and competition rules ([agents chapter](../engine/agents.md#negotiation)). The safe version is **public-data benchmarks only**: aggregate statistics over published public-procurement awards (idea 6), with method, sample size and source.

**Adapt.** SAP's free buyer postings plus free supplier responses is the right baseline for Trustwork's needs board. Do not copy the cap on free responses.

**Defer.** E-invoicing networks (Tradeshift, Peppol) matter once orders are live; the country facets already list e-invoicing ([country specifics](../engine/country-specifics.md#tax-and-invoicing)). Keep it an adapter per hub.

## 7. Industry media and AI editorial

### AI news products

| Product | Practice worth studying |
|---|---|
| [Particle](https://techcrunch.com/2024/06/11/ai-news-reader-particle-adds-publishing-partners-and-10-9m-in-new-funding) | Clusters one story from many outlets, writes a short AI summary, shows **sources and links directly under the summary**, partners with Reuters, AFP and Fortune; added AI-picked podcast clips in 2026 ([TechCrunch](https://techcrunch.com/2026/02/23/particles-ai-news-app-listens-to-podcasts-for-interesting-clips-so-you-you-dont-have-to/)); optional subscription |
| [Ground News](https://ground.news/rating-system) | Shows how many and which outlets covered a story; "Blindspot" detects stories covered mostly by one side; ratings are averages of three external raters and are explicitly about outlets, not articles |
| [Associated Press standards](https://ds.svcs.associatedpress.com/standards-around-generative-ai) | Generative AI output is "unvetted source material"; no generative alteration of news photography; confidential data never goes into AI tools |

**Adapt (idea 15).** A hub's news desk benefits most from **story clusters**: an editor groups imported items about one event (a new building code, a cement price change, a large tender) into one Trustwork publication that lists every source with its time and link. An agent may draft the summary; the editor publishes it under the existing rule that imported items are never published automatically ([publishing](../engine/publishing.md#hub-sources-proposed)). Show the sources **above the fold**, as Particle does, so the cluster sends readers to the publishers rather than replacing them.

**Adapt.** Ground News's coverage count is useful in construction too, but not as a political bias bar: show **coverage by source type** (official register or regulator, industry media, company press release, own reporting). A cluster built only from press releases should say so.

**Adopt.** AP's rule that AI output is unvetted source material matches Trustwork's untrusted-input rule; write it into the editorial policy template for hubs.

### Labelling, provenance and licences

| Standard | What it gives |
|---|---|
| [C2PA Content Credentials](https://c2pa.org/) with the [IPTC Digital Source Type](https://metawatch.iptc.org/dst/) vocabulary | Signed provenance in image files; `trainedAlgorithmicMedia` for generated images and `compositeWithTrainedAlgorithmicMedia` for edits with generative AI ([IPTC](https://iptc.org/news/tag/synthetic-media)) |
| EU AI Act Article 50 and the **Code of Practice on transparency of AI-generated content** (final June 2026; obligations apply from 2 August 2026) | Providers mark generated content machine-readably; deployers label deepfakes and AI-generated text published to inform the public, with an exception where a human editor takes editorial responsibility ([Commission](https://digital-strategy.ec.europa.eu/en/news/commission-publishes-first-draft-code-practice-marking-and-labelling-ai-generated-content), [Baker McKenzie](https://connectontech.bakermckenzie.com/new-eu-guidance-on-ai-transparency-what-should-companies-be-doing-from-2-august-2026)) |
| [RSL 1.0](https://rslstandard.org/) (Really Simple Licensing, December 2025) | Machine-readable licence terms for AI use of content: permit or deny AI training, AI input or AI indexing; attribution, pay-per-crawl or pay-per-inference ([The Register](https://theregister.com/2025/12/10/really_simple_licensing_spec_takes)) |
| Licensed image generation | Adobe Firefly trained on licensed and public-domain material and offers contractual IP indemnity to enterprise customers ([Computerworld](https://www.computerworld.com/article/1628682/adobe-offers-copyright-indemnification-for-firefly-ai-based-image-app-users.html)) |

**Adopt (idea 15).** None of the launch countries is in the EU, but an open engine should meet the strictest reasonable baseline so any hub can run it: every generated or AI-edited image carries a C2PA manifest and IPTC digital source type; every AI-assisted article shows a reader-visible label that names the responsible human editor; every machine translation is a labelled draft until a named person reviews it (already designed in [multilingual publishing](../engine/publishing.md#multilingual-publishing-proposed); add the label vocabulary and the provenance record).

**Adopt (idea 15).** The [source registry](../engine/publishing.md#hub-sources-proposed) already has separate flags for display, storage, indexing, model egress and syndication. RSL is a ready-made machine-readable form of those same flags: read it when a source publishes it, pre-fill the registry for the editor to confirm (never auto-apply a more permissive reading), and let each hub publish its own content terms in RSL for crawlers.

**Avoid.** Do not ship stock photographs or a default generator whose training data or licence is unknown; ADR 009 already removed third-party photos. If a hub enables image generation, the provider choice, its licence terms and indemnity belong in the hub's model-provider configuration, and no generated image may depict a real, identifiable person or a real site as if it were a photograph.

## 8. Company intelligence and due diligence

| Source | What is obtainable and how | Licence / price |
|---|---|---|
| [OpenCorporates](https://api.opencorporates.com/documentation/Home) | Company records from official registers worldwide, API and bulk | Data under the share-alike **ODbL**; free share-alike keys for open projects that contribute back; paid non-share-alike keys for proprietary use ([terms](https://opencorporates.com/legal-information/self-service-api-terms-of-service/)) |
| [GLEIF](https://www.gleif.org/en/lei-data/gleif-golden-copy/download-the-golden-copy) | Legal Entity Identifiers and parent relationships, Golden Copy three times daily, free API | Open data (CC0 per the [AWS registry entry](https://registry.opendata.aws/lei/)); vLEI credentials issued by qualified issuers |
| Dun & Bradstreet | D-U-N-S number free to request ([D&B](https://www.dnb.com/en-ca/smb/duns/duns-lookup.html)); reports and monitoring paid | Commercial |
| Creditsafe | Credit reports and monitoring | Commercial, sales-led |
| [OpenSanctions](https://www.opensanctions.org/licensing/) | Consolidated sanctions, PEP and debarment data, downloadable | **CC BY-NC 4.0**: commercial use requires a paid licence (API billed per query, flat-rate screening licence, or reseller licence) |
| [US Consolidated Screening List](https://www.trade.gov/print/pdf/node/112) | Eleven US export and sanctions lists with fuzzy name search via the trade.gov API | Free with a developer key (already the engine's baseline adapter) |
| Beneficial ownership | Armenia publishes ownership data in the [Beneficial Ownership Data Standard](https://www.openownership.org/blogs/armenia-and-latvia-become-first-countries-to-publish-data-in-line-with-the-beneficial-ownership-data-standard/); Open Ownership retired its global register and released BODS 0.4 ([Open Ownership](https://www.openownership.org/en/publications/developing-the-worlds-first-transnational-open-beneficial-ownership-register/)) | National terms |
| Court records | CourtListener (US) offers bulk data and API through memberships ([Free Law Project](https://free.law/2026/05/07/api-included-in-memberships/)); Uzbekistan publishes economic-court decisions on the Supreme Court site with conditions on consent and personal-data protection ([Kun.uz](https://beta.kun.uz/en/news/2019/02/06/court-decisions-in-uzbekistan-to-be-placed-on-the-internet)) | Varies; personal data restrictions apply |

**What is legally obtainable, in short.** Official register extracts and public-procurement records are generally public by design, but reuse terms differ per portal and per country, and many contain personal data of officers. Beneficial-ownership data is the clearest warning: the EU Court of Justice ruled in November 2022 that general public access to ownership registers is a serious interference with privacy (joined cases C‑37/20 and C‑601/20) and several states closed access ([eucrim](https://eucrim.eu/news/cjeu-no-unrestricted-access-to-data-of-beneficial-owners/)). Court records carry the same tension. Trustwork's existing rule, a hub operator decides per source with a recorded legal basis and licence flags, is the right one; the engine should make the decision explicit, not easy to skip.

**Adopt (idea 4).** Display **sourced facts** with source, observed time, licence and a link: legal-entity status, LEI, official contractor rating, licence category and expiry. These are cheap to fetch and immediately useful. Keep them visually distinct from claimed and verified data and outside the reputation method.

**Adopt.** OpenSanctions as an *optional* hub list must be configured with its commercial licence where the hub is commercial; the configuration screen should ask "commercial use?" and refuse the non-commercial dataset when the answer is yes. The UN Security Council consolidated list is a free alternative for an additional list.

**Adapt (below the cut).** Creditsafe and D&B sell opaque scores. Trustwork can offer a **due-diligence pack**: a dated, cited report on one counterparty composed only of sourced register facts, verification results the requester is allowed to see, sanctions screening outcome, public procurement history and published reputation with its method version. It is a platform-budget deliverable under the existing `generate_deliverable` action ([agents](../engine/agents.md#what-your-agent-can-do-for-you)), it never includes private data of the subject, and the subject can see that a pack was generated about them only in aggregate (no list of who looked). In the United States the pack must be **company-level only** and must never be offered for decisions about an individual's employment, credit, insurance or housing, otherwise the hub risks becoming a consumer reporting agency under the FCRA; sole proprietors need counsel's review before they are covered at all.

**Adapt.** OpenCorporates's split, free share-alike access for open projects and paid proprietary licences, is a fair model for a hub that wants to offer API access to its **public** directory projection (see [business models](#business-model-options)). It is also a licence-compatibility warning: ODbL data imported into a hub's directory may oblige the hub to share derived databases alike.

**US specifics.** The obtainable US sources for a company-level view are: state licence boards (bulk files in California and Texas, extracts in Florida), Secretary of State business-entity records (state by state; OpenCorporates aggregates many under ODbL), SAM.gov entity registrations and exclusions, USAspending awards, OSHA inspections from the DOL, PACER and CourtListener for federal cases, and the Consolidated Screening List for sanctions. Not obtainable for this purpose: IRS TIN matching (payers only), consumer credit data (FCRA permissible purpose), and anything behind a login.

**Avoid.** Bulk scraping of court portals, debt registers or social media to build risk scores on people. It conflicts with the employee-surveillance ban and with personal-data law, and it is the kind of feature that ends hubs. Court and debt data, if a hub enables it at all, should be **company-level, source-linked, legally reviewed per country and appealable**, with the same review-case flow as a potential sanctions match.

## 9. The AI agents ecosystem

### Protocols

| Protocol | State in October 2026 | Fit for Trustwork |
|---|---|---|
| [Model Context Protocol (MCP)](https://modelcontextprotocol.io/specification/versioning) | Current revision **2026-07-28** replaces the initialization handshake of 2025-11-25 and earlier with per-request version negotiation and a `server/discover` call; donated to the Linux Foundation's Agentic AI Foundation in December 2025 | Tools and data for an assistant; good for a **read-only hub server** and for the engine's own tool adapters |
| [Agent2Agent (A2A)](https://a2a-protocol.org/latest/specification/) | Version **1.0.0** under the Linux Foundation; Agent Card at `/.well-known/agent-card.json`, optionally **signed with JWS over JCS (RFC 8785)**; task states including `input-required`, `auth-required` and `rejected`; extension mechanism | Agent-to-agent tasks across organisations; maps to the representative and to cross-node agent envelopes |
| IBM ACP | Merged into A2A in August 2025; repository archived ([IBM Research](https://research.ibm.com/projects/agent-communication-protocol)) | A reminder that agent protocols churn |
| [AGNTCY](https://docs.agntcy.org) | Linux Foundation project (Cisco and others): Open Agent Schema Framework, federated agent directory, agent identity; indexes A2A cards and MCP server descriptions | Discovery ideas only |
| [Agent Network Protocol (ANP)](https://www.w3.org/2024/01/webevolve-series-events/annual-2025/slides/ai-agent-protocol-cg.pdf) | W3C community group draft; `did:wba` web-hosted DIDs for agents; no named production adopters *(secondary)* | Watch |
| [AP2](https://ap2-protocol.org/) | Open extension for A2A and MCP; **checkout and payment mandates** with "open" (constraints, budget) and "closed" (exact amount and checkout) stages as signed digital credentials; standardisation continuing in FIDO working groups | Vocabulary for agent commitments |

**Adapt (below the cut).** Publish an A2A Agent Card for each **company representative** (never for every person: one assistant per person, no public endpoint for it by default). The card advertises only structured skills that already exist as Trustwork intents (`request_proposal`, `propose`, `clarify`, `schedule_meeting`, `introduce`), points to the node's inbox, and is signed with the node key. Trustwork's agent envelope travels as an A2A extension carrying `refs` with digests and the `mandate_digest`; the free-text part is the untrusted `note`. A2A's signing already uses JCS, the same canonicalisation as `trustwork-digest-1`, which makes the mapping cheap. The A2A task state `input-required` corresponds to an escalation to the human; `auth-required` must never be satisfied by chat text.

**Adopt (below the cut).** A hub MCP server exposing **only the public projection** (search publications, events, companies, open needs; fetch a public record with its citation) gives every participant's own assistant a lawful, attributable way to use the hub. Writes, private data and agent actions stay out of it; it is rate-limited and carries the hub's RSL terms.

**Adapt.** AP2's split between an "open" mandate (constraints and budget for autonomous action) and a "closed" mandate (the exact amount bound to a finalised checkout) mirrors Trustwork's mandate plus digest-bound approval. Borrow the words in the agents chapter so external developers recognise the pattern; do not adopt AP2 payments until hub payment adapters exist.

**Watch.** AGNTCY's federated directory and ANP's DIDs. The mesh directory in [federation](../engine/federation.md) is already "discovery only, not authority"; there is no need for a second identity system while nodes sign with their own keys.

### Agent marketplaces and billing

[AWS Marketplace](https://aws.amazon.com/about-aws/whats-new/2025/07/ai-agents-tools-aws-marketplace) lists agents and MCP tools with free trials, usage-based and contract pricing ([October 2025](https://aws.amazon.com/about-aws/whats-new/2025/10/aws-marketplace-pricing-ai-agents-tools)). Salesforce Agentforce sells **Flex Credits** ($500 per 100,000 credits; a standard action costs 20 credits, about $0.10) alongside per-conversation and per-user models *(secondary: [eesel](https://www.eesel.ai/blog/agentforce-pricing))*.

**Avoid.** An agent marketplace inside the product. Trustwork's rule is one agent per person and at most one representative per company; specialised workers stay invisible ([agents](../engine/agents.md#one-agent-one-surface)).

**Adapt.** Per-action pricing is the most legible way to bill agent work beyond the free trial: a published price per action type, reserved from the **platform budget** before the action and settled from evidence, shown in the run log. It fits the two-budget model and avoids opaque "credits" that hide the real price.

### Model routing and cost control

[OpenRouter](https://openrouter.ai/pricing) routes to many providers at list price and charges a 5.5% fee on credit purchases (8% on Business), supports bring-your-own-key with a free monthly allowance, **zero-data-retention routing on every plan, data-policy-based routing, budgets and per-key credit caps**. [LiteLLM](https://docs.litellm.ai/docs/proxy/virtual_keys.md) is an open-source proxy with virtual keys, per-key and per-team budgets and spend tracking.

**Adapt (idea 13).** Build the routing and caps into the engine as a **model gateway port** with a fake, so a hub can plug any provider (or a self-hosted proxy) without the engine depending on a commercial router:

- route by **data class and hub egress policy** (public, shared-party, private; in-country only; zero retention required), the same matrix the [hub console](../engine/hub-administration.md) already lists;
- a **cost cap per mandate and per run**, reserved from the platform budget before the call, with `outcome_unknown` reconciliation for timeouts;
- a provider allow-list that excludes restricted jurisdictions and sanctioned providers;
- no prompt or response bodies in logs by default; only action, model, tokens, cost and data class.

### Evaluation and guardrails

The [OWASP Top 10 for LLM Applications 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/) keeps prompt injection first and expands "excessive agency"; the OWASP Top 10 for Agentic Applications (December 2025) puts **agent goal hijack** first ([summary](https://cycode.com/blog/owasp-top-10-agentic-applications/)). The UK AI Security Institute's open-source [Inspect](https://pypi.org/project/inspect-ai/0.3.232/) framework ships hundreds of evaluations.

**Adopt (idea 13).** A deterministic **agent safety suite** in this repository, mapped item by item to both OWASP lists: injected instructions in RFQ attachments, counterpart agent notes, imported news and e-mails; attempts to widen a mandate through chat; cross-party leakage of floors and budgets; competitor price relay; loops and budget exhaustion. It runs against the fake model adapter in CI (scripted adversarial outputs) and, when a hub enables a real provider, as an opt-in evaluation whose results the hub can publish. The [retrieval adversarial matrix](../quality/retrieval-evaluation.md) is the template.

## 10. Federation and decentralized networks

| Network | What to borrow | What to avoid |
|---|---|---|
| ActivityPub | Inbox/outbox shape (already borrowed by [ADR 011](../adr/011-federation-mesh.md)); [Ghost 6.0](https://techcrunch.com/2025/08/05/substack-rival-ghost-connects-to-the-open-social-web-with-its-latest-public-release) shows that a publication can federate to Mastodon, Threads and (via a bridge) Bluesky; draft FEPs for [integrity proofs (8b32)](https://w3id.org/fep/8b32) and [portable objects (ef61)](https://fediverse.codeberg.page/fep/fep/ef61/) | Using it for commercial objects; FEP-8b32 proofs become unverifiable after key rotation, a known open issue |
| AT Protocol (Bluesky) | **Labelers**: moderation and other labels are separate signed objects from separate services, and clients choose which labelers to trust ([atproto](https://atproto.com/guides/moderation)); **trusted verifiers**: named organisations issue verification marks, and users can see who verified whom ([Bluesky, 21 Apr 2025](https://bsky.social/about/blog/04-21-2025-verification)) | Global relay and AppView scale assumptions; a single dominant client |
| Matrix | Room versions with explicit, versioned state resolution; spec 1.16 changed the algorithm to reduce "state resets" ([changelog](https://spec.matrix.org/v1.19/changelog/v1.16/checklist.md)) | Replicating full conversation history to every server |

**Adapt (idea 2).** Make every verification badge a **signed attestation** issued by the node that ran the recipe: subject global identifier, evidence categories, recipe version, issued and expiry dates, node key id. This is Bluesky's "who verified this" made cryptographic and federated, and it fits ADR 011's rule that a peer shows a badge "only at `trust-verifications` level and labels it as granted elsewhere". The same object shape works as a W3C Verifiable Credential later, and can reference a GLEIF LEI or vLEI where one exists.

**Adapt.** Bluesky's labelers suggest that **moderation decisions and content labels are objects of their own**, issued by a node and attached to someone else's object without changing it. ADR 011 already says moderation is local; recording it as signed, optionally shareable labels lets a city hub follow its country hub's spam labels without obeying them.

**Adopt.** Matrix's lesson is to **version the merge algorithm**: entity links, tombstone handling and replica conflict rules should carry a method version from day one, like reputation does.

**Adapt (below the cut).** An outbound-only ActivityPub actor per hub for publications, magazine issues and public events turns every federated social account into a potential reader without building a separate social network. Replies and follows from the fediverse are not imported into Trustwork in the first version (no comment ingestion, no inbox of untrusted social content). This resolves the open question in [federation](../engine/federation.md#open-questions) in its least risky form.

## 11. Events and learning

| Service | What they do well | Business model |
|---|---|---|
| Eventbrite | Discovery, ticketing at scale | US service fee 3.7% + $1.79 per paid ticket plus 2.9% processing; free events free *(secondary: [Ticket Tailor](https://www.tickettailor.com/eventbrite-fees-and-cost))* |
| [Luma](https://help.luma.com/p/luma-plus) | Beautiful community calendars, newsletters to attendees | 5% platform fee on paid tickets, or a subscription (about $59/month annually) for 0% platform fee; card processing extra |
| [Brella](https://www.brella.io/company-information) | Intent-based matchmaking: attendees declare what they offer and seek, meetings booked into slots | Organiser licences |
| [Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0) | Each achievement is a signed **W3C Verifiable Credential (Data Model 2.0)**; self-contained, verifiable without the issuer's server | Open standard; 1EdTech certification for conformance |
| Coursera, LinkedIn Learning | Certificate pages with a verification URL and one-click "add to profile" on LinkedIn ([Coursera blog](https://blog.coursera.org/add-coursera-accomplishments-to-your-linkedin)) | Subscriptions, enterprise licences |

**US events.** The largest US gatherings (CONEXPO-CON/AGG, World of Concrete, the International Builders' Show, regional "Build" expos) already sell exhibitor space and run matchmaking apps. A US hub adds value by listing them with links, running **partner meetings around** them (the meeting profiles and slots already designed) and hosting smaller local events: site visits, code-change briefings, manufacturer training with continuing-education credit.

**Adopt.** Luma's choice between a percentage fee and a flat subscription is fair to both small and frequent organisers; offer both as price versions in the hub's event marketplace settings ([events](../engine/events.md)). Publish the full fee breakdown on the checkout page, including processing, as Eventbrite's critics demand.

**Adopt.** Brella confirms the design of [partner meetings at events](../engine/events.md#partner-meetings-at-events-proposed): declared intent, slots, mutual acceptance. Two additions are worth a small design note: a **slot optimiser** that proposes a feasible personal schedule, and a **post-event follow-up** that turns accepted meetings into introductions only with both sides' consent.

**Adopt (idea 2).** Issue every Trustwork certificate also as an **Open Badges 3.0 credential** signed by the hub's node key, keep the existing public check page, and add an "add to profile" link (a plain URL, no tracking pixel). The credential states what the [learning chapter](../engine/learning.md#honest-about-what-a-certificate-means) already says: completion of a course, not a state qualification; accreditation appears only where recorded with its source.

**Avoid.** Selling attendee lists to sponsors. Sponsors at a Trustwork event get labelled visibility and the meetings attendees choose to accept, never contact exports.


## Differentiators: what makes Trustwork uniquely better

1. **From a plan to the right people.** No US platform starts from the person's own plan and turns each step into the right object (consultation, need, RFQ, purchase, permit task) with an agent that works under the person's mandate. Lead marketplaces start from a form and sell it; PM suites start once the contractor is hired.
2. **Money never touches rank.** Directories, matching, search, reputation and badges are provably independent of payment. Houzz ties an award to paid tools, Home Depot ties leads to purchase points, lead marketplaces sell the same request repeatedly, and manufacturer tiers depend on volume.
3. **Reputation the participant builds and owns.** Evidence from real agreements and acceptances, attestations only from counterparties, explainable snapshots, disputes instead of deletions, export as signed credentials. Not endorsements from strangers, not reviews anyone can post, not a score that can be bought.
4. **Three kinds of truth, always labelled.** Sourced (state licence board, SAM.gov, OSHA, awards), claimed and verified are visually and semantically separate. Public signals are shown with attribution instead of being replaced by a proprietary score.
5. **Getting paid with evidence.** Payment milestones, retainage and lien waivers tied to digest-bound agreements and acceptance records, so both sides' payment behaviour becomes fair, explainable reputation.
6. **Free for the people who do the work.** Subcontractors keep one prequalification passport and share it by consent instead of paying each network; replying to an RFQ or accepting an introduction is always free.
7. **A lifelong professional identity in construction**, in English and Spanish, owned by the person and surviving employers, with portable work history and credentials.
8. **Agents with real accountability.** Structured, revocable mandates, digest-bound approvals, two budget kinds, reconciliation of unknown outcomes, and a named accountable person for a company representative.
9. **Immutable commercial versions.** Sent quotes and published RFQ versions never change; acceptance binds digests on both sides, even across hubs.
10. **Knowledge that stays with its authors.** Diaries, templates and expert answers published under the author's chosen licence, linked to real projects, with private data removed.
11. **Open, federated and locally owned.** AGPL engine, country packs as reviewed data, hubs run by local operators under local law, a mesh without a central authority. The same engine that runs the US reference hub runs a city hub in Samarkand.
12. **Privacy as an engineering property.** Projections on every read, search hit, export, notification and federation envelope; staff need a time-limited case grant; no "who viewed your profile"; designed with CCPA-style rights and data-broker rules in mind.

## Business-model options

### For hubs, with the US reference hub as the default example

All options respect the free minimum participation in [billing](../engine/billing.md) and the rule that payment never changes ranking, matching, reputation or badges. Prices are in the hub currency (USD for the reference hub) as versioned price versions.

| Option | How it works | Precedent | Fit |
|---|---|---|---|
| Capacity subscriptions for companies | More active projects, plan templates, open RFQs, team workspaces, integrations; unlimited people; never more visibility | Procore (volume, not seats), Fieldwire tiers | Good |
| Payments orchestration fee | A small published fee on staged payments processed through the hub's licensed payment partner, disclosed before each payment; ACH preferred | Procore Pay, Upwork, Block Renovation | Good, PAY-001; never a hidden spread |
| Consultations and mentoring marketplace | Published commission on paid consultations and mentoring; free consultations allowed; no negative-option memberships | Clarity.fm, MentorCruise; contrast JustAnswer | Good, CONS-001 |
| Agent work beyond the trial | Published per-action prices reserved from the platform budget | Agentforce Flex Credits | Good |
| Deliverables | Company-level due-diligence packs, prequalification exports, plan and estimate reports | Creditsafe, TradeTapp | Good |
| Event and training marketplace | Percentage fee or flat organiser subscription; manufacturer training with continuing-education credit listed free | Luma, Eventbrite, Simpson Strong-Tie | Good |
| Verification at cost | Cost-recovery fee for manual review (for example insurance confirmation with a broker); same price for all; waivable; never bundled with a plan | Contrast: IndiaMART, ISNetworld | Acceptable with guard rails |
| Labelled sponsorship | Event and newsletter sponsorship, manufacturer-sponsored training, always labelled, never in directories, matching, plan suggestions or search | Trade media | Acceptable with guard rails |
| Public-data API licences | Free for open projects under share-alike; paid proprietary licences for commercial reuse of the **public** projection only | OpenCorporates | Optional; legal review needed |

Not acceptable: per-lead fees, paid ranking or "featured" directory slots, paid badges or awards tied to buying tools, lead access paid with purchase points, selling attendee, profile-view or worker data, advertising targeted with private data, negative-option subscriptions.

### For Contribuddha

| Option | Notes |
|---|---|
| The US reference hub | Contribuddha's own hub on the engine, competing on equal terms with any other operator; its revenue follows the hub options above |
| Hub launch services | Configuration, country and state pack contributions, register and procurement adapters, legal-template coordination with local counsel (not legal advice), federation set-up; already offered in [hubs](../engine/hubs.md#help-with-launching) |
| Managed hosting for operators | Per-node hosting in jurisdictions that fit each hub's data-residency decision; never in or for restricted places |
| Support and SLAs | Upgrades, security patches, incident response |
| Conformance programme | A public test suite a node passes to call itself "Trustwork-compatible" in the mesh directory; certifies protocol conformance, never data quality or legal compliance |
| Custom adapters and packs | Paid development (payment and escrow partners, state licence boards, accounting), contributed upstream under AGPL |
| Training | Courses for hub editors, trust reviewers and operators |

Licensing note: the engine is AGPL-3.0-only with DCO sign-off and no contributor licence agreement, so dual licensing of contributors' code is not available; revenue has to come from services, hosting and hubs, not from proprietary licences of the engine.

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Holding or moving money (US) | Escrow and money-transmission laws (for example California's Escrow Law covering internet escrow) | Trustwork never holds funds; licensed payment or escrow providers behind adapters; the hub records the provider's licences |
| Lien-law mistakes (US) | Statutory waiver forms; unconditional waivers bind even if payment fails | State forms as reviewed pack data; unconditional waivers released only against cleared-payment evidence; "information, not legal advice" |
| FCRA and data-broker exposure (US) | Work history or due-diligence data used for decisions about individuals; importing personal data of people with no relationship | Company-level packs; person-controlled history; no sale of personal data; DROP readiness checklist for hubs that might qualify as data brokers |
| Review and endorsement law (US) | FTC fake-review rule; Vermont v. Angi on "certified" | Attestations only from recorded counterparties; no incentives or gating; fixed badge vocabulary reviewed by counsel |
| Subscription traps (US) | FTC v. JustAnswer | Clear recurring price before purchase; cancel online as easily as joining |
| Texting and messaging law (US) | 10DLC registration, TCPA consent | Channel grants per person; marketing texts off by default; registered sender identity per hub |
| Manufacturer content and copyright | Copyright in guides, photos and videos; terms of service | Facts plus links; licences or manufacturer feeds for full content; robots.txt and RSL honoured; DMCA agent and takedowns |
| Proprietary taxonomies | MasterFormat, UniFormat and OmniClass need licences to embed | Open plan-step taxonomy with crosswalks only where licensed |
| Building codes | Copyrighted model codes; liability for compliance answers | Cite and link; never host code text without licence; never present answers as compliance determinations |
| Source terms and personal data in registers | Officer and licensee names, court records and permits contain personal data; reuse terms differ per portal | Per-source legal basis and licence flags; company-level facts first; appeal flow; no bulk person-level enrichment |
| Licence contamination | OpenSanctions non-commercial without a paid licence; OpenCorporates ODbL share-alike | Licence field on every source; console refuses commercial use of non-commercial data |
| Government data disputes | An official rating or record may be wrong | Show as sourced, dated, linked; never blend into reputation; let companies add a public note with evidence |
| AI labelling rules | EU Article 50 from August 2026; US state laws on AI disclosure are emerging | Labels and provenance built in, not optional |
| Agent liability and authority | Who is bound by an agent's commitment (O12); ESIGN/UETA attribution rules | Commitments only with structured mandates, budgets and approvals; representative always names an accountable person |
| Protocol churn | ACP merged into A2A within months; MCP replaced its handshake in 2026 | Trustwork contracts canonical; external protocols as adapters with version pins and conformance tests |
| Prompt injection through channels and federation | SMS, WhatsApp, voice notes, counterpart agent notes and imported pages are attack surfaces (OWASP ASI01) | Untrusted-content rule, structured intents only, safety suite in CI, hub kill switch |
| Cold start | A gathering point without content and companies is empty; faking activity is forbidden | Content first (manufacturer guides, news, public opportunities), honest sourced directory, events and training, the plan journey for homeowners |
| Competition law | Pooled price benchmarks and agent negotiations can facilitate collusion | Public-data benchmarks and minimum group sizes; no relay of one seller's prices to another |
| Secondary-source facts | Several numbers in this document come from third-party sites | Re-verify against primary sources before any public claim or pack fact |

## Proposed work packages

**Merged on 2026-10-31** into [work-packages.json](../engine/work-packages.json) by [ADR 012](../adr/012-integrator-decisions-2026-10-31.md): this section's PAY-001 became PAY-002, AGT-002 became AGT-016 and AGT-017, I18N-001 became LANG-ES, CNT-002 was folded into EDIT-001 and CRED-001 into REP-002; the others kept their identifiers. The text below is kept as the original proposal.

These are proposals in the exact shape of [work-packages.json](../engine/work-packages.json); they are **not** added to the task graph. A maintainer decides whether to add, merge into existing packages (for example HUB-003, MATCH-001 or EXE-001) or reject each one. Dependencies refer to existing package IDs or to other proposals in this list; the list was checked with the repository's own validator (schema, dependencies, cycles, handbook links) merged into a copy of the task graph. A US country pack is expected from separate work and is not proposed here.

```json
[
  {
    "id": "PLAN-001",
    "title": "Plan to people: project plans that turn into consultations, needs, RFQs and tasks",
    "area": "projects",
    "status": "open",
    "dependsOn": [
      "AGT-001",
      "MATCH-001",
      "COM-001"
    ],
    "handbook": "docs/engine/projects.md",
    "goal": "Let a person turn a project goal into an editable plan whose steps (from the open plan-step taxonomy) become consultations, open needs, RFQs, catalogue purchases, permit tasks or self-done steps, with the agent drafting and the person deciding.",
    "read": [
      "docs/engine/projects.md",
      "docs/engine/agents.md",
      "docs/engine/partners-and-matching.md",
      "docs/engine/commerce.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define plan, plan-step and step-outcome contracts keyed by the plan-step taxonomy; plans are owner_private by default.",
      "Publish the open plan-step taxonomy (CC0) with predecessors, permit questions per pack and crosswalks to IFC and ETIM; proprietary crosswalks only as hub-licensed data.",
      "Let the agent draft a plan and propose objects per step under the person's mandate; nothing is published or sent without an explicit act.",
      "Show which steps a state requires a licensed professional for, from the country pack."
    ],
    "acceptance": [
      "A plan and its unpublished steps never appear in search, notifications, other parties' views or federation (negative tests).",
      "Publishing a need from a step respects the consented fan-out of MATCH-002.",
      "The engine works without any proprietary classification licence."
    ],
    "paths": [
      "packages/contracts/src/plans.ts",
      "apps/api/src/modules/plans",
      "tests/plans"
    ]
  },
  {
    "id": "REP-001",
    "title": "Reputation builder: evidence wallet, counterparty attestations and explainable profile",
    "area": "execution-trust",
    "status": "open",
    "dependsOn": [
      "EXE-001",
      "CRED-001",
      "REG-001"
    ],
    "handbook": "docs/engine/execution-and-reputation.md",
    "goal": "Give every person and company tools to build and confirm their own reputation from evidence: a wallet of sourced, claimed and verified items, structured attestations from counterparties after accepted work, imported past projects confirmed by former clients, public responses and disputes, never paid and never surveillance.",
    "read": [
      "docs/engine/execution-and-reputation.md",
      "docs/engine/people-and-companies.md",
      "docs/engine/learning.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define evidence-wallet items with status (sourced, claimed, verified), issuer, expiry and visibility per field.",
      "Allow attestations only from parties of an accepted agreement or a closed project; block employees and relatives of the subject; no incentives.",
      "Let a participant invite a former client to confirm a past project; evidence exists only after confirmation.",
      "Show snapshot dimensions with sample sizes, method version, exclusions, disputes and one public response per item; export items as credentials through CRED-001."
    ],
    "acceptance": [
      "An attestation without a recorded relationship is rejected (negative test).",
      "No entitlement, payment or staff action changes a snapshot (comparison test).",
      "No input comes from activity tracking or per-employee metrics.",
      "A negative attestation can be disputed but never removed for payment."
    ],
    "paths": [
      "packages/contracts/src/reputation-builder.ts",
      "apps/api/src/modules/reputation",
      "tests/reputation"
    ]
  },
  {
    "id": "PAY-001",
    "title": "Getting paid: pay applications, retainage, lien waivers and payment-timeliness evidence",
    "area": "commerce-backend",
    "status": "open",
    "dependsOn": [
      "COM-001",
      "BILL-001",
      "EXE-001"
    ],
    "handbook": "docs/engine/commerce.md",
    "goal": "Model payment milestones and pay applications under agreements, retainage with release conditions, statutory lien-waiver exchange bound to actual payments, prompt-payment reminders from pack facts, and payment-timeliness evidence for both sides, with funds handled only by licensed providers.",
    "read": [
      "docs/engine/commerce.md",
      "docs/engine/billing.md",
      "docs/engine/execution-and-reputation.md",
      "docs/engine/country-specifics.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define pay application, retainage ledger, lien-waiver (conditional or unconditional, progress or final) and payment-event contracts bound by digest to agreement versions.",
      "Store statutory waiver templates and retainage and prompt-payment facts per state as reviewed pack data.",
      "Integrate a payment and escrow port with a fake; Trustwork never holds funds; outcome_unknown goes to reconciliation.",
      "Release an unconditional waiver only against cleared-payment evidence; record due and paid dates as evidence for both parties' timing dimension."
    ],
    "acceptance": [
      "An unconditional waiver cannot be issued before cleared-payment evidence (test).",
      "Concurrent payment releases cannot exceed the milestone amount or the remaining retainage.",
      "Financing partners, if shown, are labelled and never change ranking or reputation."
    ],
    "paths": [
      "packages/contracts/src/payments.ts",
      "apps/api/src/modules/payments",
      "tests/payments"
    ]
  },
  {
    "id": "REG-001",
    "title": "Show public-register and licence-board facts as sourced records",
    "area": "verification",
    "status": "open",
    "dependsOn": [
      "HUB-003",
      "CTRY-002"
    ],
    "handbook": "docs/engine/hub-administration.md",
    "goal": "Display licence status from state boards (CSLB, TDLR, DBPR files for the US reference hub), business-entity status, SAM.gov registration and exclusion status, OSHA inspections, LEI and, in other countries, official ratings such as reyting.mc.uz, each with source, observed time, licence and link, never blended into Trustwork reputation.",
    "read": [
      "docs/product/specification.md",
      "docs/engine/hub-administration.md",
      "docs/engine/country-specifics.md",
      "docs/engine/execution-and-reputation.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define a sourced-fact contract: subject, fact kind, value, source id, licence flags, observed_at, valid_until, link.",
      "Add register-fact adapters with deterministic fakes for one US licence-board file, SAM.gov entity status, DOL OSHA inspections and GLEIF LEI; live mode disabled by default and behind second-person activation.",
      "Link facts to companies only through identifiers from the country pack (licence number, UEI, EIN never displayed), never by name alone.",
      "Render sourced facts with a distinct treatment and a \"how this is sourced\" explanation in every locale; let the company attach a public note with evidence."
    ],
    "acceptance": [
      "Sourced facts never change a reputation snapshot (test compares snapshots with and without facts).",
      "A fact without a licence flag permitting display is not shown.",
      "Expired facts are labelled stale and trigger a re-fetch per source cadence.",
      "Wording never claims \"certified\" or \"licensed by Trustwork\"; a licence fact reads as observed at the board on a date."
    ],
    "paths": [
      "packages/contracts/src/sourced-facts.ts",
      "apps/api/src/modules/registers",
      "tests/registers"
    ]
  },
  {
    "id": "PREQ-001",
    "title": "Prequalification passport shared by consent",
    "area": "verification",
    "status": "open",
    "dependsOn": [
      "REG-001",
      "HUB-003"
    ],
    "handbook": "docs/engine/hub-administration.md",
    "goal": "Let a company keep one prequalification passport (licences, insurance certificates with expiry reminders, bonding capacity, safety record, references, financial summary) and share a chosen subset with a client by consent and for a limited time, free for subcontractors.",
    "read": [
      "docs/engine/hub-administration.md",
      "docs/engine/people-and-companies.md",
      "docs/engine/partners-and-matching.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define passport sections with sourced, claimed and verified status per item and expiry.",
      "Collect insurance certificates as claimed documents and confirm them with the issuer where the hub configures a recipe; remind before expiry.",
      "Share by consent grants with scope, recipient and expiry; revocation stops access immediately.",
      "Map passport items to eligibility checks used by matching and RFQs."
    ],
    "acceptance": [
      "A client sees only the sections granted, only until expiry (negative tests).",
      "Self-declared items such as EMR are labelled claimed until a document is reviewed.",
      "Subcontractors are never charged to hold or share a passport."
    ],
    "paths": [
      "apps/api/src/modules/prequalification",
      "tests/prequalification"
    ]
  },
  {
    "id": "PROC-001",
    "title": "Public opportunities and awards: open needs, bid calendar, sourced track record and civic view",
    "area": "matching",
    "status": "open",
    "dependsOn": [
      "SRC-001",
      "MATCH-001",
      "REG-001"
    ],
    "handbook": "docs/engine/partners-and-matching.md",
    "goal": "Import public opportunities (SAM.gov for the US reference hub, state and municipal portals where terms permit, OCDS elsewhere) as read-only open needs, show a bid calendar, record awards (USAspending, OCDS) as sourced project history, and offer an opt-in civic view of public spending.",
    "read": [
      "docs/engine/partners-and-matching.md",
      "docs/engine/country-specifics.md",
      "docs/engine/projects.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Map SAM.gov notices, USAspending awards and OCDS releases to open-need and sourced-project contracts.",
      "Implement importers with fakes; record each portal's reuse terms; SAM.gov keys only in the secret store.",
      "Link awards to companies only through identifiers (UEI, registration numbers from the pack), never by name alone.",
      "Add a bid calendar of deadlines for needs a participant follows, and an opt-in hub view of public awards by category and place with method and sample size."
    ],
    "acceptance": [
      "Imported needs cannot receive Trustwork RFQ responses unless the owner is a platform participant who published them.",
      "Awards linked by name only are rejected.",
      "Statistics use only public award data; no private quote or budget enters them."
    ],
    "paths": [
      "packages/contracts/src/public-procurement.ts",
      "apps/api/src/modules/public-procurement",
      "tests/public-procurement"
    ]
  },
  {
    "id": "MATCH-002",
    "title": "Lead honesty: consented fan-out for private-client needs and no per-lead charging",
    "area": "matching",
    "status": "open",
    "dependsOn": [
      "MATCH-001",
      "BILL-001"
    ],
    "handbook": "docs/engine/partners-and-matching.md",
    "goal": "Guarantee that a private client's need reaches only providers the client chose or consented to, under a hub-configured cap, and that no price version can charge per lead, introduction or received RFQ.",
    "read": [
      "docs/engine/partners-and-matching.md",
      "docs/engine/billing.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Add a fan-out cap and explicit consent record to private-client needs.",
      "Reject offer and price-version definitions whose billable unit is a lead, introduction or received RFQ.",
      "Record need outcomes (filled, cancelled, postponed) so the board stays honest; show the client how many providers saw the need."
    ],
    "acceptance": [
      "A need is never delivered to more providers than the client consented to (concurrency test).",
      "Billing schema rejects per-lead units.",
      "Providers never see other providers' responses."
    ],
    "paths": [
      "apps/api/src/modules/matching",
      "tests/matching/lead-honesty"
    ]
  },
  {
    "id": "BIZ-001",
    "title": "Hub business-model playbook and published price-transparency page",
    "area": "billing",
    "status": "open",
    "dependsOn": [],
    "handbook": "docs/engine/billing.md",
    "goal": "Document the acceptable and forbidden revenue options for hubs and add a public price page design that lists every active price version, fee and what payment never buys.",
    "read": [
      "docs/engine/billing.md",
      "docs/engine/hubs.md",
      "docs/engine/vision.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Write the playbook section in the billing chapter: capacity subscriptions, per-action agent pricing, deliverables, event and course marketplaces, verification at cost, labelled sponsorship.",
      "List forbidden models: per-lead fees, paid ranking, paid badges, selling attendee or profile-view data.",
      "Design the public price page contract and its empty and error states."
    ],
    "acceptance": [
      "Every option names the invariant that keeps payment away from ranking.",
      "npm run validate:docs passes.",
      "Owner or maintainer review recorded before status changes."
    ],
    "paths": [
      "docs/engine/billing.md",
      "docs/engine/hubs.md"
    ]
  },
  {
    "id": "CONS-001",
    "title": "Expert consultations and mentoring as scoped, priced or free objects",
    "area": "matching",
    "status": "open",
    "dependsOn": [
      "PLAN-001",
      "BILL-001",
      "MATCH-001"
    ],
    "handbook": "docs/engine/partners-and-matching.md",
    "goal": "Let people book consultations (call, written review, site visit) and mentoring series with experts: scope, duration, price or free, schedule, deliverable, cancellation and refund terms, and the deliverable's licence, paid only through a licensed payment adapter.",
    "read": [
      "docs/engine/partners-and-matching.md",
      "docs/engine/billing.md",
      "docs/engine/events.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define consultation offer, booking, deliverable and refund contracts with immutable sent versions.",
      "Integrate scheduling and calendar files; reminders through the person's channel grants.",
      "Charge through the payment adapter with the full price and any recurring terms shown before confirmation; one-click cancellation for series.",
      "Let a plan step open a consultation request and attach its deliverable to the step."
    ],
    "acceptance": [
      "No recurring charge exists without an explicit, separately confirmed recurring term (test).",
      "Paid status never changes an expert's rank in matching (ranking comparison test).",
      "Deliverables are visible only to the parties unless the author publishes them."
    ],
    "paths": [
      "apps/api/src/modules/consultations",
      "tests/consultations"
    ]
  },
  {
    "id": "FIELD-001",
    "title": "Field evidence objects: RFIs, submittals, change orders, daily logs, punch lists and photos",
    "area": "execution-trust",
    "status": "open",
    "dependsOn": [
      "EXE-001"
    ],
    "handbook": "docs/engine/execution-and-reputation.md",
    "goal": "Add versioned field records that matter as evidence (RFIs and answers, submittals and reviews, change orders, daily logs, punch lists, timestamped photos) so fair timing and reputation rest on what happened on site.",
    "read": [
      "docs/engine/execution-and-reputation.md",
      "docs/engine/projects.md",
      "docs/engine/trust-safety-privacy.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define the record contracts with immutable versions, authorship, project participation and digests.",
      "Link change orders to agreement amendments and RFIs to delay attribution.",
      "Store photos with capture time and optional location; strip location and faces from any public projection.",
      "Allow import from Procore and CSV for one's own projects through INTEG-001."
    ],
    "acceptance": [
      "Records are visible only to project participants with the right capability (negative tests).",
      "Daily logs carry no per-worker productivity fields.",
      "Public views never include photo location metadata."
    ],
    "paths": [
      "packages/contracts/src/field.ts",
      "apps/api/src/modules/field",
      "tests/field"
    ]
  },
  {
    "id": "CHAN-001",
    "title": "Field-first channels: SMS, WhatsApp, voice notes and offline mobile web",
    "area": "communications",
    "status": "open",
    "dependsOn": [
      "AST-001"
    ],
    "handbook": "docs/engine/communications.md",
    "goal": "Let a person reach their own agent and their project threads by SMS, WhatsApp or Telegram and voice notes under per-channel grants, and let crews read plans, punch lists and schedules offline on mobile web.",
    "read": [
      "docs/engine/communications.md",
      "docs/engine/agents.md",
      "docs/engine/trust-safety-privacy.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define channel grants per person and context; adapters with fakes for SMS and WhatsApp; hub sender identity with registration data (10DLC) in hub configuration.",
      "Treat inbound text and transcribed voice as untrusted input; any action needs a structured confirmation.",
      "Add an offline-capable cache for read and draft on mobile web with conflict-safe sync of drafts.",
      "Respect consent and quiet hours; marketing messages off by default."
    ],
    "acceptance": [
      "No external effect follows from inbound message text alone (injection tests).",
      "Messages are sent only on channels the person granted.",
      "Offline drafts never overwrite newer server versions silently."
    ],
    "paths": [
      "apps/api/src/modules/channels",
      "tests/channels"
    ]
  },
  {
    "id": "I18N-001",
    "title": "Spanish (es-US) locale for the US reference hub",
    "area": "international",
    "status": "open",
    "dependsOn": [
      "INTL-002"
    ],
    "handbook": "docs/engine/localization.md",
    "goal": "Add Spanish as an engine language with US conventions so field crews and Spanish-speaking clients can use the whole product, including demo content.",
    "read": [
      "docs/engine/localization.md",
      "docs/oss/BRAND.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Add es-US dictionaries for every key with English fallback and missing-key tests.",
      "Translate demo content strings and verify Intl formatting for dates, numbers and USD.",
      "Record that translations await native-speaker review."
    ],
    "acceptance": [
      "No missing keys in es-US.",
      "The brand reads Trustwork in Spanish.",
      "Screenshots in Spanish at desktop and phone width attached to the pull request."
    ],
    "paths": [
      "packages/ui/locales/es-US.json",
      "apps/web/app/_lib/locales/es-US.json"
    ]
  },
  {
    "id": "KNOW-001",
    "title": "Shared knowledge: project diaries, plan templates and expert answers under author licences",
    "area": "content-magazine",
    "status": "open",
    "dependsOn": [
      "CNT-001",
      "PLAN-001"
    ],
    "handbook": "docs/engine/publishing.md",
    "goal": "Let authors turn completed projects into diaries and reusable plan templates and answer questions as experts, published under a licence the author chooses, with private data removed and other people's consent recorded.",
    "read": [
      "docs/engine/publishing.md",
      "docs/engine/learning.md",
      "docs/engine/projects.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Add publication formats for project diary, plan template and expert answer, linked to the source project version.",
      "Add a licence field per publication (for example CC BY-SA 4.0, CC BY 4.0, all rights reserved) shown to readers and carried in federation.",
      "Add a redaction step that removes addresses, prices, faces and names of people who did not consent before publication.",
      "Let a person start a new plan from a published template with attribution."
    ],
    "acceptance": [
      "Nothing from a private project is published without the author's publish act and recorded consents (test).",
      "The licence travels with every copy, replica and export.",
      "Templates keep a link to their source and author."
    ],
    "paths": [
      "apps/api/src/modules/content",
      "tests/content/knowledge"
    ]
  },
  {
    "id": "HOME-001",
    "title": "Homeowner journey and home passport",
    "area": "projects",
    "status": "open",
    "dependsOn": [
      "PLAN-001",
      "PAY-001",
      "FIELD-001",
      "MATCH-002"
    ],
    "handbook": "docs/engine/projects.md",
    "goal": "Give private clients a guided path from photos and a goal to a plan, consented matching and staged payments, and at completion a home passport (what was installed, by whom, warranties, documents) with maintenance reminders, structured warranty claims and transfer on sale.",
    "read": [
      "docs/engine/projects.md",
      "docs/engine/partners-and-matching.md",
      "docs/engine/commerce.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define home passport, installed item, warranty and warranty-claim contracts owned by the homeowner.",
      "Turn photos and a goal into an agent-drafted plan with budget ranges labelled as estimates with their sources.",
      "Fill the passport from accepted deliveries and field records; remind before maintenance and warranty deadlines.",
      "Transfer the passport to a new owner only with the current owner's consent; contractors keep their own evidence copies."
    ],
    "acceptance": [
      "Home passports are owner_private and never federate (negative tests).",
      "Warranty claims reach only the contractor named on the installed item.",
      "Estimates always show their sources and the word estimate."
    ],
    "paths": [
      "packages/contracts/src/home-passport.ts",
      "apps/api/src/modules/home",
      "tests/home"
    ]
  },
  {
    "id": "LLM-001",
    "title": "Model gateway with egress-policy routing and per-mandate cost caps",
    "area": "assistant",
    "status": "open",
    "dependsOn": [
      "AST-001",
      "BILL-001",
      "HUB-001"
    ],
    "handbook": "docs/engine/agents.md",
    "goal": "Provide one model port that routes every call by data class and hub egress policy, reserves cost from the platform budget per mandate and run, and logs metadata without bodies.",
    "read": [
      "docs/engine/agents.md",
      "docs/engine/hub-administration.md",
      "docs/engine/billing.md",
      "docs/adr/007-hybrid-retrieval.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define the gateway contract: data class, allowed providers, retention requirement, residency, cost estimate, reservation id.",
      "Implement a deterministic fake provider and a generic HTTP adapter disabled by default.",
      "Reserve, settle or release platform budget per call; timeouts become outcome_unknown and go to reconciliation.",
      "Exclude providers in restricted jurisdictions at configuration time."
    ],
    "acceptance": [
      "A private-class call to a provider not allowed for that class is refused (negative test).",
      "Concurrent calls cannot exceed a mandate's cost cap.",
      "Logs contain no prompt or response bodies by default."
    ],
    "paths": [
      "packages/contracts/src/models.ts",
      "apps/api/src/modules/models",
      "tests/models"
    ]
  },
  {
    "id": "EVAL-001",
    "title": "Agent safety evaluation suite mapped to OWASP LLM and Agentic Top 10",
    "area": "qa-security",
    "status": "open",
    "dependsOn": [
      "AST-001"
    ],
    "handbook": "docs/engine/trust-safety-privacy.md",
    "goal": "Run deterministic adversarial scenarios against the agent runtime in CI and publish a per-release report mapped to OWASP LLM Top 10 2025 and Agentic Top 10 2026.",
    "read": [
      "docs/engine/agents.md",
      "docs/engine/trust-safety-privacy.md",
      "docs/quality/retrieval-evaluation.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Write scenarios: injected instructions in attachments, imported news, e-mail and counterpart agent notes; mandate widening through chat; floor and budget leakage; competitor price relay; negotiation loops; budget exhaustion.",
      "Script adversarial model outputs through the fake adapter.",
      "Produce a machine-readable report with OWASP item mapping."
    ],
    "acceptance": [
      "Every OWASP item applicable to the engine has at least one scenario or a written reason why not.",
      "No scenario produces an external effect without a valid mandate and approval.",
      "The suite runs in npm run check without network access."
    ],
    "paths": [
      "tests/agent-safety"
    ]
  },
  {
    "id": "INTEG-001",
    "title": "Integrations: public API, webhooks, CSV import, calendars and accounting adapters",
    "area": "backend",
    "status": "open",
    "dependsOn": [
      "BE-001"
    ],
    "handbook": "docs/engine/architecture.md",
    "goal": "Let participants and hubs connect Trustwork to their tools: a documented public API over the public projection and one's own data with OAuth, signed webhooks, calendar feeds, CSV import of one's own contacts and projects, and adapters for QuickBooks Online, Xero and Procore import.",
    "read": [
      "docs/engine/architecture.md",
      "docs/architecture/api.md",
      "docs/engine/trust-safety-privacy.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Publish API scopes that map to projections; issue OAuth clients per participant and per hub.",
      "Implement signed webhooks with replay protection and per-subscriber delivery logs.",
      "Import CSV as the importer's private contacts or projects; never create directory members or claims.",
      "Add accounting and Procore adapters with fakes; meter and show external API usage costs to the hub."
    ],
    "acceptance": [
      "API tokens never read beyond their projection scopes (negative tests).",
      "CSV import never creates a public company or person record (test).",
      "Webhook signatures verify and replays are rejected."
    ],
    "paths": [
      "apps/api/src/modules/integrations",
      "tests/integrations"
    ]
  },
  {
    "id": "SRC-001",
    "title": "Hub source registry with machine-readable licence terms",
    "area": "content-sources",
    "status": "open",
    "dependsOn": [
      "HUB-001",
      "CNT-001"
    ],
    "handbook": "docs/engine/publishing.md",
    "goal": "Implement the proposed hub source registry with separate licence flags (display, store, index, model egress, syndicate) and read RSL 1.0 terms where a source publishes them, as suggestions an editor confirms.",
    "read": [
      "docs/engine/publishing.md",
      "docs/engine/hub-administration.md",
      "docs/engine/federation.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define source, licence-flag and import-item contracts; imported items are drafts in a review queue.",
      "Implement feed and portal importers behind adapters with fakes; no live fetch in tests.",
      "Parse RSL terms into suggested flags; never auto-apply a more permissive reading than the editor confirmed.",
      "Publish the hub's own content terms as an RSL document."
    ],
    "acceptance": [
      "No imported item is published without a person's decision.",
      "A source licensed only for display is never sent to a model adapter or a federation feed (negative tests).",
      "RSL parsing failures fall back to the most restrictive flags."
    ],
    "paths": [
      "packages/contracts/src/sources.ts",
      "apps/api/src/modules/sources",
      "tests/sources"
    ]
  },
  {
    "id": "MAT-001",
    "title": "Manufacturer knowledge and materials data on plan steps",
    "area": "content-sources",
    "status": "open",
    "dependsOn": [
      "SRC-001",
      "PLAN-001",
      "COM-001"
    ],
    "handbook": "docs/engine/commerce.md",
    "goal": "Attach manufacturer installation guides, data sheets, warranty conditions, training and EPD links to plan steps and catalogue items, collected from manufacturer feeds or logged-off public pages under recorded terms, plus public price indices, with an approved-equal helper that always defers to the designer.",
    "read": [
      "docs/engine/commerce.md",
      "docs/engine/publishing.md",
      "docs/engine/learning.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Let manufacturers claim a page and supply catalogues, guides and training under an explicit licence.",
      "Collect public manufacturer pages only logged-off, honouring robots.txt and RSL; store facts and links, not full documents, unless licensed.",
      "Tag items with plan-step keys and ETIM classes; show public price indices with source and date.",
      "Draft approved-equal comparisons labelled as drafts requiring the designer's approval."
    ],
    "acceptance": [
      "No content is collected behind a login or technical barrier (test of the collector configuration).",
      "Sponsored manufacturer content is labelled and never reorders neutral results.",
      "Takedown requests remove the item and propagate tombstones."
    ],
    "paths": [
      "apps/api/src/modules/manufacturers",
      "tests/manufacturers"
    ]
  },
  {
    "id": "CNT-002",
    "title": "Story clusters with multi-source attribution and editor-approved summaries",
    "area": "content-magazine",
    "status": "open",
    "dependsOn": [
      "CNT-001",
      "SRC-001",
      "PROV-001"
    ],
    "handbook": "docs/engine/publishing.md",
    "goal": "Let editors group imported items about one event into a publication that lists every source with its time and link above the fold, with an optional agent-drafted summary the editor approves.",
    "read": [
      "docs/engine/publishing.md",
      "docs/engine/magazine.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define cluster membership as references to source items, never copies.",
      "Show coverage by source type (official, industry media, press release, own reporting).",
      "Allow an agent draft summary labelled AI-assisted with the responsible editor named."
    ],
    "acceptance": [
      "Every cluster lists all member sources with links and times.",
      "A summary cannot be published without an editor approval event.",
      "Sources whose licence forbids model egress are excluded from summary drafting."
    ],
    "paths": [
      "apps/api/src/modules/content",
      "tests/content/clusters"
    ]
  },
  {
    "id": "PROV-001",
    "title": "AI provenance and labelling for text, translations and images",
    "area": "trust-safety",
    "status": "open",
    "dependsOn": [
      "CNT-001"
    ],
    "handbook": "docs/engine/trust-safety-privacy.md",
    "goal": "Record and show how AI contributed to every publication, translation and image: reader-visible labels naming the responsible human, C2PA manifests and IPTC digital source types on generated images.",
    "read": [
      "docs/engine/publishing.md",
      "docs/engine/trust-safety-privacy.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define a provenance record contract (none, ai_assisted, machine_translated_reviewed, generated) with responsible person.",
      "Add label strings in all six locales and render them on publications, translations and images.",
      "Behind an adapter with a fake, attach C2PA manifests with IPTC digitalSourceType to generated or AI-edited images."
    ],
    "acceptance": [
      "No AI-assisted content renders without a label.",
      "A machine translation stays a draft until a named reviewer approves it.",
      "Generated images carry trainedAlgorithmicMedia or compositeWithTrainedAlgorithmicMedia."
    ],
    "paths": [
      "packages/contracts/src/provenance.ts",
      "tests/provenance"
    ]
  },
  {
    "id": "BENCH-001",
    "title": "Privacy-safe benchmarking for companies",
    "area": "matching",
    "status": "open",
    "dependsOn": [
      "MATCH-001",
      "EXE-001"
    ],
    "handbook": "docs/engine/partners-and-matching.md",
    "goal": "Show a company its own response time, win rate and on-time delivery next to anonymised peer aggregates, only above a minimum group size and never at employee level.",
    "read": [
      "docs/engine/partners-and-matching.md",
      "docs/engine/execution-and-reputation.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define company-level metrics from structured records the company participates in.",
      "Compute peer aggregates by category and region with a minimum group size and noise where needed.",
      "Show method, period and group size beside every comparison."
    ],
    "acceptance": [
      "No aggregate is shown below the minimum group size (test).",
      "No metric is computed per employee.",
      "Private prices never enter any aggregate."
    ],
    "paths": [
      "apps/api/src/modules/benchmarks",
      "tests/benchmarks"
    ]
  },
  {
    "id": "PRMT-001",
    "title": "Building permits and inspections as sourced project data",
    "area": "content-sources",
    "status": "open",
    "dependsOn": [
      "SRC-001",
      "REG-001"
    ],
    "handbook": "docs/engine/projects.md",
    "goal": "Import municipal permit records where open-data terms allow (or through a licensed aggregator adapter) as sourced facts linked to contractors and to a person's own plan, with inspection reminders for one's own projects.",
    "read": [
      "docs/engine/projects.md",
      "docs/engine/country-specifics.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define permit and inspection fact contracts with source, licence and jurisdiction.",
      "Implement one open-data adapter and one aggregator port with fakes.",
      "Link permits to companies by licence number only; never publish homeowner names or private addresses.",
      "Let a plan step track its permit and inspection dates with reminders."
    ],
    "acceptance": [
      "Public views contain no homeowner names (negative test).",
      "Facts carry jurisdiction, source and observed time.",
      "Sources without reuse rights are rejected at configuration."
    ],
    "paths": [
      "apps/api/src/modules/permits",
      "tests/permits"
    ]
  },
  {
    "id": "DISP-001",
    "title": "Dispute evidence packages and mediation referral",
    "area": "execution-trust",
    "status": "open",
    "dependsOn": [
      "EXE-001",
      "FIELD-001",
      "PAY-001"
    ],
    "handbook": "docs/engine/execution-and-reputation.md",
    "goal": "Let parties assemble a dispute package (digest-bound agreement versions, change orders, field records, payments, waivers, messages in context) and refer it to an external mediator or arbitration provider; record outcomes as evidence only with consent.",
    "read": [
      "docs/engine/execution-and-reputation.md",
      "docs/engine/commerce.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define the package manifest with digests and an export both parties can verify.",
      "Add a referral step to configured external providers; Trustwork never decides the dispute.",
      "Annotate affected reputation observations while a dispute is open, per the existing design."
    ],
    "acceptance": [
      "A package contains only records both parties are entitled to see (negative test).",
      "Digests in the export verify against the stored versions.",
      "Outcomes enter reputation only as consented, cited evidence."
    ],
    "paths": [
      "apps/api/src/modules/disputes",
      "tests/disputes"
    ]
  },
  {
    "id": "CRED-001",
    "title": "Portable credentials: Open Badges 3.0 certificates, signed attestations and worker credentials",
    "area": "verification",
    "status": "open",
    "dependsOn": [
      "LRN-001",
      "HUB-003",
      "FED-001"
    ],
    "handbook": "docs/engine/learning.md",
    "goal": "Issue certificates as Open Badges 3.0 verifiable credentials, verification badges and confirmed projects as node-signed attestations, and let workers hold trade and safety credentials confirmed by their issuers, all exportable and displayable by peers with attribution.",
    "read": [
      "docs/engine/learning.md",
      "docs/engine/hub-administration.md",
      "docs/engine/federation.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define attestation and credential contracts aligned with W3C VC Data Model 2.0.",
      "Sign with the node key; support revocation and expiry status on the public check page.",
      "Record issuer confirmations for external credentials (for example an OSHA outreach card confirmed by its training organisation) as \"confirmed by issuer on date\", never as issued by Trustwork.",
      "Add a plain \"add to profile\" link for professional networks without tracking."
    ],
    "acceptance": [
      "Credentials verify offline against the node's published key.",
      "Revoked or expired credentials show their status on the check page.",
      "Attestations contain evidence categories, never documents or personal data beyond the public card."
    ],
    "paths": [
      "packages/contracts/src/credentials.ts",
      "tests/credentials"
    ]
  },
  {
    "id": "DD-001",
    "title": "Counterparty due-diligence pack as a cited platform deliverable",
    "area": "verification",
    "status": "open",
    "dependsOn": [
      "REG-001",
      "HUB-003",
      "AST-001",
      "BILL-001"
    ],
    "handbook": "docs/engine/hub-administration.md",
    "goal": "Generate a dated, cited report on one counterparty from sourced facts, verification results the requester may see, sanctions screening outcome, public procurement history and published reputation, billed from the platform budget.",
    "read": [
      "docs/engine/hub-administration.md",
      "docs/engine/agents.md",
      "docs/engine/billing.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Define the report contract with a citation for every statement and the projection used.",
      "Compose the report through the projection serializer of the requester; never read private data of the subject.",
      "Reserve and settle cost under generate_deliverable with the platform budget.",
      "Show the subject aggregate counts of packs generated, never who requested them."
    ],
    "acceptance": [
      "Every statement in a pack has a source citation (test).",
      "A requester without rights to a verification result never sees it in a pack (negative test).",
      "No pack contains party_private or owner_private fields of the subject."
    ],
    "paths": [
      "apps/api/src/modules/due-diligence",
      "tests/due-diligence"
    ]
  },
  {
    "id": "AGT-002",
    "title": "Agent interoperability profile: A2A card for the company representative and a read-only hub MCP server",
    "area": "assistant",
    "status": "open",
    "dependsOn": [
      "AGT-001",
      "FED-000"
    ],
    "handbook": "docs/engine/agents.md",
    "goal": "Expose the company representative through a signed A2A 1.0 Agent Card whose skills are Trustwork intents, carry agent envelopes as an A2A extension, and offer a read-only MCP server over the public projection.",
    "read": [
      "docs/engine/agents.md",
      "docs/engine/federation.md",
      "docs/adr/011-federation-mesh.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Specify the mapping of agent envelopes, intents and digests to A2A messages, task states and an extension URI.",
      "Sign Agent Cards with the node key over JCS; publish only for enabled representatives.",
      "Define MCP tools for public search and public record fetch with citations; no writes, no private projections.",
      "Add conformance vectors and pin protocol versions."
    ],
    "acceptance": [
      "Free-text parts of incoming A2A messages never change state (injection tests).",
      "The MCP server returns only public-projection fields (negative tests against private fields).",
      "No Agent Card is published for an individual person by default."
    ],
    "paths": [
      "packages/contracts/src/agent-interop.ts",
      "tests/agent-interop"
    ]
  },
  {
    "id": "FED-006",
    "title": "Outbound ActivityPub bridge for publications, issues and public events",
    "area": "federation",
    "status": "open",
    "dependsOn": [
      "FED-002",
      "CNT-001",
      "EVT-001"
    ],
    "handbook": "docs/engine/federation.md",
    "goal": "Let the wider social web follow a hub: one outbound ActivityPub actor per hub publishing public publications, magazine issues and public events with attribution, corrections as updates and deletions as tombstones.",
    "read": [
      "docs/engine/federation.md",
      "docs/adr/011-federation-mesh.md",
      "docs/engine/publishing.md",
      "docs/research/market-and-ideas-2026-10.md"
    ],
    "steps": [
      "Map public publication versions, issues and events to ActivityPub objects with links back to the hub.",
      "Honour source licences: items marked syndication none never leave the node.",
      "Accept follows; do not import replies or mentions in the first version.",
      "Send Update on correction and Delete on retraction or erasure."
    ],
    "acceptance": [
      "Only public-projection fields appear in outgoing objects (negative tests).",
      "Restricted-place instances are refused.",
      "No inbound social content is stored except follow records."
    ],
    "paths": [
      "apps/api/src/modules/activitypub",
      "tests/federation/activitypub"
    ]
  }
]
```

## Source notes

- All sources accessed 2026-10-30 or 2026-10-31. Where a vendor page blocked automated reading, figures come from the cited secondary pages and are marked *(secondary)*.
- US legal points (escrow, lien waivers, retainage, FCRA, data brokers, reviews, texting, scraping, copyright) summarise public law-firm, regulator and court-reporting sources; they are prompts for the hub operator's counsel, not advice.
- Country-specific portals outside the US (xarid.uzex.uz, tender.mc.uz, reyting.mc.uz, armeps.am, the Georgian SPA API) were identified through official or development-bank pages; their current reuse terms must be confirmed by each hub operator before an importer is enabled, and become country-pack facts only after confirmation against official sources ([country specifics](../engine/country-specifics.md)).
- No vendor was contacted, no account was registered and no paid API was used for this research.
