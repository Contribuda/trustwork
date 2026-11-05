# E — Making a private build bankable and insurable

Research note for the Trustwork Book, first edition, November 2026. Working evidence, not the book's position.

Feeds chapter 10 ("A build a bank can trust"). All web sources accessed
2026-11-04 unless stated. Evidence levels: **primary/official**, _(secondary)_,
_(vendor/self claim)_. Nothing here is legal advice; legal points are questions
for counsel. Naming an organisation records its public work; it implies no contact, interest or agreement.

**Question.** Private construction has almost nowhere a lending instrument,
because there is no standard: a family cannot get a mortgage to build its own
house. Can project management, standards, quality records and statistics make a
private build bankable and insurable, and how would Trustwork act?

## Summary

1. Most housing in the developing world is built by its owners, in stages, from
   savings, remittances and small loans; formal finance barely touches it. The
   World Bank's Sub-Saharan Africa stocktaking says "most housing is built
   incrementally" and that in 2011 only 3 percent of the population was eligible
   for a conventional mortgage; Kenya had 30,015 residential mortgages in 2023
   for 52 million people; Ghana's stock is roughly 90 percent informally
   produced.
2. Lenders refuse not because the borrower is poor but because the _object_ is
   unreadable: no approved plan and budget, no valuation of an unfinished asset,
   an unknown builder, no inspected stages, unclear title, and no loss data.
   Insurers refuse for the same reasons plus one: nobody records defects.
3. Where private building _is_ financed, the mechanism is always the same: a
   standard record of the plan, money released in stages against an inspection,
   a warranty or defect insurance tied to inspections, and a title that can
   carry a lien. US construction-to-permanent loans, UK self-build mortgages,
   Germany's MaBV payment schedule, France's dommages-ouvrage, Peru's Techo
   Propio, Mexico's ConstruYO, the Philippines' Pag-IBIG tranches and Nepal's
   reconstruction grants are all variations on it.
4. Standards unlock products. IFC's EDGE certificate turned "green" into a bank
   product: 357,000 housing units certified, Colombia from zero to 27 percent of
   new build, the first green mortgage in South Africa priced on the
   certificate. MISMO made US mortgage data exchangeable; OCDS made public
   contracts comparable across 50+ governments. Nobody has yet done this for the
   private build itself.
5. Trustwork already holds the parts of a "bankable build file": frozen approved
   plan versions, plan items for permits and inspections, change records with
   reasons, execution records (work, acceptance, defect, remediation), hashed
   evidence, counterparty confirmations, licence checks, and reputation
   explained from evidence.
6. What is missing is the _projection_ of these parts to a third party with the
   owner's consent, a role for independent inspectors and valuers, a
   disbursement instruction a licensed lender or escrow provider can act on, and
   an open data standard so many lenders can read one format.
7. Trustwork never lends, never holds money, never advises on credit, never
   collects data without consent, and never sells placement. The lines in EU, UK
   and US law (credit intermediary, insurance distribution, loan originator,
   RESPA referral) are real and close; the design must stay on the "information
   only, no additional steps, no referral fee" side of them until counsel says
   otherwise per country.
8. A hub's open statistics (cost ranges, completion times, defect rates by stage
   and building type), aggregated with minimum samples and consent, are the
   public good that makes the first lender's risk smaller and the second
   lender's product possible.
9. First moves: publish the open Build File standard with deterministic
   fixtures; pilot where a staged, inspected disbursement already exists in law
   or practice (Peru's Techo Propio, Mexico's ConstruYO, the Philippines'
   Pag-IBIG, the US construction-to-permanent loan) so Trustwork is the record,
   not the regime; housing-microfinance and refinance institutions are
   _readers_ of the file, not partners of a platform.
10. Status of everything in this note's strategy: a direction of the book, not
    yet designed in the repository. Nothing is agreed with anyone.

## 1. The problem, sourced

### 1.1 How much housing is self-built or incremental

- **Sub-Saharan Africa.** "Most housing is built incrementally, which is
  reflected by the most typical sources of housing finance: savings and small
  loans. The majority of urban residents build shelter themselves or through the
  assistance of local laborers. Without access to mortgage finance to purchase
  complete homes, housing is built incrementally with investments from
  individual savings, remittance transfers, and participation in savings
  cooperatives or through the use of microfinance." Only 24 percent of adults
  held an account at a formal institution; 6 percent received a loan from a
  financial institution in 2014; "in 2011, 85 percent of Africa's urban
  population lacked access to formal housing loans and only 3 percent of the
  population was eligible for a conventional mortgage (Kihato 2013)". — World
  Bank, _Stocktaking of the Housing Sector in Sub-Saharan Africa, Summary
  Report_, 2015, pp. 14–15,
  https://www.worldbank.org/content/dam/Worldbank/document/Africa/Report/stocktaking-of-the-housing-sector-in-sub-saharan-africa-summary-report.pdf
  — **primary/official**.
- **Ghana.** "As a result of the lack of support for incremental housing,
  approximately 90 percent of the housing stock in Ghana is produced
  informally." — Wakely & Riley, _Cities Without Slums: The Case for Incremental
  Housing_, Cities Alliance / World Bank, June 2011,
  https://documents1.worldbank.org/curated/en/883891468150578554/pdf/809580NWP0Case0box0379824B00PUBLIC0.pdf
  — **primary/official** (policy paper). CAHF's Ghana profile says a majority of
  the stock comes from the informal economy "mainly through incremental
  construction" _(secondary: search snippet of the 2023 profile; the 2024 PDF
  could not be text-extracted)_.
- **Kenya (2024 profile).** 30,015 residential mortgages outstanding (2023),
  US$2,182 million, 1.86 percent of GDP; typical mortgage rate 14.3 percent; 32
  mortgage providers, 47 microfinance providers with 284,472 loans outstanding;
  4,060,000 residential properties with a title deed (2022); cheapest newly
  built formal house Ksh 960,000 (US$7,442); national average construction cost
  Ksh 48,750/m² (US$379); 86 percent informal employment; 2,380 EDGE-certified
  homes. — CAHF, _2024 Housing Finance in Africa Yearbook: Kenya profile_,
  https://housingfinanceafrica.org/wp-content/uploads/2025/03/KENYA.pdf —
  **primary/official** (CAHF compiles from CBK, KNBS and others).
- **Nigeria (2024 profile).** More than 26 commercial banks and 32 primary
  mortgage banks offer mortgages; the Federal Mortgage Bank "has only provided
  mortgages to less than 1% of the more than 5.47 million total subscribers to
  its National Housing Fund"; home ownership fell from 30 percent (2019) to 20
  percent (2024); 92.3 percent of the employed are informal; deficit above 28
  million units; about 50,000 units a year are built against 700,000 needed;
  cement up 442 percent since 2019; a Lagos building permit takes over 60 days;
  "71.4% of landlords in the country do not possess titles... only 13.2% of
  property owners hold title deeds" (NBS 2018). — CAHF, _2024 Nigeria profile_,
  https://housingfinanceafrica.org/wp-content/uploads/2025/03/NIGERIA.pdf —
  **primary/official**.
- **Global.** People in informal settlements and slums rose from 895 million
  (2000) to 1.16 billion (2024). "Incremental development is financed gradually
  over time rather than all at once. The most common finance sources are
  savings, remittances, loans from informal lenders (relatives, friends,
  neighbours, moneylenders and pawnbrokers) and financial self-help
  organizations". "Over the past decade housing microfinance has expanded,
  although it remains a secondary product for microfinance institutions".
  "Conventional housing finance systems have generally failed to engage with the
  reality of incremental upgrading." — UN-Habitat, _World Cities Report 2026_,
  chapter 5, pp. 117, 127 and the policy section,
  https://unhabitat.org/sites/default/files/2026/05/wcr_2026_chapter_5.pdf —
  **primary/official**.
- **IFC.** "More than one billion people live in slums globally"; 1.6 billion in
  sub-standard housing; "an estimated 100,000 homes would have to be built per
  day through 2030 to meet demand"; an "estimated $16 trillion financing gap";
  IFC has "committed more than $7 billion to the sector since 2000", portfolio
  US$3.8 billion across 93 projects (March 2023); it supports mortgage
  refinancing companies and covered bonds. — IFC, _Housing Finance_,
  https://www.ifc.org/en/what-we-do/sector-expertise/financial-institutions/housing-finance
  — **primary/official** (institutional page).
- **Habitat for Humanity's Terwilliger Center.** "families build their homes
  gradually, adding rooms or making improvements over time as resources allow";
  where the system lacks finance, materials or expertise the process becomes
  "slower, more expensive, and less safe"; the Center helps lenders "design loan
  and insurance products suited to incremental building and irregular incomes".
  Reached 49 million people since 2016 through market-based work _(self claim)_.
  —
  https://www.habitat.org/impact/our-work/terwilliger-center-innovation-in-shelter
  — **primary/official** for its own programme.
- **United States.** "Custom" homes (contractor-built and owner-built, "built
  for owner occupancy on the owner's land", with either the owner or a builder
  acting as general contractor) were 17.5 percent of single-family starts in
  2024 (176,932 starts), down from 18.8 percent (2023) and 20.4 percent (2022);
  41.2 percent in New England, 10.7 percent in West South Central. The
  owner-built share alone is not published in this analysis. — NAHB Eye on
  Housing, "Custom Home Building Share Declines in 2024", October 2025, from
  Census Survey of Construction,
  https://eyeonhousing.org/2025/10/custom-home-building-share-declines-in-2024/
  — _(secondary, from a primary dataset)_.

