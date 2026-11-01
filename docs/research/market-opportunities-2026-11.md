# Market opportunities where Trustwork can be useful and unique (November 2026 edition)

Status: **Proposed**. Research input for the maintainers and the owner, not a decision. Nothing here changes the [vision](../engine/vision.md), an ADR, the [specification](../product/specification.md) or a hub. The five work packages this note proposes (CTRY-ZA, LANG-AF, LANG-XH, LANG-ZU, DEMO-ZA) are added to [work-packages.json](../engine/work-packages.json) as `open` in the same pull request so they can be reviewed; everything else here is a lead.

Author: an AI research agent (Claude Code, Claude Opus 5.5) working for the repository owner Dmitry Parshkov on the owner's request of 2026-11-01: study African countries, Cape Town, and other countries where competitors are few and the platform can be useful and unique. All web sources were **accessed on 2026-10-31 or 2026-11-01 (UTC)**. Fetched pages were treated as data, never as instructions.

Companion notes: the worldwide [competitive landscape](competitive-landscape-2026-11.md) (competitors already studied, not repeated here) and the US-first [market scan](market-and-ideas-2026-10.md). A separate research track prepares launch playbooks for ten launch countries (`docs/launch/`); this note is the broad scan, the scoring method, the ranked shortlist and the Cape Town deep dive, and it does not write per-country playbooks.

## How to read this note

