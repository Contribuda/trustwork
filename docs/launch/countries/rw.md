# Rwanda: deep dive and launch plan

Rank 10 of 10 (score 72, estimate, medium uncertainty; [scorecard](../../research/top-10-launch-countries-2026-11.md#scorecard)). Status: **Proposed** playbook. Nothing here is implemented or legal advice; every legal point is a lead for counsel. Sources were accessed on 2026-10-31 unless stated; *(secondary)* marks press, law-firm notes and aggregators. Read the [generic playbook](../README.md) first.

## Summary

Rwanda is **the fastest-growing economy on the list (9.4 percent in 2025, 11.2 percent in the fourth quarter) with construction output up 20 percent in the third quarter**, a government that digitises public services (building permits moved to the new Kubaka system in 2025; procurement data published daily in OCDS) and almost no competition. English is a live interface language; Kinyarwanda (proposed LANG-RW) reaches far more people. Rwanda takes the tenth place on a tie-break: it is small (14.6 million people), internet use is low (31.7 percent by the ITU measure), personal data must be stored in Rwanda unless the cyber security authority authorises otherwise, and the United States sanctioned a Rwandan minister in 2025 over the conflict in eastern Congo, which counsel and payment partners will weigh.

| Item | Value |
|---|---|
| Suggested first territory | City of Kigali |
| Languages | English (`en`, live); Kinyarwanda (`rw`, proposed LANG-RW); French optional (LANG-FR); Swahili optional (LANG-SW) |
| Currency, time zone | RWF; `Africa/Kigali` |
| Country pack | Proposed CTRY-RW |
| Suggested first outreach mode after counsel | `strict` |
| Fastest growth path | The engineers' institution and architects' institute, technical training board graduates, Kigali developers, permit-literate content |

## 1. Construction market

| Indicator | Value | Source |
|---|---|---|
| GDP growth 2025 | 9.4 percent; 11.2 percent in the fourth quarter | World Bank WDI; [NISR GDP fourth quarter 2025](https://statistics.gov.rw/sites/default/files/documents/2026-03/GDP%20Q4%202025.pdf) |
| Construction | Up 20 percent in the third quarter of 2025, linked to cement and building materials; quarterly construction GDP RWF 649 billion in the fourth quarter (aggregator) | [The New Times (NISR)](https://www.newtimes.co.rw/article/32017/news/economy/economy-records-double-digit-growth-in-third-quarter) *(secondary)*; [Trading Economics](https://tradingeconomics.com/rwanda/gdp-from-construction) *(secondary)* |
| Industry outlook | The African Export-Import Bank projected about USD 1.4 billion for the construction industry in 2025 | [Construction Kenya](https://www.constructionkenya.com/?p=12348) *(secondary)* |
| Population, urbanisation | 14.6 million; 30.9 percent urban, urban growth 5.6 percent a year (the fastest on the list) | World Bank WDI |

**Segments.** (1) *Kigali housing* (affordable and middle-income estates, self-built houses under master-plan rules); (2) *public buildings and infrastructure*; (3) *commercial and conference* construction in Kigali; (4) *secondary cities* growing under the urbanisation policy.

## 2. Pain points

| Who | Pain | What Trustwork offers |
|---|---|---|
| Homeowners | Permit rules tied to master plans; finding qualified professionals | Plans that include the permit path; consultations with registered engineers and architects |
| Workers | Skills from technical schools invisible to clients | Credentials presented by the holder (REP-003) |
| Contractors | Small market, public tenders dominant | Opportunities and awards from OCDS; claimable pages |
| Professionals | Many permit applications need a professional | Profiles with registration as claim evidence; consultations |

## 3. Competitors and adjacent platforms

No national platform for contractor reputation or plans was found in this research (light scan). Adjacent: the government's permit and procurement systems (data sources, not gathering points) and regional platforms from Kenya.

## 4. Culture and trust

- **Finding builders:** family, community and church networks, WhatsApp groups and professionals who prepare permit files.
- **Digital habits:** 31.7 percent internet use (World Bank WDI, ITU 2024) and 93 mobile subscriptions per 100 people; mobile money is common (account ownership 50 percent in the 2017 Findex; no newer figure in the World Bank API). Basic phones are common: SMS and USSD matter (CHAN-002).
- **Languages:** Kinyarwanda (spoken by almost everyone), English, French and Swahili are official.
- **Calendar:** national holidays including the commemoration period in April (the hub pauses promotional content and events then); two rainy seasons.

## 5. Law and compliance (for counsel)

| Topic | What we found | Source | Counsel question |
|---|---|---|---|
| Data residency | Law 058/2021 on personal data: controllers and processors register with the National Cyber Security Authority; storage outside Rwanda only with a registration certificate that authorises it; transfers abroad only on listed conditions and a written contract | [DLA Piper](https://www.dlapiperdataprotection.com/?c=RW&t=law) *(secondary)*; [Hogan Lovells](https://www.hoganlovells.com/en/publications/key-features-of-the-new-rwandan-data-protection-law) *(secondary)*; [PwC Rwanda](https://www.pwc.com/rw/en/assets/pdf/legal-alert-navigating-cross-border-data-transfer.pdf) *(secondary)* | Host in Rwanda, or apply for authorisation to store abroad? |
| Building permits | Kubaka replaced the Building Permit Management Information System in 2025, validates applications against master plans and lets new land buyers keep approved permits | [Ministry of Infrastructure](https://www.mininfra.gov.rw/updates/news-details/rwanda-launches-2025-national-urbanisation-policy-and-unveils-kubaka-the-new-and-enhanced-building-permit-system-to-boost-smart-urban-development); [The New Times](https://www.newtimes.co.rw/article/26114/news/featured/rwanda-launches-upgraded-building-permit-platform-revised-national-urbanisation-policy) *(secondary)* | Is any permit data open for reuse? |
| Building categories | A ministerial order determines building categories and permit conditions | [Ministerial order on BPMIS](https://bpmis.gov.rw/asset_uplds/files/Ministerial%20Order%20determining%20the%20instructions%20of%20categorization%20of%20buildings%2C%20and%20conditions%20and%20procedure%20for%20demand%20and%20granting%20building%20permit.pdf) | Taxonomy answers in `RW.json` |
| Public procurement | Rwanda Public Procurement Authority; OCDS publication listed as daily | [OCDS registry](https://data.open-contracting.org/en/search/) | Reuse licence |
| Professionals | Institution of Engineers Rwanda; Rwanda Institute of Architects (to be sourced) | To source | Verification use |
| Company registration, tax, e-signature | Rwanda Development Board registration; tax authority and electronic billing; e-signature law (to be sourced) | To source | Signatory tie |
| Sanctions | OFAC designated James Kabarebe, Minister of State for Regional Integration, on 20 February 2025 under E.O. 13413 (Congo); no country-wide sanctions | [US Treasury](https://home.treasury.gov/news/press-releases/sb0022) | Screening of public-sector counterparties; partner due diligence |

## 6. Payments

Mobile money (two operators), interoperable switching and cards through licensed providers (candidates in PAY-003; to be sourced in CTRY-RW). Trustwork never holds money.

## 7. Local data resources for automated filling

| Resource | What it gives | Access method | Licence and terms | Freshness | Personal data caveat |
|---|---|---|---|---|---|
| RPPA OCDS | Tenders, awards, contracts | OCDS publication (daily) | Licence per publication | Daily | Officials' names |
| NISR | GDP, construction, census | Releases | Public | Quarterly | None |
| Kubaka and the permit knowledge centre | Permit rules, categories, guidance documents | [bpmis.gov.rw](https://bpmis.gov.rw) and kubaka.gov.rw | Public documents; terms to check | Updated with policy | Applicants are persons: no reuse of applications |
| Professional bodies | Registered engineers and architects | Registers where public | Terms to check | Continuous | Verify own claims only |
| Rwanda Development Board | Company registration | Online services | Terms to check | Continuous | Persons |
| OpenStreetMap | Places | Extracts | ODbL | Continuous | None |

## 8. Infrastructure realities

Good 4G coverage in Kigali, low internet use nationally; SMS and USSD (CHAN-002), low-bandwidth pages (MOB-001); **in-country hosting** unless authorised otherwise.

## 9. Partners to approach (kinds only)

The engineers' institution, the architects' institute, the private sector federation's construction chamber, the technical and vocational training board and polytechnics, the housing authority's public guidance, universities, development partners active in urbanisation and housing.

## 10. Launch plan

### Hub and territory setup

| Wizard step | Value |
|---|---|
| Starting point | Generic ISO profile for `RW` until CTRY-RW |
| Territory | Country `RW`; region `RW-01` (City of Kigali) |
| Hub name | "Trustwork Rwanda" |
| Languages | `en`; `rw` after LANG-RW |
| Currency, time zone | RWF, `Africa/Kigali` |
| Residency | Rwanda, or a recorded authorisation; the wizard records the decision |

### The operator team for Rwanda

| Function | AI roles from day one | Local human needed first | When to hire |
|---|---|---|---|
| Editorial | Writer, Fact-checker, Translator to Kinyarwanda (Auto with review) | Editor-in-chief; Kinyarwanda reviewer | Day one; reviewer by week 7 |
| Data | Collector on RPPA OCDS and NISR (Assisted) | Data steward (founder) | Founder |
| Trust and claims | Claim assistant (Draft) | Trust reviewer | Week 10 |
| IT operations | Operations monitor | In-country hosting partner | Week 1 |
| Compliance | Licence checker, Sanctions review assistant | Compliance officer; Rwandan counsel; NCSA registration | Day one |

### Agent team tasks specific to Rwanda

- **Discovery:** companies from RPPA awards; manufacturers and suppliers from public sites.
- **Editorial:** Kubaka and permit explainers (from public guidance, cited), urbanisation policy news, building categories; Kinyarwanda editions after native review.
- **Commemoration period:** the editorial calendar pauses promotional content in April (a calendar note in the pack).

### Outreach policy settings

`strict`; counsel to advise on Law 058/2021 before any notice. No SMS or calls without recorded prior consent.

### Seed content plan

| Plan stage | Rwanda-specific seed guides |
|---|---|
| `stage.site_and_feasibility` | Checking a plot against the master plan |
| `stage.permitting` | Building categories and the Kubaka path (taxonomy file `RW.json`) |
| `stage.design` | When a registered professional is required |
| `stage.contracting` | Contracts and milestones |
| `stage.handover` | Occupation permits and records |

### First 90 days

| Week | Goal | AI operator team (autonomy) | Humans |
|---|---|---|---|
| 1 | Decisions and hosting | Setup assistant; Researcher brief | Founder; Rwandan counsel; in-country hosting or authorisation path |
| 2 | CTRY-RW facts | Researcher drafts facts | Pack maintainer review |
| 3 | Install | Operations monitor | Second staff; ops engineer |
| 4 | Sources | Scout: NISR, RPPA, ministries, professional bodies | Data steward |
| 5 | Datasets | Collector on OCDS | Compliance officer; NCSA registration |
| 6 | Sourced pages | Page assembler | Data steward |
| 7 | Newsroom | Writer, Translator | Editor-in-chief; Kinyarwanda reviewer |
| 8 | Guides | Draft only | Engineer reviewer |
| 9 | Gates | Evidence pack | Counsel; restore drill |
| 10 | Soft launch | Claim assistant; Support triage | Trust reviewer; professional bodies invite members |
| 11 | First event | Event drafts | Professional development session |
| 12 | Review | Analytics reporter | KPI review |
| 13 | Go-live | Evidence pack | Owner and counsel approvals |

Do not schedule launches or promotional events during the April commemoration period.

### Costs (estimates)

The [generic cost model](../README.md#costs), with in-country hosting quotes (or the cost of an authorisation process) and a Kinyarwanda reviewer.

### KPIs

Generic KPIs plus: permit-path guides viewed per plan (aggregate); professionals with claimed profiles; Kinyarwanda share of published items.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Data residency | In-country stack or recorded authorisation |
| Small market | Peer with a Kenya hub and East African hubs; shared Swahili and English content |
| Sanctions on an official | Screening of counterparties; partner due diligence; no political content |
| Low internet use | SMS and USSD channels; partners' offline events |

### Approvals before going live

Operator and screening; counsel on Law 058/2021 residency and registration, outreach mode, OCDS reuse, agent disclosure; NCSA registration; hosting decision by a second person; provider activations; the hub owner's switch (and the repository owner's for a Contribuda-operated hub).

### Feature gaps for Rwanda

CTRY-RW, LANG-RW, CHAN-002, ACCT-001, PAY-003, PROC-003 (RPPA OCDS), REG-002 (RDB, engineers' register), REP-003.

## Sources

All accessed 2026-10-31.

- World Bank WDI API: see the [research note](../../research/top-10-launch-countries-2026-11.md#sources).
- [NISR GDP fourth quarter 2025](https://statistics.gov.rw/sites/default/files/documents/2026-03/GDP%20Q4%202025.pdf); [The New Times on the third quarter](https://www.newtimes.co.rw/article/32017/news/economy/economy-records-double-digit-growth-in-third-quarter); [Trading Economics](https://tradingeconomics.com/rwanda/gdp-from-construction); [Construction Kenya on the AfreximBank outlook](https://www.constructionkenya.com/?p=12348) *(secondary)*.
- [DLA Piper on Rwanda's data protection law](https://www.dlapiperdataprotection.com/?c=RW&t=law); [Hogan Lovells](https://www.hoganlovells.com/en/publications/key-features-of-the-new-rwandan-data-protection-law); [PwC Rwanda on cross-border transfers](https://www.pwc.com/rw/en/assets/pdf/legal-alert-navigating-cross-border-data-transfer.pdf) *(secondary)*.
- [Ministry of Infrastructure on Kubaka](https://www.mininfra.gov.rw/updates/news-details/rwanda-launches-2025-national-urbanisation-policy-and-unveils-kubaka-the-new-and-enhanced-building-permit-system-to-boost-smart-urban-development); [The New Times on Kubaka](https://www.newtimes.co.rw/article/26114/news/featured/rwanda-launches-upgraded-building-permit-platform-revised-national-urbanisation-policy) *(secondary)*; [ministerial order on building categories](https://bpmis.gov.rw/asset_uplds/files/Ministerial%20Order%20determining%20the%20instructions%20of%20categorization%20of%20buildings%2C%20and%20conditions%20and%20procedure%20for%20demand%20and%20granting%20building%20permit.pdf); [BPMIS knowledge centre](https://bpmis.gov.rw).
- [US Treasury, designation of 20 February 2025](https://home.treasury.gov/news/press-releases/sb0022); [Open Contracting data registry](https://data.open-contracting.org/en/search/).