### 1.2 Why lenders refuse

The sources above and the instruments in section 2 converge on seven reasons.
Each is a missing record, not a missing borrower.

1. **No valuation of an unfinished asset.** Lending against a house that does
   not yet exist needs an "as completed" value and a way to re-check it as the
   building rises. Fannie Mae's single-closing rule divides the loan by the
   lesser of cost or "as completed" appraised value and requires a completion
   report (Form 1004D) at the end; if value fell, a new appraisal and
   requalification. — Fannie Mae Selling Guide B5-3.1-02,
   https://selling-guide.fanniemae.com/sel/b5-3.1-02/conversion-construction-permanent-financing-single-closing-transactions
   — **primary/official**. RICS treats development property, "where improvements
   are either being contemplated or are in progress at the valuation date", as
   "complex", with "a potentially high variation" and "optionality" that
   "require a high level of expertise", read with IVS 410. — RICS, _Valuation of
   development property_, 1 October 2019,
   https://www.rics.org/profession-standards/rics-standards-and-guidance/sector-standards/valuation-standards/valuation-of-development-property
   — **primary/official**. Where there is no comparable market, no valuer and no
   cost standard, the lender has no number to lend against.
2. **No standard plan and budget.** UK self-build lenders either pay against
   interim valuations or, in "cost-based" products, against a fixed stage
   schedule of project costs (BuildStore, section 2.2). Without a plan broken
   into stages with costs, neither method works.
3. **No reliable builder.** Fannie Mae's process assumes builder review and a
   construction contract with a draw schedule _(from the 2018 job aid, secondary
   snippets; the document itself could not be reached)_. Surety companies run "an
   extensive underwriting process to prequalify contractors" before bonding them
   (SFAA, https://surety.org/what-is-surety/ — **primary/official** for the
   industry body). Where no contractor record exists, no one can be
   prequalified.
4. **No inspection of stages.** Every working instrument releases money against
   an inspected stage (section 2). Without an inspector, the lender's only
   alternatives are to pay nothing until completion (which the owner cannot
   pre-finance) or to pay in advance and hope.
5. **Cost overruns and change.** Fannie Mae allows the loan amount to rise "only
   to cover documented increased construction costs", with a title endorsement
   confirming first-lien status (B5-3.1-02). German banks charge
   Bereitstellungszinsen on undrawn funds when the build runs past the
   interest-free period (Dr. Klein guide, section 2.3). Change without a record
   is uninsurable risk.
6. **Land tenure and title.** Nigeria: 71.4 percent of landlords without titles
   (above). Germany's MaBV forbids a developer to take any money until a
   priority notice (Vormerkung) is in the land register and prior liens are
   secured for release (section 2.3). Peru's Techo Propio requires land
   "registered in the public registry, free of liens or encumbrances" (section
   2.5). The lien is the collateral; without a registrable title there is no
   mortgage, only a personal loan.
7. **Informal income and no collateral until completion.** 92.3 percent informal
   employment in Nigeria, 86 percent in Kenya (CAHF). Habitat's microfinance
   study found demand among people "earning as little as Sh500 a day" for small,
   "non-mortgage-backed loans with short terms" (Business Daily, 15 April 2018,
   on the Terwilliger Center / Mastercard Foundation study,
   https://www.businessdailyafrica.com/bd/corporate/companies/study-tips-micro-loans-to-bridge-housing-shortfall-among-poor-2198000
   — _(secondary)_). The answer to irregular income is not a 20-year mortgage
   but a sequence of small loans, each secured by the stage it finances — which
   again needs the stage to be recorded.

### 1.3 Why insurers refuse or overprice

- **No defect and loss data.** Insurance prices frequency and severity. A
  private build with no record of defects, remediation, or who built what has no
  actuarial history; the insurer either declines or loads the premium. France
  solved this by law (compulsory décennale and dommages-ouvrage, section 2.4),
  which produced forty-five years of claims data. The UK solved it by a warranty
  provider that inspects during the build (NHBC, section 4).
- **Unknown contractors.** French décennale is the _constructor's_ obligation,
  sanctioned by up to six months' imprisonment and a €75,000 fine
  (service-public F2034 — **primary/official**). A contractor who cannot show
  insurance cannot lawfully build. Where no register exists, the insurer cannot
  distinguish a builder with twenty clean projects from one with none.
- **No inspection record.** Builder's risk covers the structure during
  construction on an all-risks basis with the completed value setting the limit
  (IRMI, https://www.irmi.com/term/insurance-definitions/builders-risk-policy —
  _(secondary reference)_); it does not price workmanship. Latent-defect cover
  (NHBC Buildmark years 3–10) exists only because the insurer saw the key
  stages.
- **Disaster exposure.** IFC's Building Resilience Index asks developers to
  "disclose resilience rating to your financiers, insurers, and users"; in the
  Philippines twelve developers pledged 2 million m² across 52 projects, one
  verified project of 1,018 units rated for wind, water, fire and geoseismic
  hazards. — IFC EDGE housing webinar, June 2023, pp. 52–53,
  https://edgebuildings.com/wp-content/uploads/2023/06/Housing-Webinar.pdf —
  **primary/official** (IFC presentation). Parametric or micro-insurance for
  low-income homes in the Philippines or Kenya: no primary source could be
  reached (the CARD Pioneer and Pioneer Insurance pages did not yield figures);
  treat any claim as unverified.

## 2. What exists and works, country by country

### 2.1 United States: construction-to-permanent with draws, inspections and title updates

- **Single-closing construction-to-permanent (Fannie Mae B5-3.1-02).** One
  closing covers construction and the permanent mortgage. The construction phase
  "may have no single period of more than 12 months and the total period may not
  exceed 18 months"; the permanent term up to 30 years. Appraisal "as
  completed", effective within four months of the note; Form 1004D completion
  report at the end; credit documents re-verified at conversion unless an
  exception applies; the loan "cannot be purchased until construction is
  complete and the loan has converted"; delivered with Special Feature Code 151;
  loan increases only for documented cost increases with a title endorsement. —
  **primary/official**, URL above.
- **Draws and inspections.** Fannie Mae's lender job aid (2018) says the lender
  should inspect "periodically... prior to issuing draws" and that "undrawn
  funds are held back by the lender"; completion needs the 1004D, lien waivers
  and a certificate of occupancy; draw requests follow "the contract draw
  schedule" _(secondary: snippets via search of
  https://singlefamily.fanniemae.com/media/6311/display and the October 2025
  process guide; direct fetch could not be reached)_.
- **Owner-builders.** The Selling Guide page fetched does not address who may
  act as builder; consumer sources say most lenders require a licensed general
  contractor or proven experience _(not verified; two consumer-finance
  pages could not be reached)_. FHA and VA "one-time close" products exist _(secondary,
  search results; HUD Handbook 4000.1 could not be fetched)_.
- **The data layer.** MISMO, "the standards development body for the mortgage
  industry", a subsidiary of the Mortgage Bankers Association, publishes a
  Reference Model (Logical Data Model 3.5/3.6, XML schemas) and dataset
  specifications; its standards are "required by most regulators, housing
  agencies and the GSEs" and "have been found to lower per loan costs". —
  https://www.mismo.org/about-mismo — _(self claim on benefits; primary on
  scope)_.
