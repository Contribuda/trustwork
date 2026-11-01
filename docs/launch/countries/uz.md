# Uzbekistan: deep dive and launch plan

Rank 7 of 10 (score 75, estimate, medium uncertainty; [scorecard](../../research/top-10-launch-countries-2026-11.md#scorecard)). Status: **Proposed** playbook. Nothing here is implemented or legal advice; every legal point is a lead for counsel. Sources were accessed on 2026-10-31 unless stated; *(secondary)* marks press, law-firm notes and aggregators. Read the [generic playbook](../README.md) first.

## Summary

Uzbekistan is **the fastest technical launch on the list**: the country pack is a sourced v2 pack already in the repository (`packages/country-packs/packs/uz.json`: VAT, electronic invoices, electronic digital signature, card schemes, holidays, the procurement portal), and both interface languages people use, Uzbek in Latin script and Russian, are live. Construction is booming (completed construction work up 14.2 percent in January to September 2025; 15.9 million square metres of housing commissioned in 2025) and 89 percent of people are online. Two small local platforms for repair and construction masters exist. The hard parts are legal and reputational: **personal data of citizens must be stored in Uzbekistan**, consent is the primary basis for marketing (with new rules on promotional calls and messages reported from 1 November 2026), and the financial system carries Russia-related secondary-sanctions exposure. Russia is not a market and no Russian provider, platform or payment rail is ever used.

| Item | Value |
|---|---|
| Suggested first territory | Tashkent city, then Samarkand (the engine's existing example place `UZ-SA:samarkand`) and the Fergana valley |
| Languages | Uzbek, Latin script (`uz-Latn`, live, machine draft) default; Russian (`ru`, live) second; Uzbek Cyrillic and Karakalpak as later community requests |
| Currency, time zone | UZS; `Asia/Tashkent` |
| Country pack | Live (v2); launch facts below are leads to add with sources |
| Suggested first outreach mode after counsel | `strict` (also the discovery design's suggestion) |
| Fastest growth path | Developers and contractors, the procurement portal's suppliers, construction universities and colleges, Telegram-native content |

## 1. Construction market

| Indicator | Value | Source |
|---|---|---|
| Completed construction work | UZS 224,532.4 billion in January to September 2025, up 14.2 percent year on year | [Statistics Agency](https://stat.uz/en/press-center/news-of-committee/63665-zbekistonda-bazharilgan-urilish-ishlari-azhmi-10-7-ga-sgan-4) (release series; figures as reported by [Zamin](https://zamin.uz/en/uzbekistan/151167-construction-volume-in-uzbekistan-grows-by-10-trillion-uzs.html) *(secondary)*) |
| Individual housing construction | UZS 35.4 trillion in January to August 2025, up 13.3 percent | [Statistics Agency](https://stat.uz/en/press-center/news-of-committee/64414-8-ojda-35-4-trln-s-mlik-shakhsij-uj-zhojlar-urilgan-4) |
| Housing commissioned 2025 | 15.9 million square metres (preliminary), up 2.8 percent; Tashkent region, Khorezm and Fergana lead | [Statistics Agency](https://stat.uz/en/press-center/news-of-committee/66577-2025-yilda-15-9-mln-kv-m-turar-joylar-foydalanishga-topshirilgan-3); [Daryo](https://daryo.uz/en/2026/01/29/uzbekistan-commissions-159mn-sq-m-of-housing-in-2025-up-28-yy/) *(secondary)* |
| GDP growth 2025 | 7.7 percent | World Bank WDI |
| Population, urbanisation | 37.1 million; 51.0 percent urban | World Bank WDI |

**Segments.** (1) *Multi-storey residential* by developers in Tashkent and regional centres; (2) *individual houses* built by families, often over years; (3) *public infrastructure* (schools, roads, utilities); (4) *commercial and industrial zones*; (5) *renovation* of Soviet-era housing stock.

## 2. Pain points

| Who | Pain | What Trustwork offers |
|---|---|---|
| Families building or renovating | Finding a reliable "usta" (master); price disputes; no documentation | Plans and budget ranges; masters' portfolios confirmed by clients; quotes frozen once sent |
| Masters and small contractors | Work through Telegram channels and acquaintances; no portable reputation | Profiles and portfolios; REP-003 for those without a company |
| Developers and contractors | Procurement participation; trust with buyers of new flats | Sourced company pages; procurement opportunities (portal data, candidate) |
| Suppliers and manufacturers | Growing market, little structured product knowledge | Manufacturer pages with guides per plan step in Uzbek and Russian |

## 3. Competitors and adjacent platforms

| Product | What it is | Why a gap remains |
|---|---|---|
| Ustabor.uz | Platform and app connecting consumers with trade professionals for repair and construction across the country; photos of masters' work; contacts free per one listing | Directory of masters; no company pages from registers, plans or confirmed portfolios ([Ustabor](https://ustabor.uz/en/howitworks) *(vendor claim)*; [Dealroom](https://app.dealroom.co/companies/ustabor_uz) *(secondary)*) |
| UBASE | App where customers find masters verified through MyID, the government identity system; a fixed fee after the third order | New; identity check but no evidence-based reputation ([UBASE](https://ubase-website.pages.dev/en/masters) *(vendor claim)*) |
| Telegram channels and groups, classifieds | Where most masters and buyers meet | No verification, no evidence |

## 4. Culture and trust

- **Finding masters:** relatives, neighbours ("mahalla" networks), Telegram groups and channels, and building-material bazaars.
- **Digital habits:** 33.1 million internet users (89.0 percent), Instagram ad reach 14.1 million, Facebook only 2.3 million, median mobile download 55.51 Mbps ([DataReportal Digital 2026 Uzbekistan](https://datareportal.com/reports/digital-2026-uzbekistan)); Telegram is the dominant messenger (not reported by DataReportal). A Telegram channel adapter is not designed yet: noted for CHAN-001's adapter list (subject to Telegram's terms and the hub's legal review).
- **Languages and scripts:** Uzbek in Latin script is official; many adults still read Cyrillic Uzbek; Russian is widely used in business and in Tashkent. The hub keeps Russian as an interface language only; the brand stays Trustwork (the Russian-language name appears only in the Russian interface).
- **Calendar:** Navruz (21 March), Ramazan and Qurbon Hayit (dates from the pack), Independence Day (1 September), Teachers' Day, Constitution Day; hot summers and cold winters shape the building season.

## 5. Law and compliance (for counsel)

| Topic | What we found | Source | Counsel question |
|---|---|---|---|
| Data residency | Personal data of citizens must be processed and stored on servers in Uzbekistan (Law on Personal Data ZRU-547, article 27-1 as amended in 2021; pack fact at `pending` level) | [`uz.json` data residency](../../../packages/country-packs/packs/uz.json); [lex.uz](https://lex.uz/docs/4396428) | Confirm the article; whether backups and model egress of public data are allowed abroad |
| Personal data register | Databases to be registered in the State Register of Personal Data (discovery design, secondary sources) | [Pull request #368](https://github.com/Contribuda/trustwork/pull/368) | Registration duty for the hub |
| Promotional messages | Promotional calls and SMS without consent barred, and from 18:00 to 09:00 altogether, from 1 November 2026 according to press reports cited by the discovery design | [Pull request #368](https://github.com/Contribuda/trustwork/pull/368) | Whether the rules cover e-mail and page notices |
| Company registers | Unified state register of enterprises (statistics agency; pack fact at `candidate`); STIR tax identifier | [`uz.json`](../../../packages/country-packs/packs/uz.json) | Reuse terms |
| Procurement | Special information portal for state procurement (`xarid.uzex.uz`, pack fact `official`); no open OCDS publication | [`uz.json`](../../../packages/country-packs/packs/uz.json) | Reuse of notices |
| Tax and e-invoicing | VAT 12 percent; mandatory electronic invoices through licensed operators (pack facts `official`) | [`uz.json`](../../../packages/country-packs/packs/uz.json) | Operator invoices |
| E-signature | Electronic digital signature with a key certificate (Law ZRU-793, pack fact `official`) | [`uz.json`](../../../packages/country-packs/packs/uz.json) | Signatory tie in claims |
| Construction licensing | Licensing of design and construction activities (to be sourced) | To source | Which licences are public |
| Sanctions | Secondary-sanctions exposure in the region's financial system (companion scan); Russia is not a market; the restricted-places list and screening apply | [Companion scan, pull request #370](https://github.com/Contribuda/trustwork/pull/370) | Bank and payment partner due diligence |

## 6. Payments

| Rail | Notes |
|---|---|
| Uzcard and Humo | National card schemes (pack fact `secondary`) through a licensed acquirer or payment organisation configured per hub |
| Central bank instant payments | Pack fact `candidate` |
| Local payment apps | Licensed payment organisations widely used for everyday payments (candidates to evaluate in PAY-003); never a Russian provider or rail |

Account ownership 59.7 percent (World Bank Findex 2024).

## 7. Local data resources for automated filling

| Resource | What it gives | Access method | Licence and terms | Freshness | Personal data caveat |
|---|---|---|---|---|---|
| Statistics Agency | Construction, housing, regional data; unified register (candidate) | [stat.uz](https://stat.uz/en/press-center/news-of-committee/66577-2025-yilda-15-9-mln-kv-m-turar-joylar-foydalanishga-topshirilgan-3) releases | Public | Monthly | None for statistics |
| State procurement portal | Notices and results | [xarid.uzex.uz](https://xarid.uzex.uz/) | Terms to check | Daily | Officials' names |
| National open data portal | Ministry and region datasets | Portal (to confirm) | Per dataset | Varies | Varies |
| Legal database | Laws and regulations | [lex.uz](https://lex.uz/docs/4396428) | Public | Continuous | None |
| Construction universities and colleges | Courses, graduates (holder-presented credentials) | Partnerships | Partner licence | — | Holder-presented only |
| OpenStreetMap | Places, mahallas | Extracts | ODbL | Continuous | None |

## 8. Infrastructure realities

High internet use and good mobile speeds; **hosting must be in Uzbekistan** for personal data, which narrows provider choice and may raise costs; model routes for non-public data must run in-country or not at all (egress policy). Telegram is the expected channel.

## 9. Partners to approach (kinds only)

Construction and developers' associations, the chamber of commerce and industry, construction universities and technical colleges, building-material manufacturers, regional administrations' construction departments (for public information only), international development programmes working on housing and energy efficiency.

## 10. Launch plan

### Hub and territory setup

| Wizard step | Value |
|---|---|
| Starting point | Country pack `UZ` (v2, version pinned) |
| Territory | Country `UZ`; region `UZ-TK` (Tashkent city) for the first hub; Samarkand next |
| Hub name | "Trustwork Ozbekiston" in `uz-Latn`, Russian spelling in `ru` (the brand rule applies) |
| Languages | `uz-Latn` default, `ru` |
| Currency, time zone | UZS, `Asia/Tashkent` |
| Residency | Uzbekistan for database, storage and backups (the wizard warns if an endpoint resolves elsewhere); egress of non-public data off |

### The operator team for Uzbekistan

| Function | AI roles from day one | Local human needed first | When to hire |
|---|---|---|---|
| Editorial | Writer, Fact-checker, Translator between Uzbek and Russian (Auto with review) | Editor-in-chief fluent in Uzbek and Russian | Day one; a native Uzbek reviewer from week 2 (the `uz-Latn` interface is a machine draft) |
| Data | Collector on statistics releases and procurement notices (Assisted) | Data steward | Founder |
| Trust and claims | Claim assistant: STIR, register, e-signature tie (Draft) | Trust reviewer | Week 10 |
| IT operations | Operations monitor | **In-country hosting partner** and ops engineer | Week 1 (residency decides hosting before install) |
| Compliance | Licence checker, Sanctions review assistant | Compliance officer; Uzbek counsel | Day one |
| Community | Moderation triage | Community manager for Telegram-native audiences | Week 10 |

### Agent team tasks specific to Uzbekistan

- **Pack work:** add sourced facts for construction licensing, building permits, the personal-data register and the 2026 advertising rules; raise `pending` and `candidate` facts where official sources are found.
- **Discovery:** procurement-portal suppliers in construction categories where terms allow; manufacturers' public sites.
- **Editorial:** housing and construction statistics monthly; guides in Uzbek and Russian; a native review of `uz-Latn` interface strings (raise the review status honestly only after a named reviewer).

### Outreach policy settings

`strict`. No calls, SMS or Telegram outreach; any notice only after counsel confirms the scope of the 2026 rules and the personal-data register duty.

### Seed content plan

| Plan stage | Uzbekistan-specific seed guides |
|---|---|
| `stage.define` | Renovating a flat in an older building; building a family house in stages |
| `stage.design` | Seismic considerations; insulation for hot summers and cold winters |
| `stage.permitting` | Permits and notifications (taxonomy file to add with CTRY work on the pack) |
| `stage.contracting` | Choosing an usta; written agreements; payment in stages |
| `stage.handover` | Records and warranties |

### First 90 days

| Week | Goal | AI operator team (autonomy) | Humans |
|---|---|---|---|
| 1 | Decisions and hosting | Setup assistant; Researcher brief | Founder; Uzbek counsel; in-country hosting chosen |
| 2 | Pack facts | Researcher drafts licensing, permits, register facts | Pack maintainer; native Uzbek reviewer |
| 3 | Install in-country | Operations monitor | Second staff; ops engineer |
| 4 | Sources | Scout: stat.uz, lex.uz, procurement portal, associations | Data steward |
| 5 | Datasets | Collector | Compliance officer; personal-data register filing if required |
| 6 | Sourced pages | Page assembler | Data steward |
| 7 | Newsroom | Writer, Translator (Auto with review) | Editor-in-chief |
| 8 | Guides | Draft only | Engineer reviewer; university partner |
| 9 | Gates | Evidence pack | Counsel; restore drill on the in-country stack |
| 10 | Soft launch | Claim assistant; Support triage | Trust reviewer; community manager |
| 11 | First event | Event drafts | Meetup with a university or association |
| 12 | Review | Analytics reporter | KPI review |
| 13 | Go-live | Evidence pack | Owner and counsel approvals |

Avoid launch events during Ramazan evenings and the Navruz holidays.

### Costs (estimates)

The [generic cost model](../README.md#costs), with in-country hosting quotes (likely above the generic range) and either in-country model hosting or model use for public data only.

### KPIs

Generic KPIs plus: share of published items in Uzbek; native-review progress of the `uz-Latn` interface; masters with client-confirmed portfolios.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Data residency | In-country stack; egress off for non-public data; wizard warnings |
| Secondary sanctions exposure | Screening of operator, partners and payees; licensed providers with their own due diligence; no Russian providers |
| Marketing rules from 2026 | `strict` outreach |
| Machine-draft language quality | Native reviewer before soft launch |

### Approvals before going live

Operator and screening; counsel on residency, the personal-data register, the 2026 advertising rules, procurement data reuse, agent disclosure; the in-country hosting decision recorded by a second person; provider activations; the hub owner's switch (and the repository owner's for a Contribuda-operated hub).

### Feature gaps for Uzbekistan

Pack facts for licensing, permits and outreach law (pack maintenance on `uz.json`; outreach facts through OUTR-001 once merged); REG-002 (statistics register, licences); PAY-003 (national card schemes and licensed payment organisations); REP-003; a Telegram adapter noted for CHAN-001; IDV-001 amended (MyID only through licensed verifiers).

## Sources

All accessed 2026-10-31.

- World Bank WDI API: see the [research note](../../research/top-10-launch-countries-2026-11.md#sources); [DataReportal, Digital 2026 Uzbekistan](https://datareportal.com/reports/digital-2026-uzbekistan).
- Statistics Agency: [housing 2025](https://stat.uz/en/press-center/news-of-committee/66577-2025-yilda-15-9-mln-kv-m-turar-joylar-foydalanishga-topshirilgan-3), [individual housing](https://stat.uz/en/press-center/news-of-committee/64414-8-ojda-35-4-trln-s-mlik-shakhsij-uj-zhojlar-urilgan-4), [construction works](https://stat.uz/en/press-center/news-of-committee/63665-zbekistonda-bazharilgan-urilish-ishlari-azhmi-10-7-ga-sgan-4); [Daryo](https://daryo.uz/en/2026/01/29/uzbekistan-commissions-159mn-sq-m-of-housing-in-2025-up-28-yy/) *(secondary)*; [Zamin](https://zamin.uz/en/uzbekistan/151167-construction-volume-in-uzbekistan-grows-by-10-trillion-uzs.html) *(secondary)*.
- [Ustabor](https://ustabor.uz/en/howitworks); [Dealroom on Ustabor](https://app.dealroom.co/companies/ustabor_uz); [UBASE](https://ubase-website.pages.dev/en/masters).
- [lex.uz, Law ZRU-547](https://lex.uz/docs/4396428); the Uzbekistan pack in `packages/country-packs/packs/uz.json`; [xarid.uzex.uz](https://xarid.uzex.uz/).
- Discovery and outreach design, [pull request #368](https://github.com/Contribuda/trustwork/pull/368); companion market scan, [pull request #370](https://github.com/Contribuda/trustwork/pull/370).
