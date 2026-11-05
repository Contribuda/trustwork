# C. Country by country: where the civic engine is needed, where it can lawfully help, and what to learn

Research note for the Trustwork Book, first edition, November 2026. Working evidence, not the book's position.

Feeds chapter 20. All web sources accessed 2026-11-04 unless stated. Nothing
here is legal advice; every legal point is a question for counsel. Naming an organisation records its public work; it implies no contact, interest or agreement.

**How this note relates to the existing research.** The construction side of
each launch country (market, competitors, payments, registers, launch plan) is
already covered in `docs/research/top-10-launch-countries-2026-11.md` and the
playbooks in `docs/launch/countries/*.md` of the repository. This note does not
repeat them. It adds the civic and societal dimension: participatory
(initiative) budgeting, open budgets, open contracting, the education of
society, and the raising of culture and reputation, read against the built
environment where public money becomes visible.

**Evidence levels.** A plain link is a primary or official source (a statute, a
statistics office, a regulator, an index publisher's own page). _(secondary)_
marks press, encyclopaedias, law-firm notes and aggregators. _(self claim)_
marks what an organisation says about itself. **Not verified in this pass**
marks a widely reported fact whose primary source could not be reached; such a
number must be verified before it is quoted.

**Restricted places** (Russia, Crimea, Sevastopol, the Donetsk and Luhansk
regions, Cuba, Iran, North Korea;
`packages/country-packs/packs/restricted.json`) are never hosts or markets and
are not scored. Ukraine appears in the short scan with the regions listed in
NOTICE excluded.

---

## 1. The cross-country picture in one table

The four indices used throughout, latest editions:

- **CPI**: Transparency International, Corruption Perceptions Index 2025,
  published 10 February 2026, 182 countries, global average 42
  ([TI summary via Basel Institute](https://baselgovernance.org/resources/publications/corruption-perceptions-index-2025)
  _(secondary)_; scores read from the
  [Wikipedia table of the 2025 index](https://en.wikipedia.org/wiki/Corruption_Perceptions_Index)
  _(secondary)_; to be confirmed against transparency.org/cpi/2025 before
  quotation).
- **OBS**: International Budget Partnership, Open Budget Survey 2025 (the newest
  round; it covers about 85 countries). Where a country was not surveyed in 2025
  the 2023 round is used and marked. Scores are transparency / public
  participation / oversight, each out of 100; 61 is the "sufficient" threshold
  ([country pages](https://internationalbudget.org/open-budget-survey/country-results)).
- **CIVICUS Monitor**: civic-space rating as of the December 2025 _People Power
  Under Attack 2025_ report (Open, Narrowed, Obstructed, Repressed, Closed) with
  the Monitor's 0 to 100 score
  ([data centre](https://monitor.civicus.org/data/);
  [global findings 2025](https://monitor.civicus.org/globalfindings_2025)).
- **OGP**: Open Government Partnership membership
  ([OGP member pages](https://www.opengovpartnership.org/our-members/); cross-checked
  against the [member list on Wikipedia](https://en.wikipedia.org/wiki/Open_Government_Partnership)
  _(secondary)_). **CoST**:
  Infrastructure Transparency Initiative membership from CoST's
  [Where we work](https://infrastructuretransparency.org/where/) page. **OCDS**:
  as recorded in the top-10 note.

| Country            | CPI 2025 | OBS (edition): transparency / participation / oversight | CIVICUS (Dec 2025)               | OGP                                                    | CoST                            | OCDS feed                              |
| ------------------ | -------- | ------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ | ------------------------------- | -------------------------------------- |
| United States      | 64       | 2023: 69 / 22 / 83 (not surveyed 2025)                  | Obstructed, 56 (downgraded 2025) | **Withdrew** by letter of 15 Jan 2026                  | No                              | No (USAspending, not OCDS)             |
| Peru               | 30       | 2025: 72 / 39 / 74                                      | Repressed, 40                    | Member since 2011                                      | No                              | OECE and PeruCompras, daily            |
| Philippines        | 32       | 2025: 76 / 37 / 68                                      | Repressed, 38                    | Founder 2011                                           | No                              | None found                             |
| Kenya              | 30       | 2025: 56 / 44 / 56                                      | Repressed, 31                    | Member since 2011                                      | Kakamega County (sub-national)  | PPRA, daily                            |
| Ghana              | 43       | 2025: **22** / 22 / 33 (down from 46)                   | Obstructed, 60                   | Member since 2011                                      | Sekondi-Takoradi (sub-national) | PPA, monthly                           |
| Colombia           | 37       | 2023: 50 (not surveyed 2025)                            | Repressed, 40                    | Member since 2011                                      | Bogotá, Cali (sub-national)     | SECOP II, daily                        |
| Dominican Republic | 37       | 2025: **82** / **50** / 56                              | **Narrowed, 74**                 | Member since 2011                                      | **National member**             | DGCP, daily                            |
| Uzbekistan         | 31       | Not surveyed                                            | **Closed, 18**                   | Not a member                                           | No                              | None found                             |
| Nigeria            | 26       | 2025: 24 / **7** / 52                                   | Repressed, 36                    | Member since 2016; Kaduna State is an OGP Local member | Kaduna, Sokoto (sub-national)   | BPP, Budeshi, 11 states                |
| Mexico             | 27       | 2023: 80 / 30 / 65 (not surveyed 2025)                  | Repressed, 40                    | Founder 2011                                           | Jalisco (sub-national)          | Former INAI quarterly; 17 sub-national |
| Rwanda             | 58       | 2025: 55 / 26 / 61                                      | Repressed, 25                    | Not a member                                           | No                              | RPPA, daily                            |
| Georgia            | 50       | 2023: **87** (ranked 1st of 125; not surveyed 2025)     | Repressed, 34 (downgraded 2025)  | **Permanently suspended** 13 April 2026                | No                              | State Procurement Agency               |
| Armenia            | 46       | 2025: 63 / 19 / 59                                      | **Narrowed, 66**                 | Member since 2011                                      | No                              | Not checked                            |
| Azerbaijan         | 30       | 2023: 67 / 11 / 65                                      | **Closed, 12**                   | Permanently suspended 2023                             | No                              | Not checked                            |

Sources for the status changes: OGP resolution making Georgia's suspension
permanent, 13 April 2026
([OGP PDF](https://www.opengovpartnership.org/wp-content/uploads/2026/04/Resolution-on-the-Participation-of-Georgia-in-OGP-1.pdf);
[Transparency International Georgia](https://transparency.ge/en/post/georgia-expelled-open-government-partnership)
_(secondary)_); Azerbaijan permanently suspended by resolution of 21 July 2023
([OGP](https://www.opengovpartnership.org/?p=76340);
[resolution PDF](https://www.opengovpartnership.org/wp-content/uploads/2023/07/Approved-SC-Resolution-on-Azerbaijan-July-21-2023-.pdf));
US withdrawal letter of 15
January 2026 signed by the GSA Administrator
([Nextgov](https://www.nextgov.com/digital-government/2026/02/us-withdraws-open-government-partnership-which-it-helped-create/411133)
_(secondary)_;
[Public Citizen](https://www.citizen.org/news/u-s-steps-away-from-open-government-partnership-it-co-founded/)
_(secondary)_); CIVICUS downgrade of the United States to Obstructed and of
Georgia to Repressed in December 2025
([CIVICUS press release](https://monitor.civicus.org/press_release/2025/global-press-realease/);
[CIVICUS Georgia](https://monitor.civicus.org/press_release/2025/georgia)).

**FATF.** After the plenary of 30 October 2026 the jurisdictions under increased
monitoring are Angola, Bolivia, Bosnia and Herzegovina, Cameroon, Haiti, Iraq,
**Kenya**, Kuwait, Laos, Lebanon, Nepal, Papua New Guinea, South Sudan, Syria,
Venezuela, Vietnam, the British Virgin Islands and Yemen; the call-for-action
list is North Korea, Iran and Myanmar
([compliance-firm summary](https://citadel365.com/?p=3791) _(secondary)_; FATF's
own page could not be reached; to be confirmed on fatf-gafi.org). Nigeria, South
Africa, Mozambique and Burkina Faso were removed in October 2025
([Mondaq](https://www.mondaq.com/nigeria/money-laundering/1700062/nigeria-removed-from-fatf-grey-list)
_(secondary)_;
[New Zealand DIA](https://www.dia.govt.nz/AML-CFT-Jurisdictions-under-increased-monitoring-October-2025)).
Of the fourteen main countries only Kenya is listed.

Three readings of the table before the country sections:

1. **Budget transparency and civic space move separately.** Georgia topped the
   Open Budget Survey in 2023 and is now rated Repressed and out of OGP.
   Azerbaijan publishes a "sufficient" budget (67) with a participation score of
   11 in a Closed civic space. The Dominican Republic is the only main country
   strong on all three (82 / 50, Narrowed, OGP, CoST). A civic engine needs both
   the documents and the room to use them.
2. **Participation is the weak pillar everywhere.** The global average for
   public participation in the budget is 17. Kenya (44) and the Dominican
   Republic (50) are the highest in our list; Nigeria (7), Azerbaijan (11),
   Armenia (19) the lowest. This is exactly the gap "the loop of public trust"
   is meant to fill, and it is a gap of practice, not of law: most of these
   countries already have a participation statute.
3. **The reference hub has moved.** The United States left OGP in January 2026
   and was downgraded by CIVICUS in December 2025. The federal layer is no
   longer a model; the cities and California remain one. The San Diego story
   rests on city and state institutions.

---

## 2. The fourteen main countries

Each section follows the same seven headings: (1) civic need, (2) civic
landscape, (3) education and skills, (4) public institutions and organisations
(kinds, and named public bodies; naming records their public work only), (5)
the single best local idea, (6) risks, (7) what a Trustwork civic hub would do
first. The construction market, competitors, payments and registers are in the
playbooks and are not repeated.

### 2.1 United States, with San Diego and California

**(1) Civic need.** The need is not informality but cost, exclusion and the age
of the stock. California's housing shortage is estimated at about 3 million
units in 2025, roughly 20 to 30 percent of the stock
([Wikipedia summary of LAO, UCLA and WSJ estimates](https://en.wikipedia.org/wiki/California_housing_shortage)
_(secondary)_). About 96 percent of residential land in the state is zoned
single-family only (UC Berkeley Othering and Belonging Institute, 2024, cited
there). San Diego in 2023 had a median home price of 910,000 dollars and the
third-highest average rent among large US cities (same source). The 2026 San
Diego regional point-in-time count reported a 1 percent fall in homelessness
region-wide and an 11 percent fall in unsheltered homelessness
([Regional Task Force on Homelessness](https://www.rtfhsd.org/) _(self claim)_);
the 2023 county count was 10,203 _(secondary, Wikipedia)_. The reference
collapse is Champlain Towers South, Surfside, Florida, 24 June 2021, 98 dead;
NIST's technical findings of June 2026 name a design that did not meet code,
construction not to the drawings, added loads and rebar corrosion; Florida
answered with SB 4-D (2022), milestone inspections at 25 or 30 years and
reserves that can no longer be waived, with inspection records posted online
([Wikipedia](https://en.wikipedia.org/wiki/Surfside_condominium_collapse)
_(secondary)_). CPI 64 (down; TI flagged US decline). OBS 2023: 69 / 22 / 83;
the US produces no Citizens Budget and the public cannot testify at
congressional budget hearings.

**(2) Civic landscape.** Strong fiscal decentralisation: cities and counties
have their own budgets, adopted in public hearings (San Diego adopted its FY2026
budget on 10 June 2025 despite a 258 million dollar deficit, with evening budget
sessions for residents;
[KPBS](https://www.kpbs.org/news/politics/2025/06/11/san-diego-city-council-restores-rec-center-and-some-library-hours-in-budget)
_(secondary)_). Participatory budgeting in California is real but small and
uneven: Vallejo ran the first city-wide PB in the US in 2012 with about 3
million dollars of new sales-tax revenue
([Planetizen](https://planetizen.com/node/56275) _(secondary)_; a 2018 study
found "mixed success",
[Clark University](https://wordpress.clarku.edu/mdavidson/?p=462)
_(secondary)_); Long Beach's Youth Power PB awarded 550,000 dollars to 11
organisations on 16 May 2025 with 1,976 validated youth votes
([City of Long Beach](https://www.longbeach.gov/press-releases/office-of-youth-development-announces-youth-power-pb-participatory-budgeting-long-beach-2025-awardees/));
Long Beach's earlier Empower Uptown reported 4.9 percent turnout, described as
the highest per capita in the country _(secondary)_; Los Angeles' LA REPAIR
distributed about 8.5 million dollars across nine zones with over 5,500 ballots
([repair.lacity.gov](https://repair.lacity.gov/), _(self claim)_; figures from
a search excerpt, the site could not be read); Sacramento and
San José ran pilots of about 100,000 dollars. New York City Council's PB, since
2011, is the largest in the country, with a nine-day district-wide vote in April
2026 ([NYC Council](https://council.nyc.gov/pb/)); a study found PB reduced 311
complaints _(secondary)_. **San Diego has no participatory budgeting**; the
Community Budget Alliance (convened by the Center on Policy Initiatives) has
pushed for a pilot since 2012
([Nonprofit Quarterly, 2012](https://nonprofitquarterly.org/?p=19908)
_(secondary)_;
[OB Rag, 2025](https://obrag.org/2025/07/center-on-policy-initiatives-tries-to-make-san-diego-county-budget-more-transparent-and-accessible/)
_(secondary)_). Open data: the city's portal lists 122 datasets from 19
departments, updated daily, including Get It Done (311) requests, Development
Services approvals and a budget dashboard back to 2021
([data.sandiego.gov](https://data.sandiego.gov/)). Housing and permitting
reform: AB 130 and SB 131, signed 30 June 2025, created a statutory CEQA
exemption for infill housing that meets local zoning and objective standards and
exempted most housing-element rezonings
([Holland & Knight](https://www.hklaw.com/en/insights/publications/2025/07/california-legislature-enacts-major-ceqa-reforms-for-housing-rich)
_(secondary)_;
[Venable](https://www.venable.com/insights/publications/2025/07/from-red-tape-to-green-light-ceqa-reforms-fast)
_(secondary)_). San Diego's ADU Bonus Program, which allowed unlimited
market-rate ADUs in exchange for one deed-restricted unit, was rolled back on 16
June 2025 by a 5 to 4 council vote to tiered caps of 4 to 6 units by lot size,
effective 22 August 2025 outside the coastal zone, over a warning from state
housing officials
([KPBS](https://www.kpbs.org/news/quality-of-life/2025/06/17/san-diego-city-council-approves-rollback-of-adu-incentives)
_(secondary)_;
[HCD technical assistance letter, 13 June 2025](https://www.hcd.ca.gov/sites/default/files/docs/planning-and-community/HAU/san-diego-adu-bonus-program-ta-061325.pdf)).
Claims of a March 2026 "60-day ADU permit" package appear only on an unofficial
builder blog and are **not verified**. Civic space: Obstructed since December
2025; federal OGP withdrawal January 2026; the Open Government Federal Advisory
Committee was terminated in February 2025 _(secondary)_.

**(3) Education and skills.** Licensing by the Contractors State License Board
(CSLB), the state's engineer and architect boards; apprenticeship through the
Division of Apprenticeship Standards and union joint training trusts; community
colleges (San Diego Community College District) run construction trades
programmes. The city's Development Services Department publishes permit data.
(Institutions named from general knowledge; not re-fetched.)

**(4) Public institutions and organisations.** The City of San Diego Performance
and Analytics Department (open data owner) and Development Services Department;
the San Diego County Regional Task Force on Homelessness (data); SANDAG
(regional housing need); the Participatory Budgeting Project (Oakland and New
York; the national PB non-profit); Community Budget Alliance and Center on
Policy Initiatives; UC San Diego and San Diego State University (urban planning,
public policy); the Associated General Contractors San Diego Chapter and the
Building Industry Association of San Diego; Habitat for Humanity San Diego; the
California Department of Housing and Community Development (HCD) as the state
counterpart on housing-element compliance.

**(5) The best local idea.** **Open 311 and open permits as a public evidence
stream.** San Diego's Get It Done requests and Development Services approvals
are published daily as open data. A city where every pothole report, every
permit and every capital budget line is already machine-readable is the natural
place to show how field evidence from a build connects to a public asset record,
before any vote is involved. The second idea, from Florida rather than
California, is **Surfside's legislative answer**: inspection records posted
online and reserves that cannot be waived; this is "evidence, not trust" written
into law for existing buildings.

**(6) Risks.** The federal retreat from open government (OGP exit, Obstructed
rating) raises the political temperature around "transparency" work and may
reduce federal data; the city and state layers are unaffected so far. Litigation
culture: anything that looks like a public rating of a contractor or inspector
invites defamation and fair-business-practice claims; California's
consumer-review protections cut both ways. Privacy: CCPA/CPRA for any resident
data. Capture risk is low, but the equity history of PB in US cities (turnout of
1 to 5 percent, affluent participants) is documented and must be designed
against.

**(7) What a Trustwork civic hub would do here first.** Not participatory
budgeting. First, a public **"works of the city" layer** on the San Diego hub:
capital improvement projects and permits from open data, each with its sourced
page, its contractor's sourced page, and a place for field evidence from the
people doing the work, with a place for the city's own inspectors to confirm.
Second, a small, honest PB pilot (one district, one capital pot, the engine's
vote module, a direction of the book) only if the city asks. Third, write the
Surfside lesson into
the engine: a building's inspection record is a public document on its page.

### 2.2 Peru

**(1) Civic need.** Most homes are self-built (estimates 67 to over 80 percent;
see the playbook). Public works stall at scale: the Contraloría counted 2,369
paralysed works with S/ 22,453 million immobilised in January 2022, 72 percent
of them (1,714) at local governments, and the Contralor said plainly "there is a
lot of corruption in works executed by direct administration"
([El Peruano, 18 Jan 2022](https://elperuano.pe/noticia/137590-contraloria-advierte-la-paralisis-de-2369-obras));
later counts run 2,215 to 2,416 works and S/ 32,000 to 43,000 million depending
on the cut-off and whether total or remaining investment is counted
([Caretas](https://caretas.pe/?p=764903) _(secondary)_;
[Expreso](https://www.expreso.com.pe/actualidad/obras-paralizadas-generan-alarma-en-gremios-de-construccion-civil-en-peru-2572-estancadas-y-se-alista-marcha-nacional-contraloria-infobras-conatracc-noticia/1224246/)
_(secondary)_;
[ComexPerú via Energiminas, Sept 2025](https://energiminas.com/?p=40759)
_(secondary)_). The Real Plaza Trujillo roof collapsed on 21 February 2025 under
pooled rainwater, killing at least six to eight people and injuring 84; the mall
had been ordered closed for structural deficiencies in 2023 and reopened in
January 2024 under political pressure; Indecopi fined the owner S/ 8 million in
January 2026
([Wikipedia](https://en.wikipedia.org/wiki/Real_Plaza_Trujillo_collapse)
_(secondary)_). CPI 30. OBS 2025: 72 / 39 / 74, with transparency "sufficient"
since 2015.

**(2) Civic landscape.** Peru is the only country in the world where
participatory budgeting is **mandatory by national law at every sub-national
level**: Ley 28056 (2003), amended by Ley 29298 (2008), requires every district,
provincial and regional government, about 1,900 jurisdictions, to run an annual
process, with civil-society organisations rather than individuals as
participants and a results-based variant tied to the public investment system
([Wikipedia es](https://es.wikipedia.org/wiki/Presupuesto_participativo)
_(secondary)_; MEF guidance on vigilance committees,
[gob.pe](https://cdn.www.gob.pe/uploads/document/file/1324482/2017%20Presupuesto%20Participativo%20Basado%20en%20Resultados%20Comite%20de%20Vigilancia.pdf)).
Twenty years of evaluation show the failure mode: projects prioritised "without
adequate technical analysis" that could not be executed (MEF), uneven
responsiveness (IEP working paper 268, Remy, Urrutia and Veas,
[IEP](https://repositorio.iep.org.pe/bitstream/handle/IEP/1171/Remy_Urrutia_Veas_Presupuesto-participativo-Peru.pdf?sequence=1)),
and the paralysed-works figures above. Regions and municipalities have real
budgets (canon minero transfers make some very rich and very weak). Open
contracting: OECE and PeruCompras publish OCDS daily; the Contraloría's
**Infobras** system registers public works and lets citizens report on them
(referenced by the trade press; the portal itself was not fetched). OGP
member since 2011. Civic space Repressed (CIVICUS 40), reflecting the 2022 to
2023 protest deaths and the pressure on NGOs through the 2024 to 2025 APCI law
changes (**not re-verified**).

**(3) Education and skills.** SENCICO (the national construction training
service, financed by a levy on construction firms) certifies workers; the
Colegio de Ingenieros del Perú and Colegio de Arquitectos license professionals;
CAPECO runs training; cement makers run master-builder communities (playbook).

**(4) Public institutions and organisations.** The Contraloría General de la República (Infobras,
paralysed-works monitoring, citizen vigilance programme "Monitores Ciudadanos de
Control"); the Ministry of Economy and Finance (PB methodology, Consulta
Amigable open budget); OECE (procurement data); a provincial municipality with a
known paralysed-works backlog (Cusco region has the most, 490) as the pilot
territory; Proética (TI Peru); the IEP and the Universidad del Pacífico or PUCP
schools of government; SENCICO; CAPECO; the Asociación de Municipalidades del
Perú (AMPE) and REMURPE (rural municipalities).

**(5) The best local idea.** **A national law that makes the vote on local works
a duty, plus a national register of every public work with citizen reports
(Infobras).** Peru has both ends of the loop in law; what it lacks is the
middle: feasibility and cost before the vote, and evidence after the contract.
Trustwork should learn the mandatory frame and the vigilance committees, and
fill the middle.

**(6) Risks.** Political volatility (six presidents since 2018), 2026 general
elections, Repressed civic space and NGO regulation; extortion against
construction crews in Lima and the north; the danger that a hub becomes a tool
in local electoral fights (mayors own PB). Data: no localisation rule found;
strict consent for commercial messages (playbook).

**(7) First steps.** Pick one province with a long paralysed-works list. Build
sourced pages for every work (from Infobras and OCDS), show the gap between the
PB priority list and what was executed, and give the vigilance committee a place
to attach dated photographs. The Contraloría's citizen-monitor programme is
the reference model; a municipal association is the kind of body that would
operate. No new vote until the evidence layer has run through one budget cycle.

### 2.3 Philippines

**(1) Civic need.** The 2025 flood-control scandal is the largest public-works
corruption case in recent Southeast Asian history: ₱545.6 billion spent on flood
control from July 2022 to May 2025; 15 of 2,409 accredited contractors received
about ₱100 billion; projects worth over ₱350 billion did not specify what was
built; "ghost" projects in Bulacan; the Speaker and the Senate President lost
their posts in September 2025; the Independent Commission for Infrastructure (EO
94, 11 September 2025) held 32 hearings, referred 65 people to the Ombudsman and
closed on 31 March 2026
([Wikipedia](https://en.wikipedia.org/wiki/2025_Philippine_flood_control_projects_controversy)
_(secondary; page carries a neutrality notice, figures provisional)_;
[Manila Bulletin on the ICI handover](https://mb.com.ph/2026/03/23/ici-turns-over-to-doj-findings-on-anomalous-flood-control-projects)
_(secondary)_). The economic planning secretary said growth in 2025 could have
been 5.5 percent but for the scandal (playbook). Housing: a backlog figure of
6.5 million units is widely used, but a DHSUD executive called it a
"misconception" in April 2026 and a senator cited 2.2 million units and about
3.7 million informal settler families
([Daily Tribune](https://tribune.net.ph/2026/04/26/jv-philippines-still-facing-urgent-housing-crisis-warns-of-worsening-backlog)
_(secondary)_; [BusinessWorld](https://www.bworldonline.com/?p=733240)
_(secondary)_). CPI 32 (fell to 120th). OBS 2025: 76 / 37 / 68, the best
transparency in Asia-Pacific in our list, with the Commission on Audit scoring
100 on participation at the audit stage.

**(2) Civic landscape.** Local government units hold real money: the
Mandanas-Garcia ruling (2018, applied from FY2022) widened the LGU share to all
national taxes
([DBM FAQs](https://www.dbm.gov.ph/wp-content/uploads/Mandanas-Garcia-Case/IEC-Materials/FAQs-Mandanas-Garcia-Ruling.pdf)),
yet a World Bank reading of COA reports found nearly half of LGU capital outlays
unspent (2015 to 2018) _(secondary)_. Bottom-up Budgeting (2013 to 2016) brought
civil-society-identified projects into about 1,500 LGUs and was replaced in 2017
by Assistance to Disadvantaged Municipalities; **not re-verified**. The
Commission on Audit runs a **Citizen Participatory Audit** (the COA page
could not be reached; **not verified**). DILG's Full Disclosure Policy obliges
LGUs to post budgets and procurement. The scandal produced the **Sumbong sa
Pangulo** portal (11 August 2025), which shows each flood-control project's
location, contractor, cost and completion date and takes citizen reports: nearly
2,000 complaints in a week, over 12,000 in a month _(secondary)_. No OCDS feed
from PhilGEPS was found. OGP founder; CIVICUS Repressed (38), with a "bright
spot" for a Baguio city ordinance on civic space in 2025.

**(3) Education and skills.** TESDA certifies construction workers (NC I to NC
IV); PRC licenses engineers and architects; PCAB licenses contractors
(playbook).

**(4) Public institutions and organisations.** The Commission on Audit (Citizen Participatory
Audit); DPWH (project data behind Sumbong sa Pangulo); a province or highly
urbanised city with Full Disclosure Policy compliance (Baguio, Naga City and
Iloilo are the usual good-governance references; **not verified**); the
League of Cities and League of Municipalities; TESDA; PICE (civil engineers) and
UAP (architects); Ateneo School of Government and UP NCPAG; Galing Pook
Foundation (local-governance awards); Philippine Center for Investigative
Journalism and Rappler (sourced news); Habitat for Humanity Philippines and the
Community Mortgage Program network for informal settler families.

**(5) The best local idea.** **Audit as participation.** The Philippines scores
100 on participation at the audit stage because COA opens audits to citizens;
and in 2025 a presidential portal turned a national list of 9,000-plus projects
into a map with a complaint button. Both are "evidence first, judgement later".
Trustwork's field-evidence and confirmation layer is the natural private-sector
mirror of a citizen audit.

**(6) Risks.** Red-tagging and the Anti-Terrorism Act chill NGO work; libel is
criminal and online libel is used against critics; political dynasties control
many LGUs; disasters. Data: Data Privacy Act with an active commission; PhilSys
identity. FATF: removed from the grey list in February 2025.

**(7) First steps.** Take the public flood-control project list and build
sourced pages for projects and contractors in one province; invite the
province's COA resident auditor and a TESDA-accredited training centre as
reference institutions; let residents attach evidence; publish the gap between
the completion date on paper and the state on the ground. Then move upstream to
the LGU's annual investment programme and a small PB pot.

### 2.4 Kenya

**(1) Civic need.** About 60 percent of Nairobi's estimated 5.5 million
residents live in informal settlements (Prof Peter Ngau,
[The Star, 6 July 2026](https://www.the-star.co.ke/news/2026-07-06-housing-dream-slipping-away-for-slum-residents-says-scholar)
_(secondary)_; a World Bank working paper gives 41 percent on a different basis
_(secondary)_). Annual demand is about 250,000 homes against about 50,000 built,
mostly high-end (same source). The NCA's 2022 audit marked 10,791 of 14,895
sampled buildings unsafe for occupancy; the Institution of Engineers of Kenya
counted 87 collapses in five years with about 200 killed and over 1,000 injured,
and a 14-storey building under construction collapsed in South C, Nairobi, on 2
January 2026
([The Standard, 24 March 2026](https://www.standardmedia.co.ke/business/amp/national/article/2001543722/over-10000-buildings-in-kenya-are-death-traps)
_(secondary)_). The 2016 Huruma collapse killed at least 51 _(secondary)_.
CPI 30. OBS 2025: 56 / **44** / 56; participation is the highest in sub-Saharan
Africa in our list, with formulation 93 and approval 89 but implementation and
audit 0.

**(2) Civic landscape.** The 2010 Constitution created 47 counties and
guarantees them at least 15 percent of national revenue (Article 203(2);
**constitution text not re-fetched**, well established). The Public
Finance Management Act 2012 and County Governments Act 2012 require public
participation in planning and budgeting. **Makueni County** runs the best-known
participatory budgeting in Africa, a tiered process from village to cluster to
sub-ward to ward to county; a World Bank initiative in Makueni and West Pokot
raised women's participation threefold to 35 percent by holding consultations
near homesteads, and credited PB with swifter budget approval
([World Bank KPBI report](https://openknowledge.worldbank.org/server/api/core/bitstreams/daa1a44c-5d80-586f-9efe-6e44ab318fc3/content);
[World Bank blog](https://blogs.worldbank.org/en/governance/citizen-engagement-kenya-law-practice));
Makueni's own FY2024/25 participation report is public
([makueni.go.ke](https://makueni.go.ke/sandbox/site/files/2024/05/Makueni-County-FY-202425-Budget-Public-Participation-Report-30-4-2024.pdf)).
The honest caveats: a pilot evaluation by Touchton and Wampler found "progress
toward accountability through PB is not uniform"
([World Bank](https://documents1.worldbank.org/curated/en/471371592554290653/pdf/Participatory-Budgeting-in-Kenya-Piloting-New-Techniques-for-Project-Monitoring.pdf)),
and a 2020 study tags Makueni with "elite privilege" _(secondary)_. Open
contracting: PPRA publishes OCDS daily; Makueni also published OCDS. Kakamega
County is a CoST sub-national member. OGP member since 2011. Civic space
Repressed (31) after the 2024 to 2025 protest killings and abductions. Civic
tech is strong (Ushahidi, Code for Africa, Open Institute; **not re-verified
today**).

**(3) Education and skills.** NITA (industrial training) and TVET CDACC certify
trades; the NCA accredits construction workers and contractors; the Engineers
Board of Kenya and the Board of Registration of Architects and Quantity
Surveyors license professionals; the IEK is the professional body.

**(4) Public institutions and organisations.** Makueni County Government (PB owner) and the Council
of Governors; the Office of the Controller of Budget (county implementation
reports); PPRA (OCDS); NCA and IEK (the proposed **national building register**,
modelled on the vehicle-records system, so anyone can check whether a building
was designed by registered professionals and has an occupancy certificate, is
the IEK president's own proposal, March 2026); the International Budget
Partnership Kenya office; TI Kenya; Slum Dwellers International Kenya (Muungano
wa Wanavijiji); the University of Nairobi's planning department; Ushahidi; Kenya
Devolution Support Programme (World Bank).

**(5) The best local idea.** **Makueni's tiered village-to-county vote, with a
county that publishes its procurement in OCDS.** It shows that PB can work in a
low-income county if the meetings go to where people are. The second idea is the
IEK's building register: a public record of who designed, who built, who
approved, which is Trustwork's sourced page by another name.

**(6) Risks.** FATF grey list since February 2024, still listed in October 2026
([Business Daily](https://www.businessdailyafrica.com/bd/economy/kenya-eyes-exit-from-money-laundering-grey-list-by-may-5361658)
_(secondary)_), which affects payment providers; section 37 consent rules for
commercial use of personal data (playbook); Repressed civic space with police
violence at protests; counties' pending bills and delayed disbursements stall
projects; capture by governors is the known PB failure.

**(7) First steps.** Peer with Makueni: import its PB project list and its OCDS
tenders as sourced pages, give ward committees an evidence channel, and show
implementation (the pillar that scores 0 nationally). In Nairobi, build the
building register idea as a sourced-page type with NCA and IEK as reference
institutions. Payments wait for the FATF exit.

### 2.5 Ghana

**(1) Civic need.** A housing deficit of about 1.8 million units (playbook). The
Melcom store collapse in Achimota, Accra, on 7 November 2012 killed 14 (**not
re-verified today**). Budget transparency collapsed in the latest survey: OBS
2025 transparency **22**, down 24 points from 46 in 2023, because the
Executive's Budget Proposal and the Citizens Budget were not published online in
time; participation 22; oversight 33
([IBP Ghana](https://internationalbudget.org/open-budget-survey/country-results/2025/ghana)).
CPI 43, the second-best in our list after Rwanda and Georgia's neighbourhood.

**(2) Civic landscape.** 261 Metropolitan, Municipal and District Assemblies
receive the District Assemblies Common Fund, constitutionally at least 5 percent
of total revenue (Article 252; **constitution text not re-fetched**); the
Local Governance Act 2016 (Act 936) requires participatory planning (**not
re-fetched**). District chief executives are appointed by the President, which
weakens local accountability. **Sekondi-Takoradi Metropolitan Assembly** is the
standout: an OGP Local member, it joined CoST in 2019 as the first OGP
sub-national government to do so, built an infrastructure disclosure portal,
persuaded neighbouring assemblies to publish on it, adopted CoST's Formal
Disclosure Mandate, and by 2026 all 14 districts of the Western Region take part
in CoST's independent review, with 28 projects reviewed
([OGP story](https://www.opengovpartnership.org/stories/building-trust-infrastructure-transparency-in-kaduna-and-sekondi-takoradi/);
[GNA, July 2026](https://gna.org.gh/2026/07/over-25-projects-reviewed-under-cost-independent-review-process/)
_(secondary)_;
[GNA, Nov 2025](https://gna.org.gh/2025/11/all-14-districts-in-western-region-to-participate-in-independent-review-process-of-cost/)
_(secondary)_). The second assurance report scored the top performers 37 of 67
disclosure points (58 percent) _(secondary)_. PPA publishes OCDS monthly. OGP
since 2011. Civic space Obstructed (60), the most open in Africa in our list,
stable democracy with a 2024 transfer of power.

**(3) Education and skills.** COTVET and the Commission for TVET; the Ghana
Institution of Engineering and Ghana Institute of Architects; the Engineering
Council; the GIZ-backed ProfArts artisan app (playbook).

**(4) Public institutions and organisations.** Sekondi-Takoradi Metropolitan Assembly and the
Western Regional Coordinating Council (CoST hosts); the Ministry of Local
Government, the DACF Administrator and the National Development Planning
Commission; PPA; the Ghana Integrity Initiative (TI Ghana), the Ghana
Anti-Corruption Coalition and SEND Ghana (budget tracking); KNUST and the
University of Cape Coast (built environment faculties); the Ghana Institution of
Engineering; Habitat for Humanity Ghana; the Ghana Real Estate Developers
Association.

**(5) The best local idea.** **A city that disclosed its infrastructure first
and persuaded its neighbours to follow.** Sekondi-Takoradi did not wait for a
national law; it adopted a disclosure mandate, built a portal and grew a region.
That is exactly how a hub should grow: one territory, a standard, neighbours
peering.

**(6) Risks.** The 2025 fall in budget transparency shows how quickly national
openness can slip; appointed district executives; the registration duty under
the Data Protection Act; the contractor classification registers are not online
(playbook). Low political risk otherwise.

**(7) First steps.** Import the Western Region's published CoST disclosures as
sourced project pages, add the engine's evidence and confirmation layer, and
give citizen reports on each disclosed project a common place across the 14
districts. One assembly's DACF-funded works would be the first PB pilot.

### 2.6 Colombia

**(1) Civic need.** 31 percent of households were in housing deficit in 2021
(7.5 percent quantitative, 23.5 percent qualitative; 5.24 million households;
[DANE](https://www.dane.gov.co/index.php/estadisticas-por-tema/demografia-y-poblacion/deficit-habitacional);
later years are in annexes not fetched). The Space building in Medellín
collapsed on 12 October 2013, 12 dead, after design errors (**not re-verified
today**). Unfinished public works ("elefantes blancos") are a national theme
with a registry at the Secretaría de Transparencia (**figures not verified
today**). CPI 37. OBS 2023: 50, below the sufficiency line; not surveyed
in 2025.

**(2) Civic landscape.** Municipalities and departments have budgets and elected
leaders. **Medellín** has run participatory budgeting since 2004, formalised by
Acuerdo 43 de 2007 and Acuerdo 28 de 2017 (Planeación del Desarrollo Local y
Presupuesto Participativo), with a fixed share of the municipal investment
budget, usually cited as 5 percent (**not verified**; the city page was
not reachable); its failure modes, documented in Colombian research, include
capture by armed actors in some comunas and clientelism. Nationally, the
statutory participation law Ley 1757 de 2015 defines participatory budgets
(articles 90 to 93) and gives veedurías ciudadanas (Ley 850 de 2003) the right
to oversee any public contract (**statute text not fetched; the Senate
site refused the connection**). Open contracting is excellent: SECOP II
publishes daily OCDS through an open API (playbook); MapaInversiones (DNP with
the IDB) maps royalties-funded projects (**not fetched**). Bogotá (2021) and
Cali are CoST sub-national members. OGP since 2011. Civic space Repressed (40):
social leaders and human-rights defenders are killed at the highest rate in the
hemisphere.

**(3) Education and skills.** SENA certifies construction workers nationally;
Camacol (construction chamber) runs training; COPNIA licenses engineers; the
Sociedad Colombiana de Ingenieros and Sociedad Colombiana de Arquitectos.

**(4) Public institutions and organisations.** Alcaldía de Medellín (Secretaría de Participación
Ciudadana, PDL y PP); Colombia Compra Eficiente (SECOP II); DNP
(MapaInversiones); Secretaría de Transparencia; Transparencia por Colombia;
Fundación Corona and Bogotá Cómo Vamos (citizen quality-of-life monitoring, a
model replicated in 20-plus cities); Universidad EAFIT and Universidad de
Antioquia (Medellín), Universidad de los Andes (Bogotá); SENA; Camacol; the Red
Nacional de Veedurías.

**(5) The best local idea.** **Veedurías ciudadanas with a legal right to
oversee any public contract, plus daily OCDS.** Colombia pairs a citizen's legal
standing to inspect a work with the open data to find it. Medellín's two-decade
PB adds the vote. The missing link is the same as in Peru: evidence from the
site, structured, dated, confirmable.

**(6) Risks.** Violence against social leaders makes evidence-gathering by
residents dangerous in some regions; armed-group capture of local PB has
happened; 2026 elections; data protection law (Ley 1581) with Habeas Data; the
playbook's security notes.

**(7) First steps.** In a city with a long PB record (Medellín is the documented
case), an operator of the university or veeduría-network kind would take the
PP-funded works of two comunas from SECOP II, build their
sourced pages and let the veeduría attach evidence; show the comuna what was
voted, what was contracted, what stands. Use Bogotá Cómo Vamos' indicators as
the "education of society" layer.

### 2.7 Dominican Republic

**(1) Civic need.** The Jet Set nightclub roof collapsed in Santo Domingo on 8
April 2025, killing 236 and injuring more than 180; the country had **no
building inspection code written into law**; the President announced one, plus
an expert commission; the owners were ordered to stand trial for involuntary
manslaughter in June 2026
([Wikipedia](https://en.wikipedia.org/wiki/Jet_Set_nightclub_roof_collapse)
_(secondary)_). A large housing deficit (the playbook; figures not re-verified).
CPI 37. OBS 2025: **82 / 50 / 56**, the best participation score of the fourteen
and transparency up from 77.

**(2) Civic landscape.** Ley 170-07 (2007) created a mandatory municipal
participatory budgeting system and Ley 176-07 obliges municipalities to spend at
least 40 percent of their transfers on capital investment (**statute texts not
fetched; widely cited**). Municipalities are small and transfers are
centrally set, but the law has been in force for nearly two decades, so there is
a practice and a literature of its weaknesses (projects not executed, low
turnout). DGCP publishes OCDS daily and a new procurement law took effect in
January 2026 (playbook). The Dominican Republic is CoST's **first Caribbean
national member** (CoST
[Where we work](https://infrastructuretransparency.org/where/)). OGP since 2011.
Civic space **Narrowed (74)**, the most open of the fourteen with Armenia;
Haitian migrants and journalists face the known pressures.

**(3) Education and skills.** INFOTEP certifies trades; CODIA (engineers,
architects and surveyors) is the professional college; MIVED (housing ministry)
and ONESVIE (seismic assessment office) are the technical state bodies.

**(4) Public institutions and organisations.** DGCP (procurement data and the new law); FEDOMU
(federation of municipalities, PB practice); the Dirección General de
Presupuesto (open budget) and the Cámara de Cuentas; ONESVIE and the new
inspection-code commission; CODIA; INFOTEP; Participación Ciudadana (TI
chapter); Alianza ONG; PUCMM and INTEC universities; a mid-size municipality
with a documented PB record (Santiago de los Caballeros or a Santo Domingo Este
district as pilot territory; **to be checked**).

**(5) The best local idea.** **A small country that already has the whole frame
in law: mandatory municipal PB, daily open contracting, a sufficient open
budget, CoST membership, and now the political will for a building inspection
code after a national tragedy.** Nothing has to be invented; the loop has to be
connected and shown.

**(6) Risks.** Weak data-protection law (playbook); small market; municipal
capacity; a presidential system where reform depends on one administration;
hurricane exposure. Low sanctions and FATF exposure.

**(7) First steps.** This is the recommended first civic pilot (section 4). In
one municipality: import the PB project list and DGCP contracts, build sourced
pages, add evidence and confirmation, and publish the budget-to-building trail
for one cycle. The engine's building page could serve as the public record of
inspections under the new inspection code.

### 2.8 Uzbekistan

**(1) Civic need.** Construction is booming (volume up 14.2 percent in January
to September 2025; 15.9 million square metres of housing commissioned in 2025;
playbook) and mass housing programmes run from the centre. Public-works quality
and procurement are opaque; no OBS survey covers Uzbekistan (the 2023 and 2025
pages do not exist) and no OCDS feed was found. CPI 31.

**(2) Civic landscape.** Uzbekistan runs what is probably the **largest
initiative-budgeting programme in the world by votes**: the "Open Budget" (Ochiq
budjet) portal, where residents propose and vote on neighbourhood projects
(roads, water, schools, lighting) funded from a fixed share of district budgets;
participation has been counted in millions of votes per season; and the
programme has had documented problems with vote-buying, bussed or paid voters
and fake accounts, leading to stricter identification rules. **None of these
figures is verified in this note**: the portal
([openbudget.uz](https://openbudget.uz/), redirecting to new.openbudget.uz)
renders only a title without scripts; the Ministry of Economy and Finance or
UNDP reports are the sources to cite, and note A carries the sourced press
figures. Local
government is not autonomous: khokims are appointed, and councils (kengashes)
have limited power; mahalla committees are the lowest tier and are
state-aligned. Not an OGP member. Civic space **Closed (18)**. The 2023 Personal
Data Law requires in-country storage (playbook).

**(3) Education and skills.** The Ministry of Construction and Housing certifies
builders; Tashkent Institute of Architecture and Civil Engineering; monocentres
for vocational training. (General knowledge; not fetched.)

**(4) Public institutions and organisations.** The Ministry of Economy and
Finance (Open Budget owner); UNDP Uzbekistan (which has supported the
initiative); the Agency for Strategic Reforms; the Chamber of Commerce and
Industry; Tashkent universities; mahalla-level associations. In a Closed civic
space, every one of these is the state or near it; there is no independent civic
organisation of the kind the other countries have.

**(5) The best local idea.** **Scale and simplicity.** Whatever its flaws, Open
Budget showed that a fixed share of local money, a phone, and a short voting
season can bring millions of people to decide on their street. The lesson for
Trustwork is in the failure mode too: votes can be bought when the vote is the
only thing that matters. Evidence of what gets built, and who built it, must
weigh as much as the vote.

**(6) Risks.** Closed civic space: a civic engine that publishes contractor
reputation or budget gaps could be read as political; data localisation;
Russia-related secondary-sanctions exposure in the financial system (playbook);
no independent partners; the state could ask for things Trustwork will never
build (surveillance, "log in as user"). This is the clearest case where the
construction hub (which the top-10 note ranks 7th and the fastest technical
launch) should run **without** the civic layer until the civic space changes.

**(7) First steps.** Construction hub only. A hub could import published Open
Budget winning projects as sourced pages so that residents can see who builds
what they voted for; it would not run votes or publish officials' reputation.

### 2.9 Nigeria

**(1) Civic need.** The Building Collapse Prevention Guild counts 653 collapses
between October 1974 and 25 May 2025 with 1,616 deaths (later tallies 679 and
1,639); Lagos accounts for 54 to 57 percent; 47 collapses in 14 states in 2024
alone
([Prime Business Africa](https://www.primebusiness.africa/lagos-accounts-for-highest-number-of-building-collapses-in-nigeria-as-deaths-hit-1616-report/)
_(secondary)_;
[Daily Trust](https://dailytrust.com/how-14-states-accounted-for-47-building-collapse-in-2024-report)
_(secondary)_). The 21-storey Ikoyi tower collapsed on 1 November 2021 killing
at least 42; the Lagos State Building Control Agency had approved 15 floors and
the consulting engineers had withdrawn over integrity concerns in 2020
([Wikipedia](https://en.wikipedia.org/wiki/Ikoyi_building_collapse)
_(secondary)_). Official housing deficit about 15 million units (playbook).
CPI 26. OBS 2025: 24 / **7** / 52, the lowest participation of the fourteen; the
Citizens Budget was not published.

**(2) Civic landscape.** Thirty-six states with their own budgets and strong
governors; local governments weak and often unfunded despite the 2024 Supreme
Court ruling on direct allocation (**not verified**). **Kaduna State** is
an OGP Local member and a CoST sub-national member, with an "Eyes and Ears"
citizen feedback programme on projects (OGP story above; **figures not
verified**). Civic tech is the strongest in Africa: BudgIT's **Tracka** monitors
federal and state projects in 36 states, over 19,000 projects tracked in over
17,000 communities, with a community-champions programme and an app
([yourtracka.org](https://yourtracka.org/) _(self claim)_); Budeshi publishes
procurement in OCDS; the Open Treasury portal publishes federal payments. OGP
since 2016. Civic space Repressed (36); the #EndSARS and 2024 cost-of-living
protest crackdowns, and the Cybercrimes Act used against journalists. FATF:
removed from the grey list in October 2025.

**(3) Education and skills.** COREN registers engineers; NIOB and CORBON
(builders); ARCON (architects); the Industrial Training Fund and NBTE for
technical education; the Building Collapse Prevention Guild is a professional
watchdog.

**(4) Public institutions and organisations.** BudgIT (Tracka), Connected Development (Follow The
Money), the Public and Private Development Centre (Budeshi); Kaduna State
Government (OGP Local, CoST); the Bureau of Public Procurement; the Nigerian
Institute of Building and COREN; the Building Collapse Prevention Guild; Lagos
State Building Control Agency (as the regulator whose approvals must become
public); the University of Lagos and Ahmadu Bello University built-environment
faculties; the Nigeria Governors' Forum.

**(5) The best local idea.** **Tracka's community champions**: a decade of
residents photographing budgeted projects and asking at town halls where the
money went, at national scale, run by a civic organisation rather than the
state. It is the "field evidence by citizens" half of the loop already working,
without the budget vote and without the contractor's page. Trustwork should
learn its channel discipline (phone first, local champions) and offer it the
other half.

**(6) Risks.** Security (kidnapping, insurgency in the north), fraud, naira
volatility, data-protection registration and consent rules (playbook); state
capture of local processes; defamation suits against civic monitors; the biggest
market and the weakest participation score, so expectations must be modest and
local.

**(7) First steps.** Kaduna first, where OGP Local, CoST and Eyes and Ears
already exist: import disclosed projects as sourced pages, add contractor pages
from BPP and Budeshi, and give Tracka champions a structured place for their
evidence. Lagos second, with the Guild and COREN, for the building register the
collapses demand.

### 2.10 Mexico

**(1) Civic need.** Self-build is 55.6 percent of the housing market by value
(playbook). The 19 September 2017 earthquake killed 370, 228 in Mexico City,
where at least 44 buildings collapsed; an investigation found over 6,000
construction-violation complaints since 2012 with no public record of follow-up,
and the owner of the Enrique Rébsamen school, where 26 children and 4 adults
died, was convicted of culpable homicide in 2020
([Wikipedia](https://en.wikipedia.org/wiki/2017_Puebla_earthquake)
_(secondary)_). The Metro Line 12 overpass collapsed on 3 May 2021, 26 dead, 98
injured; DNV found missing and badly welded studs, unauthorised design changes,
no independent certification and no inspections from 2012 to 2019; the city
rejected the third report and ended DNV's contract; as of May 2026 eight former
officials await trial
([Wikipedia](https://en.wikipedia.org/wiki/Mexico_City_Metro_overpass_collapse)
_(secondary)_). CPI 27. OBS 2023: 80 / 30 / 65, sixth in the world on
transparency; not surveyed in 2025.

**(2) Civic landscape.** Mexico City has run **participatory budgeting since
2011** under its Ley de Participación Ciudadana, administered by the electoral
institute IECM, with a fixed share of each alcaldía's budget decided by
residents in every one of about 1,800 unidades territoriales through annual
consultations, the latest in 2025
([IECM](https://www.iecm.mx/participacionciudadana/presupuesto-participativo/);
the share, often cited as 3 to 4 percent, and turnout figures could **not be
verified today**: the IECM results page is could not be read). It is the largest
PB in the Americas by number of units, and its documented problems are low
turnout and projects that are not executed by alcaldías. Nationally, the
transparency institute INAI was abolished by constitutional reform (approved
late 2024, effective 2025) and its functions moved to a government secretariat
(**dates not verified**; the Wikipedia page title guessed did not exist);
the top-10 note already treats INAI as "former". Jalisco is a CoST sub-national
member; 17 sub-national OCDS publishers. OGP founder. Civic space Repressed
(40): the deadliest country for journalists outside war zones.

**(3) Education and skills.** CONOCER certifies competences; the Colegio de
Ingenieros Civiles de México and the Colegios de Arquitectos; the Cámara
Mexicana de la Industria de la Construcción (CMIC) runs training institutes;
Infonavit and the Comisión Nacional de Vivienda (CONAVI) are the housing
institutions.

**(4) Public institutions and organisations.** IECM (PB administrator) and one alcaldía willing to
publish execution; the Secretaría Anticorrupción y Buen Gobierno (successor
transparency body); CoST Jalisco (Secretaría de Infraestructura y Obra Pública
de Jalisco); Transparencia Mexicana and Mexicanos Contra la Corrupción y la
Impunidad; IMCO (which ranks procurement risk); CMIC; UNAM and ITESM
built-environment and public-policy faculties; Habitat for Humanity Mexico and
Échale (assisted self-build).

**(5) The best local idea.** **An electoral institute runs the vote.** Mexico
City put participatory budgeting under the independent electoral body, with a
voter roll, polling stations and online voting, which protects the vote's
integrity in a way a mayor's office cannot. The lesson is institutional: the
vote belongs to a neutral keeper; execution belongs to the alcaldía; evidence
belongs to the public. Trustwork should design its vote module to be run by such
a keeper, never by the hub operator.

**(6) Risks.** Violence against journalists and civic monitors; the dissolution
of INAI and the concentration of transparency functions in the executive; a new
data-protection authority since March 2025 (playbook); organised crime in
construction supply; the Line 12 case shows how a city government can reject an
independent report.

**(7) First steps.** One alcaldía in Mexico City: import the PB-winning projects
of three years and the contracts behind them, build sourced pages, and show
execution; invite the alcaldía's comités de ejecución y vigilancia to attach
evidence. In parallel, with CoST Jalisco, mirror disclosed state works as
sourced pages.

### 2.11 Rwanda

**(1) Civic need.** Rapid urbanisation (5.6 percent a year, the highest in the
list) and a large share of Kigali's housing in unplanned settlements (often
cited at 60 to 70 percent; **not verified**). Construction output grew 20
percent in the third quarter of 2025 (playbook). CPI **58**, the best of the
fourteen and Rwanda's highest ever
([TI Rwanda](https://tirwanda.org/slider/article/driving-change-through-ti-rwanda-s-flagship-research-publication)
_(secondary)_). OBS 2025: 55 / 26 / 61.

**(2) Civic landscape.** Thirty districts with budgets and five-year District
Development Plans broken into annual **Imihigo** performance contracts, publicly
evaluated, which "put real pressure on mayors", and whose goals are meant to
come from citizen assemblies ([Wikipedia](https://en.wikipedia.org/wiki/Imihigo)
_(secondary)_). **Umuganda**, the compulsory community work on the last Saturday
of each month (08:00 to 11:00, ages 18 to 65, fine of RWF 5,000 for absence),
builds schools, roads and bridges and doubles as the local information forum;
its history is tied to colonial forced labour and to genocide-era mobilisation,
and some residents call it "a forced but non-beneficial labour"
([Wikipedia](https://en.wikipedia.org/wiki/Umuganda) _(secondary)_). The Rwanda
Governance Board publishes a Citizen Report Card (**not fetched**). RPPA
publishes OCDS daily; Kubaka issues building permits online (playbook). Not an
OGP member. Civic space **Repressed (25)**; no independent press to speak of.

**(3) Education and skills.** Rwanda TVET Board and Rwanda Polytechnic; the
Institute of Engineers Rwanda; the Rwanda Housing Authority; the University of
Rwanda's built-environment school.

**(4) Public institutions and organisations.** The Rwanda Housing Authority and the City of Kigali
(unplanned-settlement upgrading); RPPA; the Rwanda Governance Board (Citizen
Report Card, Imihigo evaluation); the Institute of Engineers Rwanda; Rwanda TVET
Board; the University of Rwanda; TI Rwanda (which operates, within limits); Skat
and Habitat for Humanity (incremental housing programmes). All but two are state
bodies.

**(5) The best local idea.** **Public performance contracts with public
evaluation.** Imihigo makes a district say in advance what it will build and be
scored on it in public. That is a reputation-from-evidence system for
institutions, which is what raising the culture and reputation of public
institutions means in this book. The caution is that it is top-down and that the
evaluation is the state's own.

**(6) Risks.** Repressed civic space; sanctions on officials over the DRC war
(US Treasury designated James Kabarebe on 20 February 2025,
[AP via Wikipedia](https://en.wikipedia.org/wiki/James_Kabarebe) _(secondary)_;
EU measures of March 2025 **not verified**), which means every official
counterpart must be screened; personal data must be stored in Rwanda unless
authorised (playbook); the state could ask for citizen scoring, which Trustwork
will never build; low internet use.

**(7) First steps.** Construction hub first, with Kubaka permits and RPPA
tenders as sourced pages. Civic layer limited to **institutional** evidence:
district Imihigo commitments on public works mirrored as sourced pages with
execution evidence. No resident reputation, no vote.

### 2.12 Georgia

**(1) Civic need.** A Batumi apartment building collapsed on 8 October 2021
killing nine (**not re-verified**; the Wikipedia title guessed did not
exist). Tbilisi and Batumi have had years of unregulated densification. CPI 50.
OBS 2023: **87**, first of 125 countries
([Georgian Ministry of Finance](https://mof.ge/4536/n/events/o_n_10911)); not
surveyed in 2025.

**(2) Civic landscape.** Municipalities have budgets and elected councils;
several (Marneuli, Ozurgeti, Khoni) ran participatory budgets under OGP Local or
Council of Europe programmes, and Tbilisi ran an ideas platform (**details not
verified today**). The e-procurement system is long praised. But the civic space
has collapsed: the Law on Transparency of Foreign Influence passed on 14 May
2024 (84 to 30)
([Wikipedia](https://en.wikipedia.org/wiki/Law_on_Transparency_of_Foreign_Influence)
_(secondary)_); a FARA-style law and grant restrictions followed in 2025 (**not
verified in detail today**); protesters were fined over ₾2 million between
November 2024 and March 2025, opposition leaders jailed in May 2025, the
journalist Mzia Amaglobeli detained from January 2025
([Wikipedia](https://en.wikipedia.org/wiki/2024%E2%80%932025_Georgian_protests)
_(secondary)_). CIVICUS downgraded Georgia to Repressed in December 2025 and put
it on its watchlist in March and July 2026
([CIVICUS](https://monitor.civicus.org/watchlist-july-2026/georgia/)). OGP
suspended Georgia and, when the civic-space laws were not repealed by end-2025,
made the suspension permanent on 13 April 2026
([OGP resolution](https://www.opengovpartnership.org/wp-content/uploads/2026/04/Resolution-on-the-Participation-of-Georgia-in-OGP-1.pdf)).
The United States put Bidzina Ivanishvili on the SDN list on 27 December 2024;
the Baltic states sanctioned him and interior-ministry officials in December
2024 ([Wikipedia](https://en.wikipedia.org/wiki/Bidzina_Ivanishvili)
_(secondary)_); more than 200 officials are under some sanction _(secondary)_.

**(3) Education and skills.** Georgian Technical University; the Levan
Samkharauli forensic bureau; the TVET system under the Ministry of Education; no
licensing of engineers at the professional-body level comparable to Western
colleges (**not verified**).

**(4) Public institutions and organisations.** With OGP gone and NGOs under a
foreign-agents regime, the independent monitors whose reports are sources here
(IDFI, Transparency International Georgia, the Georgian Young Lawyers'
Association) operate under threat, and a foreign-funded hub that implied a
relationship with them could put them at risk. Municipalities with a PB record
(Ozurgeti, Marneuli) and Georgian Technical University are the public bodies a
construction hub would read; the State Procurement Agency's data remains open.

**(5) The best local idea.** **Budget transparency as a national habit.**
Georgia proved that a small post-Soviet state can publish every budget document
on time and run fully electronic procurement that scored 97 of 100 in a 2020
rating of procurement transparency. The lesson of 2024 to 2026 is the harder
one: documents without civic space are not accountability.

**(6) Risks.** Sanctioned officials and oligarch; a foreign-agents regime that
could classify a hub operator or its partners; press and NGO prosecutions; EU
accession frozen. The pack and language are live, so the construction hub
remains a cheap technical pilot, but the civic layer is **not safe to operate**
for local organisations today.

**(7) First steps.** Keep the Georgian pack current; run no civic layer; revisit
when OGP eligibility is restored. State this in the book as an example of why
civic-space rating is a gate, not a score.

### 2.13 Armenia

**(1) Civic need.** The 1988 Spitak earthquake left housing scars in Gyumri that
lasted decades; the 2020 and 2023 wars and the arrival of over 100,000 displaced
people from Nagorno-Karabakh created a housing programme at national scale
(**not verified**). CPI 46. OBS 2025: 63 / 19 / 59, transparency now
"sufficient", participation nearly all at formulation (47) and zero at approval,
implementation and audit.

**(2) Civic landscape.** Community (hamaynk) self-government with elected
councils and budgets; consolidation reduced 915 communities to about 70 to 80
enlarged ones by 2022 (**exact number not verified**; Wikipedia's 2018
figure of 503 predates the last wave). Yerevan and some communities have run
participatory budgeting pilots with EU and Council of Europe support (**not
verified today**; the city's site shows procurement, auctions and council live
streams but no PB page). Armenia has been an OGP member since 2011 and submits
action plans; e-draft.am publishes every draft law for comment. CIVICUS
**Narrowed (66)**, with the Dominican Republic the most open in the list.
Elections in June 2026 (**not verified**).

**(3) Education and skills.** The National University of Architecture and
Construction of Armenia; the Urban Development Committee (licensing); the TVET
system; the Union of Builders of Armenia.

**(4) Public institutions and organisations.** Yerevan Municipality and the Communities Association
of Armenia; the Ministry of Territorial Administration and Infrastructure; the
Urban Development Committee; the State Procurement system (gnumner.am);
Transparency International Anticorruption Center; the Armenian Lawyers'
Association; the National University of Architecture and Construction; Habitat
for Humanity Armenia (which has worked on earthquake housing); the EU and
Council of Europe local-democracy programmes.

**(5) The best local idea.** **e-draft.am**: every draft legal act is published
for public comment with the authority's answer to each comment. Applied to a
municipality's capital plan, that is the "discussion and co-design" step of the
loop in a form Armenians already use.

**(6) Risks.** Russia exposure (EAEU membership, Russian banks and platforms;
Russian providers are never used); a fragile peace with Azerbaijan; political
polarisation before 2026 elections; small market (2.8 million). Data protection
law is older and lightly enforced.

**(7) First steps.** A small, open-country pilot in one enlarged community
outside Yerevan: import the community's capital budget and procurement as
sourced pages, run an e-draft-style comment round on next year's works, and show
execution with evidence. Armenia is the most plausible **Caucasus** civic pilot
and a counterpoint to Georgia in the book.

### 2.14 Azerbaijan

**(1) Civic need.** Massive state reconstruction of the territories retaken in
2020 and 2023 (the "Great Return" programme, with billions of manat a year in
the state budget; **figures not verified**) is the largest public-works
programme in the Caucasus, run entirely from the centre. CPI 30. OBS 2023: 67 /
**11** / 65, a sufficient budget with almost no public participation.

**(2) Civic landscape.** Elected municipalities exist alongside appointed
executive authorities, which hold the real power and money; municipalities have
charters but tiny budgets (the Council of Europe's Congress has repeatedly said
so; **not fetched**). OGP designated Azerbaijan inactive in 2016 and
permanently suspended it in 2017
([OGP](https://www.opengovpartnership.org/?p=76340)). CIVICUS **Closed (12)**,
the lowest score in the list; independent journalists were jailed through 2024
and 2025. **ASAN xidmət**, the one-stop public-service agency founded 13 July
2012, is genuinely admired: over 36 million applications, mobile service buses,
OECD and EEAS reports crediting it with reducing petty corruption, and a model
now exported to over 600 centres worldwide by its own count
([Wikipedia](https://en.wikipedia.org/wiki/ASAN_service) _(secondary; export
figures self-claimed)_).

**(3) Education and skills.** Azerbaijan University of Architecture and
Construction; the State Committee for Urban Planning and Architecture; licensing
is state-run.

**(4) Public institutions and organisations.** Only state bodies exist in this
space (ASAN, the State Committee, the reconstruction authority), and none could
be a counterpart for a civic layer that publishes institutional reputation. No
independent civic organisation is named here, because naming could put it at
risk.

**(5) The best local idea.** **ASAN's service standard**: one door, one queue, a
published satisfaction measure, and a design that removed the officials who used
to take bribes. The idea travels; the political system around it does not.

**(6) Risks.** Closed civic space; a state that prosecutes critics; no local
budgets to participate in; a reconstruction programme of national-security
sensitivity. The country pack can stay live for the diaspora and for private
construction; the civic engine cannot operate here.

**(7) First steps.** None for the civic layer. Keep the pack and the language;
say in the book why.

---

## 3. Short scan: further places where the need is acute

Each paragraph gives the indices, the hook and the gate. Ratings are CIVICUS
December 2025; OBS is 2025 unless stated.

**Ukraine (reconstruction).** CPI 36; OBS 65 / 41 / 85, transparency up 27
points as wartime documents came back online; CIVICUS Obstructed (52); OGP since
2011; CoST former member. Prozorro (launched 12 February 2015, mandatory for all
public buyers from 1 August 2016) publishes everything in OCDS; DoZorro (1
November 2016, run by Transparency International Ukraine with 24 regional
monitors) lets citizens flag tenders; the system scored 97.05 of 100 in a 2020
procurement-transparency rating
([Wikipedia](https://en.wikipedia.org/wiki/Prozorro) _(secondary)_). The DREAM
ecosystem (Digital Restoration Ecosystem for Accountable Management) tracks
reconstruction projects from idea to completion with open data, backed by the
RISE Ukraine coalition of 50 civil-society organisations including Open
Contracting Partnership and the Basel Institute
([RISE Ukraine](https://rise.org.ua/en) _(self claim)_; DREAM's own site is a
single-page app that did not render, so its project counts are **not
verified**). Kyiv's Public Budget was one of Europe's largest city PBs before
the war (**not verified**). Gate: war risk; Crimea, Sevastopol and the Donetsk
and Luhansk regions are restricted places (NOTICE) and must be geofenced;
martial-law limits on
data. The idea to learn: **a reconstruction project passport** (DREAM) that is
public from the first day.

**Indonesia.** CPI 34; OBS 71 / 33 / 74; Obstructed (42); OGP founder; CoST
sub-national members West Lombok and Nusa Tenggara Barat. The Musrenbang
development-planning deliberations run every year from village to national
level, and the Village Fund (Dana Desa) sends money directly to about 75,000
villages (**details not verified**). Gate: Bahasa Indonesia not live in
the engine; a new criminal code and defamation law. The idea: **deliberation by
law at every level**, and a village fund that makes the smallest unit a budget
holder.

**Bangladesh.** CPI 24; OBS 37 / 11 / 37; Repressed (29); not in OGP. Rana
Plaza, 24 April 2013: 1,134 dead, about 2,500 injured, four floors added without
permit on a building planned for shops, seven inspectors suspended, and neither
the murder nor the building-code trial concluded eight years later; the Accord
on Fire and Building Safety became the world's reference for brand-funded
inspection ([Wikipedia](https://en.wikipedia.org/wiki/Rana_Plaza_collapse)
_(secondary)_). Gate: a political transition since August 2024 and a Repressed
rating; CIVICUS counted a bright spot for the interim authorities'
accountability steps. The idea: **an inspection regime funded by buyers and
enforced by contract**, which is what a construction client's confirmation does
in miniature.

**Ethiopia.** CPI 38; OBS 20 / 7 / 59 (transparency doubled from 10); CIVICUS
**Closed (20)**; not in OGP; CoST former member and former pilot. Gate: Closed
civic space and conflict in Amhara and Tigray. Not a host or market now.

**Tanzania.** CPI 40; OBS 42 / 13 / 41; Repressed (26); withdrew from OGP in
2017 (**not re-verified**); CoST former member; PPRA publishes OCDS daily. The
2025 election-period shutdown is noted in the companion note. Gate: civic space;
Swahili not live. Follow Kenya.

**Ecuador.** CPI 33; OBS 2023 48 / 20 / 41; Obstructed (47); OGP since 2018;
**CoST national member**; SERCOP publishes OCDS daily and has adopted the CoST
methodology
([SERCOP](https://portal.compraspublicas.gob.ec/sercop/ecuador-se-suma-a-paises-de-la-region-que-implementan-la-metodologia-cost/)).
The 2008 Constitution and the COOTAD make participatory budgeting mandatory in
every autonomous decentralised government (**statute text not fetched**).
Gate: the security emergency since 2024. The idea: **constitutional PB plus CoST
in one state procurement agency**; next after Colombia and Peru.

**Guatemala and Honduras.** Guatemala: CPI 26; OBS 71 / 41 / 56; Repressed (40);
OGP since 2011; CoST former member; Guatecompras OCDS daily. Honduras: CPI 22;
OBS 62 / 17 / 50; Repressed (38); OGP since 2011; CoST founding pilot and former
member; its SISOCS disclosure system was the CoST reference for years (**not
verified today**; the sisocs.org domain now serves unrelated content). Gate:
Repressed ratings, violence, migration. The idea: **CoST was born here**; the
assurance report, an independent reading of disclosed project data, is a format
Trustwork's magazine could adopt.

**Mongolia.** CPI 31; OBS 64 / 35; Obstructed (59); OGP since 2013. The Glass
Account Law (2014) obliges every public body to publish spending online (**not
verified today**), and Ulaanbaatar's local development fund has run citizen
voting. Gate: small, cold, far; Mongolian not live. The idea: **a law named for
transparency itself**.

**Moldova.** CPI 42; OBS 2023 81 / 18 / 61 (fifth in the world); Narrowed (72);
OGP since 2011; EU candidate; MTender publishes OCDS (**not verified**);
Chișinău runs a civic budget (**not verified**). Gate: Transnistria, outside
the government's control, is a question for counsel; Russian is a live engine
language but Russian providers are never used. A strong small-country option
in the European ring.

**Kyrgyzstan.** CPI 26; OBS **69 / 37** (the best transparency in Central Asia);
Repressed (32); OGP Local members Bishkek (2020) and Osh (2024). Local
self-governments have their own budgets and a decade of World Bank-supported
participatory budgeting in towns (**not verified**). Gate: 2024 to 2025
foreign-agent and media laws; Russia exposure. The idea: **city-level OGP
membership when the national level is closed**.

**Pakistan.** CPI 28; OBS 45 / 22 / 35 (up 15); Repressed (24); not in OGP. The
2022 floods damaged about 2 million homes in Sindh; the Sindh People's Housing
for Flood Affectees company was set up to deliver owner-driven resilient housing
with World Bank support, the largest such programme in the world by target
(figures on the programme's site are placeholders, so **not verified**;
[SPHF](https://sphf.gos.pk/)). Gate: civic space, security, no live language.
The idea: **owner-driven reconstruction at scale**, money to the household with
a technical standard and a disbursement by stage, which is Trustwork's
plan-to-people pattern applied to disaster.

**Morocco.** CPI 39; OBS 51 / 24 / 51; Obstructed (42); OGP since 2018. The Al
Haouz earthquake of 8 September 2023 killed at least 2,960 and damaged over
59,000 houses; the state chose "supervised self-construction" with 140,000
dirhams for a collapsed home and 80,000 for a damaged one, paid in instalments
against an architect's drawings; a year later only 1,000 of 55,000 planned homes
were finished and Amazigh residents protested restrictions on traditional
materials
([Wikipedia](https://en.wikipedia.org/wiki/2023_Marrakesh%E2%80%93Safi_earthquake)
_(secondary)_). Gate: Arabic and French not live. The idea, and its failure
mode: **cash by stage against a plan** works only if the plan, the stages and
the evidence are visible to the household and the inspector together.

**Senegal.** CPI 46; OBS 42 / **6** / 31; Obstructed (47), upgraded from
Repressed in 2025; OGP since 2018. Senegal has one of Africa's longest
traditions of municipal participatory budgeting through NGO facilitation (**not
verified today**). Gate: French not live; the lowest participation score in the
scan. The idea: **civil-society-facilitated PB in dozens of communes without a
national law**.

**Türkiye (2023 earthquake reconstruction).** CPI 31; OBS 65 / **0** / 65;
Repressed (23); OGP inactive (**not re-verified**). The 6 February 2023
earthquakes killed 53,537 in Türkiye, destroyed at least 518,009 houses and
345,000 apartments, and forced the demolition of at least 61,722 buildings; the
role of construction amnesties and the prosecution of contractors are documented
elsewhere but not in the page fetched
([Wikipedia](https://en.wikipedia.org/wiki/2023_Turkey%E2%80%93Syria_earthquakes)
_(secondary)_). Gate: Repressed civic space, a participation score of zero,
Turkish not live. Not a host or market now; the lesson belongs in the book: **a
building code is only as good as the amnesty that follows it**.

---

## 4. Scorecard for the civic mission

### Criteria and weights

Seven criteria, each rated 1 to 5, higher always better for a civic hub. Weights
reflect the book's mission (where it is especially needed; where a lawful
operator can help; initiative budgeting, open budgets, education, culture and
reputation) and the caution that a civic engine in a closed civic space is risky.

| Criterion                                 | Weight | What a 5 means                                                                                                     | Evidence                 |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Civic need (N)                            | 20     | Informal building, collapses, public-works scandals, low CPI, housing deficit                                      | Sections 2 and 3         |
| Civic-space openness (O)                  | 20     | CIVICUS Open or Narrowed; OGP member in good standing; press free enough to publish evidence                       | CIVICUS, OGP             |
| Decentralised budgets and PB practice (B) | 15     | Municipalities hold money; a PB or initiative-budget law or durable practice; citizen oversight has legal standing | Statutes, PB record      |
| Open data for the loop (D)                | 15     | Budget documents sufficient (OBS 61+), OCDS daily, public works register, CoST                                     | OBS, OCDS registry, CoST |
| Partner availability (Pa)                 | 10     | Independent civic organisations, universities, professional bodies and willing public institutions                 | Section 2 (4)            |
| Risk (Ri)                                 | 10     | No sanctions exposure, not FATF-listed, no data localisation, safe for monitors                                    | OFAC, FATF, statutes     |
| Engine fit (F)                            | 10     | Live language and country pack                                                                                     | Localization doc         |

Score = sum (weight times rating) divided by 5; maximum 100. Openness is
weighted as heavily as need on purpose: without it, need cannot be served
lawfully or safely.

### Ratings

| Country                   | N   | O   | B   | D   | Pa  | Ri  | F   | Score  | Uncertainty                                                |
| ------------------------- | --- | --- | --- | --- | --- | --- | --- | ------ | ---------------------------------------------------------- |
| Dominican Republic        | 4   | 4   | 4   | 5   | 3   | 4   | 5   | **83** | Medium (PB statute and municipal practice not re-verified) |
| Peru                      | 5   | 2   | 5   | 5   | 4   | 3   | 5   | **82** | Medium                                                     |
| Colombia                  | 4   | 2   | 5   | 5   | 5   | 3   | 5   | **80** | Medium (Medellín share not verified)                       |
| Philippines               | 5   | 2   | 4   | 4   | 4   | 4   | 5   | **78** | Medium (no OCDS; CPA not verified)                         |
| United States (San Diego) | 2   | 3   | 4   | 5   | 5   | 5   | 5   | **77** | Low                                                        |
| Kenya                     | 5   | 2   | 5   | 4   | 4   | 2   | 4   | **75** | Low                                                        |
| Ghana                     | 4   | 3   | 4   | 3   | 4   | 4   | 4   | **73** | Medium (OBS collapse)                                      |
| Mexico                    | 5   | 2   | 4   | 3   | 4   | 3   | 5   | **73** | Medium (INAI, CDMX figures not verified)                   |
| Armenia                   | 3   | 4   | 3   | 3   | 3   | 3   | 5   | **68** | High (PB pilots not verified)                              |
| Nigeria                   | 5   | 2   | 3   | 3   | 4   | 2   | 4   | **66** | Medium                                                     |
| Georgia                   | 3   | 2   | 3   | 4   | 2   | 2   | 5   | **59** | Low (status changes are documented)                        |
| Rwanda                    | 3   | 2   | 3   | 4   | 3   | 2   | 3   | **57** | Medium                                                     |
| Uzbekistan                | 4   | 1   | 3   | 2   | 2   | 2   | 5   | **53** | High (Open Budget figures not verified)                    |
| Azerbaijan                | 3   | 1   | 1   | 2   | 1   | 2   | 5   | **41** | Low                                                        |

Notes on ratings. **Openness**: Narrowed earns 4, Obstructed 3, Repressed 2,
Closed 1; the United States is held at 3 despite the OGP exit because city and
state institutions are intact; Georgia is held at 2 rather than lower because
its municipalities and procurement data still function. **Budgets**: Peru, Kenya
and Colombia earn 5 for a legal frame plus practice; the Dominican Republic and
Mexico 4 for a law whose execution is weak; Uzbekistan 3 for a large programme
without local autonomy; Azerbaijan 1. **Data**: Ghana drops to 3 for the 2025
budget-transparency fall and monthly OCDS; Mexico to 3 for the end of INAI
despite a historic OBS 80. **Risk**: Kenya 2 for FATF; Nigeria 2 for security;
Rwanda 2 for sanctioned officials and localisation; Georgia 2 for sanctioned
leadership and the foreign-agents regime; Uzbekistan 2 for localisation and
Russia exposure.

### Sensitivity

- **Equal weights** (every criterion 100/7): the Dominican Republic, Peru and
  Colombia stay in the top three; the United States moves to fourth because risk
  and partners count more; Kenya and the Philippines swap.
- **Need weighted 30, openness 10** (an "impact first" view): Peru 1st, Kenya
  2nd, Philippines and Nigeria rise, the Dominican Republic falls to 5th,
  Uzbekistan passes Georgia and Rwanda. This is the view that puts local
  partners at risk and is not recommended.
- **Openness as a hard gate** (exclude Closed; exclude Repressed unless OGP
  member in good standing with functioning municipal PB): Uzbekistan and
  Azerbaijan drop out; Georgia and Rwanda drop out; the remaining ten keep their
  order. This gate is the recommendation.

### Compared with the construction ranking

|                    | Construction rank (top-10 note) | Civic rank (this note) | Reading                                                                                                                                             |
| ------------------ | ------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Peru               | 1                               | 2                      | Agree: the best overall first country; civic risk is Repressed civic space, so run the civic layer with the Contraloría's own citizen-monitor frame |
| Philippines        | 2                               | 4                      | Agree broadly; the 2025 scandal makes the civic layer the point, not an add-on, but PhilGEPS has no OCDS                                            |
| Kenya              | 3                               | 6                      | Civic case strong (Makueni, 15 percent devolution, participation 44) but FATF and protest repression hold it back                                   |
| Ghana              | 4                               | 7                      | Civic space the best in Africa, Sekondi-Takoradi the best local model; the 2025 budget-transparency fall is the warning                             |
| Colombia           | 5                               | 3                      | Civic stronger than construction: veedurías, Medellín, SECOP II; building market weak                                                               |
| Dominican Republic | 6                               | **1**                  | The biggest disagreement: small market but the only country strong on budget, participation, civic space, CoST and OCDS at once                     |
| Uzbekistan         | 7                               | 13                     | The biggest downgrade: fastest technical launch, Closed civic space; construction only                                                              |
| Nigeria            | 8                               | 10                     | Agree: large, needed, hard; Kaduna and Tracka make a local start possible                                                                           |
| Mexico             | 9                               | 8                      | Agree; Mexico City's institute-run PB is the design model even if the hub starts elsewhere                                                          |
| Rwanda             | 10                              | 12                     | Civic layer only institutional (Imihigo), never citizen reputation                                                                                  |
| Georgia            | not in ten (small)              | 11                     | Pack live; civic layer paused until OGP eligibility returns                                                                                         |
| Armenia            | not scored                      | 9                      | A small open-country pilot for the Caucasus                                                                                                         |
| Azerbaijan         | not scored                      | 14                     | No civic layer                                                                                                                                      |
| United States      | reference hub                   | 5                      | Home: the evidence layer, not PB, is the first civic product                                                                                        |

### Sequence for the five-year arc

- **Year 1 (home).** San Diego: the construction hub as planned, plus the "works
  of the city" evidence layer from open data. No vote. This is where the engine
  learns to turn a permit and a capital line into a sourced page with field
  evidence.
- **Year 2 (first civic pilot).** **Dominican Republic, one consenting
  municipality** with a documented PB record. Why: mandatory municipal PB law since 2007, the best
  participation and transparency scores of the fourteen, Narrowed civic space,
  daily OCDS, CoST national membership, Spanish live, a new procurement law, and
  a national moment after Jet Set when building inspection is a public question.
  Small enough to show the whole loop in one budget cycle and to fail safely.
- **Year 2 to 3 (highest need).** **Peru, one province** with a paralysed-works
  backlog, under the Contraloría's citizen-monitor frame and with a municipal
  association as operator; then **Medellín** with a university and veedurías, as
  the "learn from the best" partner.
- **Year 3 (Africa).** **Sekondi-Takoradi and the Western Region of Ghana**
  (open civic space, CoST disclosures already flowing) and **Makueni County,
  Kenya** once the FATF exit clears payments; **Kaduna, Nigeria** as the
  Tracka-partnered third.
- **Year 3 to 4 (Asia and the Caucasus).** **Philippines, one province** with
  the flood-control project list and COA; **Armenia, one enlarged community**.
  **Mexico City, one alcaldía** when a willing alcaldía and IECM data access
  exist.
- **Construction only, civic paused:** Uzbekistan, Rwanda (institutional
  evidence only), Georgia, Azerbaijan. Reviewed yearly against CIVICUS and OGP
  status.
- **Watch list from the short scan:** Ecuador and Moldova (strong frames, gates
  are security and occupation); Ukraine (DREAM partnership when counsel clears
  the geofence); Indonesia and Senegal (languages first).

---

## 5. What it means for Trustwork

1. **Civic-space rating is a gate, not a score.** The hub configuration should
   carry a civic-layer switch that an operator can turn on only for territories
   whose current CIVICUS rating and OGP standing meet a threshold the owner
   sets, recorded with date and source in the country pack. Georgia's fall from
   OBS first place to permanent suspension from OGP in three years shows why it
   must be re-checked yearly.
2. **The vote has a neutral keeper.** Mexico City's electoral institute and
   Peru's vigilance committees point the same way: the hub operator never runs
   the vote. The engine offers a vote module that a public body or an
   independent body operates, with the voter roll and identity verification
   outside Trustwork, and results published as sourced pages.
3. **Evidence weighs as much as the vote.** Uzbekistan's vote-buying and Peru's
   unexecuted priorities are the same failure from both ends. Every PB project
   page must carry its feasibility, its cost range, its contract (from OCDS),
   its field evidence and its confirmations, so that a bought vote still
   produces a public record of what was or was not built.
4. **Institutions have pages and reputation from evidence, never citizens from
   the state.** Rwanda's Imihigo and Kenya's Controller of Budget reports show
   how an institution's commitments can be mirrored and scored by execution.
   Residents are never scored. Officials appear only as holders of a role on a
   public record.
5. **Citizen oversight needs legal standing in the pack.** Colombia's veedurías
   (Ley 850), Peru's comités de vigilancia (Ley 28056), the Philippines' Citizen
   Participatory Audit and Kenya's PFM Act participation clauses should be
   recorded as legal facts in country packs, each with its source, so the engine
   can tell a resident what right they are exercising when they attach a
   photograph.
6. **Import before you ask.** Every pilot starts by importing what is already
   public (OCDS, CoST disclosures, Infobras, Sumbong sa Pangulo, Tracka, DACF
   releases, San Diego permits) as sourced pages. Register connectors (REG-002),
   OCDS adapters (PROC-003) and a new **public-works register connector** are
   the civic layer's first work package, not the vote.
7. **Build the building register.** Kenya's IEK proposal, Florida's SB 4-D and
   the Dominican inspection code all ask for the same object: a public page per
   building with who designed, who built, who approved, who inspected and when.
   Trustwork's sourced page for a building, with inspection records as
   documents, is a product the civic layer can offer every country.
8. **Disaster reconstruction is plan-to-people under pressure.** Morocco and
   Sindh pay households by stage against a plan. The engine's
   progressive-building plans (PLAN-004) and remote-owner oversight (PLAN-005)
   should gain a "disbursement stage with evidence" so that a household, an
   inspector and a funder see the same photograph.
9. **Phone-first, champion-led.** Tracka's community champions and Makueni's
   homestead meetings both say the civic layer reaches people where they are.
   The phone-number account (ACCT-001), USSD (CHAN-002) and messaging channels
   are prerequisites for any civic pilot outside the United States.
10. **The magazine publishes assurance.** CoST's assurance report, an
    independent reading of disclosed project data, is a format the hub's weekly
    magazine can adopt: sourced, dated, with the project pages linked, never an
    opinion piece.
11. **Protect the monitor.** In Repressed territories, evidence submission must
    allow pseudonymous or institution-mediated submission (through a veeduría, a
    COA auditor, a Tracka champion) so that no resident is exposed. Private
    stays private, including from the hub operator and from the state.
12. **Sanctions and officials.** Every public institution page in a territory
    with sanctioned officials (Rwanda, Georgia) passes through the sanctions
    engine before publication; the civic layer never lists a sanctioned person
    as a counterparty.

---

## 6. Key findings, sourced

Fifteen sourced statements, one per main country plus one general.

1. **General.** Participation is the weakest pillar of open budgeting
   everywhere: the global average public-participation score in the Open Budget
   Survey 2025 is 17 out of 100, and only two of Trustwork's fourteen countries
   reach 44 or above (Kenya 44, Dominican Republic 50).
   [IBP country pages](https://internationalbudget.org/open-budget-survey/country-results).
2. **United States.** The country that co-founded the Open Government
   Partnership withdrew from it by a letter of 15 January 2026, and CIVICUS
   downgraded its civic space to Obstructed in December 2025; the
   open-government story in America now belongs to its cities and states, and
   San Diego publishes 122 datasets, including every 311 request and every
   development approval, daily.
   [Nextgov](https://www.nextgov.com/digital-government/2026/02/us-withdraws-open-government-partnership-which-it-helped-create/411133)
   _(secondary)_; [data.sandiego.gov](https://data.sandiego.gov/).
3. **Peru.** Peru is the only country that obliges every one of about 1,900
   local and regional governments to run a participatory budget each year, and
   the Contraloría counts more than two thousand paralysed public works, 72
   percent of them at local governments; both ends of the loop exist in law, the
   middle does not.
   [El Peruano, 2022](https://elperuano.pe/noticia/137590-contraloria-advierte-la-paralisis-de-2369-obras);
   [Wikipedia es](https://es.wikipedia.org/wiki/Presupuesto_participativo)
   _(secondary)_.
4. **Philippines.** Of ₱545.6 billion spent on flood control between July 2022
   and May 2025, about ₱100 billion went to 15 of 2,409 accredited contractors,
   and the presidential portal opened on 11 August 2025 to show every project's
   contractor and cost received over 12,000 citizen complaints within a month.
   [Wikipedia](https://en.wikipedia.org/wiki/2025_Philippine_flood_control_projects_controversy)
   _(secondary, provisional)_.
5. **Kenya.** Makueni County's participatory budget runs from village to county,
   a World Bank initiative there tripled women's participation to 35 percent by
   holding meetings near homesteads, and the Institution of Engineers of Kenya
   is asking for a national building register so anyone can check who designed
   and approved a building.
   [World Bank](https://openknowledge.worldbank.org/server/api/core/bitstreams/daa1a44c-5d80-586f-9efe-6e44ab318fc3/content);
   [The Standard, 2026](https://www.standardmedia.co.ke/business/amp/national/article/2001543722/over-10000-buildings-in-kenya-are-death-traps)
   _(secondary)_.
6. **Ghana.** Sekondi-Takoradi joined CoST in 2019 as the first OGP local
   government to do so, built a disclosure portal, and by 2026 all 14 districts
   of the Western Region take part in independent review of their infrastructure
   projects; in the same years Ghana's national budget-transparency score fell
   from 46 to 22.
   [OGP story](https://www.opengovpartnership.org/stories/building-trust-infrastructure-transparency-in-kaduna-and-sekondi-takoradi/);
   [GNA, 2025](https://gna.org.gh/2025/11/all-14-districts-in-western-region-to-participate-in-independent-review-process-of-cost/)
   _(secondary)_;
   [IBP Ghana](https://internationalbudget.org/open-budget-survey/country-results/2025/ghana).
7. **Colombia.** Thirty-one percent of Colombian households live in housing
   deficit, Medellín has voted on part of its investment budget since 2004, and
   Colombia's statutory law gives citizen oversight committees (veedurías) the
   right to watch any public contract, which SECOP II publishes daily in open
   data.
   [DANE](https://www.dane.gov.co/index.php/estadisticas-por-tema/demografia-y-poblacion/deficit-habitacional);
   playbook `co.md`.
8. **Dominican Republic.** When the Jet Set roof fell on 8 April 2025 and killed
   236 people, the country had no building inspection code in law; it also had,
   already, a mandatory municipal participatory-budget law, daily open
   contracting, the best budget-participation score of Trustwork's fourteen
   countries (50) and CoST membership. The loop needs connecting, not inventing.
   [Wikipedia](https://en.wikipedia.org/wiki/Jet_Set_nightclub_roof_collapse)
   _(secondary)_;
   [IBP](https://internationalbudget.org/open-budget-survey/country-results/2025/dominican-republic);
   [CoST](https://infrastructuretransparency.org/where/).
9. **Uzbekistan.** Uzbekistan's Open Budget lets residents vote by phone on a
   fixed share of their district's money and has drawn participation in the
   millions, and it has shown that when the vote is the only thing that counts,
   votes get bought; CIVICUS rates the country's civic space Closed (18 of 100).
   Figures on the programme must be cited from the Ministry of Economy and
   Finance or UNDP before print.
   [CIVICUS data](https://monitor.civicus.org/data/).
10. **Nigeria.** Nigeria has recorded more than 650 building collapses and over
    1,600 deaths since 1974, more than half of them in Lagos, and a civic
    organisation's community champions track over 19,000 public projects in
    17,000 communities across all 36 states.
    [Prime Business Africa](https://www.primebusiness.africa/lagos-accounts-for-highest-number-of-building-collapses-in-nigeria-as-deaths-hit-1616-report/)
    _(secondary)_; [Tracka](https://yourtracka.org/) _(self claim)_.
11. **Mexico.** Mexico City's participatory budget has been run since 2011 by
    the city's independent electoral institute rather than by the mayor, in
    every one of its roughly 1,800 neighbourhood units; and the Line 12 collapse
    of 3 May 2021 that killed 26 was traced by the independent investigator to
    missing studs, unauthorised design changes and no inspections for seven
    years, a report the city rejected.
    [IECM](https://www.iecm.mx/participacionciudadana/presupuesto-participativo/);
    [Wikipedia](https://en.wikipedia.org/wiki/Mexico_City_Metro_overpass_collapse)
    _(secondary)_.
12. **Rwanda.** Rwanda scored 58 on the 2025 Corruption Perceptions Index, its
    best ever and the best of Trustwork's countries, and every district signs
    public performance contracts (Imihigo) evaluated in public; CIVICUS rates
    its civic space Repressed (25), so the civic layer there can mirror
    institutions' commitments but must never score residents.
    [TI Rwanda](https://tirwanda.org/slider/article/driving-change-through-ti-rwanda-s-flagship-research-publication)
    _(secondary)_; [Wikipedia](https://en.wikipedia.org/wiki/Imihigo)
    _(secondary)_.
13. **Georgia.** Georgia ranked first of 125 countries for budget transparency
    in 2023 and was permanently suspended from the Open Government Partnership
    on 13 April 2026 over civic space and freedom of expression, its laws on
    foreign influence among the grounds; documents
    without civic space are not accountability.
    [Ministry of Finance](https://mof.ge/4536/n/events/o_n_10911);
    [OGP resolution](https://www.opengovpartnership.org/wp-content/uploads/2026/04/Resolution-on-the-Participation-of-Georgia-in-OGP-1.pdf).
14. **Armenia.** Armenia's budget became "sufficient" in 2025 (63) while public
    participation stayed at 19, and its civic space is Narrowed, the most open
    in the Caucasus; a small community there is the region's natural civic
    pilot.
    [IBP Armenia](https://internationalbudget.org/open-budget-survey/country-results/2025/armenia);
    [CIVICUS data](https://monitor.civicus.org/data/).
15. **Azerbaijan.** Azerbaijan's ASAN service centres, founded in 2012, removed
    the officials who used to take bribes and now serve as a model copied
    abroad; the same state publishes a sufficient budget with a participation
    score of 11, was permanently suspended from OGP in 2017, and is rated Closed
    (12). A service standard travels; the civic engine does not.
    [Wikipedia](https://en.wikipedia.org/wiki/ASAN_service) _(secondary)_;
    [IBP 2023](https://internationalbudget.org/open-budget-survey/country-results/2023/azerbaijan);
    [OGP](https://www.opengovpartnership.org/?p=76340).

---

## 7. Open questions and unverified items

Each item should be verified against a primary source before it is quoted, or
dropped.

- Uzbekistan Open Budget: share of district budgets, numbers of initiatives and
  votes, funds, the vote-buying cases and the identity rules (the portal
  renders as a single-page app).
- Medellín's PB share of the investment budget (Acuerdo 28 de 2017) and recent
  turnout; Mexico City's PB share and 2025 turnout (IECM page behind a bot
  wall); the Dominican Ley 170-07 and Ley 176-07 texts and municipal compliance;
  Ecuador's COOTAD articles; Colombia's Ley 1757 text (the Senate site could
  not be reached).
- Kenya Article 203(2) (15 percent) and Ghana Article 252 (5 percent DACF) were
  not re-fetched; both are well established but need the constitution link in
  the chapter.
- The Philippines' Bottom-up Budgeting history and the COA Citizen Participatory
  Audit (the COA page could not be reached).
- Georgia's 2025 FARA and grants laws in detail; Georgian municipal PB
  programmes; the Batumi 2021 collapse figures.
- Armenia's community count after consolidation and any PB pilots; Azerbaijan
  municipal finance figures and Great Return budgets; Rwanda's Kigali
  informal-housing share and the EU March 2025 sanctions.
- DREAM project counts; Kyiv Public Budget figures; Honduras SISOCS status;
  Mongolia's Glass Account Law details; Senegal and Kyrgyzstan PB programmes;
  Tanzania's and Türkiye's OGP status.
- US: San Diego's 2025 and 2026 homelessness counts by city; the SANDAG RHNA
  figures; the claimed March 2026 San Diego housing package (unofficial source
  only).
- FATF October 2026 list was taken from a compliance-firm summary; confirm on
  fatf-gafi.org.
- The CPI 2025 scores were read from Wikipedia's table; confirm on
  transparency.org.

End of note.