- **Scale.** 176,932 custom-home starts in 2024 (section 1.1). The US Census
  publishes construction spending monthly (Value of Construction Put in Place,
  https://www.census.gov/construction/c30/c30index.html — **primary/official**).

### 2.2 United Kingdom: self-build mortgages with stage payments, warranty and building control

- **Stages.** BuildStore (a broker; _vendor claim_) lists the standard stage set
  for brick-and-block: "Purchase of land", "Preliminary costs & foundations",
  "Wall plate level", "Wind & Watertight", "First fix & plastering", "Second fix
  to completion"; for timber frame, stage 3 is "Timber frame kit erected".
  Payments are either **in arrears** (after each stage, "after the lender's
  valuer has assessed the work", up to 85 percent of plot and build cost) or
  **in advance** (at the start of each stage, "based on project costs, not
  lender valuations", up to 95 percent of plot and build cost, 5 percent
  deposit). Cost-based products guarantee the stage amount; valuation-based
  products release only what the valuer finds. —
  https://www.buildstore.co.uk/mortgages-finance/project-types/self-build-mortgages/how-self-build-mortgages-work
  — _(vendor/self claim)_.
- **Warranty.** Lenders generally expect a ten-year structural warranty or a
  professional consultant's certificate on a new build _(secondary: Build It
  magazine via search; the UK Finance Mortgage Lenders' Handbook section 6.7,
  the primary source, could not be reached)_. NHBC Buildmark: builder warranty for
  "the first two years from the date of legal completion", with NHBC
  guaranteeing the builder's obligations; years 3–10 insurance against damage
  from defects in listed parts, alternative accommodation, contaminated land;
  and deposit protection between exchange and completion if the builder becomes
  insolvent. — https://www.nhbc.co.uk/homeowners/what-does-buildmark-cover —
  **primary/official** (policy summary).
- **Help to Build** (England): a government equity loan for custom and self
  builders requiring a self-build mortgage from a registered lender. The gov.uk
  pages could not be reached, so the percentages and the £150 million figure
  usually cited are **unverified** for this note.
- **Sector voice.** NaCSBA, "the voice of the UK's custom and self build housing
  sector", a community-interest company; its guide covers "self-build mortgages,
  development finance and government-backed lending". — https://nacsba.org.uk/ —
  **primary/official** for the body; no sector figures on the page.

### 2.3 Germany: the MaBV payment schedule and payout by Baufortschritt

- **§ 3 MaBV (Makler- und Bauträgerverordnung).** A developer may take the
  buyer's money only when: the contract is legally effective and a notary
  confirms it; a priority notice (Vormerkung) for the buyer is entered in the
  land register; prior liens are secured for release even if the project fails;
  and the building permit has been granted (or deemed granted). Payments then
  follow progress "in bis zu sieben Teilbeträgen entsprechend dem Bauablauf": 30
  percent of the contract sum after the start of earthworks (20 percent on
  leasehold), then, as percentages of the balance: 40 percent on completion of
  the shell including roof framing; 8 percent roof surfaces and gutters; 3
  percent each for rough heating, plumbing and electrical installation; 10
  percent windows and glazing; 6 percent interior plaster; 3 percent screed; 4
  percent bathroom tiling; 12 percent on readiness to move in against handover;
  3 percent facade; 5 percent on full completion. —
  https://www.gesetze-im-internet.de/gewo_34cdv/__3.html — **primary/official**.
- **Bank payout.** Banks pay the construction loan "in Teilbeträgen, abhängig
  vom Fortschritt der Bauphasen"; the builder or architect submits
  Bautenstandsberichte (progress reports) and "manche Banken schicken zusätzlich
  eigene Sachverständige auf die Baustelle"; Bereitstellungszinsen accrue on
  undrawn funds after the free period; for owner-managed builds the rule of
  thumb is to pay at most 50 percent before the shell is complete. — Dr. Klein,
  "Baufortschritt: So funktioniert die Auszahlung Ihres Kredits beim Hausbau",
  14 August 2024,
  https://www.drklein.de/baufortschritt-auszahlung-baukredit.html — _(secondary,
  broker's consumer guide)_.
- **Bausparkassen.** The contractual-savings model (save first, then borrow at a
  fixed rate) is the German route to self-build equity. No primary Bausparkasse
  source could be fetched; the schedule above is what any German
  lender's payout follows in practice _(unverified beyond the Dr. Klein guide)_.

### 2.4 France: compulsory décennale and dommages-ouvrage

- **Décennale (constructor's ten-year liability insurance).** Any constructor
  must hold it before opening the site; the guarantee runs ten years from the
  day after the signed réception; failing to insure is punishable by "6 mois
  d'emprisonnement" and/or a "75 000 €" fine; the penal sanction does not apply
  to a private person building for own or family occupation. —
  service-public.gouv.fr F2034 — **primary/official**.
- **Dommages-ouvrage (owner's damage insurance).** The owner, seller, mandatary,
  syndic or promoter must take it out "avant le début des travaux"; it pays for
  repair of décennale-type damage "en dehors de toute recherche de
  responsabilité", the insurer then pursuing those liable; cover starts at the
  end of the one-year parfait-achèvement guarantee and lasts until ten years
  after réception; claims within two years of discovery; if no insurer will
  quote, the owner may refer the case to the Bureau central de tarification,
  which sets the premium; on sale within ten years the policy transfers with the
  deed. Sanction as above (Code des assurances L243-3), with the same exemption
  for "un particulier construisant un logement pour l'occuper lui-même ou pour
  un membre de sa famille". Legal bases cited: Code des assurances L242-1,
  L242-2, L243-3; Code civil 1792, 1792-2. — service-public.gouv.fr F2032 —
  **primary/official**. Parliamentary answers (2005) note that an uninsured
  owner "ne pourra pas revendre son bien pendant la période décennale, car les
  notaires refusent généralement de finaliser la vente" _(secondary: Assemblée
  nationale questions, via search)_.
- The lesson: a legal obligation on _both_ builder and owner created an
  insurance market with a tariff office of last resort, and made the insurance
  certificate part of the title chain.

### 2.5 Peru: Techo Propio "Construcción en Sitio Propio" and the Entidad Técnica

- **The subsidy.** Bono Familiar Habitacional (BFH) for building on one's own
  plot: base S/ 32,100, raised by 15–17 percent in some regions (up to S/ 37,557
  in Amazonas in the August 2025 call); second 2025 call of up to 6,698 bonos in
  12 regions (Piura 1,087, San Martín 895, Ica 823...); first 2025 call up to
  26,604 bonos. Eligibility: a plot or independent airspace "registered in the
  public registry, free of liens or encumbrances"; a first home; minimum savings
  S/ 2,045; household income not above S/ 2,706; no other property. Families
  register "through Entidades Técnicas authorized by Fondo Mivivienda". — Andina
  (state news agency), 6 August 2025, citing Resolución Ministerial N°
  194-2025-VIVIENDA,
  https://andina.pe/agencia/noticia-techo-propio-ministerio-vivienda-entregara-6698-bonos-vivienda-12-regiones-1039925.aspx
  — **primary/official** (state agency reporting a ministerial resolution).
- **The mechanism.** The Entidad Técnica (ET) signs the construction contract
  with the family, requests a project code from Fondo Mivivienda and "gestionará
  el desembolso del bono"; the builder must provide the contract, descriptive
  memo, plans and detailed budget, and has "hasta 120 días calendario para
  terminar la vivienda" after the bono is delivered; the mandatory saving is
  given as S/ 2,407.50 (0.45 UIT) in this source — a discrepancy with Andina's
  S/ 2,045 that the book should not resolve by guessing. — La Cámara (Lima
  Chamber of Commerce magazine), 12 April 2025,
  https://www.lacamara.pe/bono-techo-propio-2025-asi-puedes-acceder-al-subsidio-de-s-32-100-para-construir-tu-casa/
  — _(secondary)_. Fondo Mivivienda's site states the programme is "Dirigido a
  familias con ingresos de hasta S/ 3,715" and lists the ET register and
  eligible-family lists; a November 2026 San Marcos call offers "hasta 74
  Bonos". — https://fondomivivienda.pe/ — **primary/official**.
- **Housing microfinance.** Mibanco offers a "Construcción de Vivienda" loan
  ("Construye o remodela tu hogar con cuotas a tu medida"); terms were not
  readable today. — https://www.mibanco.com.pe/prestamos/construccion-vivienda —
  _(vendor; details unverified)_.
- Why it matters: Peru has already standardised the _role_ — a registered
  technical entity that designs, builds and triggers disbursement under the
  fund's supervision. It has not standardised the _record_. That is the gap a
  build file fills.

### 2.6 Mexico: Infonavit ConstruYO and CONAVI

- **ConstruYO.** Infonavit lets workers use their credit "to build a home on
  land they own"; the land must be "regularizado"; funds are released in stages
  ("parcialidades") as construction advances; the amount depends on payment
  capacity and the submitted project and is smaller than a purchase loan (up to
  2.7 million pesos for purchase). — El Imparcial, 5 February 2025,
  https://www.elimparcial.com/dinero/2025/02/06/construir-una-casa-con-infonavit-en-tu-terreno-te-presta-lo-mismo-que-al-comprar
  — _(secondary)_. Other secondary sources say "5 ministraciones ligadas al
  avance de obra" and that land may be private, ejidal or communal "siempre y
  cuando se demuestre la tenencia segura" _(secondary, via search; the Infonavit
  portal timed out twice)_.
- **CONAVI.** The national housing commission runs "Vivienda para el Bienestar":
  lotteries for 31,934 homes in 147 municipalities began on 16 December 2025; a
  2026 call opened in July 2026. — gob.mx/conavi headlines —
  **primary/official** (headlines only; the assisted self-production rules could
  not be fetched).
- **Green mortgage precedent.** Infonavit's Hipoteca Verde is cited by IFC as a
  national housing fund "promoting the use of sustainable practices"
  _(secondary)_; Vinte, a Mexican developer, certified "thousands of homes with
  EDGE" and issued Latin America's first developer sustainability bond in 2018
  (IFC webinar p. 32 — **primary/official**).

### 2.7 Philippines: Pag-IBIG tranches against inspection

- Pag-IBIG Fund's housing loan covers construction and home improvement;
  proceeds "may also be released in stages after inspection and verification of
  work completed"; before each release the borrower should check the
  construction progress recorded, whether an inspection was requested and its
  findings, and the target date of the next tranche; evidence to keep: dated
  photographs, contractor billings, receipts, permits, inspection requests. —
  Respicio & Co. commentary, 24 July 2026,
  https://www.respicio.ph/commentaries/how-to-resolve-a-delayed-pag-ibig-loan-release
  — _(secondary, law-firm commentary)_. Pag-IBIG's forms page lists a "Checklist
  of Requirements for Subsequent Release of Loan Proceeds" (HQP-HLF-736) and
  house-construction checklists (HQP-HLF-731) _(primary by title only; the site
  is could not be read)_.
- Resilience: the IFC Building Resilience Index commitment above.

### 2.8 Kenya: KMRC, the housing levy and housing microfinance

- **KMRC.** Kenya Mortgage Refinance Company, "licensed and regulated by the
  Central Bank of Kenya", refinances primary mortgage lenders "subject to the
  mortgage loans meeting KMRC refinancing eligibility criteria". —
  https://kmrc.co.ke/ — **primary/official**. In 2021 it lent to banks and
  saccos at 5 percent, lenders added an average 4.5 percent, and the average
  borrower rate was 9.5 percent "fixed for the tenor"; caps then were Sh 4
  million in the Nairobi metropolitan area and Sh 3 million elsewhere, borrowers
  earning up to Sh 150,000 a month, up to 20 years; 574 loans refinanced in 2021
  averaging Sh 2.34 million. — Business Daily, 10 July 2022,
  https://www.businessdailyafrica.com/bd/markets/capital-markets/banks-make-4-5pc-margin-on-cheaper-mortgages-scheme-3875392
  — _(secondary)_. The World Bank's Kenya Affordable Housing Finance Project
  (P165034): US$250 million, approved 30 April 2019, closing 30 June 2025, "to
  expand access to affordable housing finance to targeted beneficiaries". —
  World Bank projects API — **primary/official**. 2025: Sh 7.7 billion new
  lending, Sh 19.6 billion cumulative, 12.8 percent of mortgage accounts by
  number _(secondary, Business Daily via search; not fetched)_.
- **Housing microfinance.** The Terwilliger Center / Mastercard Foundation
  six-year study in Kenya and Uganda: more than 47,000 households, more than Sh
  4.3 billion mobilised, over 237,000 individuals, borrowers "earning as little
  as Sh500 a day", for "building, extending, or renovating a home" with "small,
  non-mortgage-backed loans with short terms" — _(secondary, Business
  Daily 2018)_; the Mastercard Foundation release names Kenya Women Microfinance
  Bank and Centenary Bank and US$43 million _(secondary, search snippet)_.
