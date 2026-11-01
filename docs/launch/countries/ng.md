# Nigeria: deep dive and launch plan

Rank 8 of 10 (score 73, estimate, medium uncertainty; [scorecard](../../research/top-10-launch-countries-2026-11.md#scorecard)). Status: **Proposed** playbook. Nothing here is implemented or legal advice; every legal point is a lead for counsel. Sources were accessed on 2026-10-31 unless stated; *(secondary)* marks press, law-firm notes and aggregators. Read the [generic playbook](../README.md) first.

## Summary

Nigeria has **the largest need on the list**: 237 million people, an official housing deficit of about 15 million units (industry figures go to 28 million), construction growing about 5.5 percent in real terms in 2025, and building quality problems that make evidence-based reputation valuable. English is a live interface language and the payment ecosystem (instant interbank transfers, licensed gateways headquartered in Lagos) is deep. Several artisan apps exist, mostly in Lagos and Abuja, which lowers the competition rating to 3. The risks are real: fraud and impersonation, security, currency volatility, and data protection rules (NDPA 2023 and its 2025 directive) with consent for direct marketing and registration duties. A Nigeria hub should start in one city with strong partners and strict verification.

| Item | Value |
|---|---|
| Suggested first territory | Lagos State, then the Federal Capital Territory (Abuja) and Port Harcourt |
| Languages | English (`en`, live); Hausa, Yoruba and Igbo (LANG-HA, LANG-YO, LANG-IG proposed); Nigerian Pidgin as a candidate |
| Currency, time zone | NGN; `Africa/Lagos` |
| Country pack | Proposed CTRY-NG |
| Suggested first outreach mode after counsel | `strict`; `notice_only` only after counsel (the discovery design's suggestion) |
| Fastest growth path | Professional and builders' regulatory councils, builders' and engineers' institutes, a Lagos partner, strict claims |

## 1. Construction market

| Indicator | Value | Source |
|---|---|---|
| Construction real growth 2025 | 5.53 percent (4.16 percent in 2024); nominal output NGN 19.36 trillion | [HousingTV Africa (NBS)](https://www.housingtvafrica.com/?p=34991) *(secondary)* |
| Quarterly real growth 2025 | 6.21 percent (first quarter), 5.27 percent (second), 5.57 percent (third) | [Nairametrics](https://nairametrics.com/2025/12/01/nigerias-gdp-rises-by-3-98-in-q3-2025-driven-by-strong-agricultural-and-industrial-growth/) *(secondary)*; [Daily Trust](https://dailytrust.com/real-estate-construction-among-top-10-contributors-to-gdp-in-q2-2025) *(secondary)* |
| Housing deficit | About 14.9 million units (federal government estimate); 28 million in figures linked to the Federal Mortgage Bank; about 800,000 units needed a year | [HousingTV Africa](https://www.housingtvafrica.com/?p=30349) *(secondary)*; [HousingTV Africa](https://www.housingtvafrica.com/?p=34435) *(secondary)* |
| Population, urbanisation | 237.5 million; 63.8 percent urban, urban growth 3.3 percent | World Bank WDI |

**Segments.** (1) *Self-built houses* in growing cities and towns, often in stages; (2) *estates and apartments* by developers in Lagos and Abuja; (3) *public works* at federal and state level; (4) *commercial*; (5) *repairs and renovations*.

## 2. Pain points

| Who | Pain | What Trustwork offers |
|---|---|---|
| Homeowners and families abroad | Fraudulent or unqualified builders, substandard materials, building collapses, money sent home misused | Plans and budget ranges; registered-professional consultations; remote owner oversight (PLAN-005); quotes frozen once sent |
| Artisans | Jobs by word of mouth; no portable record | Profiles and confirmed portfolios (REP-003) |
| Contractors and professionals | Registration with councils not visible to clients | Claimable pages; council registration as claim evidence checked by a person |
| Suppliers | Counterfeit and substandard material concerns | Manufacturer and supplier pages with guides; product knowledge mapped to plan steps |
| Public buyers | Transparency demands | Opportunities and awards from OCDS publications |

## 3. Competitors and adjacent platforms

| Product | What it is | Why a gap remains |
|---|---|---|
| Wocman | Platform (July 2025) linking homeowners, developers and companies to verified contractors and suppliers, with location filters and equipment rental | Marketplace; no owned evidence-based reputation or plans ([ThisDay](https://www.thisdaylive.com/2025/07/27/wocman-technology-unveils-digital-platform-to-reshape-nigerias-construction-industry) *(secondary)*) |
| Wrkman | Home services in Lagos and Abuja with physically verified providers (16,000 onboarded in December 2022, its own figure) | Home services; lead-style ([Nairametrics, 2022](https://nairametrics.com/2022/12/23/wrkman-improving-the-gaps-for-home-services-sector-in-nigeria) *(secondary)*) |
| HAGO Africa, Daibau, Fix All Africa, Artisan Express and others | Artisan marketplaces, some with escrow | Small; escrow holds money, which Trustwork never does |
| Cutstruct, Cinderbuild | Construction materials marketplaces | Materials and credit ([competitive landscape](../../research/competitive-landscape-2026-11.md#middle-east-and-africa)) |
| A government "Uber for artisans" plan | Announced digital platform for verified artisans (no date in the report) | Status unknown ([News Central](https://newscentraltv.com/?p=307446) *(secondary)*) |

## 4. Culture and trust

- **Finding builders:** family, church and mosque networks, estate associations, WhatsApp groups, Instagram and Facebook. Trust is personal; fraud fears are high.
- **Digital habits:** about 109 million internet users (45.5 percent), 165 million connections (69 percent), TikTok 47.8 million adults, Facebook 38.0 million, median mobile download 44.96 Mbps ([DataReportal Digital 2026 Nigeria](https://datareportal.com/reports/digital-2026-nigeria)); the World Bank's ITU figure is 41.2 percent.
- **Languages and literacy:** English official; Hausa, Yoruba and Igbo major; Nigerian Pidgin widely spoken; adult literacy 70.4 percent (World Bank WDI, 2024). Voice notes and local languages widen reach.
- **Inclusion:** north and south differ greatly in connectivity and language; women's participation in trades is low; keep gender data optional and aggregate.
- **Calendar:** national holidays including Eid, Easter, Christmas, Independence Day (1 October), Democracy Day (12 June); the rainy season (roughly April to October in the south) slows work.

## 5. Law and compliance (for counsel)

| Topic | What we found | Source | Counsel question |
|---|---|---|---|
| Company registration | Corporate Affairs Commission (CAC) under the Companies and Allied Matters Act; public search (to be sourced) | To source | Reuse of CAC search data |
| Professionals and builders | COREN (engineers), ARCON (architects), CORBON (builders); online verification for COREN per the companion scan | [Companion scan, pull request #370](https://github.com/Contribuda/trustwork/pull/370) | Verification use; whether registers may be displayed |
| Building approvals | State planning and building control agencies (Lagos and others) (to be sourced in `NG.json`) | To source | Open permit data |
| Public procurement | Bureau of Public Procurement; OCDS publications by the BPP, Budeshi and eleven states (update frequency unknown) | [OCDS registry](https://data.open-contracting.org/en/search/) | Reuse licence and freshness |
| Data protection | NDPA 2023; the General Application and Implementation Directive (GAID) issued 20 March 2025, effective 19 September 2025; registration of data controllers and processors of major importance in tiers; consent for direct marketing (sources differ on how strict) | [Mondaq](https://www.mondaq.com/nigeria/privacy-protection/1627428/key-regulatory-updates-under-the-2025-general-application-and-implementation-directive-gaid-issued-by-the-nigeria-data-protection-commission-ndpc) *(secondary)*; [The Nigeria Lawyer](https://thenigerialawyer.com/?p=417368) *(secondary)*; [SCP Law note](https://resource.scp-law.com/2025/04/30/what-you-need-to-know-about-gaid-2025-and-data-protection-compliance/) *(secondary)* | Registration tier; whether a page notice is direct marketing |
| SMS and calls | Sender ID registration and do-not-disturb rules of the telecom regulator (to be sourced) | To source | CHAN-001 and CHAN-002 settings |
| Tax | VAT and the 2025 tax reform laws; e-invoicing rollout (to be sourced) | To source | Operator invoices |
| E-signature, consumer protection | Evidence Act provisions on electronic records and signatures; competition and consumer protection commission (to be sourced) | To source | Signatory tie; paid services |

## 6. Payments

| Rail | Notes |
|---|---|
| Instant interbank transfers (NIP) | Everyday payments between bank accounts (to be sourced) |
| Licensed gateways and mobile money operators | Nigeria is the home market of large licensed pan-African gateways (companion scan); candidates in PAY-003 |
| Cards and USSD banking | USSD banking codes are common on basic phones |

Account ownership 63.3 percent (World Bank Findex 2024). Currency volatility: show NGN prices with dates; never convert silently. Trustwork never holds money, unlike the escrow apps in the market.

## 7. Local data resources for automated filling

| Resource | What it gives | Access method | Licence and terms | Freshness | Personal data caveat |
|---|---|---|---|---|---|
| CAC search | Company name, number, status | Public search (to confirm) | Terms to check | Continuous | Directors and business-name owners are persons |
| BPP and state OCDS | Tenders, awards | OCDS publications | Licence per publication | Unknown | Officials' names |
| Professional councils | Registration status | Online verification where public | Terms to check | Continuous | Verify own claims only |
| National Bureau of Statistics | GDP by sector, prices | Releases | Public | Quarterly | None |
| Builders' and engineers' institutes | News, events, guides | Websites, partnerships | Partner licence | Monthly | None |
| OpenStreetMap | Places | Extracts | ODbL | Continuous | None |

## 8. Infrastructure realities

Mobile-first with large gaps between cities and rural areas; power outages; data costs. USSD (CHAN-002), SMS and WhatsApp (CHAN-001), low-bandwidth pages (MOB-001), offline drafts. Addresses are often descriptive (ADDR-001).

## 9. Partners to approach (kinds only)

Builders', engineers' and architects' institutes; the regulatory councils; Lagos and Abuja real-estate and developers' associations; technical colleges and trade-test bodies; universities; housing finance institutions; diaspora associations.

## 10. Launch plan

### Hub and territory setup

| Wizard step | Value |
|---|---|
| Starting point | Generic ISO profile for `NG`; CAC numbers as local additions until CTRY-NG |
| Territory | Country `NG`; region `NG-LA` (Lagos) for the first hub |
| Hub name | "Trustwork Nigeria" |
| Languages | `en`; `ha`, `yo`, `ig` after their packages |
| Currency, time zone | NGN, `Africa/Lagos` |
| Residency | Counsel to confirm NDPA cross-border transfer conditions for the hosting region |

### The operator team for Nigeria

| Function | AI roles from day one | Local human needed first | When to hire |
|---|---|---|---|
| Editorial | Writer, Fact-checker (Auto with review) | Editor-in-chief | Day one |
| Trust and claims | Claim assistant: CAC record, council registration, signatory tie, screening (Draft) | **Two** trust reviewers (fraud risk) | Week 9, before soft launch |
| Trust and safety | Moderation triage, Trust and safety assistant (Draft) | Moderator | Week 10 |
| Data | Collector on OCDS and NBS (Assisted) | Data steward | Founder |
| Support | Support triage (Act with review) with SMS and USSD | Support agent who speaks Pidgin and a major local language | Week 10 |
| Compliance | Licence checker, Sanctions review assistant | Compliance officer; Nigerian counsel; NDPC registration | Day one |

### Agent team tasks specific to Nigeria

- **Discovery:** companies from public awards; council registrations used only to verify claims; never pages for individuals.
- **Editorial:** building quality and safety guides, material quality, housing policy news; translations into Hausa, Yoruba and Igbo after native review.
- **Claims:** stricter recipe: register match plus signatory tie plus call-back; disputes and takeover protection; every potential screening match to human review.

### Outreach policy settings

`strict`; after counsel, possibly `notice_only` for organisation addresses. No SMS, WhatsApp or calls without recorded prior consent; do-not-disturb rules respected for transactional messages.

### Seed content plan

| Plan stage | Nigeria-specific seed guides |
|---|---|
| `stage.define` | Building with money from abroad; staged building |
| `stage.site_and_feasibility` | Land documents and verification; soil tests |
| `stage.design` | Why registered professionals matter; preventing collapses |
| `stage.permitting` | State building approvals (taxonomy file `NG.json`) |
| `stage.structure` | Concrete and reinforcement quality; spotting substandard materials |
| `stage.handover` | Records and warranties |

### First 90 days

| Week | Goal | AI operator team (autonomy) | Humans |
|---|---|---|---|
| 1 | Decisions | Setup assistant; Researcher brief | Founder; Nigerian counsel; accountant; NDPC registration started |
| 2 | CTRY-NG facts | Researcher drafts facts | Pack maintainer review |
| 3 | Install | Operations monitor | Second staff; ops engineer |
| 4 | Sources | Scout: NBS, BPP, councils, institutes | Data steward |
| 5 | Datasets | Collector on OCDS | Compliance officer |
| 6 | Sourced pages | Page assembler | Data steward |
| 7 | Newsroom | Writer, Fact-checker | Editor-in-chief |
| 8 | Guides | Draft only | Engineer reviewer; institute content agreement |
| 9 | Gates and trust | Evidence pack; claim assistant dry runs | Counsel; restore drill; two trust reviewers |
| 10 | Soft launch | Support triage; Moderation triage | Moderator; support agent; partner members invited |
| 11 | First event | Event drafts | Safety workshop with an institute |
| 12 | Review | Analytics reporter | KPI review; fraud review |
| 13 | Go-live | Evidence pack | Owner and counsel approvals |

### Costs (estimates)

The [generic cost model](../README.md#costs); add a second trust reviewer, SMS and USSD aggregator quotes, and translation review for three languages over time.

### KPIs

Generic KPIs plus: claims rejected for failed signatory ties (count); disputes and takeover attempts resolved; companies with council-verified professionals named with consent.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Fraud and impersonation | Strict recipes, two reviewers, takeover protection, screening |
| Security | No active site details publicly; staff safety at events |
| Currency volatility | Dated prices; no silent conversion |
| Data protection enforcement | NDPC registration; `strict` outreach |

### Approvals before going live

Operator and screening; counsel on terms, privacy notice (NDPA and GAID), registration tier, outreach mode, CAC and council data reuse, agent disclosure; NDPC registration; provider activations; the hub owner's switch (and the repository owner's for a Contribuda-operated hub).

### Feature gaps for Nigeria

CTRY-NG, LANG-HA, LANG-YO, LANG-IG, CHAN-002, ACCT-001, PAY-003, PLAN-005, REP-003, REG-002 (CAC and councils), PROC-003, ADDR-001, IDV-001 amended (NIN only through licensed verifiers).

## Sources

All accessed 2026-10-31.

- World Bank WDI API: see the [research note](../../research/top-10-launch-countries-2026-11.md#sources); [DataReportal, Digital 2026 Nigeria](https://datareportal.com/reports/digital-2026-nigeria).
- [HousingTV Africa, construction 2025](https://www.housingtvafrica.com/?p=34991); [Nairametrics, Q3 2025](https://nairametrics.com/2025/12/01/nigerias-gdp-rises-by-3-98-in-q3-2025-driven-by-strong-agricultural-and-industrial-growth/); [Daily Trust, Q2 2025](https://dailytrust.com/real-estate-construction-among-top-10-contributors-to-gdp-in-q2-2025); [HousingTV Africa, federal deficit estimate](https://www.housingtvafrica.com/?p=30349); [HousingTV Africa, 28 million and 800,000 a year](https://www.housingtvafrica.com/?p=34435) *(secondary)*.
- [ThisDay on Wocman](https://www.thisdaylive.com/2025/07/27/wocman-technology-unveils-digital-platform-to-reshape-nigerias-construction-industry); [Nairametrics on Wrkman](https://nairametrics.com/2022/12/23/wrkman-improving-the-gaps-for-home-services-sector-in-nigeria); [News Central on the artisans platform plan](https://newscentraltv.com/?p=307446) *(secondary)*.
- [Mondaq on GAID 2025](https://www.mondaq.com/nigeria/privacy-protection/1627428/key-regulatory-updates-under-the-2025-general-application-and-implementation-directive-gaid-issued-by-the-nigeria-data-protection-commission-ndpc); [The Nigeria Lawyer](https://thenigerialawyer.com/?p=417368); [SCP Law note on GAID 2025](https://resource.scp-law.com/2025/04/30/what-you-need-to-know-about-gaid-2025-and-data-protection-compliance/) *(secondary)*.
- [Open Contracting data registry](https://data.open-contracting.org/en/search/); companion market scan, [pull request #370](https://github.com/Contribuda/trustwork/pull/370).
