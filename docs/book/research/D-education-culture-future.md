# D. Education of society, the culture of building, trust as a public good, and the five-year future

Research note for the Trustwork Book, first edition, November 2026. Working evidence, not the book's position.

Feeds chapters 5, 14 and 19. Date of access for every source: 2026-11-04 unless
marked. Evidence levels: **primary/official**, _(secondary)_, _(vendor/self
claim)_, _(not re-verified: from general knowledge, to be checked before
quotation)_. Naming an organisation records its public work; it implies no contact, interest or agreement.

Repository documents read: `docs/engine/vision.md`, `learning.md`,
`execution-and-reputation.md` (toolkit and passport), `hub-operating-company.md`
(sections 1 and 2), `roadmap.md` (headings), `status.md`.

## Summary

1. Construction is one of the three sectors with the largest share of informal
   work worldwide (ILO), employs roughly 7 per cent of the world's working
   population (UNESCO-UNEVOC 2025), and is where most public money becomes a
   physical object. A worker without a certificate and a town without a budget
   literate public are two faces of the same gap.
2. The programmes that changed self-building at scale did not start from
   inspection; they started from advice, credit and respected local masters
   (Patrimonio Hoy, Build Change, Nepal's homeowner-driven reconstruction).
   Trustwork's plan-to-people and consultations fit this shape.
3. Baukultur has a working definition and a measurable eight-criterion quality
   system (Davos 2018, Davos Baukultur Quality System 2021). It gives the book
   an existing, non-invented vocabulary for "culture of building".
4. Verifiable credentials have been a W3C Recommendation since 2019, in their
   2.0 version since May 2025; Open Badges
   3.0 and Europass's European Learning Model align with them. Trustwork's
   passport design (REP-002) already names these standards; the book can promise
   portability without inventing anything.
5. Trust in national government is a minority position across the OECD (39 per
   cent in 2024, 40 per cent in 2026), and the strongest correlate is whether
   people feel they have a say (69 per cent vs 22 per cent trust).
   Responsiveness and openness are the levers Trustwork touches.
6. Reputation systems fail in two known ways: inflation (ratings become
   uninformative because raters do not want to harm) and purchase (fake reviews,
   now illegal in the United States under a 2024 FTC rule). The anti-model,
   China's social credit system, is mostly a corporate-compliance and
   court-defaulter blacklist apparatus with local scoring pilots, not a single
   citizen score; the EU AI Act bans social scoring outright (Article 5(1)(c)).
   Trustwork's rule "never a score of citizens by the state" has a legal anchor.
7. An AGPL engine like Trustwork plausibly meets most Digital Public Goods
   Standard indicators today; the gaps are a documented SDG mapping, a
   data-extraction mechanism and a written do-no-harm (content, harassment)
   policy, all small.
8. AI in government is real but mostly in pilots (OECD, 200 cases, September
   2025); the EU moved its high-risk deadlines to December 2027 and August 2028
   (Regulation 2026/1744). A reputation engine used for public procurement
   decisions may be high-risk under Annex III; Trustwork must design for that
   now.
9. Money: USAID ceased implementing foreign assistance on 1 July 2025; the field
   has shifted to World Bank DPI programmes, Co-Develop, Gates, Omidyar
   (Humanity AI, 500 million dollars pooled), the EU and Germany (GovStack,
   Sovereign Tech Agency). Open civic projects that survived diversified income
   (Decidim after 2022, OSMF); those that died depended on one donor or one
   sponsor (Sunlight 2020, Code for America brigades 2023, Open Collective
   Foundation 2024, Matrix.org's 2025 crisis).
10. The proposal below is argued, not decided: five years in which Trustwork
    goes from a reference hub to a federation of operator-run hubs whose civic
    ring (idea, budget line, tender, build, evidence, reputation) is a
    recognised digital public good with its own association of operators.

---

## Part 1. Education of society and the culture of building

### 1.1 The workforce and the gap

Three facts frame the problem.

**Construction is large and largely informal.** UNESCO-UNEVOC's 2025 publication
_Transformative TVET for the building and construction sector_ says the sector
employs approximately 7 per cent of the global working population and accounts
for over a third of global energy demand
(https://connect.unevoc.unesco.org/home/UNESCO+Publications/lang=en/akt=detail/qs=6814,
UNESCO-UNEVOC, 2025, **primary**). The ILO's 2023 report _Women and men in the
informal economy_ identifies agriculture, domestic work and construction as the
sectors with the largest share of informal employment, with men over-represented
in construction (ILO, 2023, via summary; **primary** source not re-read).
The ILO puts total informal employment at 57.8 per cent of all employed workers
in 2024, more than 2 billion people
(https://www.ilo.org/sites/default/files/2025-05/World_Informality%20Regional%20statistical%20profile.pdf,
ILO, 2025, **primary**). The often-quoted "220 million construction workers"
could not be verified against an ILO publication today and should not be used.
Country studies give the texture: in South Africa construction employs about 1.2
million people, 7.8 per cent of employment, with about 38 per cent informal and
the true share "probably higher" (ILO research repository, market systems
analysis, _(primary)_). A Habitat for Humanity analysis of nine countries found
building construction alone accounts for 4 to 11 per cent of the workforce,
generally one of the largest employers after agriculture
(https://habitat.org/media/5941/view, Habitat for Humanity Terwilliger Center,
2021; the PDF could not be text-extracted, so the figure rests on the
search excerpt, _(secondary)_).

**Skills exist but certificates do not.** The ILO's recognition of prior
learning (RPL) work makes this concrete. In Jordan, construction workers, most
of them Syrian refugees and Jordanians, were assessed and received skills
certificates that formally acknowledge prior learning; a 2024 ceremony in Amman
reported certificates awarded after an ILO-supported RPL process; an earlier
UNHCR document describes RPL and certification for 2,600 Syrians and Jordanians
in construction
(https://www.ilo.org/resource/news/skill-certification-programme-improves-opportunities-employment-jordanian;
https://data2.unhcr.org/ar/documents/details/59800, ILO/UNHCR, **primary**).
Kenya finished an RPL policy after a pilot and planned a national roll-out for
trades including carpenters, masons and plumbers; certification follows
assessment against industry standards
(https://www.ilo.org/resource/article/kenyas-journey-recognizing-informal-skills-making-recognition-prior,
ILO, **primary**). Malawi piloted RPL in construction with ILO funds, about 187
candidates assessed by one report (Malawi News Agency, _(secondary)_). Sri
Lanka's ILO office noted in 2017 that migrant construction workers return with
transferable skills and no certificates, and called for an accessible,
transparent assessment system
(https://www.ilo.org/colombo/info/pub/pr/WCMS_551503/lang--en/index.htm, ILO,
2017, **primary**). The pattern is the same everywhere: the skill is real, the
record is missing, and the missing record is what keeps the worker informal,
uninsured and underpaid.

**TVET must change shape.** UNESCO-UNEVOC's 2025 report analyses construction
training through digitalisation, greening and migration, with case studies from
Africa, Asia-Pacific and Europe; it recommends aligning standards, delivery,
partnerships and workforce planning, and it explicitly calls for refugees and
displaced persons to be included in national TVET policies and certification
frameworks (same source, **primary**; UNHCR listing
https://data.unhcr.org/en/documents/details/119901).

What this means for a book about Trustwork: the engine's "learn" ring (short
practical courses, certificates checkable by number, Demo today; authoring,
assessments, accreditation Proposed, `docs/engine/learning.md`) is not a
nice-to-have beside the marketplace. In the countries where Trustwork says it is
"especially needed", a checkable record of what a mason can do is the first rung
of formality. The handbook is already honest that a platform certificate "is not
a state qualification or licence" and that accreditation is shown only with a
recorded source; the book should keep that honesty and add the RPL framing: a
hub can be the place where an informal worker's prior learning is assessed by a
recognised body and recorded once, portably.

### 1.2 Programmes that trained self-builders and master builders

The question was which programmes worked. Four are well documented, all with
self-reported figures.

**Patrimonio Hoy (CEMEX, Mexico and Latin America, since 1998).** Combines
materials on credit, technical advice and a savings-and-delivery schedule for
low-income families who build incrementally; it runs through a network of more
than 200 promoters, mainly women, from the communities themselves. CEMEX reports
more than 650,000 families (over 3.1 million people) served by December 2022, a
99 per cent timely payment rate in 2015, break-even in 2004 and US$388.5 million
of revenue to CEMEX over 19 years; it received a UN-Habitat Business Award
(https://www.cemnet.com/News/story/175239/cemex-celebrates-25-years-of-patrimonio-hoy,
2023, _(secondary reporting of vendor figures)_; case study
https://joyce-coffee.squarespace.com/s/Case-Study_An-Update-on-Cemexs-Patrimonio-Hoy-from-a-Resilience-Perspective_April-2023.pdf,
2023, _(vendor-backed)_). One trade article's "265 million families" is a typo
and must not be repeated. The lesson is not the cement. It is that a
manufacturer's knowledge reached the self-builder as advice from a trusted local
person, tied to a schedule and a small credit. Trustwork's design that
manufacturers appear "as knowledge partners... on the plan steps where they
help, because they fit, never because they paid" (vision.md) is the open,
non-captive version of this.

**Build Change (Haiti, Nepal, Colombia, Philippines, Indonesia and others).** An
engineering non-profit that works through homeowners and local builders, with
retrofits as well as new builds. In Nepal it reports more than 150,000 people
living in over 24,000 newly built or strengthened houses, more than 52,350
homeowners who visited Technical Support Centres for advice, more than 8,425
government engineers and construction professionals trained, and a "Build Back
Safe" campaign (forum theatre, flyers, a retrofit film) reaching at least
378,000 people across 32 districts; the Government of Nepal approved and
published Build Change's confined masonry house design in March 2017; retrofits
were about 3,000 rupees per square metre against about 17,000 for a new build in
2016 (https://buildchange.org/programs/build-back-better/;
https://buildchange.org/stories/the-homeowners-of-bethanchok/;
https://www.globalgiving.org/projects/empowering-nepal-to-build-safer/reports/,
2016–2021, _(self claim)_; Curry Stone Foundation profile, _(secondary)_). No
independent evaluation of safety outcomes was found.

**Nepal's homeowner-driven reconstruction (2015 earthquakes).** The government
mandated that housing reconstruction be homeowner-driven: owners chose from
approved designs, managed materials and builders, and received a grant of Rs
300,000 in three tranches (50,000; 150,000; 100,000) tied to construction
stages. The National Reconstruction Authority reported 37 per cent of private
homes rebuilt by August 2018, 69.9 per cent at five years and 92 per cent of
private housing at the end of its term in December 2021; beneficiary counts vary
by report (about 796,000 to 812,000 grant agreements)
(https://kathmandupost.com/national/2018/08/09/authority-claims-over-37pc-private-homes-reconstructed;
https://thehimalayantimes.com/nepal/nras-term-comes-to-an-end;
https://thehimalayantimes.com/business/national-reconstruction-authority-completes-five-years-of-establishment,
2018–2021, _(secondary reporting of official figures)_). The mechanism that
mattered for Trustwork's purposes: money released against inspected stages, with
engineers posted to municipalities. That is staged acceptance of hidden works,
the exact practice `execution-and-reputation.md` says the engine makes easy.

**Habitat for Humanity's assisted self-help model** (owner families contribute
labour, Habitat supplies plans, supervision and finance) is older and larger,
but the figures found were not specific enough to quote; its Terwilliger
Center report estimated about 97 jobs per US$1 million of construction output
and argued that in emerging markets most construction workers are informal
(Habitat for Humanity op-ed, October 2021, _(self claim)_). Figures to be
verified before quotation.

**"Build back safer".** The phrase belongs to post-disaster shelter practice
(Nepal, Philippines, Haiti): simple, memorable construction messages, trained
local carpenters and masons, demonstration houses, and public campaigns. The
Nepal numbers above are the best documented example found. The transferable
pattern: safety culture spreads through the people who build, when they are paid
and respected for building well, not through posters alone.

### 1.3 Safety culture and collapse prevention

Where building is informal and inspection weak, buildings fall. Nigeria's
Building Collapse Prevention Guild (BCPG), a professional body, counts 614
collapse incidents from October 1974 to July 2024, 653 incidents and 1,616
deaths by 25 May 2025, and about 679 incidents and at least 1,639 deaths through
2025; Lagos accounted for 56.68 per cent of incidents (348) in the 2024 report,
and 47 collapses were recorded across 14 states in 2024
(https://leadership.ng/nigeria-records-145-building-collapse-incidents-in-4-years/;
https://www.primebusiness.africa/lagos-accounts-for-highest-number-of-building-collapses-in-nigeria-as-deaths-hit-1616-report/;
https://dailytrust.com/how-14-states-accounted-for-47-building-collapse-in-2024-report,
2024–2025, _(secondary reporting of a professional body's count)_). The causes
named by COREN (the engineering regulator), the Standards Organisation of
Nigeria and Lagos officials are unqualified builders ("quacks"), substandard
materials, disregard for design specifications, weak supervision, inadequate
soil testing and non-enforcement of stage certification
(https://nannews.ng/nigeria-records-22-building-collapse-33-deaths-in-7-months-coren/;
https://guardian.ng/?p=2798495, 2025, _(secondary)_). Investigations often end
in "unknown factors". No audited cause breakdown exists.

Every cause in that list is a missing record: who the builder was, what
materials were delivered, whether a stage was accepted and by whom, whether a
soil test was done. Trustwork's execution records (delivery, work record,
acceptance, defect, remediation, obligation) are precisely those records.
Nigeria is among the top-ten launch countries in the repository's Proposed
research; the book can say, with the BCPG figures and a named source, that
collapse prevention in such places is a documentation problem before it is an
engineering one.

### 1.4 Baukultur: the Davos Declaration and the quality system

The book asks for a culture of building well. Europe has already given it a
name and a method.

**The Davos Declaration 2018.** Adopted by the European Ministers of Culture in
Davos in January 2018 under the title "Towards a high-quality Baukultur for
Europe"; it treats building as a cultural act and the whole built environment,
including infrastructure and public space, as culture
(https://davosdeclaration2018.ch/en/, Davos Process, **primary**). A "Davos
Process" of conferences followed (Zagreb, Venice, Davos 2023), and a Davos
Baukultur Alliance was launched with the World Economic Forum (WEF document
"Davos Baukultur Alliance Innovative Practice 2024", _(secondary)_).

**The Davos Baukultur Quality System (2021).** Published by the Swiss Federal
Office of Culture in May 2021, it is the first method to assess the Baukultur
quality of a place, putting social, cultural and emotional criteria on an equal
footing with technical, environmental and economic ones. Its eight criteria are
**Governance, Functionality, Environment, Economy, Diversity, Context, Sense of
Place and Beauty**; each has an assessment questionnaire; a quality statement is
required on all eight
(https://www.bak.admin.ch/en/davos-baukultur-quality-system and the full
document
https://www.bak.admin.ch/dam/bak/de/dokumente/baukultur/qualtaet/en_davos_baukultur_gesamtdokument.pdf.download.pdf/02-EN_DAVOS_BAUKULTUR_GESAMTDOKUMENT.pdf,
Swiss FOC, 2021, **primary**). Europa Nostra endorsed it as the principles for
the New European Bauhaus
(https://europanostra.org/europa-nostra-fully-endorses-the-davos-baukultur-quality-system-also-as-key-principles-for-the-new-european-bauhaus,
_(secondary)_).

**The New European Bauhaus (NEB).** The EU initiative on "sustainable,
beautiful, together" now has a funding instrument, the NEB Facility 2025–2027,
with a research-and-innovation strand in Horizon Europe (the 2025 call had a
dedicated budget of €118.4 million) and a deployment strand; published annual
figures differ between sources (€100 to €180 million a year) and should be
checked against the work programmes before quotation; LIFE calls earmarked up to
€8 million for NEB projects in 2025
(https://new-european-bauhaus.europa.eu/new-european-bauhaus-facility_en,
European Commission, 2025, **primary**;
https://errin.eu/news/new-neb-facility-will-support-neb-2025-2027,
_(secondary)_).

Why this matters for the book. "Culture of building" risks sounding like a
slogan. Baukultur gives it a definition adopted by ministers, a published
eight-part measure and a European funding line. A hub's magazine, events and
courses can be organised around the eight criteria without inventing anything; a
participatory-budget project page can carry a short Baukultur statement; and
"Governance" being the first criterion ties the culture of building directly to
the loop of public trust. The system is European in origin; the
book should present it as a tool to adapt, not a standard to impose.

### 1.5 Civic and budget literacy

A public that understands its budget is the precondition of the civic loop.
Three instruments recur.

**Citizens' budgets.** A non-technical presentation of the budget for the public
is one of the eight key budget documents the Open Budget Survey has scored since
its early rounds _(not re-verified against the OBS methodology text)_. The
International Budget Partnership published the Open Budget Survey 2025 on 15
April 2026, covering 82 countries, in the survey's twentieth year; examples:
Rwanda 55 (up from 50), the Philippines 76, Ghana down from 46 to 22
(https://www.finances.gov.ma/en/Pages/detail-actualite.aspx?fiche=7652 (Moroccan
ministry's note of the release date);
https://www.newtimes.co.rw/article/38220/news/rwanda/five-areas-where-budget-oversight-falls-short;
https://ghanaiantimes.com.gh/ghanas-budget-transparency-score-hits-record-low/amp/;
https://www.gmanetwork.com/news/money/economy/992241/ph-maintains-lead-in-southeast-asia-in-2025-budget-transparency-survey/story/,
2026, _(secondary reporting of IBP results)_; IBP itself:
https://internationalbudget.org/). Notes B and C cover OBS in depth; here
the point is that OBS 2025 exists, is the latest round, and Ghana's fall shows
transparency can be lost as well as gained.

**Budget schools and civic education.** No single authoritative global source
was found; the practice (short courses for citizens and journalists on
reading a municipal budget, often run by budget groups and universities) is well
attested in national cases but the figures that would matter (reach, outcomes) were
not verified. The book should describe the practice, not count it.

**Media literacy.** Relevant because sourced news is the first ring of Trustwork
("news with sources and dates"). The engine's editorial rules (sources named,
corrections published, no fakes) are themselves a media literacy device: a
reader who sees a source and a correction learns what to expect from news.

### 1.6 How an open magazine, events and short courses raise a craft's culture

The claim the book wants to make is that reading, meeting and learning together
raise a craft. The evidence is indirect but consistent with the programmes
above: Patrimonio Hoy worked through promoters and advice, not products; Build
Change's outreach used theatre and films and technical support centres; Nepal
posted engineers in municipalities. Culture travelled through people who were
paid for it. Trustwork's design matches this at three points: experts "earn
reputation and income from the consultations and mentoring they give"
(vision.md); manufacturers teach "labelled as such" (learning.md); event
organisers include "associations, training centres, manufacturers and
communities". The missing piece in developing-country hubs is the respected
local master, the Patrimonio Hoy promoter or the Nepal mason-trainer;
Trustwork's "mentor" role and the consultation record give that person a place
and a record.

### 1.7 Verifiable credentials and the portable record

**W3C Verifiable Credentials 2.0.** The family of seven specifications (Data
Model 2.0, Data Integrity 1.0, EdDSA and ECDSA cryptosuites, JOSE/COSE securing,
and others) became W3C Recommendations on 15 May 2025; the Data Model 1.0 had
been a Recommendation since 19 November 2019
(https://www.w3.org/TR/2019/REC-vc-data-model-20191119/)
(https://www.w3.org/news/2025/the-verifiable-credentials-2-0-family-of-specifications-is-now-a-w3c-recommendation;
press release https://www.w3.org/press-releases/2025/verifiable-credentials-2-0,
W3C, 2025, **primary**).

**Open Badges 3.0 (1EdTech).** Open Badges are "digitally signed as Verifiable
Credentials compatible with the W3C Verifiable Credentials Data Model 2.0", use
JSON-LD, and have a certification programme
(https://www.1edtech.org/standards/open-badges, 1EdTech, **primary**). The exact
final-publication date was not shown on the page.

**Europass / European Digital Credentials for Learning.** The European
Commission's infrastructure lets institutions issue tamper-proof learning
credentials free of charge to issuers and holders; the data format is the
European Learning Model (ELM, v3 in use), which Europass says aligns with W3C
Verifiable Credentials; cross-border micro-credential portability is piloted on
the European Blockchain Services Infrastructure (EBSI); 18 countries were listed
as piloting at national level on an undated page
(https://europass.europa.eu/en/european-digital-credentials;
https://ec.europa.eu/futurium/en/europass/digitally-signed-credentials, European
Commission, **primary**; the main EDC page could not be reached, so details rest
on secondary Commission pages). The ELM is what a European hub would map
Trustwork certificates to.

**Why it helps informal workers.** The Jordan and Kenya RPL cases show that the
certificate is the formalising step; a paper certificate is lost, forged or
unrecognised in the next city or country. A signed, revocable, holder-controlled
credential verifiable by number or by signature travels with the worker between
employers, hubs and borders. Trustwork's passport design is already specific:
W3C VC 2.0, Open Badges 3.0 compatible, issued by the home hub, signed with the
node key, revocable through published status lists, holder chooses what to
include, free to issue (`execution-and-reputation.md`, REP-002, Proposed). The
book can promise the standard; it must not promise that any ministry or
professional body recognises Trustwork certificates. None does; none has been
asked.

---

## Part 2. Trust and reputation as public goods

### 2.1 What the OECD Trust Survey says

**2024 results (fieldwork October–November 2023, 30 countries, nearly 60,000
respondents).** 39 per cent reported high or moderately high trust in their
national government, 44 per cent low or no trust. Among people who feel they
have a say in what government does, 69 per cent trust national government; among
those who do not, 22 per cent. Women trusted less than men (36 vs 43 per cent),
and the largest falls since 2021 were among women and people with less
education. Trust is higher in day-to-day interactions with public services than
in government's ability to make policy decisions involving trade-offs
(https://www.oecd.org/en/about/news/press-releases/2024/07/governments-must-better-engage-all-citizens-to-tackle-growing-gaps-in-trust.html;
report
https://oecd-ilibrary.org/governance/oecd-survey-on-drivers-of-trust-in-public-institutions-2024-results_9a20554b-en,
OECD, 2024, **primary**). The report ranks trust by institution (police and
courts high, national government and political parties low, local government in
between); the exact per-institution figures were not re-read and should be
taken from the report before quotation.

**2026 results (third wave, fieldwork 2025, 33 OECD countries plus five
accession candidates; press release "Trust steadies but people still do not feel
heard", June 2026).** 40 per cent high or moderately high trust in national
government, 43 per cent low or none. 68 per cent believe voting influences what
government does, but only 31 per cent believe people like them have a say. New
in this wave: more than four in ten believe AI could help governments improve
services or reduce costs, but fewer are confident that governments will ensure
appropriate safeguards. Australia rose from 38 per cent (2021) to 51 per cent
(2025)
(https://www.oecd.org/en/about/news/press-releases/2026/06/trust-steadies-but-people-still-do-not-feel-heard-oecd-trust-survey.html;
full report
https://www.oecd.org/en/publications/oecd-survey-on-drivers-of-trust-in-public-institutions-2026-results_9eb63fec-en/full-report,
OECD, 2026, **primary**; the full-report page could not be reached, figures from
the press release and country notes).

**The OECD framework.** Trust is driven by **competence** (responsiveness:
public services that work and adapt; reliability: anticipating needs, stability)
and **values** (openness: information and consultation; integrity: high
standards of conduct; fairness: equal treatment). The 2024 report emphasises
engagement and "having a say"; the 2026 wave adds that day-to-day service
experience and perceived quality of decision-making on complex issues are both
strongly associated with trust (country notes, e.g. Germany and the United
Kingdom,
https://www.oecd.org/en/publications/oecd-survey-on-drivers-of-trust-in-public-institutions-2026-results_c88c8869-en/germany_a8908944-en.html,
OECD, 2026, **primary**).

**Latin America.** A separate "OECD Survey on Drivers of Trust in Public
Institutions in Latin America and the Caribbean, 2025 Results" exists
(https://www.oecd.org/en/publications/oecd-survey-on-drivers-of-trust-in-public-institutions-in-latin-america-and-the-caribbean-2025-results_ea3385cf-en/full-report.html,
OECD, 2025, **primary**); its figures were not read and matter for Peru,
Colombia, the Dominican Republic and Mexico in the launch research.

The lesson for Trustwork is unusually direct. The single largest gap in the OECD
data is between people who feel heard and people who do not. A
participatory-budget loop that closes (idea, vote, budget line, build, evidence
back to the person who proposed it) is a "have a say" machine. The 2026 finding
on AI is a warning: people expect AI to make services cheaper and do not expect
governments to keep it safe. An engine that puts agents in public processes must
show its safeguards before it shows its savings.

### 2.2 Reputation systems that worked and failed

**Inflation.** Filippas, Horton and Golden, "Reputation Inflation", _Marketing
Science_ 41(4), 2022: average buyer ratings of sellers rose substantially over
time in five online marketplaces; in one marketplace with transaction-level
data, much of the rise (an earlier working paper says at least 35–45 per cent)
came from raters applying looser standards, not from better service. The
mechanism is that raters do not want to harm the rated party; since the capacity
to harm is what makes a rating informative, public ratings become uninformative
over time. When feedback was private, raters were candid; when it became public,
inflation began (https://john-joseph-horton.com/papers/reputation-inflation/;
https://econpapers.repec.org/RePEc:inm:ormksc:v:41:y:2022:i:4:p:733-745, 2022,
**primary, peer-reviewed**). This is the strongest single argument for
Trustwork's design choice: reputation from **records of what happened**
(delivered, accepted, paid on time, against the plan as agreed) rather than from
stars, and no public score until a method with minimum samples is released.

**Purchase.** The US Federal Trade Commission's rule banning fake reviews and
testimonials (16 CFR Part 465) was announced in August 2024 and took effect on
21 October 2024; it prohibits buying or selling fake reviews, including
AI-generated ones, undisclosed insider reviews, suppression of negative reviews
by threat, and the sale of fake social-media indicators, and lets the FTC seek
civil penalties (US$51,744 per violation in 2024) against knowing violators
(https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials,
FTC, 2024, **primary**; law-firm summaries _(secondary)_). Whether the rule has
been challenged since was not checked. For a United States reference hub
the rule is binding context; "no fakes" is law, not only principle.

**Two-sided and relationship-bound systems.** Marketplaces that tie each rating
to a verified transaction, allow only counterparties to rate, and publish sample
sizes degrade more slowly than open review sites; this is the general lesson of
the literature _(not re-verified beyond the paper above)_. Trustwork goes
one step further: confirmations are "once plus one reminder, never with an
incentive", reviews must be tied to a real interaction and are excluded from
aggregates until confirmed, and review rings open a human case rather than an
automatic sanction (`execution-and-reputation.md`).

**The anti-model: China's social credit system, described accurately.** It is
not a single national score of citizens. It is an umbrella (Planning Outline
2014–2020) for: a financial credit reference system; a corporate compliance
apparatus (regulatory records, "blacklists" and "redlists" for firms, joint
punishment across agencies); a national blacklist of court-judgment defaulters
with real consequences (travel and consumption restrictions); and local pilots
that computed personal scores (a few dozen towns and cities, e.g. Rongcheng),
mostly used for rewards
(https://foreignpolicy.com/2018/11/16/chinas-orwellian-social-credit-score-isnt-real/
(Jamie Horsley, Yale);
https://www.merics.org/en/comment/chinas-social-credit-score-untangling-myth-reality
(MERICS), 2018–2022, _(secondary, expert)_). A draft Social Credit System
Construction Law was released for comment in November 2022 and, as of the
sources read, remains unenacted ("Planned",
https://www.chinalawtranslate.com/en/social-credit-law/, China Law Translate,
_(secondary, expert translation)_). In March 2025 the General Offices of the CPC
Central Committee and State Council issued _Opinions on Improving the Social
Credit System_ with 23 measures aimed at a unified national market, unified
rules and credit repair, and officials acknowledged inconsistent frameworks and
insufficient data sharing
(https://english.www.gov.cn/policies/latestreleases/202503/31/content_WS67ea9a7fc6d0868f4e8f1588.html,
State Council, 2025, **primary**;
https://www.scmp.com/economy/article/3304748/chinas-complex-social-credit-system-evolves-23-new-guidelines-beijing,
_(secondary)_). The honest critique is therefore not "a dystopian score" but:
state-run, opaque, cross-domain consequences (a court debt becomes a travel
ban), weak appeal, and the blending of legal sanction with moral labelling
("trustworthy"/"untrustworthy"). Those are exactly the properties Trustwork's
rules exclude: no state score of citizens, consequences never cross domains
silently, disputed observations never count, appeals decided by a different
person, every snapshot explains itself.

**The legal anchor.** The EU AI Act prohibits AI systems that evaluate or
classify natural persons over time on social behaviour or personal
characteristics where the score leads to detrimental treatment in unrelated
social contexts or treatment that is unjustified or disproportionate (Article
5(1)(c), applicable since 2 February 2025;
https://artificialintelligenceact.eu/article/5/, **primary text, unofficial
site**). The GDPR's Article 22 right not to be subject to solely automated
decisions with legal or similarly significant effects is the other anchor _(not
re-verified today)_. Trustwork's "never a score of citizens by the state" is
thus not only a value; in the EU it is the law, and the book can say so.

### 2.3 Principles for fair, explained, appealable reputation

Drawn from the above and from the engine's own policy; the book can present them
as Trustwork's rules rather than as a general theory:

1. Evidence before opinion: a reputation observation is a record of a
   transaction, delivery, acceptance or payment with evidence, not a feeling.
2. Separate dimensions, never one number: timing, quality, payment discipline,
   cooperation and subjective reviews reported apart, each with its sample size.
3. Published method, versioned: weights and windows are released by a reviewed
   process and announced; snapshots cite the method version.
4. Minimum samples: "not enough data" is a legitimate state; absence of evidence
   is unknown, not failure.
5. Fair timing: performance is measured against the plan as agreed at the time;
   client-caused changes are excluded.
6. Disputes stop the clock: a disputed observation never silently counts.
7. Appeals to a different person: the decider of an appeal is never the original
   decider; a fair negative observation can be answered publicly, never deleted.
8. Nothing for sale: no payment, plan, sponsorship or staff action changes a
   score; a paid check buys the check, not its result.
9. Home authority: only the subject's home node computes; others display with
   attribution.
10. No cross-domain consequence by default: a reputation fact in commerce does
    not become a civic penalty; a civic role never scores a citizen.

### 2.4 Reputation of public institutions as a delivery record

The book's idea that officials and institutions earn reputation from evidence
must be handled with care: public bodies are not sellers, and a "rating" of a
ministry is a political instrument. What the evidence supports is a **delivery
record**: did the project the public voted for get a budget line, a tender, a
contract, a build, an acceptance, on the promised date, at the promised cost,
and was the documentation published? That is the logic of the Open Budget Survey
(document publication and timeliness), of the CoST Infrastructure Transparency
Initiative (disclosure of 40 data points across the project cycle and
independent assurance; CoST's own estimate is that 10–30 per cent of
infrastructure investment is lost to corruption, mismanagement and inefficiency,
a figure that originates with CoST in 2018 and should be attributed to it, not
presented as an independent finding;
https://ice.org.uk/news-views-insights/inside-infrastructure/how-to-incentivise-transparency-in-the-infrastructure-sector,
ICE, 2021, _(secondary)_; CoST materials _(self claim)_), and of the OECD's
finding that day-to-day service experience drives trust. A delivery record is
factual, time-stamped and appealable; a rating is not. The book should use the
words "delivery record" and "track record" for institutions and officials, and
reserve "reputation" in the technical sense for participants who opted in.

---

## Part 3. The five-year future and how such an engine sustains itself

### 3.1 Digital public goods and the DPG Standard

The Digital Public Goods Alliance's standard has nine indicators: **1. SDG
relevance; 2. Open licensing; 3. Clear ownership; 4. Platform independence; 5.
Documentation; 6. Mechanism for extracting data; 7. Privacy and applicable
laws; 8. Standards and best practices; 9. Do no harm by design**, the last split
into 9A data privacy and security, 9B inappropriate and illegal content, 9C
protection from harassment (https://www.digitalpublicgoods.net/standard, DPGA,
2026, **primary**; licence CC-BY-SA 4.0). Projects that pass review enter the
DPG Registry (more than 220 DPGs in 2025 by DPGA's own count; the exact 2026
total was not confirmed; https://www.digitalpublicgoods.net/registry,
**primary**). Decidim is a recognised DPG
(https://interoperable-europe.ec.europa.eu/collection/open-source-observatory-osor/news/decidim-recognized-digital-public-good,
European Commission OSOR, _(secondary)_).

**Would Trustwork qualify, and what would it need?** An assessment, not a
verdict:

| Indicator                       | Trustwork today (from the repository)                                                                                        | Gap                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 SDG relevance                 | Implicit: decent work (SDG 8), sustainable cities and housing (11), institutions and anti-corruption (16), partnerships (17) | A written SDG mapping with evidence of relevance                                                                        |
| 2 Open licensing                | AGPL-3.0-only, an OSI-approved licence                                                                                       | None                                                                                                                    |
| 3 Clear ownership               | Created and maintained by Contribuda; NOTICE file; governance names owner, integrator, maintainers                           | Confirm ownership statement is unambiguous in the repository                                                            |
| 4 Platform independence         | PostgreSQL, fake adapters for providers; mandatory dependencies open                                                         | Document that no proprietary component is mandatory (model gateway is a risk if a single vendor model becomes required) |
| 5 Documentation                 | Extensive handbook, ADRs, module specs                                                                                       | None material                                                                                                           |
| 6 Mechanism for extracting data | Public projections, exports described                                                                                        | Document a non-proprietary export of all user data                                                                      |
| 7 Privacy and applicable laws   | Trust, safety and privacy docs; sanctions engine; case grants                                                                | Written privacy policy per hub template                                                                                 |
| 8 Standards and best practices  | OCDS, W3C VC 2.0, Open Badges 3.0, MCP named                                                                                 | List them in one place                                                                                                  |
| 9 Do no harm                    | Private stays private; no fakes; no surveillance                                                                             | 9B and 9C need a written content and harassment policy for hubs; 9A a security practice statement                       |

The gaps are documentation and policy, not architecture. Applying is free;
recognition is a review, not a partnership, and the book must not say Trustwork
"is" a DPG until it is listed.

### 3.2 Digital public infrastructure: the landscape Trustwork will sit in

**The Global Digital Compact** was adopted on 22 September 2024 at the UN Summit
of the Future as an annex to the Pact for the Future (A/RES/79/1); it names
open-source software, data, AI models, standards and content as digital public
goods, commits to increased investment in DPGs and DPI by 2030 especially in
developing countries, and calls for DPI safeguards
(https://www.un.org/global-digital-compact, UN, 2024, **primary**; OSOR summary
_(secondary)_).

**50-in-5** (launched November 2023 by first-mover countries with UNDP, the
Gates Foundation, Co-Develop, the Centre for DPI and the DPGA) aims for 50
countries to design, launch and scale at least one DPI component (ID, payments,
data exchange) by 2028; membership rose from 11 to 26 to a reported 33, with
Jamaica and Mexico (May 2025), South Africa, Bangladesh, Indonesia, Papua New
Guinea and Benin (May 2026) among joiners
(https://www.undp.org/news/11-first-mover-countries-launch-50-5-campaign-accelerate-digital-public-infrastructure-adoption-around-world,
UNDP, 2023, **primary**;
https://www.biometricupdate.com/202606/indonesia-png-join-50-in-5-as-digital-public-infrastructure-push-expands,
2026, _(secondary)_). Rwanda and Kenya are members _(Rwanda:
https://www.minict.gov.rw/..., **primary**; Kenya not re-verified)_.

**MOSIP** (Modular Open Source Identity Platform, anchored at IIIT Bangalore)
reports up to 29 signed country MoUs at MOSIP Connect 2026 in Rabat, mostly
Asia-Pacific and Africa, six in Latin America; some countries adopt only
components (Cambodia eSignet; Peru piloting eSignet and Inji); a "brownfield"
model integrates with existing ID databases; the Philippines is its largest live
deployment
(https://www.biometricupdate.com/202602/mosip-connect-2026-targets-sustainability-practical-use-cases-for-digital-id,
2026, _(secondary)_; https://www.mosip.io/pdf/MOSIP-Rewind-2025.pdf, _(self
claim)_). Peru and the Philippines are both in Trustwork's top-ten list; MOSIP's
eSignet is one possible identity-verification adapter in those countries.

**X-Road** is the open-source data-exchange layer used by Estonia and Finland
and governed by the Nordic Institute for Interoperability Solutions (NIIS), an
association founded by the two governments in 2017 and later joined by Iceland
_(not re-verified)_. Its governance model, a small international
non-profit owned by its member governments, is the cleanest example of several
operators jointly owning one engine.

**India Stack.** UIDAI's dashboard shows 144.66 crore (about 1.45 billion)
Aadhaar numbers generated as of May 2026
(https://uidai.gov.in/aadhaar-dashboard/enrollment-dashboard, UIDAI, 2026,
**primary**); UPI processed 24.07 billion transactions in September 2026 (about
₹29.37 lakh crore), with daily volume crossing 800 million for the first time,
per press reports of NPCI data
(https://startuptalky.com/india-upi-transactions-september-2026/, _(secondary)_;
NPCI statistics not read directly). The relevance is architectural: a
layered public stack (identity, payments, consent-based data sharing) that
private and public services build on. Trustwork is one such service; it does not
build identity or payments, it plugs into them through adapters.

**GovTech maturity.** The World Bank's GovTech Maturity Index 2025 update
(published 17 December 2025; 198 economies; 48 indicators in four groups: core
government systems, public service delivery, digital citizen engagement, GovTech
enablers) is the latest edition; its blog notes progress remains uneven
(https://www.worldbank.org/en/programs/govtech/gtmi-2025-update;
https://blogs.worldbank.org/en/governance/bridging-the-gap-in-govtech--why-progress-remains-uneven-around-,
World Bank, 2025, **primary**). The "digital citizen engagement" group is where
participatory budgeting and e-participation are scored; country scores for the
ten launch countries should be pulled from the dataset
(https://datacatalog.worldbank.org/search/dataset/0037889) by whoever writes the
country chapters.

### 3.3 AI agents in government and public services

**OECD, _Governing with Artificial Intelligence_ (September 2025).** Analyses
200 use cases across 11 core government functions; finds use expanding but many
efforts stuck at pilot stage; introduces an OECD Framework for Trustworthy AI in
Government; recommends prioritising high-benefit, low-risk applications first;
names fragmented data, lack of specialist staff and legacy systems as barriers
and warns against vendor dependence (https://doi.org/10.1787/795de142-en, OECD,
2025, **primary**; summaries _(secondary)_).

**Estonia, Bürokratt.** A network of agency chatbots managed by the Information
System Authority (RIA), funded in part by €53 million of Recovery and Resilience
Facility money for two projects with a speech-and-text assistant due by
end-2025; listed as active by the EU's Open Source Observatory in 2026;
secondary sources report about 18 agencies live and about 200 services, figures
not confirmed with RIA today
(https://interoperable-europe.ec.europa.eu/collection/open-source-observatory-osor/government-virtual-assistant-burokratt;
https://commission.europa.eu/projects/burokratt-programme-and-national-virtual-assistant-platform-and-ecosystem_el,
**primary**;
https://luukasilves.substack.com/p/building-the-agentic-state-in-estonia,
_(secondary)_). Estonia's stated next step is cross-border interoperability of
assistants, which is the public-sector analogue of Trustwork's agent-to-agent
structured offers across hubs.

**United Kingdom, "Humphrey".** A suite for civil servants (Consult for
analysing consultation responses, Minute for meeting notes, others), tied to a
government productivity claim of £45 billion that is an estimate, not an audited
saving; Minute trialled at 25 councils
(https://www.gov.uk/government/news/shake-up-of-tech-and-ai-usage-across-nhs-and-other-public-services-to-deliver-plan-for-change,
UK Government, 2025, **primary**;
https://www.itpro.com/business/public-sector/governments-humphrey-ai-tool-helps-local-authorities-cut-costs,
_(secondary)_).

**Singapore.** Pair (a secured LLM assistant from Open Government Products) is
reported as regularly used by between a third and more than half of 150,000
public officers in 2025–2026, the two figures coming from different official
statements; AIBots had 16,000 active users across 97 agencies; LaunchPad over
3,000 monthly users; in June 2026 the government announced a registry of AI
agents for the public service
(https://www.tech.gov.sg/technews/how-govtech-uses-ai-to-enhance-digital-public-services/,
GovTech, **primary**;
https://www.thestar.com.my/aseanplus/aseanplus-news/2026/06/02/singapore-to-create-a-registry-of-ai-agents-for-150000-public-officers-amid-ai-push,
_(secondary)_). The agent registry is a direct precedent for Trustwork's
"operator agents with a named accountable person" in the hub operating company.

**The EU AI Act timeline through 2027 and beyond, as amended by the Digital
Omnibus on AI (Regulation (EU) 2026/1744, published 24 July 2026, in force 27
July 2026).** Prohibitions (including social scoring) have applied since 2
February 2025; GPAI model obligations since 2 August 2025 (models placed on the
market earlier must comply by 2 August 2027); Article 50 transparency
obligations (chatbot disclosure, deepfake labelling) apply from 2 August 2026,
with Article 50(2) watermarking postponed to 2 December 2026; **Annex III
stand-alone high-risk systems** (employment, education, credit, essential public
services, law enforcement and others) moved from 2 August 2026 to **2 December
2027**; **Annex I** product-embedded high-risk systems moved from 2 August 2027
to **2 August 2028**; high-risk systems used by public authorities and placed on
the market before 2 August 2026 must comply by 2 August 2030 (Article 111(2));
two new prohibitions on non-consensual intimate imagery and CSAM generation
apply from 2 December 2026
(https://fpf.org/blog/the-ai-act-implementation-timeline-what-changes-under-the-ai-omnibus/
(28 July 2026) and timeline PDF
https://fpf.org/wp-content/uploads/2026/07/FPF-EU-AI-Act-Timeline-2026-R2.pdf,
Future of Privacy Forum, _(secondary, expert)_;
https://artificialintelligenceact.eu/article/5/; law-firm notes _(secondary)_;
the Official Journal text was not read directly). What this means for
Trustwork: an agent that ranks contractors for a municipal tender, or a
reputation snapshot used in awarding public work, could fall under Annex III
(access to essential public services, or evaluation affecting economic
opportunity); the engine's explainability, human decision, logging and appeal
design should be written as a conformity story now, two years before the date.

### 3.4 What changes in construction with AI

Sourced cases are in permitting and code checking; estimating and scheduling
claims are mostly vendor claims and are not quoted here.

- **Austin, Texas** signed a five-year contract with Archistar after a
  three-month pilot of an AI pre-check for zoning on single-family residential
  permits, and is piloting automated International Building Code compliance
  review with the International Code Council
  (https://austintexas.gov/node/96266, City of Austin, 2025, **primary**;
  https://www.bdcnetwork.com/codes-and-standards/news/55237400/austin-texas-adopts-ai-driven-building-permit-software,
  _(secondary)_).
- **Seattle** evaluated CivCheck in 2026: automated intake screening found 87
  per cent of the errors manual reviewers found; in plan review, city reviewers
  agreed with the automated assessment 92 per cent of the time; the report
  states pre-screening cannot check every code for all building types
  (https://seattle.gov/documents/Departments/Performance/Publications/2026CivCheckEvaluationReport.pdf,
  City of Seattle, 2026, **primary**).
- **Toronto** runs an AI building-permit pre-check for completeness and basic
  zoning and code compliance, listed in its AI register with outputs "advisory
  only"
  (https://www.toronto.ca/city-government/data-research-maps/ai-register/building-permit-application-precheck/,
  City of Toronto, **primary**).
- **Rwanda, Kubaka** (launched April 2025 with the 2025 National Urbanisation
  Policy) replaced the 2016 BPMIS built with IFC support; it is a "zero-trip"
  online permit process integrated with other government systems, reported to
  validate master-plan compliance automatically; a 2026 feature lets a land
  buyer keep an approved permit. No AI component was found in any source; do not
  call Kubaka "AI permitting"
  (https://www.mininfra.gov.rw/updates/news-details/rwanda-launches-2025-national-urbanisation-policy-and-unveils-kubaka-the-new-and-enhanced-building-permit-system-to-boost-smart-urban-development,
  MININFRA, 2025, **primary**;
  https://www.newtimes.co.rw/article/35115/news/housing/rwandas-digital-permit-reform-gains-ground-with-kubaka,
  2026, _(secondary)_).
- **Singapore, CORENET X** soft-launched 18 December 2023; replaces more than 20
  agency touchpoints with three gateways (Design, Construction, Completion;
  Piling optional); requires openBIM IFC with a local IFC-SG extension; BCA
  expects shorter approval lead times; 2025 circulars update the implementation
  plan
  (https://www1.bca.gov.sg/regulatory-info/building-control/corenet-x/corenet-x-faq/general-information;
  https://www.ura.gov.sg/Corporate/Guidelines/Circulars/dc25-01, BCA/URA,
  2023–2025, **primary**).

The pattern across all five: the machine screens, the human decides, the output
is advisory, and the model-based submission (BIM) is the precondition for
automation. For Trustwork, the implication is that "permits and inspections" in
a plan are becoming machine-readable gateways; a hub's agent can prepare a
complete, pre-checked application, and the field evidence Trustwork already
records (staged acceptance with photographs) is what a Completion gateway will
one day accept. None of these cities or agencies is a partner; all are
precedents.

### 3.5 Who funds open civic engines in 2025–2026

**The shock.** The United States cancelled 83 per cent of USAID-managed
programmes in March 2025; on 1 July 2025 USAID "officially ceased to implement
foreign assistance" and remaining functions moved to the State Department, with
fewer than 6 per cent of staff transferring by one account; Devex describes 2026
as a year of capacity shortfalls at State for moving assistance money; a July
2026 GAO report and an August 2026 State OIG report exist but were not read; a
court ruling on constitutionality was reported but could not be confirmed
(https://www.everycrsreport.com/files/2025-09-05_IF10261_675e6d431c41d3c7bcbda03dda2ee4dd857e4c3e.html,
Congressional Research Service, 2025, **primary**;
https://www.wkar.org/2025-07-01/usaid-officially-shuts-down-and-merges-remaining-operations-with-state-department,
NPR affiliate, _(secondary)_). USAID had been a principal funder of open
government, anti-corruption and civic-tech work; that money is largely gone and
the book should not count on it.

**Multilaterals.** The World Bank's Global DPI Program (digital ID, payments,
data sharing) and ID4D (which reports having catalysed more than US$2.3 billion
of ID financing by 2023) are the largest public funders of DPI; recent examples
are US$50 million for Nepal (with US$40 million from the Asian Development Bank)
and US$120 million for Zambia
(https://www.worldbank.org/en/results/2026/05/06/global-digital-public-infrastructure-program;
https://www.worldbank.org/en/results/2023/10/12/creating-digital-public-infrastructure-for-empowerment-inclusion-and-resilience,
World Bank, 2023–2026, **primary**; Nepal/Zambia _(secondary)_). The Bank's
GovTech programme funds e-procurement, e-permitting and participation systems
through country loans; the IFC supported Rwanda's BPMIS. IDB and AfDB DPI
programmes were not verified; the IDB publishes Consul as an open-source
solution in its knowledge catalogue
(https://knowledge.iadb.org/en/code-development/open-source-solutions/consul,
IDB, **primary**). UNDP co-leads 50-in-5 and the DPI Safeguards work. The EU's
Global Gateway (a 2021–2027 investment framework) and Horizon Europe (NEB
Facility) are European channels _(Global Gateway figures not re-verified
today)_. Germany funds through GIZ (GovStack co-founder with Estonia, ITU and
DIAL; GovSpecs 2.0 strategy adopted summer 2025; the founders intend an
independent GovStack foundation in Estonia) and through the Sovereign Tech
Agency, which gave the OpenStreetMap Foundation €384,000 over two years for
infrastructure (https://www.govstack.global/about/;
https://estdev.ee/en/articles/new-govstack-tech-strategy-govspecs-20-leads-way-future-ready-digital-public,
2025, **primary**; OSMF treasurer's report
https://osmfoundation.org/wiki/Annual_General_Meetings/2025/Treasurer%27s_report,
**primary**).

**Philanthropy.** Co-Develop (born of a 2021 Rockefeller-co-hosted convening;
receives funds from multiple donors; joined the DPGA in November 2025; UNICEF
partnership for Tanzania and Lesotho; Google committed about US$5 million to
Latin American DPI through it in April 2026) (https://www.codevelop.fund/who;
https://www.codevelop.fund/insights-1/co-develop-joins-the-digital-public-goods-alliance-to-accelerate-safe-and-inclusive-digital-public-infrastructure-globally,
_(self claim)_;
https://www.biometricupdate.com/202604/google-investing-5m-into-latam-dpi-projects-through-co-develop,
_(secondary)_). The Gates Foundation co-sponsors 50-in-5. Omidyar Network
co-chairs with MacArthur the five-year US$500 million Humanity AI pooled fund
(Ford, Mozilla, Mellon, Packard and others participate), whose first US$18
million went to public-interest AI organisations in May 2026 with a US$10
million open call to follow; Omidyar lists Co-Develop among its programmes
(grantedai.com summaries, 2026, _(secondary)_; verify on Omidyar/Humanity AI
sites). Ford, Sloan, Open Society, Omidyar and Mozilla backed the Digital
Infrastructure Fund for open-source infrastructure research
(https://www.fordfoundation.org/work/challenging-inequality/technology-and-society/digital-infrastructure/our-work/,
**primary**). Mozilla ran US$50,000 grants for AI that strengthens democracy in
2026 _(secondary)_. Hewlett (long-time funder of fiscal transparency and IBP)
and Luminate (civic tech) were not verified with 2025–2026 announcements today;
name them as historical funders of the field only.

Naming an organisation records its public work; it implies no contact, interest or agreement.

### 3.6 How open civic projects sustained themselves, and why others died

**Decidim** (Barcelona, 2016; Free Software Association since 2019). By 2022 two
contracted workers were paid by two €50,000 public grants and the association
faced a crisis; it adopted a diversification plan (public funding, philanthropy
and research funds, services, donations, partners) and reported in 2025 that of
15 funding applications 9 were refused and 6 accepted; a 2021 framework
agreement with the Generalitat de Catalunya and Barcelona City Council remains
the main source; lessons presented at FOSDEM 2025 and FOSS Backstage 2026
(https://fosdem.org/schedule/event/fosdem-2025-5552-building-sustainability-a-case-study-in-funding-diversification-for-decidim;
https://meta.decidim.org/processes/sustainability-governance/f/1848, Decidim,
**primary/self**). Decidim also requires every deployment to sign a Social
Contract (free software, transparency, equal opportunity, privacy,
accountability, continuous improvement) _(not re-verified; the wording
should be taken from decidim.org before quotation)_. Decidim is a recognised
DPG.

**Consul Democracy** (Madrid, 2015). Political support fell after elections; a
Dutch foundation was created in 2019 with Access Info Europe's help to keep the
platform maintained; it reports a small staff of about four; use in dozens of
countries (one source says 36, another "more than 150 clients"); a single
undated source names Munich as a €20,000-a-year sponsor
(https://consuldemocracy.org/about-us/;
https://www.access-info.org/2019-04-17/access-info-europe-helps-create-the-consul-democracy-foundation/,
**primary/self**; OSOR case study
https://interoperable-europe.ec.europa.eu/sites/default/files/inline-files/osor-case-study-of-consul-democracy.pdf,
_(secondary)_). Lesson: a city's software must leave the city's politics before
the next election.

**OpenStreetMap Foundation.** Membership fees and donations, plus large grants
(Meta €178,710; Sovereign Tech Agency €384,000); a 2025 budget around GBP
650,000 (secondary figure), a projected GBP 80,000 deficit turned into about GBP
30,000 surplus; the 2026 budget approved in January 2026
(https://osmfoundation.org/wiki/Board/Minutes/2026-01/2026_OSMF_budget;
https://osmfoundation.org/w/images/e/e6/FY2024_Full_accounts.pdf, OSMF,
**primary**). Lesson: a tiny foundation can steward a global commons if the
heavy work is done by the community and the data is the asset.

**Ushahidi and mySociety.** Both are long-lived (2008 and 2003) and both publish
annual reports; their 2025 figures were not retrieved and should be read
before quotation. Their survival pattern, from general knowledge: grants plus
earned income (mySociety's FixMyStreet Pro for councils; Ushahidi's hosted
plans) _(not re-verified)_.

**Deaths and near-deaths.**

- **Sunlight Foundation** closed in September 2020 after Sunlight Labs ended
  technical work in 2016, a failed leadership search and funding decline;
  projects went to ProPublica, the Center for Responsive Politics and others
  (https://technical.ly/civic-news/sunlight-foundation-shutting-down/;
  https://nonprofitquarterly.org/becoming-an-ancestor-sunlight-foundation-closes-its-own-shutters/,
  2020, _(secondary)_).
- **Code for America Brigade Network.** In February 2023 CfA ended fiscal
  sponsorship of about 60 volunteer chapters and cut Network staff, citing
  long-term sustainability, a fundraising deficit and growing privacy and
  security concerns about volunteers working with governments; former chapters
  regrouped as the Alliance for Civic Technologists
  (https://codeforamerica.org/news/an-open-letter-to-the-code-for-america-brigades/;
  https://www.govtech.com/civic/Code-for-Americas-Quest-to-Save-the-Brigades.html,
  2023, _(primary/secondary)_).
- **Open Collective Foundation** (a US fiscal host for more than 600
  collectives) announced on 28 February 2024 that it would dissolve by 31
  December 2024, citing an unsustainable model; the Open Source Collective and
  the platform continued
  (https://opencollective.com/foundation/updates/announcement-we-are-dissolving-open-collective-foundation-at-the-end-of-this-year,
  2024, **primary**).
- **Matrix.org Foundation.** After Element stopped most of its funding in
  December 2023, the Foundation ended 2024 with a reported US$356,000 deficit
  after liquidating US$283,000 in crypto donations, and in February 2025 warned
  it would shut its bridges unless US$100,000 was raised in a month; it moved to
  a funding-member model covering about half its budget and published its first
  annual report in March 2026 (https://matrix.org/blog/2025/02/crossroads/;
  https://matrix.org/blog/2026/03/annual-report/, Matrix.org Foundation,
  **primary/self**).

**The common lessons**, stated plainly: one funder is a death sentence on a
delay; a city or company sponsor must become a neutral legal entity before the
sponsor's priorities change; volunteers need a paid core and a legal home;
infrastructure that everyone uses and nobody pays for will ask for money in
public one day; earned income from the people who benefit (councils, operators,
members) is the only income that grows with use.

### 3.7 Governance models for an engine run by many operators

Observed models, each with a living example:

| Model                                              | Example                                                                                    | What it does well                                                  | Risk                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Member-government association                      | NIIS (X-Road): founded by Estonia and Finland, joined by Iceland _(not re-verified)_ | Operators own the engine jointly; stable public funding; neutral   | Slow; governments only                                         |
| Free software association with a social contract   | Decidim Association (Barcelona)                                                            | Values bind every deployment; members include cities and companies | Dependent on one region's public money                         |
| Independent foundation spun out of a city          | Consul Democracy Foundation (Dutch stichting)                                              | Survived the founding city's politics                              | Very small; thin funding                                       |
| University-anchored programme                      | MOSIP (IIIT Bangalore); DHIS2 (University of Oslo) _(DHIS2 not re-verified)_         | Credible neutral host; grants flow easily; long horizon            | Capacity of one institution; country MoUs, not ownership       |
| Membership foundation for a commons                | OSMF                                                                                       | Cheap; community does the work; data is the asset                  | Chronic under-funding of infrastructure                        |
| Funding-member foundation                          | Matrix.org Foundation                                                                      | Companies that depend on the protocol pay                          | Collapses if the anchor company withdraws                      |
| Multi-government initiative moving to a foundation | GovStack (planned Estonian foundation)                                                     | Shared financing and political support                             | Transition risk                                                |
| Maintainer company plus operator network           | Trustwork today: Contribuda maintains; hubs operate; public work packages; ADRs            | Fast; one accountable maintainer; free software guarantees exit    | Perceived capture by the maintainer; single-company dependence |

The design question for Trustwork is not which to copy but when to add the
second layer: a **hub operators' association** that owns the invariants (a
charter like Decidim's Social Contract, with Trustwork's "will never build"
list), elects the country-pack maintainers' council, and advises on the use of the
Trustwork name for hubs (the name and mark remain the owner's, NOTICE), while
Contribuda remains the maintainer; its optional hub tool is a separate service
on its own terms. The AGPL already guarantees the exit right; the association
guarantees the voice.

---

## A proposed five-year arc for Trustwork

**This is an argued proposal of the research, not a decision.** Year five is an
engine others run. The civic ring is a direction of this book; its design is not
yet in the repository and a decision record is expected. Years are the arc's
shape, not dates.

**Year one (2027): one real hub, and the loop closed once in construction.** The
world: EU Article 50 transparency rules in force; Annex III high-risk deadline
set for December 2027; AI pre-check of permits spreading in US and Canadian
cities; the OECD 2026 survey's "do not feel heard" finding fresh; USAID money
gone; 50-in-5 past 35 countries. Trustwork should have: the San Diego reference
hub in production with sourced news, events, courses and the first certificates
checkable by number; plan-to-people live for private projects; reputation
without a public score; the DPG Standard application prepared (SDG mapping,
export mechanism, do-no-harm policy); the civic decision record written and
reviewed; one sourced "public works" page type that shows a city project from
budget line (open budget data) to contract (OCDS) to field evidence, read-only,
in the reference territory; the passport (W3C VC 2.0) issued for the first
certificates. Nothing civic is promised to any government.

**Year two (2028): three operator hubs, and the first participatory-budget loop
with a lawful municipality.** The world: the 50-in-5 deadline year; EU Annex III
obligations in force since December 2027, and the first conformity assessments
of public-sector scoring tools; e-permitting with BIM gateways normal in
Singapore and spreading; AI assistants in government counted in registries
(Singapore's precedent). Trustwork should have: hubs run by at least three
independent operators (an association, a publisher, a university or training
body) in two or three countries from the top-ten list, each with its country
pack maintained locally; the mesh federating public projections; the civic ring
in Demo and then Live for one consenting municipality: idea, discussion,
feasibility and cost by registered professionals on the hub, vote through the
municipality's own process, a budget line linked to its open-budget source, an
open tender linked to OCDS, construction with staged field evidence, resident
and inspector confirmations as separate records, a delivery record for the
project (never a score of any citizen or official). Recognition of prior
learning explored with one national training authority. The operators'
association founded with a charter.

**Year three (2029): the civic ring is a product, the hub company is a team of
people and agents, the engine is a recognised digital public good.** The world:
Annex I high-risk rules in force (August 2028); national DPI stacks (ID,
payments, data exchange) available as adapters in most launch countries; the
OECD's 2028 trust wave likely asking again about AI safeguards. Trustwork should
have: DPG recognition (if the review passes; otherwise the honest gap list);
civic ring available to any hub as a module with hub-configurable law and
consent; the hub operating company's 23 functions staffed by agents and people
in at least five hubs; Baukultur statements on public-works pages where
operators adopt the Davos criteria; courses and certificates mapped to one
national qualifications framework (Europass ELM in a European hub, or an RPL
authority in Kenya or Jordan); an annual, published "delivery
record" report for each participating municipality, written from records, with
the municipality's reply.

**Year four (2030): a federation that funds itself.** The world: the Global
Digital Compact's 2030 investment goal reviewed; EU public-authority legacy
systems deadline (2 August 2030); AI agents in procurement under conformity
rules; the first generation of self-builders trained on hubs finishing their
houses. Trustwork should have: the operators' association financially
independent (membership fees from hubs, services, grants from funders of the
kind in 3.5), holding the charter and advising on the use of the name (the
marks remain the owner's); Contribuda as maintainer, with its optional hub tool
on its own terms; income to hubs from
commissions as hub settings, events, courses and services, never from ranking; a
published federation protocol with at least one non-Contribuda implementation of
a node; reputation passports accepted by at least one external verifier (an
insurer, a licensing board or a lender) as a possible outcome, if any agrees; a
public failure log (projects voted and not built, disputes, revoked
certificates) because the credibility of the loop depends on showing what did
not work.

**Year five (2031): an engine others run, in the places where it is especially
needed.** The world: post-disaster reconstruction and informal-settlement
upgrading increasingly run through homeowner-driven models with digital staged
payments (Nepal's model generalised); national permit systems exposing
machine-readable gateways; trust surveys measuring whether AI in government kept
its safeguards. Trustwork should be: hubs in ten or more countries run by local
operators under one charter; the civic ring running in several municipalities
per country where the law allows; RPL-recognised certificates for informal
workers in at least two countries; a library of shared project knowledge (with
owner consent) that a self-builder in Lima or Accra can read in their language;
a federated delivery record that lets a resident see what their vote became; and
the engine still refusing to score citizens, hold money, rank for pay or watch
workers. Trustwork's open gap is the next hub, the next country pack, the next
craft.

The arc's logic: construction first, because that is where the engine already
works and where public money is visible; the civic ring only with a consenting
municipality and a lawful operator; standards and recognition (DPG, VC, ELM,
RPL) before scale; an association before the fourth operator; self-funding
before the tenth country.

---

## What it means for Trustwork

1. **Treat certificates as the first rung of formality.** Add an RPL pathway to
   the learning design: an accredited assessor (a training authority or
   professional body, recorded with a source) assesses prior learning on the hub
   and the hub issues a certificate naming the assessor; the accreditation
   record already exists in `learning.md`. Design the assessor role and the
   consent model.
2. **Make the passport export ELM-compatible** (European Learning Model v3)
   alongside W3C VC 2.0 and Open Badges 3.0, so a European hub can push
   certificates into Europass wallets; a direction of the book.
3. **Write the DPG Standard gap closers**: an SDG relevance statement, a
   complete user-data export, a per-hub content and harassment policy template,
   a security practice statement. Apply when the reference hub is in production.
4. **Add a "delivery record" entity for public projects**, distinct from
   reputation: planned vs actual dates and amounts, documents published and
   when, confirmations by residents and inspectors as separate records, the
   institution's reply. Never a score; never a ranking of officials; never
   cross-domain consequences.
5. **Encode the social-scoring prohibition** as an invariant and a test: no code
   path aggregates civic signals about a natural person into a score; civic
   roles (resident, voter, proposer) carry no reputation dimensions.
6. **Prepare the AI Act conformity story for Annex III** by December 2027:
   logging, human decision at every award, explanation text, appeal routes, data
   governance, and a statement of which Trustwork functions are high-risk when
   used by a public body and which are not.
7. **Add a Baukultur statement field** (eight criteria, free text, optional) to
   public project pages and participatory-budget proposals where the operator
   adopts it; cite the Swiss FOC system; do not make it mandatory.
8. **Design the permit step of a plan as a gateway**: machine-readable
   application packages, pre-check results as advisory, staged field evidence
   shaped for a completion gateway; CORENET X and Seattle's evaluation are the
   precedents.
9. **Draft the hub operators' charter** from the existing invariants and "will
   never build" list, modelled on Decidim's Social Contract; make it a condition
   of using the Trustwork name for a hub; keep the engine AGPL and
   chartered-name-free so anyone can run it unbranded.
10. **Diversify income before it is needed**: hub membership fees to the
    association, Contribuda's optional tool on its own terms and services by
    others, event and course revenue to hubs, grants from funders of the kind in
    3.5; a published annual
    budget in the OSMF style. Never ranking, never data sales.
11. **Publish failures**: revoked certificates with reason categories, disputed
    observations, voted projects not built, launch gates failed. The OECD data
    says people trust what responds; a public failure log is a response.
12. **Keep the agent accountable and registered**: one representative per
    person, operator agents with a named accountable person, a hub-level agent
    register visible to the operator (Singapore's registry precedent), chat text
    never authorising anything.

---

## Key findings (15 statements, sourced)

1. Construction employs about 7 per cent of the world's working population and
   is one of the three sectors with the most informal work; the record of what a
   worker can do is what most of them lack (UNESCO-UNEVOC 2025; ILO 2023).
2. Where buildings fall, the causes named by regulators are missing records:
   unqualified builders, unverified materials, uninspected stages, untested
   soil. Nigeria's Building Collapse Prevention Guild counted 653 collapses and
   1,616 deaths between 1974 and May 2025 (BCPG via Nigerian press, 2025).
3. The programmes that changed self-building did so through advice from trusted
   local people, small credit and staged payments: Patrimonio Hoy reports
   650,000 families; Nepal's homeowner-driven reconstruction paid grants in
   three stages against inspections and reported 92 per cent of private houses
   rebuilt by 2021 (CEMEX 2023, self-reported; Nepal NRA via press).
4. "Culture of building" has a definition ministers adopted (Davos Declaration,
   January 2018) and a measure with eight criteria: governance, functionality,
   environment, economy, diversity, context, sense of place, beauty (Swiss
   Federal Office of Culture, 2021).
5. A certificate can now be a signed, revocable, holder-controlled record anyone
   can verify: W3C Verifiable Credentials have been a standard since 2019, in
   their 2.0 version since 15 May 2025;
   Open Badges 3.0 and Europass's European Learning Model align with it (W3C
   2025; 1EdTech; European Commission).
6. Trust in national government is a minority position in the OECD: 39 per cent
   in 2024, 40 per cent in 2026; 69 per cent of people who feel they have a say
   trust their government, 22 per cent of those who do not (OECD 2024, 2026).
7. More than four in ten people think AI could make government cheaper or
   better; fewer believe governments will keep it safe (OECD 2026). Safeguards
   must be shown before savings.
8. Public ratings inflate: raters do not want to harm, so stars stop meaning
   anything; much of the rise in marketplace ratings over time is lower
   standards, not better service (Filippas, Horton and Golden, _Marketing
   Science_, 2022). Trustwork counts records, not stars.
9. Buying reviews is illegal in the United States since 21 October 2024, with
   civil penalties per violation (FTC rule, 16 CFR 465).
10. China's social credit system is not one citizen score; it is a
    corporate-compliance and court-defaulter apparatus with local scoring pilots
    and a still-unenacted draft law (Horsley 2018; MERICS; State Council
    Opinions, March 2025; China Law Translate). Its real faults are opacity,
    cross-domain punishment and weak appeal. The EU bans social scoring by AI
    outright (AI Act Article 5(1)(c), in force since February 2025). Trustwork
    will never score a citizen.
11. An AGPL engine can be a recognised digital public good if it documents SDG
    relevance, open licence, ownership, platform independence, documentation,
    data export, privacy, standards and do-no-harm (DPG Standard, nine
    indicators). Trustwork's gaps are paperwork, not architecture.
12. Countries are building the rails Trustwork will run on: 50-in-5 has passed
    30 members; MOSIP has up to 29 country agreements; India's UPI processed 24
    billion transactions in September 2026; the Global Digital Compact commits
    to investing in digital public goods by 2030 (UNDP; Biometric Update; press
    reports of NPCI; UN 2024).
13. AI in permitting is advisory and human-decided where it works: Seattle's
    automated pre-check found 87 per cent of the errors reviewers found and
    reviewers agreed 92 per cent of the time; Austin contracted after a pilot;
    Singapore's CORENET X replaced 20 touchpoints with three gateways (Seattle
    2026; Austin 2025; BCA 2023–2025).
14. The EU's high-risk AI obligations now start on 2 December 2027 (Annex III)
    and 2 August 2028 (Annex I); a tool that ranks bidders for public work may
    be high-risk, and Trustwork designs for it now (Regulation (EU) 2026/1744
    via FPF, 2026).
15. Open civic engines live on diversified income and die on one funder: USAID
    stopped implementing aid on 1 July 2025; Sunlight closed in 2020, Code for
    America's brigades lost their sponsor in 2023, Open Collective Foundation
    dissolved in 2024, Matrix.org nearly closed in 2025; Decidim and
    OpenStreetMap survived by widening their base (CRS 2025; Technical.ly 2020;
    CfA 2023; OCF 2024; Matrix.org 2025; Decidim FOSDEM 2025; OSMF 2026).

---

## Open questions and unverified items

- The "220 million construction workers" figure (ILO): not found in a primary
  source.
- Per-institution trust figures in the OECD 2024 report and exact AI-perception
  percentages in the 2026 report (OECD full-report pages could not be reached).
- Europass Digital Credentials main page (403); ELM/W3C alignment rests on
  Commission secondary pages.
- The current DPG Registry total and whether a DPG Standard v1.2 exists.
- X-Road/NIIS membership, DHIS2 governance, Decidim's Social Contract wording,
  GDPR Article 22 wording, EU Global Gateway figures, Hewlett and Luminate
  2025–2026 grants, IDB and AfDB DPI programmes: from general knowledge, marked
  as such.
- Bürokratt's "18 agencies / 200 services" (secondary only); Singapore Pair
  usage (two conflicting official figures); Humphrey savings (an estimate, not
  audited).
- Any independent evaluation of Build Change or Patrimonio Hoy outcomes; Habitat
  for Humanity's nine-country figures (PDF could not be read).
- Whether the 2024 FTC rule has been challenged; the reported court ruling on
  USAID's dismantling.
- Kubaka has no AI component in any source found; do not describe it as AI
  permitting.
- mySociety and Ushahidi current income figures.