- **Data.** KNBS is CAHF's source for building-material cost inflation (4.3
  percent in 2023) — **primary/official** via CAHF.

### 2.9 Nigeria: Family Homes Funds and NMRC

- **Family Homes Funds Ltd** "mobilises capital, structures financing and builds
  the partnerships" for housing; supported by the Federal Ministry of Finance,
  Ministry of Finance Incorporated and the Nigeria Sovereign Investment
  Authority; Home Ownership Fund (Help-to-Own URL), Affordable Housing Fund
  (construction finance for developers), Rental Housing Fund, Social Housing
  Programme; claims 15,900+ homes financed, 84,000+ jobs, 1,000+ artisans
  trained; no incremental or self-build product shown. — https://fhfl.com.ng/ —
  _(self claim)_. AfDB approved up to US$60 million for its Home Loan Assistance
  Programme _(secondary, search)_.
- **NMRC** is a private-sector-driven mortgage liquidity facility with uniform
  underwriting standards; it "committed to recommending EDGE certification to
  its clients" _(secondary, search; the site could not be reached)_.

### 2.10 Ghana, Rwanda, Colombia, Dominican Republic, Uzbekistan

- **Ghana.** ~90 percent informally produced stock (2011, above). The National
  Homeownership Fund and incremental-finance products: **unverified** today (the
  CAHF Ghana 2024 PDF uses a font encoding that defeated text extraction).
- **Rwanda.** World Bank Rwanda Housing Finance Project (P165649): US$150
  million, approved 29 November 2018, closing 31 October 2025, "To expand access
  to housing finance to households and to support capital market development in
  Rwanda" — **primary/official** (projects API). Results and microfinance
  components: unverified (CAHF Rwanda PDF unreadable).
- **Colombia.** Mi Casa Ya assigns subsidies to households "con una
  clasificación de Sisbén IV entre A1 y D20" under Decreto 1077 de 2015 as
  modified by Decreto 490 de 2023, administered through a fiducia mercantil
  (Fiduciaria de Occidente); the programme gives preference to women heads of
  household, informal-sector workers and community mothers (Ley 3 de 1991 as
  amended). — Fonvivienda Resolución 0813 de 21 octubre 2025,
  https://www.minvivienda.gov.co/sites/default/files/normativa/0813-2025.pdf —
  **primary/official**. The programme was suspended at the end of 2024 for
  budget reasons and reopened in 2025 _(secondary)_. In November 2025 the
  ministry issued a decree exempting subsidised "mejoramiento de vivienda,
  vivienda progresiva, construcción en sitio propio y autogestión" from the
  construction licence, outside non-mitigable-risk and environmental-protection
  zones, replacing it with a Carta de Responsabilidad with plans and technical
  documents signed by professionals who answer for them; the subsidy-granting
  entity certifies the team's competence. — El Cronista Colombia, 13 November
  2025 — _(secondary; decree number not given)_. A rural on-site construction
  subsidy of COP 122,563,350 is quoted for 2026 _(secondary; cautious)_.
- **Dominican Republic.** Ley 189-11 (2011) on the mortgage market and trusts
  created the fideicomiso instruments for low-cost housing; in March 2015 the
  Junta Monetaria let banks and savings-and-loan associations use RD$10,000
  million of legal reserve: interim builder loans at up to 6 percent for up to
  two years, buyer mortgages up to RD$2.4 million at up to 8 percent for 20
  years, 75 percent to public-private trusts. — Acento, 15 May 2015,
  https://acento.com.do/economia/banco-central-y-las-aapp-evaluan-financiar-de-viviendas-economicas-8249546.html
  — _(secondary)_; law text at https://www.mopc.gob.do/media/1336/ley-189-11.pdf
  — **primary/official** (not read in full). Construction credit portfolio
  RD$81,063 million in 22,294 loans at April 2026 _(secondary, search snippet;
  not fetched)_. No staged owner-build instrument found.
- **Uzbekistan.** Before reform: 21 uncoordinated subsidy programmes, mortgages
  8.3 percent of bank loans, no wholesale refinancing; ADB's Mortgage Market
  Sector Development Program (approved November 2019, closing June 2026): US$50
  million policy loan plus US$300 million intermediation loan; the Uzbekistan
  Mortgage Refinancing Company, established 2020 with government and bank
  equity, "prefinances and refinances eligible mortgages and housing improvement
  loans"; as of 1 January 2025 it had lent more than US$280 million and
  supported more than 20,000 mortgages, launched a green renovation mortgage,
  and the programme introduced "a housing price index, a mortgage market
  database and website". An earlier US$500 million rural housing programme
  (total US$3.05 billion) was evaluated as crowding out private participation. —
  ADB Development Asia case study,
  https://development.asia/case-study/expanding-access-housing-uzbekistan-through-market-reforms
  — **primary/official** (ADB).

### 2.11 Other instruments worth naming

- **Staged reconstruction grants (Nepal)** and **Patrimonio Hoy (CEMEX)** are
  covered in research note D (section 1.2 and its key findings) and are not
  repeated here; their relevance to this chapter is that both
  released value (grant tranches, materials) against inspected or scheduled
  stages with a trusted local technical person.
- **Community construction management (Durban).** FEDUP acted as community
  contractor with "Community Construction Management Teams (CCMTs) supervised by
  uTshani Fund and composed of approved professional contractors, who ensured
  technical support", with savings groups and bridging finance. — WCR 2026 Box
  5.5 — **primary/official**. This is a working model of "inspector as
  participant" in the poorest settings.
- **Guarantee funds.** IFC's housing-finance page mentions investments, covered
  bonds and refinancing companies but not partial credit guarantees for
  self-build; none found in the sources read. **Unverified.**

## 3. Standards that unlocked finance: the key analogy

- **EDGE (IFC).** "A minimum of 20% savings in energy, water, and embodied
  carbon in materials" against a local baseline; third-party certification with
  design and construction audits. By February 2023: 8,184 projects certified,
  **357,000 housing units**, 89 countries, US$53 billion of assets certified
  since 2015, US$10.2 billion of IFC green-building investment. "Colombia
  mainstreams green buildings: from zero in 2017 to over 27% of new build".
  Incremental cost "about 1%" (IHS South Africa, Vinte Mexico, Capital House
  Vietnam). Drivers of profitability named: "Access to international green
  finance flows for better financing terms" and "Lowered default rates and
  superior collateral value for green mortgages". "South Africa's first Green
  Mortgage": ABSA Bank with Balwin Properties, 807 homes, a rate benefit for
  buyers of EDGE-certified homes. Capital House (Vietnam) "reduced financing
  costs by 3%". — IFC EDGE housing webinar, June 2023, pp. 8–9, 28–33 —
  **primary/official**; https://edgebuildings.com/ — **primary/official**.
  Fannie Mae accepts EDGE for multifamily green financing; NMRC recommends it
  _(secondary)_. Kenya counts 2,380 EDGE homes (CAHF). The pattern: a _standard_
  (20 percent), a _certificate_ issued by an independent auditor, and _lenders_
  who read it and price it. The standard did not lend; it made the object
  legible.
- **MISMO (US).** A common data model "required by most regulators, housing
  agencies and the GSEs"; it let thousands of lenders, servicers and investors
  exchange loan data. — above.
- **OCDS.** "A common data model for disclosing data and documents at all stages
  of the contracting process", maintained by the Open Contracting Partnership,
  "implemented by over 50 governments", Apache 2.0, v1.1.5. —
  https://standard.open-contracting.org/latest/en/ and
  https://www.open-contracting.org/data-standard/ — **primary/official**.
  Trustwork already reads OCDS for sourced pages; the build file is OCDS's
  private-construction cousin.
- **EU Digital Building Logbook.** Defined by a 2021 Commission study (40
  initiatives analysed) as "a common repository for all relevant building data"
  that "facilitates transparency, trust, informed decision making" among
  "owners, occupants, financiers, and other market players"; definition updated
  February 2023; also called building passport or electronic building file;
  follow-up guidelines for member states in progress. — BPIE summary and EC
  Publications Office study,
  https://www.bpie.eu/news/new-report-from-european-commission-provides-first-ever-common-definition-of-a-european-digital-building-logbook/
  — _(secondary summary of a primary study)_.