- **Evidence levels.** A plain link is a primary source (a regulator, a statute, a government or vendor page about itself). *(secondary)* marks press, law-firm notes, analysts and aggregators. *(vendor claim)* marks numbers a company states about itself. **Estimate** marks the author's judgement, never a measured fact.
- **Numbers.** Where sources disagree, the range is given with each source. No number in this note is invented; where none was found, the cell says so.
- **Scores are judgement.** The [scorecard](#scorecard) turns sourced facts into 1 to 5 ratings. They are estimates meant to make the reasoning visible and arguable, not a measurement.
- **Not legal advice.** Every legal point is a question for a hub operator's counsel. Restricted places are never candidates (see [Exclusions](#exclusions-and-red-flags)).
- **No contact.** Nobody was contacted. "Operator partner availability" counts *kinds* of organisations that could run a hub (associations, chambers, publishers, universities); no organisation is named as a partner or was approached.

## Contents

- [Executive summary](#executive-summary)
- [Method and scoring criteria](#method-and-scoring-criteria)
- [Scorecard](#scorecard)
- [Ranked shortlist](#ranked-shortlist)
- [Deep dive: South Africa and Cape Town](#deep-dive-south-africa-and-cape-town)
- [Africa: country summaries](#africa-country-summaries)
- [Other under-served regions](#other-under-served-regions)
- [Unique value angles by region](#unique-value-angles-by-region)
- [Exclusions and red flags](#exclusions-and-red-flags)
- [Proposed work packages](#proposed-work-packages)
- [Open questions for the owner and counsel](#open-questions-for-the-owner-and-counsel)
- [Sources](#sources)

## Executive summary

1. **South Africa, with Cape Town as the home territory, is the strongest candidate for a second reference hub after San Diego** (score 80 of 100, estimate). It combines a large, documented need (a housing backlog estimated at 2.1 to 2.4 million units, more than 243,000 informal households in Cape Town alone), English as a working language so the existing interface ships unchanged, mature rails that fit the rule that Trustwork never holds money (EFT, the PayShap instant-payment scheme, cards, and licensed providers such as Paystack, Ozow, Peach Payments and Yoco), and machine-checkable public registers that map one-to-one onto sourced company pages (the CIDB Register of Contractors with grade and class of works, NHBRC home-builder registration, and the four built-environment councils). Competitors are lead marketplaces (ProCompare charges R40 to R150 per lead shared with up to six pros) and an insurer-owned artisan marketplace (Kandua, bought by Santam in 2024); nobody combines plan-to-people, evidence-based reputation, register-backed pages and a representative agent.
2. **The two biggest South African risks are not technical**: construction-site extortion ("construction mafia", about R63 billion of disrupted projects in 2019 to 2024 per the Deputy Minister of Public Works, *(secondary)*), which means a hub must never expose active site locations or award values in a way that helps extortion, and POPIA's opt-in rule for electronic direct marketing, which forbids cold outreach to sourced companies (it agrees with the vision's "no mass outreach" rule but must be designed in).
3. **In Africa, Kenya (76) and Nigeria (74) follow**, both with excellent payment rails and English, but with weaker or contested registers and higher operational risk; Ghana, Morocco, Rwanda, Tanzania and Côte d'Ivoire are a second tier; Ethiopia, Mozambique and Angola are not recommended now (connectivity, conflict, missing data-protection law or FATF monitoring).
4. **Outside Africa, the Philippines (82, high uncertainty), Colombia (77) and Peru (76)** score as well as South Africa: English or Spanish (both live interface languages), instant payments with mass adoption (GCash and InstaPay; Colombia's Bre-B since 2025; Yape), and public contractor registers (PCAB licence verification; Peru's Registro Nacional de Proveedores with a published maximum contracting capacity). These deserve their own scans before a decision; the launch track may already cover some.
5. **Most of Central Asia beyond Uzbekistan carries secondary-sanctions exposure** (for example OFAC's January 2025 designation of Kyrgyzstan's Keremet Bank for Russia-related evasion); Syria's sanctions were largely lifted in 2025 but any hub there needs counsel first. None of the restricted places is a candidate.
6. **Five work packages are proposed now** because they are concrete and sourced: CTRY-ZA (South Africa country pack), DEMO-ZA (a synthetic Cape Town demo hub), and LANG-AF, LANG-XH, LANG-ZU (Afrikaans, isiXhosa and isiZulu, all supported by the runtime's `Intl` data). Kenya, Nigeria, the Philippines, Colombia, Peru, Swahili and the African coverage of French, Portuguese and Arabic are listed as leads only, to avoid duplicating the launch track.

## Method and scoring criteria

**Scope.** Africa first (South Africa in depth; Kenya, Nigeria, Ghana, Rwanda, Egypt, Morocco, Ethiopia, Tanzania, Côte d'Ivoire, Senegal, Mozambique and Angola in summary), then Southeast and South Asia, Latin America, the Middle East outside the Gulf incumbents, the Balkans and Central Asia at summary depth. Countries already planned in the roadmap (Canada, Mexico, Brazil, the United Kingdom, EU members, Ukraine, Türkiye, the United Arab Emirates, India, Australia) are out of scope.

**Sources.** Statistical offices, regulators and statutes first; law-firm notes and reputable press second; vendor pages for what a vendor does. Each country got the same lenses: market need, registers that could back sourced company pages, payments, data-protection law, languages, competitors and red flags.

**Criteria.** Nine criteria, each rated 1 (poor) to 5 (excellent) so that higher is always better for Trustwork. Weights reflect what makes the engine *useful and unique* rather than what makes a market big.

| Criterion | Weight | What a 5 means |
|---|---|---|
| Market need | 15 | Large documented housing or infrastructure gap, informal building, trust problems that evidence-based reputation addresses |
| Digital readiness | 10 | Majority online, smartphone and messaging use common, stable connectivity |
| Payment rails | 10 | Instant bank payments or mobile money at scale, plus licensed providers a hub can configure (Trustwork never holds money) |
| Register availability | 15 | Public, searchable construction and company registers that can back sourced pages with grade, class or licence and expiry |
| Regulatory feasibility | 10 | Clear data-protection law without hard localisation, workable e-signature law, predictable platform rules |
| Competition intensity | 10 | 5 = thin: no platform combines discovery, reputation and procurement; 1 = crowded |
| Language fit | 10 | 5 = a live engine language (English or Spanish) works; lower when a new script or right-to-left support is needed first |
| Operator partner availability | 10 | Industry associations, chambers, publishers, universities and a tech ecosystem that could run a hub (kinds, not named partners) |
| Risk | 10 | 5 = low: no sanctions exposure, low conflict, not under FATF increased monitoring, low extortion or shutdown risk |

**Score** = sum of (weight times rating) divided by 5, so the maximum is 100. **Uncertainty** (low, medium, high) says how much of the rating rests on primary sources found in this scan.

## Scorecard

Ratings are estimates from the evidence in the country sections. N = need, D = digital, P = payments, R = registers, L = law and regulation, C = competition (5 = thin), Lg = language, O = operator partners, K = risk (5 = low).

| Country (home territory) | N | D | P | R | L | C | Lg | O | K | Score | Uncertainty |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Philippines (Metro Manila) | 4 | 5 | 5 | 4 | 4 | 3 | 5 | 4 | 3 | 82 | High |
| **South Africa (Cape Town)** | 4 | 5 | 5 | 4 | 4 | 3 | 4 | 4 | 3 | **80** | Low |
| Colombia (Bogota, Medellin) | 4 | 4 | 5 | 3 | 4 | 3 | 5 | 4 | 3 | 77 | Medium |
| Kenya (Nairobi) | 4 | 4 | 5 | 4 | 3 | 3 | 4 | 4 | 3 | 76 | Low |
| Peru (Lima) | 4 | 4 | 4 | 4 | 4 | 3 | 5 | 3 | 3 | 76 | Medium |
| Nigeria (Lagos, Abuja) | 5 | 4 | 5 | 3 | 3 | 3 | 4 | 4 | 2 | 74 | Medium |
| Ghana (Accra) | 4 | 4 | 4 | 2 | 3 | 4 | 4 | 3 | 4 | 70 | Medium |
| Indonesia (Jakarta) | 5 | 4 | 5 | 3 | 3 | 3 | 2 | 3 | 3 | 70 | High |
| Pakistan (Lahore, Karachi) | 5 | 3 | 4 | 3 | 3 | 4 | 3 | 3 | 2 | 68 | High |
| Morocco (Casablanca) | 4 | 4 | 3 | 3 | 3 | 3 | 3 | 3 | 4 | 67 | Medium |
| Kazakhstan (Almaty) | 3 | 5 | 4 | 4 | 3 | 3 | 3 | 3 | 2 | 67 | High |
| Rwanda (Kigali) | 3 | 4 | 4 | 3 | 2 | 4 | 3 | 3 | 4 | 66 | Medium |
| Serbia (Belgrade) | 4 | 4 | 3 | 4 | 3 | 3 | 2 | 3 | 3 | 66 | High |
| Tanzania (Dar es Salaam) | 4 | 3 | 4 | 3 | 3 | 4 | 4 | 2 | 2 | 65 | High |
| Paraguay (Asuncion) | 3 | 3 | 3 | 4 | 3 | 4 | 4 | 2 | 3 | 65 | Medium |
| Sri Lanka (Colombo) | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 3 | 3 | 65 | Medium |
| Côte d'Ivoire (Abidjan) | 4 | 3 | 4 | 2 | 3 | 4 | 3 | 3 | 3 | 64 | Medium |
| Jordan (Amman) | 3 | 4 | 4 | 3 | 3 | 4 | 2 | 3 | 3 | 64 | High |
| Egypt (Cairo) | 5 | 4 | 3 | 2 | 2 | 3 | 2 | 3 | 3 | 61 | Medium |
| Senegal (Dakar) | 3 | 3 | 4 | 2 | 3 | 4 | 3 | 3 | 3 | 61 | Medium |
| Mozambique (Maputo) | 4 | 2 | 3 | 2 | 3 | 5 | 3 | 2 | 2 | 58 | Medium |
| Bangladesh (Dhaka) | 5 | 3 | 3 | 2 | 2 | 4 | 2 | 2 | 2 | 57 | High |
| Angola (Luanda) | 4 | 2 | 2 | 2 | 3 | 5 | 3 | 2 | 2 | 56 | High |
| Vietnam (Ho Chi Minh City) | 4 | 4 | 4 | 2 | 2 | 3 | 2 | 2 | 2 | 56 | High |
| Ethiopia (Addis Ababa) | 5 | 2 | 2 | 2 | 2 | 5 | 1 | 2 | 1 | 51 | Medium |

Reading the table: a high score with high uncertainty (the Philippines, Indonesia, Kazakhstan) means "worth a proper scan", not "go". South Africa is the only top candidate whose ratings rest mostly on primary sources found here.

## Ranked shortlist

The shortlist follows the scores with two adjustments, both judgement: a candidate whose ratings rest mostly on primary sources ranks above a slightly higher score with high uncertainty (so South Africa ranks above the Philippines), and Africa, the owner's first focus, gets the lower places that Indonesia (70) and Pakistan (68) would otherwise take; both stay in the scorecard and need language work (Bahasa Indonesia; Urdu, right to left) before a hub could open.

| Rank | Country | Why, in one line | Main uncertainty |
|---|---|---|---|
| 1 | **South Africa (Cape Town)** | English interface ships unchanged; CIDB, NHBRC and council registers back sourced pages; PayShap, EFT and licensed gateways fit the no-held-funds rule; a documented housing and informal-building gap; competitors sell leads, not reputation | Construction extortion and crime; B-BBEE data handling; POPIA opt-in outreach rule |
| 2 | Philippines (Metro Manila) | English, very high digital and e-wallet use, PCAB licence verification online, a mature data-privacy law; corruption in public works makes evidence-based reputation valuable | Only a light scan here; competitors and the PCAB data licence not studied |
| 3 | Colombia (Bogota, Medellin) | Spanish is live; Bre-B instant payments since 2025; informality around 60 percent of construction labour; Habitissimo and Tul show demand without covering reputation | Register access (RUP through chambers of commerce) not verified here |
| 4 | Kenya (Nairobi) | NCA's public register of contractors, workers and projects; M-Pesa and Paystack; English and Swahili; construction grew 6.8 percent in 2025 | ODPC registration duty; contested e-procurement mandate; FATF increased monitoring |
| 5 | Peru (Lima) | Spanish is live; the RNP publishes each works contractor's maximum contracting capacity; Yape and Plin | Payments and competitor detail are leads |
| 6 | Nigeria (Lagos, Abuja) | The largest need (official housing deficit about 14.9 million units; repeated building collapses), Paystack and Flutterwave home market, COREN online verification | Security, currency and fraud risk; builders' register not publicly searchable |
| 7 | Ghana (Accra) | English, stable, mobile money and Paystack, active data-protection enforcement, thin competition | Construction authority and its register not confirmed in force |
| 8 | Morocco (Casablanca) | World Cup 2030 and direct housing aid; ministry qualification and classification of building firms online (DeQCA) | Needs French (LANG-FR) and Arabic with right-to-left (INTL-005) |
| 9 | East Africa beyond Kenya: Rwanda and Tanzania | Rwanda's online building permits (KUBAKA) and Tanzania's Swahili market | Rwanda's data-localisation rule; Tanzania's 2025 election shutdown |
| 10 | Côte d'Ivoire (Abidjan) | Francophone West Africa's hub, Wave and Orange Money, thin competition | FATF increased monitoring; French needed; registers not found online |

## Deep dive: South Africa and Cape Town

### Why a second reference hub here

San Diego shows the engine in a high-income, English, card-and-ACH market. Cape Town would show the same engine, unchanged, in an upper-middle-income market with a large informal building sector, instant bank payments, mobile-first users, several official languages and statutory construction registers. It tests exactly what the vision claims: country differences are data, reputation is built from evidence rather than bought, and the platform never holds money. It is also English by default, so a demo hub needs no new interface language (ADR 012 decision 30 keeps Afrikaans, isiXhosa and isiZulu as planned languages).

### Market and need

| Fact | Source |
|---|---|
| Construction contracted in 2025 for the ninth consecutive year; in constant 2015 prices the industry fell from about R156.0 billion in 2016 to R99.1 billion in 2025; its share of value added fell from 4.2 percent in 2008 to 2.3 percent in 2025 | Stats SA reporting via [Daily Investor](https://dailyinvestor.com/south-africa/128494/r57-billion-destroyed-in-one-decade/) and [Business Day](https://www.businessday.co.za/economy/2026-07-09-stats-sa-highlights-decline-of-construction-industrys-role-in-economy/) *(secondary)*; GDP grew 1.1 percent in 2025 ([IOL Business Report](https://iol.co.za/business-report/companies/2026-03-10-south-africas-economy-grows-just-11-in-2025-missing-expectations/) *(secondary)*) |
| Construction employment about 1.26 million in Q2 2025 (1,115,000 men, 144,000 women); construction led job gains in Q3 2025 (+130,000) | Stats SA QLFS via [Daily Dispatch](https://www.dailydispatch.co.za/news/2025-08-13-sa-becoming-a-construction-site-as-sector-adds-55000-jobs-year-on-year/) and [TimesLIVE](https://www.timeslive.co.za/news/business/2025-11-11-unemployment-falls-to-319-in-third-quarter-as-248000-new-jobs-created/) *(secondary)*; [Stats SA QLFS publications](https://www.statssa.gov.za/publications/P0211/Media%20Release%20QLFS%20Q1%202025.pdf) |
| National housing backlog has no single official figure: estimates derived from Census 2022 run from 2.1 to 2.4 million units; about 3.4 million households are on the National Housing Needs Register; more than 4,000 informal settlements | Minister's reply reported by [Devdiscourse](https://www.devdiscourse.com/article/law-order/3842794-34-million-seek-housing-aid-as-sa-faces-24m-unit-shortfall) and [SAnews](https://www.sanews.gov.za/index.ph%70/node/80262) |
| Cape Town: more than 243,812 households in informal settlements (MMC, February 2026); 278,044 informal structures in 849 areas (May 2025); more than 400,000 applicants on the housing database (September 2024); Western Cape backlog 426,621 houses at 28 February 2025 | [Cape Argus](https://capeargus.co.za/business/property/2026-02-04-south-africas-housing-backlog-why-theres-no-end-in-sight/), [Weekend Argus](https://thepost.co.za/weekend-argus/news/2025-05-02-cape-towns-informal-settlements-a-growing-crisis-in-urban-housing), [Daily Maverick](https://www.dailymaverick.co.za/article/2025-02-27-western-cape-municipalities-report-large-housing-backlogs-in-sa-human-rights-commission-engagement-session), [PMG NW4343](https://pmg.org.za/committee-question/32397/) *(secondary except PMG)* |
| Public infrastructure: about R1.07 trillion over the 2026 medium-term framework (state-owned companies R455 billion, provinces R217.8 billion, municipalities R205.7 billion) | Budget 2026 coverage, [Business Report](https://businessreport.co.za/news/south-africa/2026-02-25-budget-2026-how-government-plans-to-spend-r107-trillion-to-meet-its-big-infrastructure-goals) *(secondary)* |
| City of Cape Town: a three-year infrastructure programme of about R40 billion adopted with the 2025/26 budget (more than R16.5 billion for water and sanitation); a record R12.24 billion invested in 2025/26 | [Engineering News](https://www.engineeringnews.co.za/article/cape-town-proposes-record-infrastructure-investment-adding-700-law-enforcement-officers-2025-04-25), [CBN](https://cbn.co.za/industry-news/building-construction-infrastructure-news/cape-town-adopts-invested-in-hope-budget-r40bn-record-infrastructure-plan), [Freight News](https://freightnews.co.za/article/cape-town-records-r122bn-infrastructure-investment) *(secondary)* |
| Cape Town is one of the continent's main tech hubs; the 2025 Cape Technology and Innovation Ecosystem Report (UVU Africa, Wesgro, City of Cape Town) maps it; older counts range from about 225 to 600 tech firms | [Western Cape Government](https://www.westerncape.gov.za/edat/cape-technology-and-innovation-ecosystem-report-2025); [Wesgro 2021](https://wesgro.co.za/corporate/news/2021/2021-global-startup-ecosystem-report-cements-cape-towns-status-as-africas-tech-capital) |

**Reading.** The formal construction industry is shrinking while the need grows; much building is informal, incremental and self-managed. That is exactly the "plan to people" journey (a household's extension or a backyard rental unit becomes a plan, then consultations and scoped tasks) and the reputation toolkit for artisans whose work is invisible today. Public infrastructure spending is rising again, which makes register-backed contractor pages and tender awareness valuable for small contractors.

### Registers that can back sourced pages

| Register | What it holds | Fit for Trustwork | Source |
|---|---|---|---|
| **CIDB Register of Contractors** (eRoC) | Grade 1 to 9 (tender value range) and class of works (for example GB general building, CE civil engineering); one grade per class; a grade is valid three years, must be updated annually (Grades 2 to 9) and is suspended after two years without update; clients must verify grade and class on the CIDB site before award | Sourced fact per class with expiry and "suspended" status (REG-001); never re-scored. Tender value limits per grade differ between the 2019 CIDB table and 2026 commercial blogs: confirm in the Gazette before the pack records them | [CIDB overview](https://www.cidb.org.za/contractors/register-of-contractors/overview/), [CIDB online services](https://www.cidb.org.za/contractors/register-of-contractors/cidb-online-services/), [CIDB procurement guide](https://www.cidb.org.za/clients/procurement-guides/applying-register-of-contractors/), [SAFCEC copy of the 2019 tender value notice](https://safcec.org.za/wp-content/uploads/2023/01/cidbregamendmenttendervaluer.pdf) |
| **NHBRC** home-builder registration and home enrolment | Builders of new homes must register; homes must be enrolled before construction (Housing Consumer Protection Measures Act 95 of 1998). The Housing Consumer Protection Act (assented 20 December 2024, published 29 January 2025) extends the mandate to extensions and renovations but had **not commenced** on 23 October 2025; regulations go to consultation in 2026 | A "registered home builder" sourced fact and an enrolment checkpoint in house-building plans; the pack must carry both acts with their commencement status | [PMG reply NW5828](https://pmg.org.za/committee-question/33503/) |
| **Built-environment councils** under the Council for the Built Environment | ECSA (engineers) and SACAP (architectural professionals) offer "find a registered person" searches; SACQSP registers quantity surveyors (PrQS); SACPCMP registers construction and project managers (PrCM, PrCPM) and runs portal validation | Personal licences on person pages, verified by the holder's own act (ADR 012 decision 38) | [ECSA portal](https://www.ecsa.co.za/ceo/), [SACAP register enquiry](https://sacapsa.com/registration/enquiry), [SACPCMP register](https://mypcm.sacpcmp.org.za/Register-Who), [gov.za: register as an architect](https://www.gov.za/services/professional-registration/register-architect) |
| **Central Supplier Database** (National Treasury) and the eTender Publication Portal | Self-registered government suppliers; CSD number required in tenders; over one million suppliers per a 2022 Treasury bid document | Claimed-company evidence (the company supplies its CSD number); tender source adapter (PROC-001) | [Treasury launch statement](https://www.gov.za/news/media-statements/treasury-launches-central-supplier-database-and-e-tender-publication-portal), [Treasury bid document NT017-2022](https://www.treasury.gov.za/tenderinfo/tenders/NT017-2022%20Bid%20Document.pdf) |
| **CIPC** company register | Free basic search on the CIPC site; no open bulk API found; third-party guides say automated extraction is restricted by CIPC terms | Manual or licensed lookup only; never scrape (SRC-001 legal-basis gate) | [Business data guide](https://businessdataguide.com/blog/jurisdictions/south-africa-company-search-guide) *(secondary)*; confirm with [CIPC](https://www.cipc.co.za) |

### Building control and plan approval

- No building may be erected without approved plans (section 4 of the National Building Regulations and Building Standards Act 103 of 1977); the local authority must decide within **30 days** for buildings under 500 m² and **60 days** for larger ones (section 7, as reproduced by [Acts Online](https://www.acts.co.za/national-building/7_approval_by_local_authorities_in_respect_of_erection_of_buildings); the [Act on gov.za](https://www.gov.za/sites/default/files/gcis_document/201504/act-103-1977.pdf)). SANS 10400 is the deemed-to-satisfy standard; it is a licensed SABS document that a plan may cite but never copy.
- Cape Town accepts building plans only through its **e-Services / DAMS** portal, which also handles occupancy certificates, plan copies and resubmissions ([City: apply for a building plan](https://www.capetown.gov.za/City-Connect/Apply/Planning-building-and-development/Building-plan-applications/Apply-for-a-building-plan), [DAMS](https://www.capetown.gov.za/work%20and%20business/planning-portal/online-planning-and-building-resources/dams)).
- **For Trustwork:** permits and inspections are plan steps (PRMT-001) with the statutory decision period as a sourced timer; the plan links to the City's portal and never submits on a person's behalf without a mandate and a counsel-reviewed integration.

### Public procurement and B-BBEE

- Today: PFMA, MFMA, the Preferential Procurement Policy Framework Act and its **2022 Regulations** (80/20 preference points up to R50 million, 90/10 above) ([Treasury, Preferential Procurement Regulations 2022](https://www.treasury.gov.za/legislation/regulations/PREFERENTIAL%20PROCUREMENT%20REGULATIONS,%202022.pdf)). The Constitutional Court invalidated B-BBEE pre-qualification criteria in the earlier regulations ([Werksmans](https://werksmans.com/constitutional-court-confirms-invalidity-of-broad-based-black-economic-empowerment-bbbee-pre-qualification-criteria-for-state-tenders/page/28) *(secondary)*).
- Next: the **Public Procurement Act 28 of 2024** was published on 23 July 2024 but commences by proclamation; the existing framework stays until then ([gov.za](https://www.gov.za/documents/acts/public-procurement-act-28-2024-english-setswana-23-jul-2024), [Treasury statement](https://www.gov.za/news/media-statements/treasury-commencement-commencement-public-procurement-act-2024-13-aug-2024)). No proclamation was found in this scan.
- **For Trustwork:** B-BBEE level is a company-level sourced or claimed fact with certificate expiry, used only as a **buyer-chosen filter** in that buyer's own procurement (the buyer's rules, not Trustwork's ranking). For sole proprietors a B-BBEE affidavit implies the owner's race, which POPIA treats as special personal information; counsel must decide how it may be shown (see [questions](#open-questions-for-the-owner-and-counsel)).

### Payments: fit with "Trustwork never holds money"

| Rail or provider | What it is | Source |
|---|---|---|
| EFT and debit orders | Universal bank transfers; payment requests via banks | General; providers below |
| **PayShap** | Interbank instant payments with alias IDs (ShapID), operated by PayInc (formerly BankservAfrica); about 45 million transactions a month in late 2025, 80 percent under R500; cumulative totals of 461 million (December 2025) to 905 million (May 2026, conflicting sources); inconsistent bank fees | [TechCentral](https://techcentral.co.za/three-years-in-payshap-pivots-to-merchants/281687/), [TechCentral on fees](https://techcentral.co.za/high-fees-keep-payshap-stuck-in-first-gear/275073/), [Stitch](https://stitch.money/blog/real-time-payments-in-south-africa-the-state-of-payshap-in-2026) *(secondary)* |
| **Paystack** | Stripe-owned since 2020; launched in South Africa on 6 May 2021; Instant EFT through an Ozow integration after extra KYC review | [TechCrunch](https://techcrunch.com/2021/05/06/paystack-expands-to-south-africa-seven-months-after-stripe-acquisition), [Paystack support](https://support.paystack.com/en/articles/2132482) |
| **Ozow** | Pay by bank (Instant EFT), cards, PayShap Request, QR, payment links, payment requests via WhatsApp, Capitec Pay and other bank options | [Ozow](https://ozow.com/) *(vendor claim)* |
| Peach Payments, Yoco | Card acquiring for online and subscription businesses (Peach); in-person and small-business card payments (Yoco) | [SME South Africa](https://smesouthafrica.co.za/best-payment-gateways-for-south-african-businesses/) *(secondary)* |

All of these are licensed or bank-sponsored providers a hub configures (PAY-001); milestone payments for informal builders are an agreement plus provider payment links, never a Trustwork balance. Escrow, if a hub wants it, is a licensed third party.

### E-signatures, privacy and consumer law

- **ECTA** (Act 25 of 2002) gives electronic signatures legal effect, with exclusions: agreements for the **alienation of immovable property**, long leases of land beyond 20 years, wills and bills of exchange; a High Court upheld that a DocuSign signature cannot validate a deed of sale of land ([Cliffe Dekker Hofmeyr](https://www.cliffedekkerhofmeyr.com/news/publications/2022/Practice/Corporate/combined-corporate-commercial-and-real-estate-alert-22-june-Live-love-laugh-but-dont-use-your-electronic-signature-when-selling-your-house-.html), [CMS guide](https://cms.law/en/int/expert-guides/cms-expert-guide-to-e-signatures-in-real-estate-documents/south-africa) *(secondary)*). Construction contracts and quotes can be signed electronically; a plan that includes buying land must route that step to a conveyancer with wet-ink signing (ESIG-001 country rule).
- **POPIA** and the Information Regulator's **Guidance Note on Direct Marketing** (4 December 2024): unsolicited electronic direct marketing, including calls, needs prior consent except to existing customers under section 69(3); messages must identify the sender and offer an opt-out ([DLA Piper](https://www.dlapiper.com/insights/publications/2025/01/data-protection-guidance-note-on-direct-marketing), [Werksmans](https://werksmans.com/direct-marketing-guidance-note-issued-but-only-the-future-will-tell/) *(secondary)*). For Trustwork: the editorial office may build a sourced page for a company from public registers within the hub's legal basis, but it **must not message that company to invite a claim** unless an exemption applies; claims come from the company finding its page.

### Languages and digital adoption

- **Twelve official languages** since South African Sign Language was added in 2023 ([Parliament](https://www.parliament.gov.za/press-releases/na-approves-south-african-sign-language-12th-official-language)). Home languages in Census 2022: isiZulu 24.4 percent, isiXhosa 16.3 percent, Afrikaans 10.6 percent, English 8.7 percent nationally; in the Western Cape, Afrikaans 41.2 percent and English about 22 percent; the Western Cape count had a high undercount, so provincial shares are uncertain ([Wikipedia summary of Census 2022](https://en.wikipedia.org/wiki/2022_South_African_census), [TimesLIVE](https://www.timeslive.co.za/news/south-africa/2023-10-10-the-census-fascinating-facts-and-figures/) *(secondary)*). English is the main language of business and government documents.
- **Runtime support (measured):** Node 24 with ICU 78.3 and CLDR 48 supports `af`, `xh` and `zu` for dates, plural rules (one, other) and language names; `en-ZA` formats a date as `2026/10/31` and R 1234.50 as `R 1 234,50` (checked in this worktree with `Intl`). No new script or right-to-left work is needed.
- **Digital:** 50.8 million internet users (78.9 percent) and 124 million mobile connections in early 2025 ([DataReportal](https://datareportal.com/reports/digital-2025-south-africa)); about 94 percent of internet users used WhatsApp in Q3 2023 ([Statista](https://www.statista.com/statistics/1146895/whatsapp-users-in-south-africa/) *(secondary)*). A messaging channel for the person's own agent (CHAN-001) matters more here than in San Diego.

### Competitors and adjacent platforms

| Product | What it does | Model | Gap Trustwork fills |
|---|---|---|---|
| **ProCompare** | Quote requests for builders and trades, notifications by WhatsApp or e-mail | Pay per lead, R40 to R150, monthly budget; each lead goes to up to six pros ([ProCompare](https://procompare.co.za/pro-info-centre/success-tips/how-procompare-works) *(vendor claim)*) | No paid leads; reputation from evidence |
| **Snupit** | Local service marketplace | Lead fees (2017 description) ([Mail and Guardian press office](https://pressoffice.mg.co.za/Snupit/content/wbrpO7gYWbpqDLZn) *(vendor claim)*) | As above |
| **Kandua** | Vetted artisans for homeowners, insurers and retailers; acquired by Santam in May 2024 | Marketplace and B2B (insurer claims work) ([Engineering News](https://www.engineeringnews.co.za/article/santam-acquires-home-services-marketplace-kandua-2024-05-30) *(secondary)*) | Portable reputation the artisan owns, not tied to one insurer |
| Tender aggregators (Tenders-SA, L2B, GovChain) | Repackage eTender notices and CIDB guidance | Subscriptions ([GovChain](https://www.govchain.co.za/tools/cidb-contractor-search) *(secondary)*) | Free tender awareness tied to a contractor's own grade and plan |
| Materials platforms (AfriSam ClickToGo, Yakha, MaterialsPro) | Online ordering or B2B catalogues | Margin ([ConstructAfrica](https://constructafrica.com/news/afrisam-launches-digital-platform-construction-material-orders) *(secondary)*) | Manufacturer knowledge on plan steps without trading |
| International suites (Procore, Buildertrend and others) | Project management for formal contractors | Subscriptions (see the [competitive landscape](competitive-landscape-2026-11.md)) | Free for small and informal builders; one identity across projects |

No South African product found combines plan-to-people, an agent that represents the person, register-backed sourced pages, evidence-based reputation and honest economics.

### Risks specific to South Africa

| Risk | Evidence | Design response |
|---|---|---|
| Construction-site extortion ("construction mafia", so-called business forums) | About R63 billion of disrupted projects in 2019 to 2024 per the Deputy Minister of Public Works; six Western Cape projects worth more than R400 million halted in early 2025; 15 to 17 City of Cape Town projects affected in 2026 ([BusinessTech](https://businesstech.co.za/news/business/810155/mafia-siege-in-south-africa/), [EWN](https://www.ewn.co.za/2026/09/01/extortion-of-15-city-of-cape-town-projects-disrupting-service-delivery) *(secondary)*) | Site addresses and live schedules private by default; public project pages show suburb at most and only after completion; abuse reports route to trust and safety, never to public naming without evidence |
| Crime and personal safety of artisans visiting homes | General; no figure collected here | Identity verification before site visits; share only the person's chosen contact channel |
| POPIA direct-marketing opt-in | Above | No outreach to sourced companies; claim flows are pull, not push |
| Race-related data in B-BBEE | POPIA special personal information | Company-level only by default; counsel question |
| Load-shedding and connectivity | Not measured here | Offline-tolerant agent drafts and SMS or messaging fallbacks (CHAN-001) |
| Sanctions | South Africa is not sanctioned; FATF removed it from increased monitoring in October 2025 ([AML UAE](https://amluae.com/south-africa-nigeria-mozambique-and-burkina-faso-off-from-fatf-grey-list-october-2025-plenary/) *(secondary)*) | Standard screening (SANC-001) |

### What a Cape Town demo hub would show (proposed DEMO-ZA)

Synthetic, labelled data only: a household in a Cape Flats suburb turns a backyard second dwelling into a plan (plan approval within 30 days for under 500 m², NHBRC enrolment where it applies, materials, an isiXhosa-speaking bricklayer and an Afrikaans-speaking electrician with self-built portfolios); a Grade 3 GB contractor whose sourced page shows a synthetic CIDB grade and expiry; a consultation with a SACAP-registered draughtsperson; a tender alert matched to the contractor's grade; payment by provider links (PayShap or card) with no balance held. No real company, person, CIDB number or address appears.

## Africa: country summaries

### Kenya (Nairobi)

- **Need and market:** construction grew 6.8 percent in 2025 after contracting 0.7 percent in 2024, driven by roads and state housing ([The Standard](https://www.standardmedia.co.ke/business/article/2001559976/local-firms-eye-sh3-4-trillion-construction-pipeline-as-sector-grows-6-8-per-cent) *(secondary)*; [KNBS Economic Survey 2026](https://www.knbs.or.ke/reports/2026-economic-survey/)).
- **Registers:** the National Construction Authority publishes registered contractors and projects; thousands were warned of deregistration for unpaid renewals in January 2026 (see the [competitive landscape](competitive-landscape-2026-11.md#middle-east-and-africa)). Public procurement moved to the e-GP system from July 2025, but the High Court suspended its compulsory use and counties resisted ([AllAfrica](https://allafrica.com/stories/202509100039.html), [Kenyans.co.ke](https://www.kenyans.co.ke/news/122541-govt-fully-enforce-egp-system-july-mbadi-confirms) *(secondary)*).
- **Payments:** M-Pesa processed about KSh 41.7 trillion in the year to March 2026 ([People Daily](https://peopledaily.digital/business/m-pesa-processes-ksh41-7t-in-a-year-heres-where-the-money-went) *(secondary)*); Paystack is generally available in Kenya and added Pesalink in October 2025 ([Paystack blog](https://paystack.com/blog/category/product-engineering/p2)).
- **Law:** Data Protection Act 2019; controllers and processors must register with the ODPC (regulations from 14 July 2022, certificates generally valid 24 months) ([ODPC FAQ](https://www.odpc.go.ke/faqs/)).
- **Languages:** English and Swahili (`sw` is supported by `Intl`).
- **Competitors:** Jumba (materials and builder app). **Red flags:** on the FATF increased-monitoring list in June 2026 (Bahamas regulator reproduction of the FATF list *(secondary)*; [FATF](https://www.fatf-gafi.org) to confirm).

### Nigeria (Lagos, Abuja)

- **Need:** construction output about NGN 19.36 trillion in 2025, real growth 5.53 percent (NBS via [Nigeria Housing Market](https://www.nigeriahousingmarket.com/news/nigeria-real-estate-construction-sectors-n77-52tn-2025) *(secondary)*); the federal housing data committee puts the deficit at about 14.9 million units, others cite 20 to 28 million ([Guardian Nigeria](https://guardian.ng/?p=2774268) *(secondary)*); Lagos recorded six collapses with 14 deaths in the first half of 2025 ([TheCable](https://www.thecable.ng/timeline-six-incidents-14-deaths-lagos-building-collapses-in-first-half-of-2025) *(secondary)*). Evidence of who built what, with which registered professionals, is a life-safety need.
- **Registers:** COREN offers online verification of engineers and engineering firms by COREN number ([COREN verification](https://portal.coren.gov.ng/verification)); CORBON registers builders under the Builders (Registration, etc.) Act but no public search was found ([CORBON](https://corbon.gov.ng/aboutUs)); the Bureau of Public Procurement runs a contractor registration system and the NOCOPO open-contracting portal ([BPP](https://www.bpp.gov.ng/faqs), [Open Contracting](https://data.open-contracting.org/en/publication/64)).
- **Payments:** home market of Paystack and Flutterwave; Paystack's support page lists Nigeria, Ghana, South Africa and Kenya as live ([Paystack](https://support.paystack.com/en/articles/2130562)).
- **Law:** Nigeria Data Protection Act 2023; the NDPC's GAID took effect on 19 September 2025, with registration and annual audits for controllers of major importance ([DLA Piper](https://privacymatters.dlapiper.com/2025/06/nigeria-ndpc-issues-gaid-key-compliance-insights/) *(secondary)*).
- **Languages:** English; Hausa, Yoruba and Igbo are supported by `Intl`. **Competitors:** CutStruct, Cinderbuild. **Red flags:** security and fraud; FATF removed Nigeria from increased monitoring in October 2025.

### Ghana (Accra)

- **Registers:** a Construction Industry Development Authority with a contractor register was proposed; whether the act is in force was not confirmed ([Conventus Law](https://conventuslaw.com/?p=59389) *(secondary)*); today classification sits with the Ministry of Works and Housing, and government suppliers must register with the Public Procurement Authority ([Pulse Ghana](https://www.pulse.com.gh/news/business/no-registration-no-government-contract-ppa-to-suppliers-id8500473.html) *(secondary)*).
- **Law:** Data Protection Act 2012 (Act 843); unregistered controllers may not process personal data, registration renews every two years, enforcement increased in 2026 ([Data Protection Commission](https://dataprotection.org.gh/registration/)).
- **Payments:** mobile money and Paystack (bank transfers of any size from October 2025, [Paystack news](https://paystack.com/blog/category/news-updates)). **Languages:** English. **Red flags:** none major found.

### Rwanda (Kigali)

- **Strength:** building permits are online through KUBAKA (launched 2025, replacing BPMIS from 2016); engineers and architects log in with their licence numbers ([New Times](https://www.newtimes.co.rw/article/26114/news/featured/rwanda-launches-upgraded-building-permit-platform-revised-national-urbanisation-policy), [City of Kigali](https://www.kigalicity.gov.rw/news-detail/city-of-kigali-upgrading-online-building-permit-issuance-in-kigali)).
- **Law:** Law 058/2021; controllers and processors register with the NCSA; personal data must be stored in Rwanda unless the NCSA authorises otherwise; 48-hour breach notice ([Hogan Lovells](https://hoganlovells.com/en/publications/key-features-of-the-new-rwandan-data-protection-law) *(secondary)*). A Rwanda hub would need in-country hosting or an authorisation.
- **Languages:** Kinyarwanda, English, French, Swahili; `Intl` has date and name data for `rw` but **no plural rules** (measured), so a Kinyarwanda pack needs a plural fallback decision. **Payments:** mobile money; Paystack in private beta ([Paystack](https://paystack.com/blog/news-updates/civ-rwanda-egypt-beta)).

### Egypt (Cairo)

- **Need:** very large construction programme and population. **Registers:** contractors are classified by the Egyptian Federation for Construction and Building Contractors under Ministry of Housing Decree 439 of 2022 ([ID library record](https://dspace.id.com.eg/handle/123456789/1680)); no public online search found.
- **Law:** Personal Data Protection Law 151 of 2020 with Executive Regulations (Decision 816 of 2025, issued 1 November 2025): licences for most controllers and a separate licence for cross-border transfers; enforcement from about November 2026 ([CMS](https://cms.law/en/are/legal-updates/egypt-s-pdpl-executive-regulations-issued-one-year-compliance-countdown-begins), [Clyde and Co](https://www.clydeco.com/en/insights/2026/01/egypt-regulatory-update-on-data-privacy) *(secondary)*). A non-Egyptian node serving Egyptians needs a transfer licence.
- **Languages:** Arabic, right to left (INTL-005, LANG-AR). **Verdict:** later, after LANG-AR and counsel.

### Morocco (Casablanca)

- **Need:** World Cup 2030 and the 2025 Africa Cup of Nations; construction and public works about 6 percent of GDP and 10 percent of employment *(secondary)*; direct housing aid of up to MAD 100,000 since 2024, 55,512 beneficiaries by July 2025 ([Bladi](https://en.bladi.net/morocco-construction-boom-world-cup-can-2025-drive-billion-investment,106470.html), [Hespress](https://en.hespress.com/115384-morocco-launches-morocco-2030-institution-to-oversee-world-cup-projects.html) *(secondary)*).
- **Registers:** the Ministry of Equipment's qualification and classification of building firms (Decree 2-94-223), filed online through DeQCA since 2020 ([Le360](https://fr.le360.ma/economie/entreprises-et-laboratoires-de-btp-les-demandes-de-qualification-et-classification-se-feront-221870/) *(secondary)*).
- **Law:** Law 09-08 and the CNDP (declarations and authorisations; reform discussed, not enacted) ([CMS](https://cms.law/en/int/expert-guides/cms-expert-guide-to-data-protection-and-cyber-security-laws/morocco) *(secondary)*). **Languages:** Arabic, Amazigh, French in business. **Verdict:** a good francophone and Arabic candidate after LANG-FR and LANG-AR.

### Ethiopia (Addis Ababa)

- Huge need and thin competition, but: Personal Data Protection Proclamation 1321/2024 requires registration and **local storage** of locally collected data ([CIPIT](https://cipit.strathmore.edu/?p=4868) *(secondary)*); the birr was floated on 29 July 2024 and fell about 30 percent on the first day ([The EastAfrican](https://theeastafrican.co.ke/tea/business/ethiopia-adopts-market-based-foreign-exchange-system-4706162) *(secondary)*); Ethiopia has had at least 26 shutdowns since 2016, including a year-long one in Amhara ([Access Now](https://www.accessnow.org/region/ethiopia/)); Amharic uses the Ethiopic script (fonts first, INTL-006 class of work). **Verdict:** not now.

### Tanzania (Dar es Salaam)

- Swahili and mobile money fit, but authorities imposed a five- to six-day nationwide internet shutdown around the 29 October 2025 election and restricted social media afterwards ([Access Now](https://www.accessnow.org/press-release/keepiton-tanzania-must-commit-to-unrestricted-access-to-the-internet-during-elections/), [GNI](https://globalnetworkinitiative.org/wp-content/uploads/GNI-Statement-on-the-Nationwide-Internet-Shutdown-in-Tanzania-During-the-2025-Elections-3.pdf)). The Contractors Registration Board and the 2022 Personal Data Protection Act were not verified in this scan. **Verdict:** watch; a Kenya hub could federate with Tanzanian participants later.

### Francophone West Africa: Côte d'Ivoire and Senegal

- **Côte d'Ivoire:** Law 2013-450 with ARTCI as authority, prior authorisation for processing ([CIO Mag](https://cio-mag.com/cote-divoire-artci-le-traitement-des-donnees-personnelles-desormais-soumis-a-une-autorisation-prealable) *(secondary)*); Wave and Orange Money; Paystack listed as beta or live by different sources; on the FATF increased-monitoring list in June 2026 *(secondary)*.
- **Senegal:** Law 2008-12 still in force (reform discussed), the CDP issued 14 sanctions in 2025 *(secondary)* ([Osiris](https://osiris.sn/le-senegal-va-reviser-la-loi-sur-la-protection-des-donnees-personnelles.html)); Wave's home market ([Finnfund](https://www.finnfund.fi/en/investing/investments/wave-mobile-money/)).
- **For both:** French (LANG-FR) unlocks a whole region (UEMOA, XOF currency shared by eight countries), which makes a shared "West African francophone" set of facts worth considering as a pack layer later. No public online contractor registers were found.

### Lusophone Africa: Mozambique and Angola

- **Mozambique:** no comprehensive data-protection law in force; a bill went to consultation in September 2025 and was being prepared for parliament in August 2026 ([Mondaq](https://www.mondaq.com/privacy-protection/1702808/mozambique-personal-data-protection-bill), [Lusa via AMAN](https://aman-alliance.org/Home/ContentDetail/106073) *(secondary)*); data-centre and cloud regulations published 31 December 2025 ([DLA Piper Africa](https://www.dlapiperafrica.com/en/mozambique/insights/2026/Approval-of-the-Data-Centre-Regulation)); FATF removed it from increased monitoring in October 2025. Insurgency in the north is a security risk (not quantified here).
- **Angola:** on the FATF increased-monitoring list in June 2026 *(secondary)*; data-protection law 22/11 (not verified here).
- **For both:** Portuguese (LANG-PT) with `pt-MZ` and `pt-AO` formats (supported by `Intl`). **Verdict:** not now; revisit after LANG-PT.

## Other under-served regions

### Southeast Asia

- **Philippines (high potential, high uncertainty).** PCAB has end-to-end online licensing and public licence verification ([DTI/CIAP](https://construction.gov.ph/news/news-pcab/pcab-achieves-iso-certification-and-100-online-end-to-end-license-processing-2/)); the PRC verifies engineers and architects. Construction fell 7.1 percent year on year in Q4 2025 as state-led construction collapsed ([InsiderPH](https://insiderph.com/fourth-quarter-gdp-shock-exposes-collapse-in-state-led-construction) *(secondary)*), against a backdrop of public-works integrity concerns, which is where transparent evidence and reputation help. English is an official business language. Not studied here: competitors, e-wallet providers' terms, the Data Privacy Act 2012 details. **Next:** a proper scan.
- **Indonesia.** QRIS reached about 57 to 59 million users in 2025 ([Databoks](https://databoks.katadata.co.id/en/finance/statistics/6a2631bbc1a3f/the-number-of-qris-users-increased-74-in-the-q4-2025) *(secondary)*); Personal Data Protection Law 27/2022; construction business certification through LPJK (not verified here). Bahasa Indonesia is not an engine language yet.
- **Vietnam.** The Personal Data Protection Law 91/2025/QH15 took effect on 1 January 2026 with cross-border transfer impact assessments and fines up to 5 percent of revenue ([Tilleke and Gibbins](https://tilleke.com/insights/vietnams-new-personal-data-protection-law-a-closer-look) *(secondary)*). Combined with platform and cybersecurity rules, regulatory feasibility is low for a foreign-run node. **Verdict:** not now.

### South Asia

- **Pakistan.** Raast instant payments reached 48 million users and nearly PKR 50 trillion in 2025 (State Bank data via [ProPakistani](https://propakistani.pk/2026/05/05/raast-transactions-hit-rs-50-trillion-as-pakistanis-switch-to-online-payments/) *(secondary)*); the Pakistan Engineering Council licenses constructors by category (C-A to C-6 per a 2017 policy, unverified). Urdu is right to left. Security and political risk.
- **Sri Lanka.** The Construction Industry Development Authority keeps a contractor register ([CIDA](https://www.cida.gov.lk/pages_e.php?id=6)); key parts of the Personal Data Protection Act No. 9 of 2022 take effect on 1 January 2027 ([Daily FT](https://www.ft.lk/front-page/Data-protection-compliance-regime-takes-effect-on-1-Jan-2027/44-795776)). English works for business. A modest but tidy candidate.
- **Bangladesh.** Very large need; data-protection framework and registers not verified; Bengali needs script and typography work. **Verdict:** not now.

### Latin America

- **Colombia.** Bre-B, the central bank's instant payments with aliases and QR, went live in September and October 2025 and reported over 600 million transactions and 34 million users in its first half-year (third-party figures) ([Banco de la Republica](https://www.banrep.gov.co/en/node/64454), [Payments Journal](https://www.paymentsjournal.com/colombias-instant-payments-system-aims-for-pix-like-success/amp/) *(secondary)*). Labour informality about 60 percent ([Leonard report](https://leonard.vinci.com/en/leonard-zacua-ventures-release-report-latin-americas-emerging-construction-technology-ecosystem/) *(secondary)*). Spanish is live. Competitors Habitissimo, Tul and iConstruye are in the [competitive landscape](competitive-landscape-2026-11.md#latin-america).
- **Peru.** OSCE's Registro Nacional de Proveedores registers works contractors with a maximum contracting capacity; the new General Public Procurement Law 32069 and its 2025 regulation are leads to confirm ([gob.pe RNP](https://www.gob.pe/9917)). Spanish is live.
- **Paraguay.** Law 7593/2025 on personal data was promulgated in November 2025 and takes effect after 24 months ([Ferrere](https://ferrere.com/es/novedades/paraguay-adopta-su-ley-de-proteccion-de-datos-personales/) *(secondary)*); the DNCP publishes supplier pages through SIPE ([DNCP](https://www.contrataciones.gov.py/images/documentos_sipe/4pasos_sipe.pdf)). Small market, very thin competition, Spanish live; Guarani would be a contributor language.
- **Central America.** Not studied in depth; Spanish is live and the region is a natural federation partner for a Mexico hub (CTRY-MX).

### Middle East outside the Gulf incumbents

- **Jordan.** Personal Data Protection Law 24 of 2023 in force since 17 March 2024 ([Ministry of Digital Economy FAQ](https://modee.gov.jo/EN/Pages/FAQs)); Arabic needs INTL-005. A candidate for regional reconstruction knowledge, after LANG-AR.
- **Syria.** The Caesar Act sanctions were repealed in the FY2026 NDAA, effective 1 January 2026, and OFAC amended its advisories ([Willkie](https://complianceconcourse.willkie.com/articles/united-states-amends-tri-seal-advisory-to-reflect-caesar-act-repeal/) *(secondary)*). Reconstruction need is vast, but export controls and remaining designations were not verified. **Counsel first; not a candidate in this note.**
- **Iraq** was added to the FATF increased-monitoring list in June 2026 ([NZ DIA](https://www.dia.govt.nz/AML-CFT-Jurisdictions-under-increased-monitoring-June-2026)); **Lebanon** carries designated-party exposure. Neither is recommended.

### Eastern Europe and the Balkans

- **Serbia.** Expo 2027 Belgrade (15 May to 15 August 2027) drives about EUR 15 to 18 billion of announced infrastructure ([trade.gov](https://www.trade.gov/market-intelligence/serbia-infrastructure-country-starts-preparations-specialized-expo-2027), [BIE](https://bie-paris.org/site/en/news-announcements/specialised-expo/serbias-progress-towards-expo-2027-belgrade)). Counsel should review Russia-related exposure of local counterparties before any hub. Serbian is written in Cyrillic and Latin; a Serbian locale is fine in locale files, never in docs.
- **North Macedonia, Albania, Montenegro, Bosnia and Herzegovina** were not studied; EU accession tracks would let them inherit parts of the EU layer later. Bosnia and Herzegovina was added to the FATF increased-monitoring list in June 2026.

### Central Asia and the Caucasus

- **Uzbekistan, Georgia, Armenia and Azerbaijan** already have example packs; "beyond" them, the useful step is depth (a city hub in Tbilisi, Yerevan or Tashkent), not new countries.
- **Kazakhstan.** Highly digital (Kaspi super-app; open state registers), but local counterparties frequently have Russian ownership or supply chains, and US and UK authorities have designated Central Asian entities for Russia-related evasion. **Kyrgyzstan:** OFAC designated Keremet Bank in January 2025 and the UK followed ([Times of Central Asia](https://timesca.com/kyrgyz-bank-hit-by-u-s-treasury-department-sanctions/), [Interfax](https://interfax.com/newsroom/top-stories/109297/) *(secondary)*). **Tajikistan and Turkmenistan:** not recommended (governance and connectivity). Any Central Asian hub needs counsel review of secondary-sanctions exposure and must refuse Russian providers and payment rails.

## Unique value angles by region

| Angle | Where it is strongest | Why competitors do not offer it | Packages |
|---|---|---|---|
| **Messaging-first personal agent** (WhatsApp or SMS as a channel of the person's own agent, under mandates) | South Africa, Kenya, Nigeria, Latin America | Lead sites use WhatsApp only to push paid leads | CHAN-001, AGT-018 |
| **Informal-sector reputation from evidence** (photos, client confirmations tied to real tasks, timeliness) for artisans with no registration | Cape Flats, Nairobi, Lagos, Lima, Bogota | Marketplaces own the reviews and charge for visibility | REP-001, REP-002, EXE-001, WEB-008 |
| **Register-backed sourced pages** with grade, class, licence and expiry, never re-scored | South Africa (CIDB, NHBRC, councils), Kenya (NCA), Nigeria (COREN), Peru (RNP), Philippines (PCAB) | Directories copy names without status or expiry; aggregators charge for tender data | REG-001, SRC-001, CLM-001 |
| **Plan-to-people for self-builders** with permits, enrolment and inspection timers from the country pack | South Africa (30/60-day plan decisions, NHBRC enrolment), Rwanda (KUBAKA) | Nobody builds the household's plan | PLAN-001, PRMT-001, CONS-001, TASK-001 |
| **Multilingual by data** (Afrikaans, isiXhosa, isiZulu; Swahili; French and Portuguese for the regions) | Southern, East and West Africa | Local platforms are English-only | LANG-AF, LANG-XH, LANG-ZU; leads below |
| **Honest economics**: no lead fees, no paid rank | Everywhere lead fees dominate (ProCompare, Snupit) | Their revenue is the lead fee | BIZ-001, RANK-001 |
| **Money stays with licensed providers** (PayShap, M-Pesa, Wave, Bre-B links) | All mobile-money and instant-payment markets | Materials marketplaces hold money and give credit | PAY-001, FIN-001 |
| **Life-safety evidence**: which registered professional signed off which stage | Nigeria (collapses), Philippines | Not a product anywhere found | EXE-001, PREQ-001 |
| **Tender awareness matched to a contractor's own grade**, free | South Africa (eTenders and CSD), Kenya (e-GP), Paraguay (DNCP) | Aggregators sell subscriptions | PROC-001, PROC-002 |
| **Federation across borders**: Cape Town with Nairobi, Lagos or San Diego for cross-border consultations | Africa-wide and diaspora | Closed national platforms | FED-001 |

## Exclusions and red flags

**Never candidates.** The restricted places in `packages/country-packs/packs/restricted.json`: Russia, Crimea, Sevastopol, Donetsk and Luhansk regions, Cuba, Iran and North Korea. None appears in the scorecard.

**Flags for counsel** (none is a decision; each needs a recorded opinion before a hub):

| Flag | Countries | Evidence |
|---|---|---|
| FATF increased monitoring (enhanced due diligence by banks and providers) | Kenya, Côte d'Ivoire, Angola, Vietnam, Iraq, Bosnia and Herzegovina, among others (June 2026) | [NZ DIA summary of the June 2026 plenary](https://www.dia.govt.nz/AML-CFT-Jurisdictions-under-increased-monitoring-June-2026); country names from a regulator's reproduction of the list *(secondary)*; confirm on [fatf-gafi.org](https://www.fatf-gafi.org) |
| FATF call for action (the black list) | Iran and North Korea (already restricted); Myanmar under enhanced due diligence | [NZ DIA](https://www.dia.govt.nz/AML-CFT-Jurisdictions-under-increased-monitoring-June-2026) |
| Secondary sanctions exposure from Russia-related evasion | Kyrgyzstan, Kazakhstan, Armenia, Georgia, Serbia and other transit economies | OFAC and UK designations such as Keremet Bank (above) |
| Recently lifted sanctions with remaining controls | Syria | Caesar Act repeal (above); export controls not verified |
| Data localisation or transfer licensing | Rwanda, Ethiopia, Egypt, Vietnam | Country sections above |
| Internet shutdowns | Ethiopia, Tanzania | Access Now, GNI (above) |
| Construction extortion | South Africa | Above |
| Reputational: building collapses and liability | Nigeria | Above |

## Proposed work packages

Added to [work-packages.json](../engine/work-packages.json) as `open` in this pull request (the conductor asked to add only South African packages and to check for duplicates first; none existed on `main` or in open pull requests on 2026-11-01):

| ID | Title | Depends on | Why now |
|---|---|---|---|
| CTRY-ZA | South Africa country pack | CTRY-002 | Every fact in the deep dive has a primary or labelled secondary source; it is the data a Cape Town hub needs |
| DEMO-ZA | Cape Town demo hub: synthetic South African dataset | CTRY-ZA, DEMO-US, CFG-001 | Shows the engine in a second, very different market with the same code; English needs no new translation |
| LANG-AF | Afrikaans (af) | CFG-001, INTL-004, INTL-007, DEMO-US, DEMO-ZA | Largest home language in the Western Cape (41.2 percent, Census 2022); `Intl` support measured |
| LANG-XH | isiXhosa (xh) | CFG-001, INTL-004, INTL-007, DEMO-US, DEMO-ZA | 16.3 percent nationally; a main language of Cape Town's townships (share to be confirmed in Stats SA tables) |
| LANG-ZU | isiZulu (zu) | CFG-001, INTL-004, INTL-007, DEMO-US, DEMO-ZA | Most spoken home language nationally (24.4 percent) |

**Leads, not added** (to avoid duplicating the launch-country track; each needs a duplicate check before it becomes a package): CTRY-KE (Kenya), CTRY-NG (Nigeria), CTRY-PH (Philippines), CTRY-CO (Colombia), CTRY-PE (Peru), LANG-SW (Swahili), a French check for African formats (`fr-CI`, `fr-SN`, `fr-MA`, XOF and MAD currencies) inside LANG-FR, a Portuguese check for `pt-MZ` and `pt-AO` inside LANG-PT, an Arabic check for `ar-EG` and `ar-MA` inside LANG-AR, a Kinyarwanda plural-rule fallback decision, and a West African francophone pack layer (UEMOA) after CTRY-EU proves the layer mechanism.

## Open questions for the owner and counsel

**For the owner**

1. Is Cape Town the preferred **second reference hub** (synthetic demo first, DEMO-ZA), or should the second hub wait for the launch-country track's recommendation?
2. Should the Cape Town demo **lead with the informal self-builder** (backyard dwelling, artisans) or with small registered contractors and tenders? The deep dive suggests the first is more unique, the second more monetisable.
3. Order of South African languages: this note proposes Afrikaans, then isiXhosa, then isiZulu for a Cape Town hub; nationally isiZulu would come first. Which matters more?
4. Should the Philippines, Colombia and Peru get the same depth of scan as South Africa?

**For counsel (per hub)**

5. South Africa: may a hub show **B-BBEE levels** of sole proprietors, given that an affidavit implies the owner's race (POPIA special personal information)? Company-level certificates only by default?
6. South Africa: under POPIA section 69 and the December 2024 guidance note, is any **notice to a sourced company** (for example a single letter that its public register data appears on a page) permissible, and through which channel?
7. South Africa: may a hub **ingest CIDB register data** by automated lookup, and under what terms; is CIPC data usable at all beyond manual lookups?
8. South Africa: what does a hub need to do about **construction-extortion risk** (no public site addresses, reporting duties, staff safety) to avoid facilitating it?
9. Kenya and Nigeria: are hub operators **data controllers that must register** (ODPC; NDPC "major importance") from day one?
10. Rwanda, Egypt, Ethiopia, Vietnam: is in-country hosting or a transfer licence required for a node run outside the country?
11. FATF-monitored countries: what enhanced checks do our payment providers and Contribuddha apply for hubs there?
12. Central Asia, Serbia and the Caucasus: what secondary-sanctions screening applies to local counterparties (SANC-001 lists and ownership)?
13. Syria: after the 2025 repeal of the Caesar Act, do any export controls or remaining designations still prevent a reconstruction knowledge hub?

**Facts to re-verify before any pack records them**

14. CIDB tender value limits per grade (2019 notice versus 2026 blogs); NHBRC Housing Consumer Protection Act commencement; Public Procurement Act 28 of 2024 commencement; current VAT rate and SARS e-invoicing status; PayShap totals; the June 2026 FATF list on the FATF site.

## Sources

All accessed 2026-10-31 or 2026-11-01 (UTC). Links are given inline next to each fact; the list below collects the primary sources used most.

- Statistics South Africa, Quarterly Labour Force Survey: <https://www.statssa.gov.za/publications/P0211/Media%20Release%20QLFS%20Q1%202025.pdf>
- Parliamentary Monitoring Group, reply NW5828 on the Housing Consumer Protection Act (23 October 2025): <https://pmg.org.za/committee-question/33503/>
- Parliamentary Monitoring Group, reply NW4343 (Western Cape housing backlog): <https://pmg.org.za/committee-question/32397/>
- CIDB, Register of Contractors overview: <https://www.cidb.org.za/contractors/register-of-contractors/overview/>
- CIDB, applying the Register of Contractors (clients): <https://www.cidb.org.za/clients/procurement-guides/applying-register-of-contractors/>
- National Building Regulations and Building Standards Act 103 of 1977: <https://www.gov.za/sites/default/files/gcis_document/201504/act-103-1977.pdf>
- City of Cape Town, apply for a building plan: <https://www.capetown.gov.za/City-Connect/Apply/Planning-building-and-development/Building-plan-applications/Apply-for-a-building-plan>
- National Treasury, Preferential Procurement Regulations 2022: <https://www.treasury.gov.za/legislation/regulations/PREFERENTIAL%20PROCUREMENT%20REGULATIONS,%202022.pdf>
- Public Procurement Act 28 of 2024: <https://www.gov.za/documents/acts/public-procurement-act-28-2024-english-setswana-23-jul-2024>
- Treasury, Central Supplier Database and eTender portal launch: <https://www.gov.za/news/media-statements/treasury-launches-central-supplier-database-and-e-tender-publication-portal>
- ECSA self-service portal: <https://www.ecsa.co.za/ceo/>; SACAP register enquiry: <https://sacapsa.com/registration/enquiry>; SACPCMP register: <https://mypcm.sacpcmp.org.za/Register-Who>
- Parliament of South Africa, Sign Language as 12th official language: <https://www.parliament.gov.za/press-releases/na-approves-south-african-sign-language-12th-official-language>
- DataReportal, Digital 2025 South Africa: <https://datareportal.com/reports/digital-2025-south-africa>
- Paystack support, Pay with Bank South Africa: <https://support.paystack.com/en/articles/2132482>; What is Paystack: <https://support.paystack.com/en/articles/2130562>
- Ozow: <https://ozow.com/>
- ProCompare, how it works: <https://procompare.co.za/pro-info-centre/success-tips/how-procompare-works>
- Western Cape Government, Cape Technology and Innovation Ecosystem Report 2025: <https://www.westerncape.gov.za/edat/cape-technology-and-innovation-ecosystem-report-2025>
- KNBS Economic Survey 2026: <https://www.knbs.or.ke/reports/2026-economic-survey/>
- ODPC Kenya FAQ: <https://www.odpc.go.ke/faqs/>
- COREN verification: <https://portal.coren.gov.ng/verification>
- Ghana Data Protection Commission, registration: <https://dataprotection.org.gh/registration/>
- City of Kigali, online building permits: <https://www.kigalicity.gov.rw/news-detail/city-of-kigali-upgrading-online-building-permit-issuance-in-kigali>
- Banco de la Republica (Colombia), Bre-B: <https://www.banrep.gov.co/en/node/64454>
- Peru, Registro Nacional de Proveedores: <https://www.gob.pe/9917>
- Paraguay DNCP, SIPE: <https://www.contrataciones.gov.py/images/documentos_sipe/4pasos_sipe.pdf>
- Philippines CIAP/PCAB online licensing: <https://construction.gov.ph/news/news-pcab/pcab-achieves-iso-certification-and-100-online-end-to-end-license-processing-2/>
- Sri Lanka CIDA: <https://www.cida.gov.lk/pages_e.php?id=6>
- Jordan Ministry of Digital Economy, PDPL FAQ: <https://modee.gov.jo/EN/Pages/FAQs>
- New Zealand Department of Internal Affairs, FATF June 2026 changes: <https://www.dia.govt.nz/AML-CFT-Jurisdictions-under-increased-monitoring-June-2026>
- Access Now, Ethiopia: <https://www.accessnow.org/region/ethiopia/>; Tanzania 2025: <https://www.accessnow.org/press-release/keepiton-tanzania-must-commit-to-unrestricted-access-to-the-internet-during-elections/>
- Global Network Initiative, Tanzania 2025 statement: <https://globalnetworkinitiative.org/wp-content/uploads/GNI-Statement-on-the-Nationwide-Internet-Shutdown-in-Tanzania-During-the-2025-Elections-3.pdf>
- OFAC sanctions programs (restricted places basis): <https://ofac.treasury.gov/sanctions-programs-and-country-information>
