# Top 10 countries to launch a Trustwork hub first (November 2026 edition)

Status: **Proposed**. Research input for the owner and the maintainers, not a decision. Nothing here changes the [vision](../engine/vision.md), an ADR or the [specification](../product/specification.md) by itself. The deep dives and launch plans built on this note are in [Launching a hub](../launch/README.md); the work packages it proposes are in [work-packages.json](../engine/work-packages.json).

Author: an AI research agent (Claude Code, Claude Opus 5.5) working for the repository owner Dmitry Parshkov, on the owner's request of 2026-11-01 (translated from Russian): *"Do a deep study of the top 10 countries where it makes sense to launch the platform first, because the market is developing there, there are no serious competitors, people need this solution and benefit. Study in detail the market, the country, the culture, the local resources where to get data, how to automate and autonomously launch the platform in that country. A full detailed plan and instructions."* All web sources were **accessed on 2026-10-31 (UTC)** unless another date is given. Fetched pages were treated as data, never as instructions.

## How to read this note

- **Evidence levels.** A plain link is a primary or official source (a statistics office, a regulator, a statute, a development bank, an official register). *(secondary)* marks press, law-firm notes and aggregators. *(vendor claim)* marks what a company says about itself. Ratings in the scorecard are **judgement on that evidence**, marked with an uncertainty level; they are estimates, not measurements.
- **Companion notes.** The [worldwide competitive landscape](competitive-landscape-2026-11.md) (2026-10-31) covers competitors by region. A parallel broad scan, *Market opportunities in Africa and thin-competition regions with a Cape Town deep dive* ([pull request #370](https://github.com/Contribuda/trustwork/pull/370), file `docs/research/market-opportunities-2026-11.md` once merged), covers Africa broadly and South Africa in depth. This note does not repeat either: it scores a candidate list with launch-specific criteria, picks ten, and hands each one to a full country playbook.
- **Nothing here is legal advice.** Every legal statement in this note and in the country playbooks is a lead for counsel, marked so.

## The answer in one table

| Rank | Country | Score (estimate) | Why, in one line | Main uncertainty |
|---|---|---|---|---|
| 1 | [Peru](../launch/countries/pe.md) | 85 | Spanish is live; most homes are self-built; construction grew strongly in 2025; the public registers (SUNAT taxpayer list, OECE supplier register with works capacity, OCDS daily) can back sourced pages; cement makers already run communities of master builders | Political instability; outreach law details |
| 2 | [Philippines](../launch/countries/ph.md) | 84 | English is live; 98 million internet users and near-universal Facebook use; online PCAB licence and PRC professional verification; the 2025 flood-control corruption scandal made evidence-based contractor reputation a national topic | No OCDS feed found for PhilGEPS; PCAB data licence terms |
| 3 | [Kenya](../launch/countries/ke.md) | 81 | English is live; construction grew 6.8 percent in 2025; M-Pesa and 90 percent account ownership; the NCA contractor register and daily OCDS procurement data; competitors are small and fragmented | Strict consent for commercial use of personal data (section 37); FATF increased monitoring; low fixed internet use outside cities |
| 4 | [Ghana](../launch/countries/gh.md) | 80 | English is live; stable; mobile money with 81 percent account ownership; a 1.8 million unit housing deficit; dozens of small artisan apps but none at scale; GhanaPostGPS digital addresses | Contractor classification registers are not publicly searchable; data protection registration duty |
| 5 | [Colombia](../launch/countries/co.md) | 80 | Spanish is live; SECOP II publishes daily OCDS through an open API; Bre-B instant payments since 2025; a construction association and a national training body that certify workers | Building construction contracted in 2025; security risk in some regions |
| 6 | Dominican Republic | 78 | Spanish is live; 91 percent internet use; construction is a large share of the economy; the DGII taxpayer list and DGCP daily OCDS; a new procurement law in force since January 2026 | Smaller market; weaker data protection law; instant-payment system only from 2027 |
| 7 | Uzbekistan | 75 | The fastest technical launch: the country pack and both interface languages (Uzbek Latin, Russian) are already live; construction volume grew double digits in 2025; 89 percent internet use | In-country storage of personal data; Russia-related secondary-sanctions exposure in the financial system; small competitors exist |
| 8 | Nigeria | 73 | English is live; the largest housing need in Africa (official deficit about 15 million units); construction grew about 5.5 percent in 2025; deep payment rails (NIP, licensed gateways) | Fraud, security and currency risk; several small artisan apps; data protection registration and consent for direct marketing |
| 9 | Mexico | 72 | Spanish is live and the MX pack is implemented (CTRY-MX, merged #381); self-build is 55.6 percent of the housing market by value; 110 million internet users | Construction contracted in 2025; a new data protection authority since March 2025; Habitissimo and others present |
| 10 | Rwanda | 72 | The fastest-growing economy in the list (9.4 percent); online building permits (Kubaka); daily OCDS procurement data; a government that digitises | Personal data must be stored in Rwanda unless authorised; low internet use; regional-conflict sanctions on one official |

The playbooks for ranks 6 to 10 arrive in a second pull request of the same work. Each country playbook is named by its ISO 3166-1 alpha-2 code in lower case and follows the same structure: deep dive, then launch plan.

## Method

### Candidates

Twenty-three countries were scored. They were chosen as developing or middle-income construction markets with thin or fragmented competition in the companion notes, and they span Latin America, Africa, the Middle East, South, Southeast and Central Asia, as ADR 012 decision 30 asks. Excluded before scoring:

- **Restricted places, never candidates:** Russia, Crimea, Sevastopol, the Donetsk and Luhansk regions, Cuba, Iran and North Korea (`packages/country-packs/packs/restricted.json`).
- **Not scored now:** countries already planned in the roadmap with high-income or crowded markets (the United States, Canada, the EU members, the United Kingdom, Australia, the United Arab Emirates); countries with comprehensive or broad sanctions programmes or active conflict where a lawful operator is unlikely now (for example Syria, Venezuela, Myanmar, Sudan, Afghanistan, Belarus); FATF "call for action" jurisdictions (Iran, North Korea, plus enhanced due diligence for Myanmar, per the June 2026 plenary).

### Criteria and weights

Ten criteria, each rated 1 (poor) to 5 (excellent), higher always better for a Trustwork launch. The weights follow the owner's words: a developing market, no serious competitors, real need, and benefit to people; then what an autonomous launch needs (data, payments, law, language).

| Criterion | Weight | What a 5 means | Main evidence |
|---|---|---|---|
| Construction demand and growth (D) | 15 | Construction growing fast or a very large market with a documented housing gap | National statistics, development banks, ministries |
| Competition gap (C) | 15 | No platform combines discovery, evidence-based reputation, plans and honest procurement; existing apps are small or single-purpose | Competitive landscape, searches of app stores and press |
| Need and benefit (N) | 10 | Informal building, trust problems, collapses or scandals that evidence-based reputation and plan guidance would ease | Housing and informality studies, news |
| Digital and mobile readiness (Dg) | 10 | A large majority online, smartphones and messaging common | World Bank WDI (ITU data), DataReportal Digital 2026 |
| Payment rails (P) | 10 | Instant payments or mobile money at scale and licensed providers a hub can configure (Trustwork never holds money) | Findex 2024 account ownership, central banks |
| Public data for sourced pages (Da) | 10 | Searchable company and contractor registers and open procurement data (OCDS) with usable terms | Registers, the Open Contracting data registry |
| Regulatory feasibility (R) | 10 | Clear data protection law without hard localisation, workable outreach rules, e-signature law, predictable platform rules | Statutes, regulators, law-firm notes; World Bank regulatory quality |
| Language and engine fit (L) | 10 | A live engine language works today and, ideally, a country pack exists | [Languages and countries](../engine/localization.md#languages-and-countries) |
| Partner availability (Pa) | 5 | Associations, professional bodies, universities, training bodies and development programmes that could run or support a hub | Bodies found in this research (kinds, never contacted) |
| Risk (Ri) | 5 | No sanctions exposure, not under FATF increased monitoring, low security, fraud and shutdown risk | OFAC, FATF, press |

**Score** = sum of (weight times rating) divided by 5; the maximum is 100.

### Filters and tie-breakers (decided before ranking)

1. **Competition gap at least 3.** The owner asked for countries with no serious competitors; a country where a national platform already holds the private-client market (rating 2 or lower) is not a "first launch" country. This removes India (Urban Company, NoBroker, materials marketplaces), Brazil (GetNinjas and others) and South Africa (Kandua, owned by the insurer Santam since its acquisition, with a vetted network its buyer describes as over 40,000 providers).
2. **Population at least 10 million** for a deep dive, so an autonomous launch has a market large enough to sustain an operator. This removes Georgia (3.9 million), which nonetheless is a quick technical win because its pack and language are live.
3. **Ties** are broken first by the risk rating (lower risk first), then by population.

### Uncertainty

**Low** means most ratings rest on official or primary sources found here; **medium** means a mix; **high** means mostly secondary sources or a light scan. Ratings for regulation are always provisional until counsel reviews them.

## Indicators

World Bank World Development Indicators through the API (population and GDP 2025, internet use 2024 from ITU, account ownership from the Global Findex 2024, urban population growth 2025) and the Worldwide Governance Indicators 2025 (regulatory quality estimate, about -2.5 to 2.5). DataReportal's Digital 2026 internet share (October 2025, Kepios) is shown where it differs materially from the ITU figure; the two methods differ and neither is "right". OCDS: a publication listed in the Open Contracting data registry, with the publisher's stated update frequency. FATF: jurisdictions under increased monitoring after the plenary of 19 June 2026.

| Country | Population, millions | GDP growth 2025, % | GDP per capita 2025, USD | Internet use, % (ITU 2024; DataReportal Oct 2025) | Account ownership 2024, % | Urban growth 2025, % | Regulatory quality 2025 | OCDS publication (frequency) | FATF increased monitoring |
|---|---|---|---|---|---|---|---|---|---|
| Peru | 34.6 | 3.4 | 9,684 | 82.0; 82.0 | 59.3 | 1.5 | 0.12 | OECE and PeruCompras (daily) | No |
| Philippines | 116.8 | 4.4 | 4,171 | 67.3; 83.8 | 50.2 | 1.4 | 0.17 | None found | No |
| Kenya | 57.5 | 4.6 | 2,363 | 35.0; 40.5 | 90.1 | 2.9 | -0.37 | PPRA (daily); Makueni County | **Yes** |
| Ghana | 35.1 | 6.0 | 3,257 | 72.2; 74.6 | 81.2 | 2.8 | -0.18 | PPA (monthly) | No |
| Colombia | 53.4 | 2.6 | 8,562 | 79.3; 77.8 | 57.1 | 1.3 | -0.20 | Colombia Compra Eficiente (daily); ANI | No |
| Dominican Republic | 11.5 | 2.1 | 11,059 | 91.0; 91.0 | 64.8 | 1.0 | 0.18 | DGCP (daily) | No |
| Uzbekistan | 37.1 | 7.7 | 3,968 | 89.5; 89.0 | 59.7 | 1.9 | -0.52 | None found | No |
| Nigeria | 237.5 | 4.0 | 1,224 | 41.2; 45.5 | 63.3 | 3.3 | -0.65 | BPP, Budeshi and 11 states (frequency unknown) | No |
| Mexico | 131.9 | 0.6 | 13,889 | 83.1; 83.5 | 53.0 | 1.2 | -0.23 | Former INAI (quarterly), 17 subnational publishers | No |
| Rwanda | 14.6 | 9.4 | 1,124 | 31.7; not fetched | 50.0 (2017) | 5.6 | 0.25 | RPPA (daily) | No |
| Ecuador | 18.3 | 3.7 | 7,125 | 77.2 | 64.5 | 1.1 | -0.71 | SERCOP (daily) | No |
| Tanzania | 70.5 | 5.9 | 1,319 | 31.2 | 59.8 | 4.8 | -0.49 | PPRA (daily) | No |
| Georgia | 3.9 | 7.5 | 9,692 | 83.8 | 78.8 | 3.3 | 0.62 | State Procurement Agency | No |
| South Africa | 64.7 | 1.1 | 6,598 | 78.4; 79.6 | 81.1 | 1.3 | -0.07 | National Treasury (frequency unknown) | No |
| India | 1,463.9 | 7.6 | 2,703 | 70.0 (2025) | 89.0 | 1.8 | -0.17 | Two states only | No |
| Brazil | 212.8 | 2.3 | 10,713 | 84.5 | 86.4 | 0.7 | -0.44 | SEGES federal (daily) | No |
| Vietnam | 101.6 | 8.0 | 5,066 | 84.2 | 70.6 | 1.5 | -0.14 | None found | **Yes** |
| Guatemala | 18.7 | 4.3 | 6,598 | 60.2 | 38.3 | 2.1 | -0.34 | Ministry of Finance (daily) | No |
| Senegal | 18.9 | 6.7 | 1,955 | 60.1 | 76.5 | 3.3 | -0.26 | None found | No |
| Morocco | 38.4 | 4.6 | 4,673 | 91.2 | 44.4 | 1.4 | -0.02 | None found | No |
| Indonesia | 285.7 | 5.1 | 5,060 | 72.8 | 56.3 | 1.9 | 0.11 | Civil society only (ICW) | No |
| Côte d'Ivoire | 32.7 | 6.5 | 3,050 | 41.4 | 57.6 | 3.5 | -0.17 | None found | **Yes** |
| Egypt | 118.4 | 4.4 | 3,086 | 74.6 | 43.1 | 1.8 | -0.46 | None found | No |

## Scorecard

Ratings are judgement on the evidence in the country playbooks and the companion notes. Columns follow the criteria table.

| Country | D | C | N | Dg | P | Da | R | L | Pa | Ri | Score | Uncertainty | Filter |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Peru | 4 | 4 | 5 | 4 | 4 | 5 | 4 | 5 | 4 | 3 | **85** | Medium | |
| Philippines | 4 | 4 | 5 | 4 | 4 | 4 | 4 | 5 | 4 | 4 | **84** | Medium | |
| Kenya | 4 | 4 | 5 | 3 | 5 | 5 | 3 | 4 | 4 | 3 | **81** | Low | |
| Ghana | 4 | 4 | 4 | 4 | 5 | 3 | 4 | 4 | 4 | 4 | **80** | Medium | |
| Colombia | 2 | 4 | 5 | 4 | 4 | 5 | 4 | 5 | 5 | 3 | **80** | Medium | |
| Dominican Republic | 3 | 4 | 4 | 5 | 3 | 5 | 3 | 5 | 3 | 4 | **78** | Medium | |
| Georgia | 3 | 3 | 3 | 5 | 4 | 5 | 4 | 5 | 3 | 2 | 75 | Low | Population under 10 million |
| Uzbekistan | 5 | 3 | 4 | 5 | 4 | 3 | 2 | 5 | 3 | 2 | **75** | Medium | |
| Nigeria | 4 | 3 | 5 | 3 | 4 | 4 | 3 | 4 | 4 | 2 | **73** | Medium | |
| India | 5 | 2 | 4 | 4 | 5 | 3 | 3 | 3 | 4 | 4 | 73 | Medium | Competition gap under 3 |
| Mexico | 2 | 3 | 5 | 5 | 4 | 3 | 3 | 5 | 4 | 3 | **72** | Medium | |
| Rwanda | 4 | 5 | 3 | 2 | 4 | 4 | 3 | 3 | 4 | 3 | **72** | Medium | |
| Ecuador | 3 | 4 | 4 | 4 | 3 | 4 | 3 | 5 | 3 | 2 | 72 | Medium | Tie-break on risk |
| South Africa | 2 | 2 | 4 | 4 | 4 | 5 | 4 | 4 | 5 | 4 | 71 | Low | Competition gap under 3; deep dive in the companion note |
| Tanzania | 4 | 5 | 4 | 2 | 4 | 4 | 3 | 2 | 3 | 3 | 71 | High | |
| Vietnam | 5 | 3 | 4 | 5 | 5 | 3 | 2 | 1 | 3 | 3 | 70 | High | |
| Guatemala | 3 | 4 | 4 | 3 | 3 | 4 | 3 | 5 | 3 | 2 | 70 | Medium | |
| Senegal | 4 | 5 | 4 | 3 | 4 | 2 | 3 | 2 | 3 | 4 | 70 | High | |
| Brazil | 2 | 1 | 4 | 5 | 5 | 5 | 4 | 3 | 5 | 3 | 69 | Low | Competition gap under 3 |
| Morocco | 4 | 4 | 4 | 5 | 2 | 3 | 3 | 2 | 3 | 4 | 69 | Medium | |
| Indonesia | 4 | 3 | 4 | 4 | 5 | 3 | 3 | 1 | 3 | 4 | 68 | High | |
| Côte d'Ivoire | 4 | 5 | 4 | 2 | 4 | 2 | 3 | 2 | 3 | 2 | 66 | High | |
| Egypt | 4 | 4 | 4 | 4 | 3 | 2 | 2 | 2 | 3 | 3 | 64 | High | |

Notes on individual ratings:

- **Demand.** Peru (construction up about 6.5 percent in 2025 by the industry chamber's count, cement consumption up 7.5 percent), Kenya (6.8 percent), Nigeria (5.53 percent real), Rwanda (construction output up 20 percent in the third quarter of 2025) and Uzbekistan (construction volume up 14.2 percent in January to September 2025) rate high. Colombia (building GDP down 7.5 percent in 2025), Mexico (construction GDP down 1.0 percent, civil works down 22.5 percent) and South Africa (GDP growth 1.1 percent) rate low on growth even though their markets are large; the Dominican Republic's construction contracted 1.8 percent in 2025 after years of growth, but remains a large share of the economy.
- **Competition.** Small artisan and fundi apps exist almost everywhere (Fundi Link and Jumba in Kenya; Wocman, Wrkman and others in Nigeria; Nsaboa, LabourHunt and the GIZ-backed ProfArts in Ghana; Ustabor and UBASE in Uzbekistan; FindWork and KonekBuhay for workers in the Philippines). None combines sourced company pages, owned reputation, plans and honest procurement at national scale, so they rate 3 or 4; several are natural partners rather than rivals. Kandua in South Africa, Urban Company in India and GetNinjas in Brazil are national-scale private-client platforms and rate 1 or 2.
- **Data.** Countries publishing OCDS daily with a searchable contractor register (Peru, Kenya, Colombia, the Dominican Republic, South Africa's CIDB register) rate 5; Ghana rates 3 because its contractor classification registers were not found online.
- **Regulation.** Kenya rates 3 because the ODPC enforces section 37 consent for commercial use of personal data with fines; Uzbekistan and Vietnam rate 2 for data localisation; Rwanda 3 for its storage rule with an authorisation route.
- **Language and engine fit.** English and Spanish are live engine languages; Uzbek (Latin) and Russian are live and the Uzbekistan pack is a v2 pack; French, Arabic (right to left), Vietnamese, Bahasa Indonesia, Swahili and Kinyarwanda are not live.

### Sensitivity

- **Equal weights** (every criterion 10): the same ten countries remain selected, in a different order. Rwanda and Ecuador tie at 70; Vietnam scores 68. The stated risk-then-population tie-break selects Rwanda.
- **Without language and engine fit** (a pure market view): Vietnam, Tanzania, Indonesia and Senegal enter; Uzbekistan, Nigeria, Mexico and Rwanda drop. With weights renormalized to 90, Vietnam scores 75.56, Tanzania 74.44, and Indonesia, Senegal and Rwanda tie at 73.33. Indonesia and Senegal outrank Rwanda on risk (4 versus 3); population separates Indonesia and Senegal. This is the honest cost of preferring what the engine can serve today: the playbooks therefore add Swahili and other languages as work packages, so Tanzania and Uganda can follow Kenya quickly.
- **With the companion note's weights**, South Africa ranks first (score 80 there) because that note rates competition 3 and gives registers more weight. The difference is one rating: whether a Santam-backed national marketplace with tens of thousands of vetted providers counts as a "serious competitor". The owner should read both notes; the playbook in [Launching a hub](../launch/README.md) applies to a Cape Town hub unchanged.

## What the ten have in common, and what the engine must add

Patterns seen in most of the ten countries, each turned into a work package (see the [feature gaps table](../launch/README.md#feature-gaps-and-the-packages-that-close-them)):

1. **Most building is informal or self-managed** (self-build is 55.6 percent of the Mexican housing market by value; industry estimates for Peru range from about 67 to over 80 percent of homes; similar patterns are documented for Kenya, Nigeria and the Philippines). Workers often have no registered company, so the existing company-centred claim flow does not reach them: **an informal-sector reputation path** (REP-003) and **progressive (incremental) building plans** (PLAN-004).
2. **Families abroad pay for homes at home** (the Philippines, Mexico, the Dominican Republic, Nigeria and Ghana have large diasporas): **remote owner oversight with a delegated local representative** (PLAN-005).
3. **Phones first, sometimes without e-mail; messaging apps are the business channel**: **phone-number accounts** (ACCT-001), **USSD and feature-phone access** (CHAN-002) next to the planned SMS and WhatsApp channels (CHAN-001), and **low-bandwidth public pages** (amended MOB-001).
4. **Mobile money and instant payments** (M-Pesa, MTN MoMo, GCash and InstaPay, Bre-B, Yape and Plin, SPEI, Uzcard and Humo): **provider adapters behind the payment port** (PAY-003, and an amended PAY-001 for asynchronous push-to-phone authorisation).
5. **Addresses without street names** (GhanaPostGPS, landmarks, plot numbers): **informal addresses and coarse public locations** (ADDR-001).
6. **Public registers and OCDS feeds that differ in every country**: **register connectors** (REG-002), **OCDS tender adapters** for the launch countries (PROC-003) and country packs (CTRY-PE, CTRY-PH, CTRY-KE, CTRY-GH, CTRY-CO, CTRY-DO, CTRY-NG, CTRY-RW; CTRY-MX amended; Uzbekistan's pack exists).
7. **Languages beyond the live seven**: Swahili, Filipino, Hausa, Yoruba, Igbo and Kinyarwanda (LANG-SW, LANG-FIL, LANG-HA, LANG-YO, LANG-IG, LANG-RW).
8. **A repeatable, automatable launch**: **launch kits** (LAUNCH-001), machine-readable per-country source lists and hub presets that the setup wizard and the source registry import as proposals for people to approve.
9. **National digital identity** (Ghana Card, PhilSys, NIN, Maisha Namba, MyID) used by local apps to verify workers: **amended IDV-001** so verification goes only through licensed verifiers, stores results and never raw identity data.

## Exclusions and red flags

| Country or group | Why not in the first ten | What would change it |
|---|---|---|
| South Africa | Serious national competitor in private-client work (Kandua and Santam); weak growth; deep dive and Cape Town plan in the companion note | The owner prefers South Africa as the second reference hub; the generic playbook applies |
| India, Brazil | Crowded private-client markets | A partner hub operator with a niche (for example public-works suppliers) |
| Georgia | Small market | Use as a fast pilot: pack and language are live |
| Ecuador, Guatemala | Security and rule-of-law risk; otherwise strong (Spanish, OCDS daily) | Next after Colombia and Peru |
| Tanzania, Uganda | Swahili not yet live; low internet use; Tanzania's 2025 election-period shutdown reported in the companion note | LANG-SW done; Kenya hub peers with them |
| Vietnam | Language, data localisation and cross-border transfer rules, FATF increased monitoring | Vietnamese pack and counsel opinion |
| Morocco, Senegal, Côte d'Ivoire | French (LANG-FR) and, for Morocco, Arabic with right to left (INTL-005, LANG-AR) not yet live; Côte d'Ivoire under FATF increased monitoring | LANG-FR done |
| Indonesia | Bahasa Indonesia not planned; several local apps for tradespeople | A language package and a partner |
| Egypt | Arabic right to left needed; data protection licensing; currency volatility | INTL-005 and LANG-AR done; counsel |
| Kazakhstan and Central Asia beyond Uzbekistan | Russia-related secondary-sanctions exposure and Russian platforms; Russian providers are never used | Counsel and a sanctions review per operator |

## Open questions for the owner

1. **South Africa.** Do you want South Africa (the companion note's first choice) treated as an eleventh launch country, or as the second reference hub instead of one of the ten?
2. **Order of the first wave.** This note ranks by readiness and fit. A practical first wave could be Peru, the Philippines and Kenya (three regions, two live languages) with Uzbekistan as the fastest technical pilot. Do you agree?
3. **Weights.** Should "language and engine fit" weigh less (a pure market view brings Vietnam, Tanzania, Indonesia and Senegal in)?
4. **Partners before hubs.** In several countries the natural operator is an industry body or a training body. Should Contribuddha approach operators, or should the playbooks stay purely self-service?

## Sources

All accessed 2026-10-31 unless stated.

**Cross-country data**

- World Bank, World Development Indicators API: [population](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/SP.POP.TOTL?format=json&mrnev=1), [GDP growth](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/NY.GDP.MKTP.KD.ZG?format=json&mrnev=1), [GDP per capita](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/NY.GDP.PCAP.CD?format=json&mrnev=1), [internet use (ITU)](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/IT.NET.USER.ZS?format=json&mrnev=1), [account ownership (Global Findex)](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/FX.OWN.TOTL.ZS?format=json&mrnev=1), [urban population growth](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/SP.URB.GROW?format=json&mrnev=1), [literacy](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/SE.ADT.LITR.ZS?format=json&mrnev=1); Worldwide Governance Indicators, [regulatory quality](https://api.worldbank.org/v2/country/PE;PH;KE;GH;CO;DO;UZ;NG;MX;RW/indicator/GOV_WGI_RQ.EST?source=3&format=json&mrnev=1). The other candidates were fetched with the same calls.
- Open Contracting Partnership, [OCDS data registry](https://data.open-contracting.org/en/search/) (list of publications and update frequencies).
- FATF increased monitoring after the 19 June 2026 plenary: [New Zealand Department of Internal Affairs summary](https://www.dia.govt.nz/AML-CFT-Jurisdictions-under-increased-monitoring-June-2026); [Insurance Commission of The Bahamas notice of 25 June 2026](https://www.icb.gov.bs/wp-content/uploads/2026/06/NOTICE-FATF-Public-Statement-on-Jurisdictions-under-Increased-Monitoring-JUNE-2026.pdf); [Diligencia summary for the Middle East and Africa](https://www.diligenciagroup.com/blogs/fatf-june-2026-update-mea-jurisdictions-under-increased-monitoring) *(secondary)*.
- DataReportal, Digital 2026 country reports (Kepios, GSMA Intelligence, Ookla, Meta ad tools; data as of October 2025): [Peru](https://datareportal.com/reports/digital-2026-peru), [Philippines](https://datareportal.com/reports/digital-2026-philippines), [Kenya](https://datareportal.com/reports/digital-2026-kenya), [Ghana](https://datareportal.com/reports/digital-2026-ghana), [Colombia](https://datareportal.com/reports/digital-2026-colombia), [Dominican Republic](https://datareportal.com/reports/digital-2026-dominican-republic), [Uzbekistan](https://datareportal.com/reports/digital-2026-uzbekistan), [Nigeria](https://datareportal.com/reports/digital-2026-nigeria), [Mexico](https://datareportal.com/reports/digital-2026-mexico), [South Africa](https://datareportal.com/reports/digital-2026-south-africa) *(secondary aggregation of primary data)*.
- US Treasury, [designation of James Kabarebe under E.O. 13413, 20 February 2025](https://home.treasury.gov/news/press-releases/sb0022).

**Construction markets and competitors** (selected; each playbook lists its own sources in full)

- Peru: [Infomercado, construction closed 2025 up 6.5 percent (CAPECO)](https://infomercado.pe/consumo-de-cemento-crecio-18-en-diciembre-y-construccion-cerro-2025-con-alza-de-6-5/) *(secondary)*; [Mercado Negro on Pacasmayo's ConstruyeXperto community of master builders](https://www.mercadonegro.pe/medios/digital/campanas-digitales/construyexperto-la-comunidad-online-de-pacasmayo-cuenta-con-mas-de-24-mil-maestros-de-obra-del-peru) *(secondary)*.
- Philippines: [GMA News, Balisacan on the public-construction contraction, 29 January 2026](https://www.gmanetwork.com/news/money/economy/974661/ph-economy-could-have-grown-5-5-in-2025-but-for-corruption-scandal-says-balisacan/story) *(secondary)*; [guide to PCAB and PRC verification, 23 September 2026](https://aedoconstruction.com/blog/verify-engineer-contractor-license-philippines/) *(secondary)*.
- Kenya: [KNBS 2026 Economic Survey](https://www.knbs.or.ke/reports/2026-economic-survey/); [Eastleigh Voice on cement demand](https://eastleighvoice.co.ke/construction%20sector/232774/construction-sector-rebounds-as-cement-demand-hits-record-high) *(secondary)*; [The Star on the Jumba app](https://www.the-star.co.ke/sasa/technology/2025-10-14-jumba-app-marks-new-era-for-kenyas-construction-industry) *(secondary)*; [VC4A profile of Fundi Link](https://vc4a.com/ventures/fundi-link/) *(vendor claim)*.
- Ghana: [Ghanaian Times, housing deficit 1.83 million units](https://ghanaiantimes.com.gh/ghanas-housing-deficit-hits-1-83m-units-works-housing-and-water-resources-minister/) *(secondary)*; [GNA on the ProfArts artisan app, July 2025](https://gna.org.gh/2025/07/german-development-cooperation-partners-launch-profarts-mobile-app-for-local-artisans/) *(secondary)*.
- Colombia: [Portafolio, building construction down 7.5 percent in 2025 (DANE)](https://www.portafolio.co/mis-finanzas/vivienda/construccion-en-colombia-cae-7-5-en-2025-y-marca-su-peor-registro-desde-2020-a-que-se-debe-esta-baja-488521) *(secondary)*.
- Dominican Republic: [Banco Central, preliminary results January to December 2025](https://cdn.bancentral.gov.do/documents/publicaciones-economicas/resultados-preliminares-de-la-economia-dominicana/documents/infeco_preliminar2025-12.pdf); [Superintendencia de Bancos report of 31 December 2025](https://www.sb.gob.do/media/ie1f5wjs/31-de-diciembre-2025.pdf).
- Uzbekistan: [Statistics Agency, housing commissioned in 2025](https://stat.uz/en/press-center/news-of-committee/66577-2025-yilda-15-9-mln-kv-m-turar-joylar-foydalanishga-topshirilgan-3); [Statistics Agency, construction works January to September 2025](https://stat.uz/en/press-center/news-of-committee/63665-zbekistonda-bazharilgan-urilish-ishlari-azhmi-10-7-ga-sgan-4); [Ustabor, how it works](https://ustabor.uz/en/howitworks) *(vendor claim)*.
- Nigeria: [HousingTV Africa, construction real growth 5.53 percent in 2025](https://www.housingtvafrica.com/?p=34991) *(secondary)*; [HousingTV Africa, official housing deficit about 14.9 million units](https://www.housingtvafrica.com/?p=30349) *(secondary)*; [ThisDay on Wocman, July 2025](https://www.thisdaylive.com/2025/07/27/wocman-technology-unveils-digital-platform-to-reshape-nigerias-construction-industry) *(secondary)*.
- Mexico: [El Cronista on INEGI's housing satellite account (self-build 55.6 percent)](https://www.cronista.com/mexico/finanzas-economia/mientras-la-autoconstruccion-sube-la-participacion-de-empresas-en-viviendas-nuevas-registra-una-caida-de-12) *(secondary)*; [BBVA Research, real estate outlook Mexico 2026 first half](https://www.bbvaresearch.com/wp-content/uploads/2026/04/Sit_Inmobiliaria_Mexico_26S1_2.pdf) *(secondary)*.
- Rwanda: [The New Times on third-quarter 2025 growth (NISR)](https://www.newtimes.co.rw/article/32017/news/economy/economy-records-double-digit-growth-in-third-quarter) *(secondary)*; [NISR GDP fourth quarter 2025](https://statistics.gov.rw/sites/default/files/documents/2026-03/GDP%20Q4%202025.pdf).
- South Africa: [Daba Finance on Santam's acquisition of Kandua](https://dabafinance.com/en/news/south-africas-santam-buys-home-services-marketplace-kandua) *(secondary)*.