- **Valuation standards.** RICS Red Book with IVS 410 for development property
  (above): a shared method lets a lender in one city accept a valuer's number
  from another.
- **Payment-schedule standards.** The MaBV table (section 2.3) is itself a
  standard: a legally fixed mapping from physical stage to percentage of price.
  The UK stage list (section 2.2) is a market standard that lenders, valuers and
  warranty providers share.
- **Licensing linked to insurability.** France: no décennale certificate, no
  lawful building (section 2.4). Trustwork's credentials tool already records
  "licences... insurance" checked "on date by hub X"
  (execution-and-reputation.md) — the hook exists.

## 4. Insurance: what insurers need to price a small private build

| Product                                                 | What it covers                                                                                                                                            | What the insurer needs                                                                                                                                                 | Source                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Builder's risk / contractor's all risks                 | Physical loss to the works during construction, materials in transit and storage; completed value sets the limit; "no single standard builders risk form" | Completed value, location and hazards, construction type, duration, named insured parties                                                                              | IRMI _(secondary reference)_                         |
| Latent-defect / structural warranty (UK NHBC Buildmark) | Years 0–2 builder's obligations guaranteed; years 3–10 damage from defects in listed parts; deposit protection                                            | Registered builder, key-stage inspections during the build, completion certificate                                                                                     | NHBC — **primary/official**                          |
| Dommages-ouvrage (France)                               | Pre-finances repair of décennale damage for 10 years from réception "en dehors de toute recherche de responsabilité"                                      | Constructors' décennale certificates before works start, réception record, descriptive documents; tariff office if refused                                             | service-public F2032 — **primary/official**          |
| Décennale (France)                                      | Constructor's ten-year liability                                                                                                                          | Licensed/insured constructor                                                                                                                                           | service-public F2034 — **primary/official**          |
| Performance and payment bonds (surety)                  | Completion if the contractor defaults; payment of subcontractors and suppliers                                                                            | "An extensive underwriting process to prequalify contractors" (the trade's "three Cs" — capital, capacity, character — are not on the SFAA page; _unverified wording_) | SFAA — **primary/official**                          |
| Catastrophe / resilience                                | Wind, water, fire, geoseismic                                                                                                                             | A resilience rating disclosed "to your financiers, insurers, and users"                                                                                                | IFC Building Resilience Index — **primary/official** |
| Parametric and home micro-insurance                     | Trigger-based payouts for low-income homes                                                                                                                | Hazard model, roof/structure type, location                                                                                                                            | **Not verified today**                               |

What every row has in common: an insurer prices from (a) a described object, (b)
a known builder, (c) evidence that stages were inspected, (d) a dated
completion, and (e) a history of claims. Items (a)–(d) are records a project
platform can keep; item (e) is the statistic a hub can publish.

## 5. Data and statistics

- **Why lenders and insurers need them.** A loan officer approving a stage draw
  needs to know whether "foundations complete" in this town usually costs what
  the budget says; an insurer needs the frequency of roof defects by building
  type; a refinance company needs completion times to set tenors. Uzbekistan's
  reform explicitly built "a housing price index, a mortgage market database" as
  a precondition for a mortgage market (ADB, above). The SSA stocktaking lists
  absent data as a core constraint _(primary, 2015)_.
- **Who publishes what today (verified).** US Census: monthly construction
  spending (VIP) and the Survey of Construction behind the custom-home share —
  **primary**. Kenya: KNBS building-material cost inflation, cited by CAHF —
  **primary via CAHF**. CAHF: 55+ country profiles with cheapest formal house,
  cost per m², cement price, mortgage counts — **primary compilation**.
  Uzbekistan: housing price index (ADB). Nigeria: NBS title statistics (2018)
  via CAHF.
- **Who publishes what today (not fetched).** Peru's INEI (construction
  materials price index, cement dispatch), the Philippine Statistics Authority
  (construction materials wholesale/retail price indices, approved building
  permits) and Mexico's INEGI (producer price index for construction,
  construction enterprise survey) are the usual national sources; their pages
  did not load today (certificate errors or blocked). The book should name them as the
  hubs' first statistical neighbours, not quote figures from them.
- **How platform data becomes a public statistic without exposing anyone.** The
  engine's analytics module already distinguishes "hub cohorts" from individuals
  and forbids individual payment histories outside the parties (getting-paid.md,
  "Analytics"). The same rule applies here: publish cost ranges, durations and
  defect rates only per (country, region, building type, stage) cell with a
  minimum sample, only from projects whose owners consented at completion to
  knowledge sharing (projects.md, "Permits, diaries and shared knowledge"), and
  never a street address, a quote, or a named party. Under GDPR, information
  that does not relate to an identifiable person is outside the regulation
  (Recital 26) — the engine must make sure the aggregate truly is such
  information, including against re-identification in small towns. _(GDPR text
  not fetched; cite Regulation (EU) 2016/679 generally.)_

## 6. Regulation and risk for Trustwork

### 6.1 What Trustwork must not do

- **Lend or hold money.** ADR 010 decision 20: the engine
  "never hold, pool or move participants' funds"; PAY-001 "refuses any
  configuration that would route participants' funds through an operator
  account"; holding until delivery, retainage and milestone payouts exist "only
  where the configured provider supports them" (billing.md). This note changes
  nothing there.
- **Act as an unlicensed credit intermediary.** EU Mortgage Credit Directive
  2014/17/EU, Article 4(5): a credit intermediary is a person "not acting as a
  creditor or notary and not merely introducing, either directly or indirectly"
  a consumer to a creditor, who "presents or offers credit agreements to
  consumers", "assists consumers by undertaking preparatory work or other
  pre-contractual administration", or "concludes credit agreements with
  consumers on behalf of the creditor"; Article 4(21) "advisory services" means
  "the provision of personal recommendations to a consumer in respect of one or
  more transactions". — https://www.legislation.gov.uk/eudr/2014/17/article/4
  (retained EU law text) — **primary/official**. The safe zone is "merely
  introducing", with no preparatory work on the loan and no personal
  recommendation.
- **Act as an unlicensed insurance distributor.** Insurance Distribution
  Directive (EU) 2016/97, Article 2(1)(1): distribution includes providing
  information "in accordance with criteria selected by customers through a
  website or other media" and "the compilation of an insurance product ranking
  list, including price and product comparison" when the customer can conclude a
  contract through the site; Article 2(2) excludes "the provision of information
  on an incidental basis in the context of another professional activity" and
  "the mere provision of data and information on potential policyholders to
  insurance intermediaries" provided no additional steps are taken to help
  conclude the contract; an "ancillary insurance intermediary" distributes
  products "complementary to a good or service" for remuneration. —
  https://www.legislation.gov.uk/eudr/2016/97/article/2 — **primary/official**.
  A comparison table of insurers with "buy" buttons would be distribution; a
  neutral list with no ranking, no remuneration and no further steps is the
  exclusion.
