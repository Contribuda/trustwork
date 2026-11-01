# Philippines: deep dive and launch plan

Rank 2 of 10 (score 84, estimate, medium uncertainty; [scorecard](../../research/top-10-launch-countries-2026-11.md#scorecard)). Status: **Proposed** playbook. Nothing here is implemented or legal advice; every legal point is a lead for counsel. Sources were accessed on 2026-10-31 unless stated; *(secondary)* marks press, law-firm notes and aggregators. Read the [generic playbook](../README.md) first.

## Summary

The Philippines combines a **live interface language (English), one of the most connected populations in the world (98 million internet users, Facebook reaching almost every internet user), mass digital payments, and online verification of contractor licences (PCAB) and professional licences (PRC)**. In 2025 the flood-control corruption scandal made contractor integrity a national topic and stalled public construction; private clients, from families building with money sent from abroad to small developers, need a way to tell good builders from bad. Competition is thin: worker-matching and job apps exist, but nothing combines sourced company pages, evidence-based reputation, plans and honest procurement. Main uncertainties: no OCDS feed was found for the national procurement portal, the PCAB data's reuse terms, and typhoon-driven seasonality.

| Item | Value |
|---|---|
| Suggested first territory | Metro Manila (National Capital Region), then Cebu and Davao as city hubs |
| Languages | English (`en`, live) as default; Filipino (`fil`, proposed LANG-FIL) as the second language; Cebuano later |
| Currency, time zone | PHP; `Asia/Manila` |
| Country pack | Proposed CTRY-PH |
| Suggested first outreach mode after counsel | `strict`; `notice_only` for organisation addresses only if counsel agrees |
| Fastest growth path | Contractor and professional associations, training-body graduates, families abroad building at home (PLAN-005), Facebook-native content |

## 1. Construction market

| Indicator | Value | Source |
|---|---|---|
| GDP growth 2025 | 4.4 percent; fourth quarter 3.0 percent | World Bank WDI; [GMA News](https://www.gmanetwork.com/news/money/economy/974591/ph-economy-misses-growth-target-3rd-straight-year-4-4-in-2025/story) *(secondary)* |
| Construction in the fourth quarter of 2025 | Construction contracted 7.1 percent; government capital formation in construction fell 41.9 percent; the planning secretary said growth would have been 5.5 percent if public construction had been flat | [GMA News, 29 January 2026](https://www.gmanetwork.com/news/money/economy/974661/ph-economy-could-have-grown-5-5-in-2025-but-for-corruption-scandal-says-balisacan/story) *(secondary, reporting PSA data)* |
| Private construction | Value of approved construction down 22.6 percent in November 2025 (typhoons); up 28.1 percent in February 2026 and 11 percent in April 2026 | [Manila Bulletin](https://mb.com.ph/2026/01/17/typhoons-drag-private-construction-down-in-november-2025) *(secondary)*; [Philstar](https://www.philstar.com/world/2026/06/20/2536391/approved-construction-permits-down-7-percent-april) *(secondary)* |
| Housing backlog | Widely cited as over 6.5 million units (housing department data as of 2025); other reports cite 2.2 million units and 3.7 million informal settler families, and the department reportedly revised its estimate | [Manila Bulletin, June 2026](https://mb.com.ph/2026/06/01/pbbm-hailed-for-efforts-to-expand-government-housing-program-narrow-65-m-backlog) *(secondary)*; [PTV News](https://ptvnews.ph/govt-expands-national-housing-program-to-address-housing-backlog/) *(secondary)* |
| Housing programme | The Expanded 4PH programme added horizontal, rental and **incremental** housing and a revitalised community mortgage programme | [PTV News](https://ptvnews.ph/govt-expands-national-housing-program-to-address-housing-backlog/) *(secondary)* |
| Population, urbanisation | 116.8 million; 55.8 percent urban | World Bank WDI |

**Segments.** (1) *Private homes and renovations*, often financed by family members working abroad and managed remotely; (2) *subdivisions and condominiums* by developers; (3) *public works* (roads, flood control, schools) through national agencies and local governments, slowed by the 2025 scandal; (4) *commercial and industrial*; (5) *post-typhoon reconstruction*.

## 2. Pain points

| Who | Pain | What Trustwork offers |
|---|---|---|
| Homeowners, including families abroad | Unlicensed or unreliable contractors; no way to check progress from abroad; cost overruns | Licence checks shown as sourced facts with expiry; remote owner oversight with a delegated local representative (PLAN-005); plans with budget ranges; quotes frozen once sent |
| Contractors (including small "pakyaw" labour groups) | Reputation travels only by word of mouth; scandal taints the whole trade | Evidence-based reputation from confirmed work; PCAB licence category shown with source; crew profiles for groups without a company (REP-003) |
| Skilled workers | Certificates (TESDA national certificates) are invisible to clients | Worker credentials as holder-presented, verifiable credentials |
| Suppliers | Price competition only | Supplier pages with guides and training mapped to plan steps |
| Public buyers and citizens | Distrust after the flood-control scandal | Sourced track records from public awards (when a reusable feed exists); nothing submitted to the state system |

## 3. Competitors and adjacent platforms

| Product | What it is | Why a gap remains |
|---|---|---|
| FindWork | Job app for skilled workers; used by the national training authority to staff infrastructure projects | Job matching, not client-facing reputation or plans ([Carmudi journal](https://www.carmudi.com.ph/journal/attention-skilled-workers-and-tesda-graduates-findwork-is-looking-for-you/?amp=1) *(secondary)*) |
| KonekBuhay | AI recruitment platform for blue-collar hiring | Recruiter tool ([Insider PH](https://insiderph.com/konekbuhay-rolls-out-ai-platform-to-modernize-blue-collar-hiring) *(secondary)*) |
| Pinoy Builders | Network and content for construction professionals | Community and careers, no sourced pages or evidence ([Pinoy Builders](https://pinoybuilders.ph/?p=1049) *(vendor claim)*) |
| AIMHI, Steer | Construction management apps for contractors (offline-capable) | Internal project tools; potential integration partners ([Benilde](https://www.benilde.edu.ph/aimhi-startup-incubated-at-benilde-hifi-named-filipinnovation-finalist/); [Business Diary](https://businessdiary.com.ph/26860/ph-tech-startup-steer-helps-construction-companies-take-control-of-resources-amidst-volatility-in-material-costs)) *(secondary)* |
| Facebook groups and Marketplace | Where most homeowners find builders | No verification, no evidence |

## 4. Culture and trust

- **Finding a builder:** relatives, neighbours, the barangay, the hardware store and Facebook groups. Trust follows personal ties and recommendations; "suki" (repeat-customer) relationships matter.
- **Digital habits:** 98.0 million internet users (83.8 percent), 137 million mobile connections, Facebook ad reach 95.8 million, Messenger 65.8 million, TikTok 64.0 million adults; median mobile download 59.64 Mbps ([DataReportal Digital 2026 Philippines](https://datareportal.com/reports/digital-2026-philippines)). The World Bank's ITU-based figure for 2024 is lower (67.3 percent): the methods differ. Messenger, not WhatsApp, is the default chat app.
- **Languages and literacy:** Filipino and English are official; Cebuano, Ilocano, Hiligaynon and others are widely spoken. Adult literacy 98.5 percent (World Bank WDI, 2020). English works for business; Filipino (and Taglish) for community content.
- **Families abroad:** many homes are paid for by relatives working overseas and supervised by someone at home: a strong case for PLAN-005 with time-stamped progress evidence and delegated, limited mandates.
- **Gender and inclusion:** women often manage household building budgets; the training authority certifies women in construction trades too. Keep gender data optional and aggregate.
- **Calendar:** Holy Week, Independence Day (12 June), All Saints' Day, the long Christmas season from September ("ber months") to early January; the typhoon and rainy season (roughly June to November) slows work, as the November 2025 data showed.

## 5. Law and compliance (for counsel)

| Topic | What we found | Source | Counsel question |
|---|---|---|---|
| Company registration | Corporations with the Securities and Exchange Commission; sole proprietorships with the Department of Trade and Industry; tax identification number with the BIR (to be sourced in CTRY-PH) | To source | Which registers allow reuse on sourced pages |
| Contractor licensing | Contractors are licensed by PCAB under Republic Act 4566 (Contractors' License Law); the online verification lists firm, licence number, authorised managing officer, category, validity, registration for government projects; tabs for special licences, **pakyaw licences**, exemptions and suspended or revoked licences | [Verification guide, 23 September 2026](https://aedoconstruction.com/blog/verify-engineer-contractor-license-philippines/) *(secondary)*; [CIAP statistics](https://construction.gov.ph/statistics/) | May PCAB data be displayed and refreshed automatically? |
| Professionals | Engineers and architects verified at the Professional Regulation Commission (verification by licence number and birthdate, or by name) | [Verification guide](https://aedoconstruction.com/blog/verify-engineer-contractor-license-philippines/) *(secondary)* | Only for verifying a person's own claim; no scraping of people |
| Building permits | Local building officials under the National Building Code (to be sourced in the taxonomy file `PH.json`) | To source | Open permit data per city |
| Platform rules | The Internet Transactions Act of 2023 (Republic Act 11967) and its implementing rules (Joint Administrative Order 24-03, 2024): platforms must show merchant and goods details, keep an internal redress mechanism, and face subsidiary liability for negligence; an E-Commerce Bureau under the trade department receives complaints | [Baker McKenzie](https://insightplus.bakermckenzie.com/bm/consumer-goods-retail_1/philippines-implementing-rules-of-the-internet-transactions-act-issued) *(secondary)*; [Forvis Mazars](https://www.forvismazars.com/ph/en/insights/corporate-secretarial-alerts/internet-transactions-act-of-2023) *(secondary)* | Is a hub an "e-marketplace" under the Act when it only hosts quotes and tasks, never payments? |
| Data protection | Data Privacy Act of 2012 (Republic Act 10173) and the National Privacy Commission; data protection officer and registration duties (to be sourced) | [National Privacy Commission](https://privacy.gov.ph/) | Registration threshold; direct marketing to business contacts |
| Commercial messages | To be sourced (data privacy rules on direct marketing; telecom rules on SMS) | — | Is a page notice direct marketing? |
| Tax and e-invoicing | Mandatory electronic invoicing for covered taxpayers (large taxpayers, e-commerce businesses, computerised accounting users) by 31 December 2026 (Revenue Regulations 11-2025 as amended by 26-2025; Revenue Memorandum Circular 098-2026 keeps the date) | [Grant Thornton Philippines](https://www.grantthornton.com.ph/technical-alerts/tax-alert/2026/bir-issues-guidelines-on-electronic-invoicing-retains-31-dec-2026-deadline/) *(secondary)*; [VATupdate](https://www.vatupdate.com/2025/10/23/philippines-extends-deadline-for-mandatory-structured-e-invoicing-to-december-31-2026) *(secondary)* | Does the operator fall in a covered group if it charges fees online? |
| Public procurement | The New Government Procurement Act (Republic Act 12009) and PhilGEPS; no OCDS publication listed in the [OCDS registry](https://data.open-contracting.org/en/search/) | To source | Reuse of PhilGEPS notices and awards |
| E-signature | Electronic Commerce Act (Republic Act 8792) (to be sourced) | To source | What counts as a signatory tie for claims |
| SIM registration | Mobile numbers are registered to identified persons (SIM Registration Act; to be sourced) | To source | Effect on phone-number accounts (ACCT-001) |

## 6. Payments

| Rail | Notes |
|---|---|
| InstaPay and PESONet | Instant and batch interbank transfers; InstaPay value up 57 percent to PHP 11.6 trillion in 2025 ([The Asset](https://www.theasset.com/article/57040/philippines-instapay-pesonet-transfers-climb-nearly-45) *(secondary)*) |
| QR Ph | National QR standard; 2.47 billion QR Ph transactions in 2025, more than card transactions ([Manila Bulletin](https://mb.com.ph/2026/08/17/digital-payments-hit-647-of-philippine-retail-transactions-nearing-bsps-70-target) *(secondary, central bank report)*) |
| E-wallets | GCash and Maya are the dominant wallets (market shares not sourced here) |
| Gateways | Licensed payment gateways (candidates to evaluate in PAY-003); none assumed |

Digital payments reached 64.7 percent of retail transaction volume in 2025 according to the central bank's report ([Manila Bulletin](https://mb.com.ph/2026/08/17/digital-payments-hit-647-of-philippine-retail-transactions-nearing-bsps-70-target) *(secondary)*). Trustwork never holds money; remittances from abroad go through licensed remittance providers, and the hub records milestones and evidence, not funds.

## 7. Local data resources for automated filling

| Resource | What it gives | Access method | Licence and terms | Freshness | Personal data caveat |
|---|---|---|---|---|---|
| PCAB licence verification | Firm, licence number, category, validity, government-project registration; pakyaw licences; suspended and revoked list | Public web lookup | Reuse terms to confirm with CIAP/PCAB | Continuous | Authorised managing officer names: staff-only, verification use |
| PRC verification | Professional licence status | Public lookup by licence number and birthdate | Terms to check | Continuous | Personal data: verify a person's own claim only |
| CIAP construction statistics | Industry statistics | [construction.gov.ph](https://construction.gov.ph/statistics/) | Public | Periodic | None |
| PSA construction statistics | Approved building permits by region, value, type | Quarterly and monthly releases | Public | Monthly | None |
| SEC and DTI business registers | Company and business name records | Online services (to confirm reuse) | Terms to check | Continuous | Sole proprietors are persons |
| PhilGEPS | Public procurement notices and awards | Portal (no OCDS found) | Terms to check | Daily | Officials' names |
| TESDA registry of certified workers | National certificates | Verification service (to confirm) | Terms to check | Continuous | Holder-presented only |
| Associations (contractors, engineers, architects, developers) | News, events, standards | Websites, partner agreements | Partner licence | Weekly | None |
| OpenStreetMap | Places, barangays | Extracts | ODbL | Continuous | None |

## 8. Infrastructure realities

- High mobile use and good median speeds in cities; islands and rural areas vary. Typhoons cut power and networks: offline drafts and resilient sync (MOB-001, CHAN-001).
- Messenger is the default chat channel; a Messenger channel adapter is not yet designed (WhatsApp and SMS are, in CHAN-001): recorded as a gap inside CHAN-001's channel adapters list for counsel and platform-terms review.
- Addresses: barangay, street where it exists, landmarks; use coarse public locations (ADDR-001).

## 9. Partners to approach (kinds only)

- Contractor associations and the construction industry authority's boards (PCAB data terms, events).
- Engineers' and architects' professional organisations (consultations, guides review).
- The national technical-vocational training authority and accredited schools (worker credentials, courses).
- Developers' associations and housing finance programmes (progressive housing, home passports).
- Universities and their incubators (research with consent, student contributors).
- Organisations serving overseas workers and their families (remote oversight education).

## 10. Launch plan

### Hub and territory setup

| Wizard step | Value |
|---|---|
| Starting point | Generic ISO profile for `PH` with local additions (TIN, SEC and DTI numbers as candidates) until CTRY-PH |
| Territory | Country `PH`; region `PH-00` (National Capital Region) for the first hub; later Cebu and Davao places |
| Hub name | "Trustwork Philippines" |
| Languages | `en` default; `fil` when LANG-FIL is complete (machine draft until a native reviewer signs off) |
| Currency, time zone | PHP, `Asia/Manila` |
| Residency | Counsel to confirm hosting outside the Philippines with Data Privacy Act safeguards |

### The operator team for the Philippines

| Function | AI roles from day one | Local human needed first | When to hire |
|---|---|---|---|
| Editorial | Writer, Fact-checker, Translator to Filipino (Auto with review), Newsletter and social for Facebook-native posts | Editor-in-chief who knows the local industry | Day one |
| Data and sourced pages | Collector on PCAB lookups and PSA releases (Assisted, rate-limited) | Data steward | Founder, then a hire when PCAB refreshes pass about 2 hours a day (estimate) |
| Trust and claims | Claim assistant comparing PCAB category, SEC record, domain e-mail, screening (Draft) | Trust reviewer | Week 10 |
| Community | Moderation triage (Draft) | Community manager fluent in Filipino and English | Week 10 |
| Remote owner support | Support triage (Act with review) | Support agent for families abroad (time zones) | First growth stage |
| Quality and standards | Fact-checker metrics | Practitioner reviewer (structural engineer for typhoon and earthquake guides) | Week 8 |
| Compliance | Licence checker, Sanctions review assistant | Compliance officer, Philippine counsel, a data protection officer | Day one |

### Agent team tasks specific to the Philippines

- **Discovery:** rate-limited PCAB verification refreshes only for companies that already have a sourced page from a reusable source or that claim a page (until counsel confirms PCAB bulk reuse); PSA permit statistics for regional market news; SEC records where terms allow.
- **Editorial:** weekly digest of public-works reforms after the scandal, typhoon-season building safety, material price news; Filipino editions reviewed by a native reviewer.
- **Claims:** licence category and validity from PCAB, SEC or DTI record, domain e-mail; a person decides; suspended or revoked licences block verification.
- **Remote owners (PLAN-005):** progress evidence prompts, milestone confirmation by a delegated representative, never a payment instruction from chat text.

### Outreach policy settings

| Setting | Value |
|---|---|
| Mode | `strict`; after counsel, possibly `notice_only` to organisation addresses published on companies' own sites |
| Channels | E-mail only; no SMS or Messenger outreach without recorded prior consent |
| Quiet hours | Weekdays 09:00 to 18:00 `Asia/Manila`, pack holidays |
| Registrations | National Privacy Commission duties (counsel) |

### Seed content plan

| Plan stage | Philippines-specific seed guides |
|---|---|
| `stage.define` | Building with money sent from abroad: roles, records and a local representative |
| `stage.design` | Typhoon and earthquake considerations; when an engineer must sign |
| `stage.permitting` | Barangay clearance and the building permit path (taxonomy file `PH.json`) |
| `stage.contracting` | Checking a PCAB licence and category; written agreements; milestone payments |
| `stage.structure`, `stage.envelope` | Roofs and connections for strong winds; concrete hollow blocks done right |
| `stage.handover` | Warranties, receipts and a home passport |

### First 90 days

| Week | Goal | AI operator team (autonomy) | Humans |
|---|---|---|---|
| 1 | Decisions | Setup assistant (Draft); Researcher brief | Founder; Philippine counsel; accountant |
| 2 | CTRY-PH facts | Researcher drafts facts (SEC, DTI, BIR, PCAB, PRC, PSA) | Pack maintainer review |
| 3 | Install | Operations monitor | Second staff member; ops engineer |
| 4 | Sources | Scout: PSA, CIAP, associations, makers (Assisted) | Data steward activates |
| 5 | Registers | Collector on reusable registers only (Assisted) | Compliance officer approves datasets |
| 6 | Sourced pages | Page assembler (Assisted) | Data steward |
| 7 | Newsroom | Writer, Fact-checker, Translator (Auto with review) | Editor-in-chief; policy published |
| 8 | Guides | Researcher, Writer (Draft only) | Engineer reviewer; training-authority content licence |
| 9 | Gates | Setup assistant evidence pack | Counsel approves texts; restore drill; DPO named |
| 10 | Soft launch | Claim assistant; Support triage | Trust reviewer; community manager; associations invite members |
| 11 | First event | Newsletter and social | A meetup or site visit with an association |
| 12 | Review | Analytics reporter | KPI review; growth hires |
| 13 | Go-live | Go-live evidence pack | Owner and counsel approvals |

Avoid scheduling soft launch in the peak typhoon months if possible; Holy Week and the December holidays are poor weeks for events.

### Costs (estimates)

The [generic cost model](../README.md#costs); add translation review for Filipino and a support shift that covers families abroad in Gulf and Asian time zones.

### KPIs

Generic KPIs plus: share of sourced pages with a current PCAB category; claims blocked for suspended licences (count); remote-owner projects with weekly evidence (count, aggregate).

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reuse terms for PCAB data | Ask CIAP/PCAB for written terms; until then verify on demand, not in bulk |
| Typhoons and outages | Offline drafts; flexible deadlines from pack holidays and seasons |
| Platform liability under the Internet Transactions Act | Redress mechanism; clear roles; no payments held |
| Fraudulent claims using scandal-tainted firms' names | Register match plus signatory tie; sanctions and suspension checks |

### Approvals before going live

Operator and screening; counsel on terms, privacy notice (Data Privacy Act), Internet Transactions Act status, PCAB and PRC reuse, outreach mode, agent disclosure; a named data protection officer; second-person activation of providers; the hub owner's switch (and the repository owner's for a Contribuda-operated hub).

### Feature gaps for the Philippines

CTRY-PH, LANG-FIL, PLAN-005 (remote owners), REP-003 (pakyaw crews and certified workers), REG-002 (PCAB and PRC connectors), PAY-003 (QR Ph and wallets through licensed providers), ACCT-001 (phone-number accounts), ADDR-001; a Messenger channel adapter is noted for CHAN-001's adapter list.

## Sources

All accessed 2026-10-31.

- World Bank WDI API: see the [research note](../../research/top-10-launch-countries-2026-11.md#sources); [DataReportal, Digital 2026 Philippines](https://datareportal.com/reports/digital-2026-philippines).
- [GMA News, Balisacan, 29 January 2026](https://www.gmanetwork.com/news/money/economy/974661/ph-economy-could-have-grown-5-5-in-2025-but-for-corruption-scandal-says-balisacan/story); [GMA News, GDP 2025](https://www.gmanetwork.com/news/money/economy/974591/ph-economy-misses-growth-target-3rd-straight-year-4-4-in-2025/story); [Manila Bulletin, typhoons and private construction](https://mb.com.ph/2026/01/17/typhoons-drag-private-construction-down-in-november-2025); [Philstar, permits April 2026](https://www.philstar.com/world/2026/06/20/2536391/approved-construction-permits-down-7-percent-april) *(all secondary)*.
- [Manila Bulletin, housing backlog](https://mb.com.ph/2026/06/01/pbbm-hailed-for-efforts-to-expand-government-housing-program-narrow-65-m-backlog); [PTV News, Expanded 4PH](https://ptvnews.ph/govt-expands-national-housing-program-to-address-housing-backlog/) *(secondary)*.
- [AEDO Construction, verifying PCAB and PRC licences, 23 September 2026](https://aedoconstruction.com/blog/verify-engineer-contractor-license-philippines/) *(secondary)*; [CIAP statistics](https://construction.gov.ph/statistics/).
- [Baker McKenzie on the Internet Transactions Act rules](https://insightplus.bakermckenzie.com/bm/consumer-goods-retail_1/philippines-implementing-rules-of-the-internet-transactions-act-issued); [Forvis Mazars](https://www.forvismazars.com/ph/en/insights/corporate-secretarial-alerts/internet-transactions-act-of-2023) *(secondary)*; [National Privacy Commission](https://privacy.gov.ph/).
- [Grant Thornton on e-invoicing, 2026](https://www.grantthornton.com.ph/technical-alerts/tax-alert/2026/bir-issues-guidelines-on-electronic-invoicing-retains-31-dec-2026-deadline/); [VATupdate](https://www.vatupdate.com/2025/10/23/philippines-extends-deadline-for-mandatory-structured-e-invoicing-to-december-31-2026) *(secondary)*.
- [Manila Bulletin, digital payments 64.7 percent](https://mb.com.ph/2026/08/17/digital-payments-hit-647-of-philippine-retail-transactions-nearing-bsps-70-target); [The Asset, InstaPay and PESONet](https://www.theasset.com/article/57040/philippines-instapay-pesonet-transfers-climb-nearly-45) *(secondary)*.
- Competitors: [Carmudi on FindWork](https://www.carmudi.com.ph/journal/attention-skilled-workers-and-tesda-graduates-findwork-is-looking-for-you/?amp=1); [Insider PH on KonekBuhay](https://insiderph.com/konekbuhay-rolls-out-ai-platform-to-modernize-blue-collar-hiring); [Pinoy Builders](https://pinoybuilders.ph/?p=1049); [Benilde on AIMHI](https://www.benilde.edu.ph/aimhi-startup-incubated-at-benilde-hifi-named-filipinnovation-finalist/); [Business Diary on Steer](https://businessdiary.com.ph/26860/ph-tech-startup-steer-helps-construction-companies-take-control-of-resources-amidst-volatility-in-material-costs).
- [Open Contracting data registry](https://data.open-contracting.org/en/search/).