- **Act as a US loan originator or take referral fees.** SAFE Act, Regulation H
  §1008.103: licensing is required for anyone who, "in a commercial context and
  habitually or repeatedly", takes a residential mortgage loan application or
  "offers or negotiates terms... for compensation or gain", which includes
  "steering a borrower to a particular lender" when the person receives "payment
  of money or anything of value" tied to it. —
  https://www.consumerfinance.gov/rules-policy/regulations/1008/103/ —
  **primary/official**. RESPA Regulation X §1024.14: "No person shall give and
  no person shall accept any fee, kickback or other thing of value" for
  referrals of settlement-service business; a referral is "any oral or written
  action directed to a person which has the effect of affirmatively influencing
  the selection" of a provider; "thing of value" is broad ("monies, things,
  discounts, salaries, commissions, fees"). —
  https://www.consumerfinance.gov/rules-policy/regulations/1024/14/ —
  **primary/official**. The existing proposed requirement PAY-F13 ("financing
  partner referrals... referral fees disclosed") must be read against this: for
  _consumer mortgage_ finance in the US a disclosed referral fee may still be a
  prohibited referral fee. Recommendation: no referral fees of any kind for
  consumer housing finance, in any country, until counsel clears a specific
  arrangement.
- **Give credit or insurance advice.** The agent "is advice, not professional
  engineering or legal advice" (projects.md) and must say the same about money:
  it may explain what a build file contains and what lenders generally ask for;
  it may not recommend a lender, a product or a sum.
- **Collect or share data without consent.** The project is owner-private by
  default; sharing is "one item at a time, with one audience at a time"
  (projects.md). A lender or insurer is a new _audience_ that the owner adds;
  nothing travels by default.
- **Fake anything.** No invented completion certificates, no self-reported
  "inspected" without an inspector's record, no reputation from payment
  (execution-and-reputation.md).

### 6.2 Licences typical roles need (questions for counsel per country pack)

| Role                                          | Typical licence                                                                                                                        | Who holds it    | Trustwork's relation                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| Lender (mortgage, construction, microfinance) | Banking or microfinance licence (CBK in Kenya; SBS in Peru; CNBV in Mexico; BSP in the Philippines)                                    | The lender      | Reads the build file with consent; sends disbursement outcome to the record |
| Credit intermediary / mortgage broker         | MCD Art. 29 registration (EU); FCA permission (UK); SAFE Act licence (US)                                                              | A broker        | Trustwork is not one; a licensed broker may be a participant                |
| Insurance distributor                         | IDD registration (EU/UK); state producer licence (US)                                                                                  | Broker or agent | Trustwork lists insurers without ranking or remuneration, or not at all     |
| Payment / escrow provider                     | Payment institution, money-transmitter or escrow licence                                                                               | The provider    | PAY-001 port; releases funds on instruction; Trustwork never touches funds  |
| Inspector / clerk of works / Entidad Técnica  | Professional licence or registration (state inspector in the US; architect/engineer in DE/FR; ET register at Fondo Mivivienda in Peru) | The inspector   | A participant with capability `inspect`, their own reputation and liability |
| Valuer                                        | RICS member, state-licensed appraiser                                                                                                  | The valuer      | Participant; valuation attached as evidence with hash                       |
| Warranty / latent-defect insurer              | Insurance licence                                                                                                                      | The insurer     | Reads inspection records; issues certificate recorded as evidence           |

### 6.3 Consumer and data protection angles

- Deposit limits and cancellation rights for private clients come from the
  country pack (PAY-F09; e.g. US state home-improvement rules). Staged release
  protects the owner as much as the lender: the owner "never pay[s] far ahead of
  the work" (PAY-S3).
- Consent must be specific (this lender, these fields, this period) and
  revocable; revocation stops new reads but cannot unsend what a lender lawfully
  received — the record must say when it was shared and what version.
- Automated decisions: Trustwork must never produce a credit score or a
  "bankability score". It produces a _file_; the lender decides. A public score
  would also breach the reputation policy ("no public score").
- Inspectors' and valuers' liability is governed by their professional law, not
  by the platform; the engine records who signed what and when, which protects
  the honest and exposes the careless.

### 6.4 How an open engine integrates licensed parties behind ports

The engine already uses adapters with fakes for payments, e-signature, registers
and e-invoicing. The same pattern: a **financing port** (list licensed partners
per hub; hand over a consented build-file export; receive status events:
application received, approved, stage released, declined — without reasons
beyond what law allows), an **escrow/disbursement port** (an instruction to
release a stage amount, signed by the parties the agreement names, executed by
the licensed provider, reconciled by provider reference), an **inspection port**
(an inspector's act as a signed evidence record; where a public inspection
authority has an API, its result as a permit record), and an **insurance port**
(a certificate of cover attached as a credential with expiry, checked like a
licence). Every port has a deterministic fake for demo and tests; no port moves
money; every call carries the owner's consent reference.

## 7. Country × instrument table

Legend: **S** staged disbursement against inspection exists; **W** warranty /
defect insurance regime; **T** title/registry precondition explicit; **M**
housing microfinance or incremental product documented; **R** refinance /
liquidity facility; **D** public cost or housing data; **G** green or resilience
standard used in finance. "—" not found; "?" exists but unverified.

| Country               | Main instrument for a private build                                                                                                 | S               | W                                          | T                                       | M           | R                     | D                   | G                            | Source quality                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------ | --------------------------------------- | ----------- | --------------------- | ------------------- | ---------------------------- | ---------------------------------- |
| United States (ref.)  | Single-closing construction-to-permanent; draws against inspections; 1004D; lien waivers; CO                                        | S               | state/warranty varies                      | T                                       | —           | GSEs (Fannie/Freddie) | D (Census)          | G (EDGE multifamily)         | primary                            |
| United Kingdom (ref.) | Self-build mortgage, stage payments in advance or arrears; 10-year warranty; building control                                       | S               | W (NHBC etc.)                              | T                                       | —           | —                     | ?                   | ?                            | primary + vendor                   |
| Germany (ref.)        | MaBV § 3 schedule; bank payout by Bautenstandsbericht; Bausparkasse savings                                                         | S               | statutory defect liability (not insurance) | T (Vormerkung)                          | —           | —                     | ?                   | —                            | primary + secondary                |
| France (ref.)         | Décennale + dommages-ouvrage compulsory; BCT tariff of last resort                                                                  | implicit        | W (strong)                                 | T                                       | —           | —                     | ?                   | —                            | primary                            |
| Peru                  | Techo Propio CSP: BFH S/ 32,100+ through registered Entidad Técnica; Fondo Mivivienda; Mibanco construction loan                    | S (bono via ET) | —                                          | T (registered, lien-free)               | M (Mibanco) | ?                     | INEI (not fetched)  | EDGE 3% share                | primary + secondary                |
| Philippines           | Pag-IBIG construction loan in tranches after inspection                                                                             | S               | —                                          | T                                       | ?           | —                     | PSA (not fetched)   | G (Resilience Index pledges) | secondary + primary titles         |
| Kenya                 | KMRC-refinanced mortgages (9.5% avg, caps); housing microfinance (KWFT); housing levy/AHP                                           | ?               | —                                          | T (4.06m titled)                        | M (strong)  | R (KMRC)              | D (KNBS, CAHF)      | G (2,380 EDGE homes)         | primary + secondary                |
| Ghana                 | Incremental self-build ~90% informal; finance largely absent                                                                        | —               | —                                          | weak                                    | ?           | —                     | CAHF                | —                            | primary (2011)                     |
| Colombia              | Mi Casa Ya (Sisbén IV A1–D20) via fiducia; CSP/vivienda progresiva exempt from licence with Carta de Responsabilidad (2025)         | subsidy         | —                                          | T                                       | ?           | —                     | ?                   | G (27% of new build EDGE)    | primary + secondary                |
| Dominican Republic    | Ley 189-11 trusts; 2015 reserve-funded low-cost housing lines; no owner-build instrument found                                      | —               | —                                          | T                                       | —           | —                     | ?                   | —                            | secondary                          |
| Uzbekistan            | UMRC refinancing (>20,000 mortgages, >US$280m by 1 Jan 2025); housing improvement loans; green renovation loan; housing price index | ?               | —                                          | T                                       | partial     | R (UMRC)              | D (new HPI)         | G (green renovation)         | primary (ADB)                      |
| Nigeria               | FHFL Help-to-Own; NMRC liquidity; FMBN/NHF (<1% of subscribers served)                                                              | —               | —                                          | weak (71.4% untitled)                   | ?           | R (NMRC)              | NBS via CAHF        | G (NMRC recommends EDGE)     | primary + self claim               |
| Mexico                | Infonavit ConstruYO (own land, staged ministraciones); CONAVI Vivienda para el Bienestar; Hipoteca Verde                            | S               | —                                          | T (regularised; ejidal possible)        | ?           | —                     | INEGI (not fetched) | G (Hipoteca Verde; Vinte)    | secondary                          |
| Rwanda                | World Bank Rwanda Housing Finance Project (US$150m, 2018–2025) via BRD                                                              | ?               | —                                          | T (titling programme, unverified) | ?           | ?                     | ?                   | —                            | primary (project), rest unverified |

## 8. How Trustwork will act

Status: a direction of the book, not yet designed in the repository. A staged
plan. Each step keeps the invariants: never holds money, never lends, no public
score, private by default, no fakes, lawful by design, no partnership implied
by any name below.

### (a) The bankable build file

A **build file** is a consented, versioned projection of one project for one
reader (a lender, an insurer, a guarantor), containing only the fields that
reader needs, each traceable to a canonical record. It is not a new database; it
is a serializer with an audience, like the public projection, but for a
`financier` audience the owner adds. What it contains, and where each item comes
from:

| Item the lender or insurer asks for                                    | Trustwork part                                                                                                                                        | Status today                                 | Gap                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved plan with phases, tasks, materials, timeline as ranges, risks | Plan version `approved` (frozen, digest-bound; only the owner approves; an agent never approves) — projects.md                                        | Live in API (PLAN-001)                       | Export as build-file section                                                                                                                                                     |
| Bill of quantities and cost estimate within benchmark ranges           | Plan items of kind `material`/`purchase` with quantities and uncertainty; budget ranges "with their basis" from hub-licensed cost data (ADR 012 d.23) | Proposed                                     | Benchmark comparison per hub; a "within range / outside range, reason" flag the owner can see                                                                                    |
| Permits and inspections required and obtained                          | Plan items `permit`/`inspection`; permit records with authority, number, dates, results from the country pack                                         | Live (permit records), Proposed (pack lists) | Jurisdiction templates per pack                                                                                                                                                  |
| Land documents checked                                                 | "Site location and cadastral reference" (owner-private; pack defines identifier format)                                                               | Proposed addition                            | A `title_check` credential: "checked on date by hub X against register Y", document never shown                                                                                  |
| Named licensed professionals                                           | Credentials tool: licences, insurance, certificates, "checked on date by hub X"                                                                       | Live (REP-001)                               | Role binding: this engineer, this inspector, on this project                                                                                                                     |
| Contractor reputation from evidence                                    | Reputation snapshot with method version, samples, exclusions, "not enough data"                                                                       | Live, no public score                        | A reader sees the explained snapshot the contractor consents to show, never a number alone                                                                                       |
| Staged schedule with inspection gates                                  | Plan items `milestone` + `inspection` with dependencies                                                                                               | Live                                         | A hub **stage template** (like MaBV or the UK list) per building type                                                                                                            |
| Field evidence and acceptance at each stage                            | Execution records: work record, acceptance (partial normal), evidence with source, time, hash, classification                                         | Live (EXE-001)                               | Stage closure as a first-class record                                                                                                                                            |
| Independent inspector's act                                            | —                                                                                                                                                     | Missing                                      | New participant role `inspector` with capability `inspect`; inspection record signed; separate from contractor's statement and owner's acceptance (three records, three persons) |
| Change records                                                         | Plan change: what, why, who asked, which agreement covers it, who is accountable                                                                      | Designed                                     | Include in file; lenders read cost and date deltas                                                                                                                               |
| Defects and remediation                                                | Defect, remediation, their acceptance                                                                                                                 | Live                                         | Defect taxonomy per stage for statistics                                                                                                                                         |
| Frozen quotes and agreements                                           | Quotes frozen once sent; agreements both sides can prove identical (digest)                                                                           | Live/Contract                                | Agreement digest cited by the pay application (PAY-F04)                                                                                                                          |
| Payment behaviour                                                      | Obligations, timeliness evidence (dates, not amounts, in public)                                                                                      | Live/Proposed                                | For the file, amounts are shown only to the reader the owner authorised                                                                                                          |
| Final completion                                                       | Acceptance of the last stage + permit record (certificate of occupancy / réception) + warranty credential                                             | Partly                                       | A `completion` record that closes the file version                                                                                                                               |
| Consent trail                                                          | Plan share per item per audience; knowledge sharing consent at completion                                                                             | Proposed                                     | `build_file_share`: reader, fields, version, period, revocation                                                                                                                  |

The file has versions like a plan; a lender reads version n, decides, and the
record remembers which version it decided on. Nothing in the file is editable;
corrections are new records.

### (b) Staged disbursement without holding money

The sequence, all parties human, all money outside Trustwork:

1. The owner approves a plan version with stage gates; the hub's stage template
   suggests the gates and the typical share of cost per stage (the MaBV table is
   a model; each hub sets its own from counsel-reviewed pack data).
2. The owner adds a licensed lender (and, if the agreement uses one, a licensed
   escrow provider) as a `financier` reader of the build file through the
   financing port. The lender decides in its own systems. Trustwork records
   "application submitted / decided" as events without reasons.
3. Work proceeds. The contractor files a work record with evidence; the
   inspector files an inspection act; the owner files acceptance. Three separate
   records.
4. When all three exist for a stage, the engine composes a **disbursement
   instruction**: agreement digest, stage key, amount per the agreement, the
   three record references, the file version. The parties the agreement names
   sign it (step-up, idempotency key). The licensed provider executes; its
   reference and outcome return through the idempotent webhook inbox; unknown
   outcomes go to reconciliation (PAY-F03).
5. Lien waivers, retainage and deposit limits follow PAY-F05, F06, F09 where the
   pack has them.
6. If the lender's own inspector is required (as in US practice), that inspector
   is a participant too; two inspection acts are two records.

Trustwork is the clerk, never the cashier. Where no licensed provider exists in
a country, the engine "records obligations and evidence while money moves
outside it" (PAY-F10) — the build file is still valuable to a lender who pays by
its own transfer.

### (c) Inspectors and valuers as participants

An inspector is a person or firm with a verified credential, a mandate on this
project, a limited capability (`inspect`: read the shared stage item and attach
an act; never edit the plan, never accept work, never see budgets unless the
owner shares them), and a reputation of their own: acts filed on time, acts
later contradicted by a confirmed defect, appeals. Their agent may schedule
visits and draft the act; the person signs. Valuers work the same way with
`value`. Peru's Entidades Técnicas, Durban's Community Construction Management
Teams and the US lender's draw inspector are the three archetypes; a hub's
country pack says which licence each needs.

### (d) Insurers pricing from evidence

An insurer added as a reader sees what a warranty provider sees in the UK: who
built, which stages were inspected by whom, which defects were found and fixed,
what the structure is, where it stands. It issues a certificate (builder's risk,
latent defects, catastrophe cover) that becomes a credential with expiry on the
project and, with consent, on the contractor's passport. Over time the hub's
open statistics (e) give the insurer the frequency data it lacks today.
Trustwork never ranks insurers, never takes a commission on a policy, and never
says "buy this".

### (e) A hub's open statistics

Per hub, per period, per (region, building type, stage): cost per m² range,
duration range, share of stages passed at first inspection, defect rate by
category, change frequency and cause (owner / contractor / external). Only from
consented completed projects; only cells above a minimum sample; never a
project, person, company or address; published with the method version like a
reputation method. Published as open data under a hub licence, and offered to
national statistics offices (INEI, PSA, INEGI, KNBS, NBS as kinds of neighbour)
as a _contribution_, not a replacement. This is the chapter's bridge to the
civic mission: the same cells, computed from public-works records, tell a
municipality what a school roof should cost.

### (f) An open Build File standard

Trustwork publishes a **Build File Data Standard**: a JSON schema and vocabulary
for the sections above (plan, estimate, permits, parties and credentials,
stages, inspections, acceptance, changes, defects, completion, consent), with
stable keys across versions, crosswalk slots to IFC and ETIM through the
plan-step taxonomy (CC0, PLAN-000), a mapping to OCDS fields where a build is
public, deterministic fixtures for every engine language, and a validator.
Licence for the schema: an open licence (CC0 or Apache 2.0 like OCDS) so any
lender, insurer, inspector app or national programme can read and write it
without Trustwork. The standard is what makes "many lenders read one format"
true, as EDGE made "many banks read one certificate" true. Governance: a
published change process with hub operators, lenders and inspectors as
reviewers; Trustwork does not own the data, only the schema's stewardship, which
it can hand to a neutral body later.

### (g) Kinds of licensed parties a build file serves

Kinds, with public examples where research supports naming them:

- **Readers of the file (lenders).** Housing microfinance institutions with
  incremental products (Kenya Women Microfinance Bank, Mibanco in Peru — both
  named in sources above); national housing funds that already disburse in
  stages (Infonavit, Pag-IBIG, Fondo Mivivienda / Techo Propio Entidades
  Técnicas); mortgage refinance companies that set eligibility standards for
  many lenders (KMRC, NMRC, UMRC); development finance institutions that fund
  them (IFC housing finance, World Bank Kenya and Rwanda projects, ADB in
  Uzbekistan, AfDB with Family Homes Funds). A refinance company has the
  highest leverage: if the build file becomes part of its eligibility criteria,
  every primary lender it refinances reads it.
- **Standards and certification bodies.** IFC EDGE and the Building Resilience
  Index (a resilience rating the file could carry); RICS and IVSC for valuation
  of work in progress; the Open Contracting Partnership for schema practice; the
  EU digital-building-logbook working groups for interoperability.
- **Insurers and warranty providers.** The kinds: latent-defect and warranty
  insurers (NHBC and other UK schemes as models), dommages-ouvrage insurers in
  France, builder's-risk carriers in the US, catastrophe and micro-insurers in
  the Philippines and Kenya (no name verified today).
- **Inspection bodies.** Peru's registered Entidades Técnicas; municipal
  building control; licensed engineers' chambers; community construction
  management teams in federations of the urban poor (SDI affiliates such as
  FEDUP/uTshani in South Africa as the documented model).
- **Materials companies with credit programmes.** CEMEX Patrimonio Hoy
  (documented in note D); other programmes exist but are not verified here.
- **Data partners.** CAHF (country profiles), HOFINET (housing finance
  indicators; page unreachable), national statistics offices.
- **Countries first.** Peru (a legally standardised technical-entity role and a
  staged subsidy already exist; Spanish is an engine language, a machine draft
  awaiting native review, and the reference hub's second language; EDGE
  presence), Mexico (ConstruYO's staged ministraciones; CONAVI's self-production
  line; Vinte's green precedent), the Philippines (Pag-IBIG tranches; resilience
  pledges), Kenya (KMRC, deep microfinance, KNBS data, EDGE homes), and the
  United States reference hub (San Diego: ADUs and owner-builders under a
  construction-to-permanent regime that already demands draw inspections, so
  Trustwork can be the evidence record lenders already want). Nigeria and Ghana
  second: the need is greatest and the title base weakest; begin with evidence
  and statistics, not finance. Uzbekistan when the UMRC's housing-improvement
  loan line is understood. Rwanda and the Dominican Republic after their
  programmes are verified.

Naming an organisation records its public work; it implies no contact, interest or agreement.

### (h) What stays human; what needs counsel

Human: approving a plan version; accepting work; signing an inspection act; the
credit decision; underwriting; consenting to share; publishing statistics (a hub
owner role releases the method). Agents draft, schedule, remind and compile;
they never approve, inspect, decide or consent.

Counsel, per country pack, before any launch: whether offering a build-file
export to a lender list is "merely introducing" (MCD), "incidental information"
(IDD), or an "arranging" or "steering" activity (FCA, SAFE Act); whether any fee
from a lender or insurer to a hub is a RESPA referral fee or its local
equivalent (default: none); escrow and money-transmission licensing of the
disbursement provider; e-signature validity of inspection acts and disbursement
instructions; inspectors' professional liability and insurance; data-protection
basis for each field shared and for aggregates; consumer deposit and
cancellation rules; whether a build file may be required by a public subsidy
programme without discrimination against people who do not use Trustwork (it
must not be).

### (i) Measures of success

- Projects with a complete build file (all sections present, no self-reported
  "inspected").
- Share of stages with an independent inspection act before disbursement.
- Days from stage acceptance to lender-reported release (lender-consented,
  aggregated).
- Cost variance between approved estimate and accepted cost per stage; change
  frequency by cause.
- Defect rate per stage and category at first inspection and at one year.
- Licensed lenders and insurers that read the standard (count by country);
  refinance companies that reference it in eligibility criteria.
- Hubs publishing open statistics with minimum-sample cells; national statistics
  offices that cite them.
- Zero funds held, zero referral fees for consumer credit, zero unlicensed
  activity findings; complaints and appeals resolved within the published
  deadline.
- Owners' statement at completion: would they build again with the file; did
  they borrow at all, and at what stage.

## 9. What it means for Trustwork

Mapped to existing parts (projects.md, execution-and-reputation.md, billing.md,
modules/getting-paid.md) and to proposed modules.

1. **Build file projection (new, BF-001).** A serializer for a `financier`
   audience over existing canonical records, versioned, digest-bound,
   consent-referenced (`build_file_share`: reader, fields, version, valid
   period, revocation). Reuses the public-projection discipline: one serializer
   for every exit (API, export, notification, federation) so nothing leaks
   through a side door. Amounts visible only to the reader the owner authorised;
   address only `after_acceptance` of the reader's mandate.
2. **Stage templates per hub (extends "Project templates per hub",
   projects.md).** Typical stages and acceptance checkpoints per building type
   with suggested cost shares; counsel-reviewed pack data where a statute fixes
   them (MaBV); CC0 taxonomy terms so lenders in different hubs recognise "wind
   and watertight".
3. **Inspector and valuer roles (extends participants).** Capabilities
   `inspect`, `value`; inspection and valuation records as execution records
   with claimant, evidence, hash, and a separate confirmation path; reputation
   dimensions for inspectors (timeliness, contradiction rate) under a published
   method; never a public score.
4. **Stage closure record (extends execution records).** A derived record that
   exists only when work record + inspection act + owner acceptance exist for a
   stage; it is what a disbursement instruction cites.
5. **Disbursement instruction (extends PAY-002/PAY-F04).** A signed, idempotent
   instruction to a licensed provider citing the agreement digest and the stage
   closure; PAY-001 refusal of operator accounts unchanged; reconciliation
   unchanged; provider-neutral port with fake.
6. **Financing and insurance ports (new; FIN-001 revised).** Replace "referral
   fees disclosed" (PAY-F13) with "no remuneration from lenders or insurers for
   consumer housing finance; listing is neutral, unranked, hub-configured,
   licensed-only, with licence checks recorded as credentials". Events:
   submitted, decided (no reasons), released, closed. Country packs carry the
   licensing facts and the legal basis for listing.
7. **Title check credential (extends credentials/REP-001).** "Checked on date by
   hub X against register Y" for the plot; document never shown; cadastral
   identifier format from the pack; where no register API exists, a human check
   recorded with the checker's identity.
8. **Cost benchmark flag (extends plan budget ranges, ADR 012 d.23).** "Within
   hub range / outside range" per plan item against licensed cost data and,
   later, the hub's own open statistics; shown to the owner, shareable to a
   reader; never other participants' private quotes.
9. **Defect taxonomy (extends defects).** Categories by stage and element for
   statistics; CC0; crosswalk to IFC elements.
10. **Open statistics (extends analytics module).** Cells (country, region,
    building type, stage, period) with minimum-sample suppression and
    re-identification review; method versions released like reputation methods;
    export as open data; consent gate at project completion (KNOW-001) extended
    with a separate "contribute to statistics" consent, field by field.
11. **Build File Data Standard (new, open repository).** Schema, vocabulary,
    fixtures in every engine language, validator, change process; licence CC0 or
    Apache 2.0; stewardship transferable.
12. **Agent jobs under mandates (extends agent catalogue).**
    `build_file.compile` (draft the file for the owner's review),
    `inspection.schedule`, `disbursement.prepare` (compose the instruction for
    human signature), `statistics.suggest_consent` (at completion, propose what
    to contribute). None may approve, sign, decide or consent.
13. **Country packs.** New facts with sources: who may inspect; statutory stage
    schedules; deposit and retainage rules; licensing of lenders,
    intermediaries, distributors, escrow; registers for title; statistics
    offices; subsidy programmes with staged disbursement (Techo Propio,
    ConstruYO, Pag-IBIG) as references for templates.
14. **Invariants to test.** A reader without a consent reference gets 404 for
    the build file; a disbursement instruction cannot be composed without all
    three stage records from three different persons; no code path ranks lenders
    or insurers; no fee record exists with a lender or insurer counterparty in a
    consumer-credit context; a statistics cell below the minimum sample is never
    emitted; revocation of a share stops the next read.

## 10. Key findings, sourced

Fifteen statements, each with its source above.

1. "Most housing is built incrementally" in Sub-Saharan Africa, from "savings
   and small loans"; in 2011 only 3 percent of the population was eligible for a
   conventional mortgage. (World Bank stocktaking, 2015.)
2. Kenya, a country of 52 million people, had 30,015 residential mortgages in
   2023 — and 284,472 microfinance loans. (CAHF 2024.)
3. In Nigeria, 71.4 percent of landlords hold no title; home ownership fell from
   30 percent to 20 percent between 2019 and 2024. (CAHF 2024, citing NBS.)
4. Roughly 90 percent of Ghana's housing stock is produced informally. (Cities
   Alliance / World Bank, 2011.)
5. "Conventional housing finance systems have generally failed to engage with
   the reality of incremental upgrading." (UN-Habitat, World Cities Report
   2026.)
6. In the United States, 176,932 homes were started in 2024 on the owner's land,
   by the owner or a contractor the owner chose — 17.5 percent of all
   single-family starts. (NAHB from Census SOC.)
7. Where a private build is financed, money moves the same way everywhere:
   against an inspected stage. Fannie Mae's lenders inspect "prior to issuing
   draws" and hold back undrawn funds; German law fixes the schedule — 30
   percent after earthworks, 40 percent of the rest at the shell, 5 percent at
   completion — in up to seven instalments. (Fannie Mae; § 3 MaBV.)
8. A UK self-builder's lender pays at "Wall plate level", "Wind & Watertight",
   "First fix & plastering" — and expects a ten-year warranty whose provider
   inspected the build. (BuildStore; NHBC Buildmark.)
9. France made defect insurance compulsory for builders and owners in 1978; an
   uninsured constructor faces six months' imprisonment and a €75,000 fine, and
   if no insurer will quote, a tariff office sets the premium. The result is a
   market that prices defects because it has recorded them for forty-five years.
   (service-public.gouv.fr.)
10. Peru pays a family S/ 32,100 to build on its own registered, lien-free plot
    — through a registered technical entity that signs the contract, builds and
    triggers the disbursement, with 120 days to finish. The state standardised
    the role; nobody yet standardised the record. (Andina / RM
    194-2025-VIVIENDA; La Cámara.)
11. A standard turns into a bank product. IFC's EDGE certificate — 20 percent
    less energy, water and embodied carbon — has reached 357,000 housing units
    in 89 countries; Colombia went from zero to 27 percent of new build; a South
    African bank launched its first green mortgage on 807 certified homes. (IFC,
    2023.)
12. Uzbekistan built a mortgage market in five years by building its records
    first: a refinancing company, a housing price index and a mortgage database;
    by January 2025 it had refinanced more than 20,000 mortgages. (ADB.)
13. Trustwork will never lend, never hold money, never recommend a lender and
    never take a fee for a borrower's introduction. A credit intermediary
    "presents or offers credit agreements"; Trustwork hands the owner a file and
    the owner hands it to whom they choose. (MCD Art. 4(5); SAFE Act; RESPA.)
14. The bankable build file is nothing new in the engine: an approved plan that
    cannot be edited, permits and inspections as plan items, three separate
    records for every stage — the builder's statement, the inspector's act, the
    owner's acceptance — change records with reasons, defects with remediation,
    and a reputation that explains itself. What is new is the consent that lets
    a lender read it, and the open standard that lets every lender read it the
    same way.
15. The same cells that tell a lender what a roof should cost tell a town what a
    school roof should cost. A hub's open statistics — ranges, durations, defect
    rates, by stage and building type, from consented projects, never a name or
    an address — are where the private build and the public work meet.

## 11. Open questions and unverified items

- The owner-built (as distinct from contractor-built) share of US starts;
  owner-builder lending rules of specific lenders; HUD Handbook 4000.1
  one-time-close text.
- UK Finance Lenders' Handbook section 6.7 wording; Help to Build percentages
  and budget; UK self-build volumes.
- A primary Bausparkasse disbursement source.
- Legifrance text of L242-1 (service-public paraphrase used instead).
- Pag-IBIG's official checklist content (site could not be read).
- Infonavit's official ConstruYO page (not reachable); CONAVI assisted
  self-production rules.
- Mibanco's loan terms; Techo Propio's minimum saving (two figures in sources).
- CAHF Ghana and Rwanda 2024 profiles (PDF font encoding unreadable); Rwanda
  Housing Finance Project results; Ghana's National Homeownership Fund.
- KMRC's current eligibility caps (2022 figures used); 2025 totals (secondary
  only).
- NMRC underwriting standards and EDGE statement (site not reachable); Family Homes Funds'
  AfDB figures (search only).
- Any parametric or micro-insurance product for low-income homes in the
  Philippines or Kenya.
- Partial credit guarantee schemes for self-build.
- National statistics pages for Peru, the Philippines and Mexico (certificate
  errors or blocked pages).
- GDPR article text (not fetched; cited generally).
- Materials-company credit programmes other than Patrimonio Hoy (covered in note
  D).

Primary documents read in full: (World Bank 2011 and 2015, UN-Habitat WCR 2026 ch. 5, IFC EDGE
housing webinar 2023, CAHF Kenya/Nigeria 2024, Fonvivienda Res. 0813-2025).
