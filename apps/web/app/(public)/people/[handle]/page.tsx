import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Building2,
  Clock,
  FileCheck2,
  FileText,
  FolderOpen,
  GraduationCap,
  Mail,
  MapPin,
  MessageSquareText,
  Phone,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench,
} from 'lucide-react';
import { Breadcrumb, ButtonLink, MediaFrame } from '@/components/ui';
import { CompanyMark } from '@/components/public/CompanyMark';
import { PersonAssistant, type PersonBrief } from '@/components/public/agent/person';
import { AgentTrigger } from '@/components/public/agent/PublicAssistant';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { SectionNav } from '@/components/public/SectionNav';
import { ShareRow } from '@/components/public/ShareRow';
import { SignalBadge, signalLabel } from '@/components/public/SignalBadge';
import { SRLogo, SRMark } from '@/components/public/SRMark';
import { EvidenceChip, ProjectStatusChip, formatLabel, regionLabel, topicLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import { fixtureMedia, projectCover, storyCover } from '@/app/_lib/media';
import { getPrincipal, hrefFor, type PageSearchParams } from '@/app/_lib/principal';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ handle: string }>; searchParams: PageSearchParams };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primeLocale();
  const { handle } = await params;
  const person = await data.getPerson(handle);
  return { title: person ? person.displayName : t('error.notFoundTitle'), description: person?.headline ?? undefined };
}

/**
 * Person profile (same system as the company page): cover and identity with self-declared statuses, fact strip,
 * sticky section nav over long-scroll sections (about, services, portfolio, experience, projects, publications,
 * confirmations, contacts), sticky aside (agent, share, similar people, «is this you»). Optional sections appear
 * only when the person published something there. Portrait, employer and contacts are shown only with consent.
 */
export default async function PersonPage({ params, searchParams }: Params) {
  await primeLocale();
  const { handle } = await params;
  const person = await data.getPerson(handle);
  if (!person) notFound();
  const principal = await getPrincipal(searchParams);
  const isMe = principal.kind === 'person' && principal.personId === person.id;
  const pr = person.profile;
  const messageHref = `/login?next=${encodeURIComponent(`/app/messages/new?person=${person.handle}`)}`;
  const inviteHref = `/login?next=${encodeURIComponent(`/app/projects?invite=${person.handle}`)}`;
  const years = pr.since ? new Date().getFullYear() - pr.since : null;
  const coverWork = pr.portfolio.find((w) => w.cover) ?? null;
  const coverProject = person.projects[0];
  const cover = coverWork?.cover ? fixtureMedia(coverWork.cover, 'project') : coverProject ? projectCover(coverProject.handle) : null;
  const geography = pr.geography.length ? pr.geography : [regionLabel(person.region)];

  const similar = (await data.listPeople())
    .filter((p) => p.id !== person.id)
    .map((p) => ({ p, score: (p.field === person.field ? 3 : 0) + (p.region === person.region ? 1 : 0) + p.expertise.filter((e) => person.expertise.includes(e)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.p);

  const documents = [
    ...(pr.accreditation ? [`${t('sr.mark')} · ${shortDate(pr.accreditation.verifiedAt)}: ${pr.accreditation.scope.join(', ')}`] : []),
    ...pr.platformCertificates.map((c) => `${t('sr.certTitle')}: ${c.course.title} (${t('sr.certNumber', { id: c.id })})`),
    t('personPage.consentItem'),
    ...(person.portrait ? [t('personPage.portraitItem')] : []),
    person.employer ? t('personPage.employerItem') : t('personPage.employerNone'),
  ];
  const brief: PersonBrief = {
    name: person.displayName,
    handle: person.handle,
    role: person.roleLine,
    field: person.field ? t(`people.fields.${person.field}`) : '',
    independent: person.independent,
    employer: person.employer,
    about: pr.about ?? person.experience,
    expertise: person.expertise,
    geography,
    signals: person.signals.map((s) => ({ label: signalLabel('person', s.kind) + (s.until ? ` · ${t('signals.until', { date: shortDate(s.until) })}` : ''), note: s.note })),
    services: pr.services.map((s) => ({ name: s.name, description: s.description, format: t(`personPage.serviceFormat.${s.format}`) })),
    portfolio: pr.portfolio.map((w) => ({ title: w.title, kind: w.kind, year: w.year, href: w.projectHref })),
    career: pr.career.map((c) => ({ role: c.role, company: c.company, years: `${c.from} — ${c.to ?? t('personPage.present')}`, href: c.companyHref })),
    certificates: pr.certificates.map((c) => ({ name: c.name, evidence: t(`evidence.${c.evidence}`) })),
    projects: person.projects.map((p) => ({ name: p.name, status: t(`projectStatus.${p.status}`), href: p.href })),
    publications: person.publications.map((p) => ({ title: p.title, href: p.href, date: shortDate(p.publishedAt) })),
    contacts: [
      pr.contacts?.phone ? { label: t('personPage.phone'), value: pr.contacts.phone, href: `tel:${pr.contacts.phone.replace(/[^\d+]/g, '')}` } : null,
      pr.contacts?.email ? { label: t('personPage.email'), value: pr.contacts.email, href: `mailto:${pr.contacts.email}` } : null,
      pr.contacts?.telegram ? { label: t('personPage.telegram'), value: pr.contacts.telegram, href: `https://t.me/${pr.contacts.telegram.replace(/^@/, '')}` } : null,
    ].filter((x): x is { label: string; value: string; href: string } => Boolean(x)),
    documents,
    faq: pr.faq,
    messageHref,
  };

  const sections = (
    [
      ['overview', true],
      ['services', pr.services.length > 0],
      ['portfolio', pr.portfolio.length > 0],
      ['experience', true],
      ['academy', true],
      ['projects', true],
      ['publications', true],
      ['documents', true],
      ['contacts', true],
    ] as const
  ).filter(([, show]) => show);
  const nav = sections.map(([id]) => ({ id, label: t(`personPage.nav.${id}`) }));
  const hasContacts = Boolean(pr.contacts && (pr.contacts.email || pr.contacts.phone || pr.contacts.telegram));

  return (
    <div className="pub pub-page cp pp">
      <div className="pub-wrap">
        <Breadcrumb
          items={[
            { id: 'home', label: t('publicNav.0'), href: '/' },
            { id: 'people', label: t('publicNav.5'), href: '/people' },
            { id: 'self', label: person.displayName },
          ]}
        />
      </div>

      <div className="pub-wrap">
        <header className="cp-hero">
          <div className="cp-cover" aria-hidden="true">
            {cover ? <MediaFrame media={cover} ratio="fill" radius="none" loading="eager" sizes="(max-width: 767px) 100vw, 1480px" /> : <div className="cp-cover__pattern" />}
          </div>
          <div className="cp-identity pp-identity">
            <div className="cp-identity__mark pp-identity__portrait">
              <PersonAvatar name={person.displayName} portrait={person.portrait} size={96} />
            </div>
            <div className="cp-identity__text">
              {person.signals.length ? (
                <p className="pp-signals">
                  {person.signals.map((s) => (
                    <SignalBadge key={s.kind} scope="person" signal={s} />
                  ))}
                </p>
              ) : null}
              <h1 className="cp-name cp-name--mark" tabIndex={-1}>
                {person.displayName}
                {pr.accreditation ? <SRMark accreditation={pr.accreditation} size="lg" /> : null}
              </h1>
              <p className="cp-tagline">{person.headline ? typo(person.headline) : person.roleLine}</p>
              <ul className="cp-meta">
                <li>
                  {person.employer ? (
                    <>
                      <CompanyMark name={person.employer.name} seed={person.employer.href} size={18} />
                      <span>
                        {person.roleLine.split(',')[0]} · <NextLink href={person.employer.href} className="pp-inline-link">{person.employer.name}</NextLink>
                      </span>
                    </>
                  ) : (
                    <>
                      <UserRound size={14} strokeWidth={2} aria-hidden="true" />
                      {person.roleLine}
                    </>
                  )}
                </li>
                <li>
                  <MapPin size={14} strokeWidth={2} aria-hidden="true" />
                  {geography.join(', ')}
                </li>
                {pr.since ? (
                  <li>
                    <Clock size={14} strokeWidth={2} aria-hidden="true" />
                    {t('personPage.since', { year: pr.since })}
                  </li>
                ) : null}
              </ul>
            </div>
            <div className="cp-identity__actions">
              {isMe ? (
                <ButtonLink href={hrefFor(principal, '/app/me')} variant="secondary">
                  {t('personPage.edit')}
                </ButtonLink>
              ) : (
                <>
                  <NextLink href={messageHref} className="pub-btn pub-btn--dark">
                    <Send size={16} strokeWidth={2} aria-hidden="true" />
                    {t('personPage.write')}
                  </NextLink>
                  {person.independent ? (
                    <NextLink href={inviteHref} className="pub-btn">
                      {t('personPage.invite')}
                    </NextLink>
                  ) : null}
                </>
              )}
              <AgentTrigger kind="person" className="pub-btn cp-ask">
                <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
                {t('personPage.askAgent')}
              </AgentTrigger>
            </div>
          </div>
        </header>

        <dl className="ev-facts-grid co-facts cp-facts">
          <div>
            <dt>{t('personPage.factProjects')}</dt>
            <dd>{person.projectsCount}</dd>
          </div>
          <div>
            <dt>{t('personPage.factPublications')}</dt>
            <dd>{person.publicationsCount}</dd>
          </div>
          <div>
            <dt>{t('personPage.factWorks')}</dt>
            <dd>{pr.portfolio.length}</dd>
          </div>
          <div>
            <dt>{t('personPage.factServices')}</dt>
            <dd>{pr.services.length}</dd>
          </div>
          <div>
            <dt>{t('personPage.factYears')}</dt>
            <dd>{years !== null ? t('people.yearsCount', { count: Math.max(1, years) }) : '—'}</dd>
          </div>
        </dl>

        <SectionNav items={nav} label={person.displayName} />

        <div className="pub-feed cp-body">
          <div className="cp-main">
            <section className="cp-section" id="overview" aria-labelledby="overview-title">
              <h2 className="pub-h2 cp-section__title" id="overview-title">
                {t('personPage.aboutTitle')}
              </h2>
              <div className="cp-about">
                {(pr.about ?? person.experience).split(/\n\n+/).map((para, i) => (
                  <p key={i} className={i === 0 ? 'cp-about__lead' : undefined}>
                    {typo(para)}
                  </p>
                ))}
                <p className="cp-section__note">{t('personPage.selfDescribed')}</p>
              </div>
              <dl className="cp-dl">
                <div>
                  <dt>{t('personPage.expertiseTitle')}</dt>
                  <dd className="co-row__tags">
                    {person.expertise.map((e) => (
                      <NextLink key={e} href={`/people?spec=${encodeURIComponent(e)}`} className="co-tag">
                        {e}
                      </NextLink>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt>{t('personPage.topicsTitle')}</dt>
                  <dd className="co-row__tags">
                    {person.topics.map((tp) => (
                      <NextLink key={tp} href={`/people?topic=${tp}`} className="co-tag">
                        {topicLabel(tp)}
                      </NextLink>
                    ))}
                  </dd>
                </div>
                {person.field ? (
                  <div>
                    <dt>{t('people.fieldLabel')}</dt>
                    <dd>
                      <NextLink href={`/people?field=${person.field}`} className="co-tag">
                        {t(`people.fields.${person.field}`)}
                      </NextLink>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {person.signals.length ? (
                <div className="pp-status-list">
                  {person.signals.map((s) => (
                    <div key={s.kind} className="pp-status">
                      <SignalBadge scope="person" signal={s} />
                      {s.note ? <span className="pp-status__note">{typo(s.note)}</span> : null}
                    </div>
                  ))}
                  <p className="cp-section__note">{t('signals.declared')}</p>
                </div>
              ) : null}
              {pr.faq.length ? (
                <div className="cp-faq">
                  <h3 className="cp-sub">{t('personPage.faqTitle')}</h3>
                  {pr.faq.map((f) => (
                    <details key={f.q} className="cp-faq__item">
                      <summary>{typo(f.q)}</summary>
                      <p>{typo(f.a)}</p>
                    </details>
                  ))}
                </div>
              ) : null}
            </section>

            {pr.services.length ? (
              <section className="cp-section" id="services" aria-labelledby="services-title">
                <div className="cp-section__head">
                  <h2 className="pub-h2 cp-section__title" id="services-title">
                    {t('personPage.servicesTitle')}
                  </h2>
                  <p className="cp-section__lede">{typo(t('personPage.servicesLede'))}</p>
                </div>
                <div className="cp-products">
                  {pr.services.map((s) => (
                    <article key={s.id} className="cp-product">
                      <span className="co-tag">{t(`personPage.serviceFormat.${s.format}`)}</span>
                      <h3 className="cp-product__name">{typo(s.name)}</h3>
                      {s.description ? <p className="cp-product__unit">{typo(s.description)}</p> : null}
                      <p className="cp-product__price">
                        {t('personPage.priceOnRequest')}
                        {s.unit ? ` · ${s.unit}` : ''}
                      </p>
                      <NextLink href={`${messageHref}&kind=request`} className="pub-more">
                        {t('personPage.request')}
                        <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                      </NextLink>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {pr.portfolio.length ? (
              <section className="cp-section" id="portfolio" aria-labelledby="portfolio-title">
                <div className="cp-section__head">
                  <h2 className="pub-h2 cp-section__title" id="portfolio-title">
                    {t('personPage.portfolioTitle')}
                  </h2>
                  <p className="cp-section__lede">{typo(t('personPage.portfolioLede'))}</p>
                </div>
                <div className="pp-works">
                  {pr.portfolio.map((w) => (
                    <article key={w.id} className="pp-work">
                      <div className="pp-work__media" aria-hidden="true">
                        {w.cover ? <MediaFrame media={fixtureMedia(w.cover, 'project')} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 420px" /> : <div className="cp-cover__pattern" />}
                        <span className={w.projectHref ? 'pp-work__flag pp-work__flag--platform' : 'pp-work__flag'}>{w.projectHref ? t('personPage.onPlatform') : t('personPage.selfDeclared')}</span>
                      </div>
                      <div className="pp-work__body">
                        <span className="pub-kicker">
                          {w.kind}
                          {w.year ? ` · ${w.year}` : ''}
                        </span>
                        <h3 className="pp-work__title">{w.projectHref ? <NextLink href={w.projectHref}>{typo(w.title)}</NextLink> : typo(w.title)}</h3>
                        {w.description ? <p className="pp-work__desc">{typo(w.description)}</p> : null}
                        {w.projectHref ? (
                          <NextLink href={w.projectHref} className="pub-more">
                            {t('personPage.openProject')}
                            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                          </NextLink>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="cp-section" id="experience" aria-labelledby="experience-title">
              <h2 className="pub-h2 cp-section__title" id="experience-title">
                {t('personPage.experienceTitle')}
              </h2>
              {pr.career.length ? (
                <>
                  <h3 className="cp-sub">{t('personPage.careerTitle')}</h3>
                  <ol className="pp-career">
                    {pr.career.map((c) => (
                      <li key={c.id} className="pp-career__item">
                        <span className="pp-career__mark" aria-hidden="true">
                          {c.companyHref ? <CompanyMark name={c.company} seed={c.companyHref} size={40} /> : <Building2 size={18} strokeWidth={2} />}
                        </span>
                        <div className="pp-career__body">
                          <p className="pp-career__role">{typo(c.role)}</p>
                          <p className="pp-career__company">{c.companyHref ? <NextLink href={c.companyHref}>{c.company}</NextLink> : c.company}</p>
                          <p className="pp-career__years">
                            {c.from} — {c.to ?? t('personPage.present')}
                          </p>
                          {c.summary ? <p className="pp-career__summary">{typo(c.summary)}</p> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <div className="cp-empty">
                  <Building2 size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('personPage.experienceEmpty')}</p>
                </div>
              )}
              {pr.education.length ? (
                <>
                  <h3 className="cp-sub">{t('personPage.educationTitle')}</h3>
                  <ul className="cp-certs">
                    {pr.education.map((e) => (
                      <li key={e.id} className="cp-cert">
                        <span className="cp-cert__text">
                          <span className="cp-cert__name">
                            <GraduationCap size={16} strokeWidth={2} aria-hidden="true" /> {typo(e.degree)}
                          </span>
                          <span className="cp-cert__meta">
                            {e.school}
                            {e.year ? ` · ${e.year}` : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>

            <section className="cp-section" id="academy" aria-labelledby="academy-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="academy-title">
                  {t('sr.sectionTitle')}
                </h2>
                <p className="cp-section__lede">{typo(t('sr.sectionLedePerson'))}</p>
              </div>
              <h3 className="cp-sub cp-sub--mark">
                <SRLogo size={14} /> {t('sr.platformGroup')}
              </h3>
              {pr.platformCertificates.length ? (
                <div className="sr-certs">
                  {pr.platformCertificates.map((c) => (
                    <article key={c.id} className="sr-cert">
                      <div className="sr-cert__head">
                        <span className="sr-cert__logo" aria-hidden="true">
                          <SRLogo size={18} tone="white" />
                        </span>
                        <span className="sr-cert__num">{t('sr.certNumber', { id: c.id })}</span>
                      </div>
                      <h4 className="sr-cert__title">{typo(c.course.title)}</h4>
                      <p className="sr-cert__summary">{typo(c.course.summary)}</p>
                      <p className="sr-cert__meta">
                        <span>{t('sr.certIssued', { date: shortDate(c.issuedAt) })}</span>
                        {c.score !== null ? <span>{t('sr.certScore', { score: c.score })}</span> : null}
                        <span>{t('sr.certModules', { count: c.course.modules })}</span>
                      </p>
                      <NextLink href={`/certificates/${c.id}`} className="pub-more">
                        <BadgeCheck size={16} strokeWidth={2} aria-hidden="true" />
                        {t('sr.certVerify')}
                      </NextLink>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="cp-section__note">{t('sr.platformEmpty')}</p>
              )}
              <h3 className="cp-sub">{t('sr.externalGroup')}</h3>
              {pr.certificates.length ? (
                <ul className="cp-certs">
                  {pr.certificates.map((c) => (
                    <li key={c.id} className="cp-cert">
                      <span className="cp-cert__text">
                        <span className="cp-cert__name">
                          <span className="co-tag cp-cert__kind">{t(`sr.certKind.${c.kind}`)}</span> {typo(c.name)}
                        </span>
                        <span className="cp-cert__meta">
                          {t('sr.issuer')}: {c.issuer}
                          {c.number ? ` · ${t('sr.number', { number: c.number })}` : ''}
                          {' · '}
                          {c.validUntil ? t('companyPage.validUntil', { date: shortDate(c.validUntil) }) : t('companyPage.noExpiry')}
                        </span>
                      </span>
                      <EvidenceChip state={c.evidence} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cp-section__note">{t('sr.externalEmpty')}</p>
              )}
            </section>

            <section className="cp-section" id="projects" aria-labelledby="projects-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="projects-title">
                  {t('personPage.projectsTitle')}
                </h2>
                <p className="cp-section__lede">{t('personPage.projectsLede')}</p>
              </div>
              {person.projects.length ? (
                <div className="cp-projects">
                  {person.projects.map((p) => {
                    const role = p.publicParticipants.find((pp) => pp.href === person.href)?.roleTitle;
                    return (
                      <article key={p.id} className="cp-project">
                        <NextLink href={p.href} className="cp-project__media" aria-hidden="true" tabIndex={-1}>
                          <MediaFrame media={projectCover(p.handle)} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 420px" />
                        </NextLink>
                        <div className="cp-project__body">
                          <p className="co-row__tags">
                            <ProjectStatusChip status={p.status} size="sm" />
                            <span className="cp-project__region">{regionLabel(p.region)}</span>
                          </p>
                          <h3 className="cp-project__title">
                            <NextLink href={p.href}>{typo(p.name)}</NextLink>
                          </h3>
                          {p.summary ? <p className="cp-project__summary">{typo(p.summary)}</p> : null}
                          {role ? <p className="cp-project__role">{t('personPage.roleInProject', { role })}</p> : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="cp-empty">
                  <FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('personPage.projectsEmpty')}</p>
                </div>
              )}
            </section>

            <section className="cp-section" id="publications" aria-labelledby="publications-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="publications-title">
                  {t('personPage.publicationsTitle')}
                </h2>
                <p className="cp-section__lede">{t('personPage.publicationsLede')}</p>
              </div>
              {person.publications.length ? (
                <ul className="cp-articles">
                  {person.publications.map((card) => (
                    <li key={card.id} className="cp-article">
                      <NextLink href={card.href} className="cp-article__media" aria-hidden="true" tabIndex={-1}>
                        <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 112px, 200px" />
                      </NextLink>
                      <div className="cp-article__body">
                        <span className="pub-kicker">
                          {formatLabel(card)}
                          {card.topics[0] ? ` · ${topicLabel(card.topics[0])}` : ''}
                        </span>
                        <h3 className="cp-article__title">
                          <NextLink href={card.href}>{typo(card.title)}</NextLink>
                        </h3>
                        <p className="cp-article__lede">{typo(card.lede)}</p>
                        <p className="cp-article__meta">
                          {longDate(card.publishedAt)}
                          {card.readMinutes ? ` · ${t('companyPage.readTime', { minutes: card.readMinutes })}` : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="cp-empty">
                  <FileText size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('personPage.publicationsEmpty')}</p>
                  {isMe ? (
                    <NextLink href={hrefFor(principal, '/app/publications')} className="pub-more">
                      {t('people.writeArticle')}
                      <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                    </NextLink>
                  ) : null}
                </div>
              )}
              {person.mentions.length ? (
                <>
                  <h3 className="cp-sub">{t('personPage.mentionsTitle')}</h3>
                  <ul className="srch-list">
                    {person.mentions.map((card) => (
                      <li key={card.id} className="srch-row">
                        <span className="srch-row__thumb" aria-hidden="true">
                          <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="96px" />
                        </span>
                        <span className="srch-row__body">
                          <span className="pub-kicker">
                            {formatLabel(card)} · {card.authorLabel}
                          </span>
                          <NextLink href={card.href} className="srch-row__title">
                            {typo(card.title)}
                          </NextLink>
                          <span className="srch-row__meta">{longDate(card.publishedAt)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>

            <section className="cp-section" id="documents" aria-labelledby="documents-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="documents-title">
                  {t('personPage.documentsTitle')}
                </h2>
                <p className="cp-section__lede">{t('personPage.documentsLede')}</p>
              </div>
              <div className={pr.accreditation ? 'sr-accred' : 'sr-accred sr-accred--none'}>
                <span className="sr-accred__logo" aria-hidden="true">
                  <SRLogo size={20} tone={pr.accreditation ? 'white' : 'brand'} />
                </span>
                <div>
                  <p className="sr-accred__title">{pr.accreditation ? t('sr.mark') : t('sr.accreditationNone')}</p>
                  {pr.accreditation ? (
                    <p className="sr-accred__meta">
                      {t('sr.accreditationScope')}: {pr.accreditation.scope.join(', ').toLowerCase()} · {t('sr.accreditationDate')}: {shortDate(pr.accreditation.verifiedAt)}
                    </p>
                  ) : (
                    <NextLink href="/#about" className="pub-more">
                      {t('sr.howToGet')}
                      <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                    </NextLink>
                  )}
                </div>
              </div>
              <div className="cp-docs">
                {documents
                  .filter((d) => !d.startsWith(t('sr.mark')) && !d.startsWith(t('sr.certTitle')))
                  .map((d, i) => (
                    <div key={i} className="cp-doc">
                      {i === 0 ? (
                        <ShieldCheck size={18} strokeWidth={2} aria-hidden="true" />
                      ) : i === documents.length - 1 ? (
                        <Building2 size={18} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <FileCheck2 size={18} strokeWidth={2} aria-hidden="true" />
                      )}
                      <div>
                        <p className="cp-doc__value">{d}</p>
                      </div>
                    </div>
                  ))}
              </div>
              <NextLink href="/#about" className="pub-more">
                {t('companyPage.howStatuses')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>

            <section className="cp-section" id="contacts" aria-labelledby="contacts-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="contacts-title">
                  {t('personPage.contactsTitle')}
                </h2>
                <p className="cp-section__lede">{t('personPage.contactsLede')}</p>
              </div>
              {hasContacts ? (
                <dl className="cp-contacts">
                  {pr.contacts?.phone ? (
                    <div>
                      <dt>
                        <Phone size={16} strokeWidth={2} aria-hidden="true" />
                        {t('personPage.phone')}
                      </dt>
                      <dd>
                        <a href={`tel:${pr.contacts.phone.replace(/[^\d+]/g, '')}`}>{pr.contacts.phone}</a>
                      </dd>
                    </div>
                  ) : null}
                  {pr.contacts?.email ? (
                    <div>
                      <dt>
                        <Mail size={16} strokeWidth={2} aria-hidden="true" />
                        {t('personPage.email')}
                      </dt>
                      <dd>
                        <a href={`mailto:${pr.contacts.email}`}>{pr.contacts.email}</a>
                      </dd>
                    </div>
                  ) : null}
                  {pr.contacts?.telegram ? (
                    <div>
                      <dt>
                        <MessageSquareText size={16} strokeWidth={2} aria-hidden="true" />
                        {t('personPage.telegram')}
                      </dt>
                      <dd>
                        <a href={`https://t.me/${pr.contacts.telegram.replace(/^@/, '')}`} target="_blank" rel="noopener noreferrer">
                          {pr.contacts.telegram}
                        </a>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <div className="cp-empty">
                  <MessageSquareText size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('personPage.contactsEmpty')}</p>
                </div>
              )}
              <div className="pub-actions cp-contacts__actions">
                <NextLink href={messageHref} className="pub-btn pub-btn--dark">
                  <Send size={16} strokeWidth={2} aria-hidden="true" />
                  {t('personPage.write')}
                </NextLink>
                <AgentTrigger kind="person" className="pub-btn cp-ask">
                  <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
                  {t('personPage.askAgent')}
                </AgentTrigger>
              </div>
            </section>
          </div>

          <aside className="pub-aside cp-aside">
            <section className="pub-note cp-rep" aria-labelledby="rep-title">
              <div className="cp-rep__head">
                <span className="cp-rep__icon" aria-hidden="true">
                  <Sparkles size={18} strokeWidth={2} />
                </span>
                <h2 className="pub-note__title" id="rep-title">
                  {t('personPage.agentTitle', { name: person.displayName.split(' ')[0] ?? person.displayName })}
                </h2>
              </div>
              <p className="pub-note__body">{typo(t('personPage.agentStatus'))}</p>
              <div className="cp-rep__chips">
                {[0, 3, 1, 5].map((i) => (
                  <AgentTrigger kind="person" key={i} className="cp-rep__q" question={t(`personPage.agentQuestions.${i}` as 'personPage.agentQuestions.0')}>
                    {t(`personPage.agentQuestions.${i}` as 'personPage.agentQuestions.0')}
                    <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                  </AgentTrigger>
                ))}
              </div>
              <AgentTrigger kind="person" className="pub-btn pub-btn--dark cp-rep__open">{t('personPage.askAgent')}</AgentTrigger>
            </section>
            <section className="pub-note" aria-labelledby="share-title">
              <h2 className="pub-note__title" id="share-title">
                {t('events.share')}
              </h2>
              <ShareRow path={person.href} title={person.displayName} />
            </section>
            {similar.length ? (
              <section className="pub-note" aria-labelledby="similar-title">
                <h2 className="pub-note__title" id="similar-title">
                  {t('personPage.similarTitle')}
                </h2>
                <ul className="cp-similar">
                  {similar.map((p) => (
                    <li key={p.id}>
                      <NextLink href={p.href} className="cp-similar__item">
                        <PersonAvatar name={p.displayName} portrait={p.portrait} size={36} />
                        <span className="cp-similar__text">
                          <span className="cp-similar__name">{p.displayName}</span>
                          <span className="cp-similar__meta">{p.roleLine}</span>
                        </span>
                      </NextLink>
                    </li>
                  ))}
                </ul>
                <NextLink href={`/people?field=${person.field}`} className="pub-more">
                  {t('personPage.similarAll')}
                  <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </section>
            ) : null}
            <section className="pub-note" aria-labelledby="consent-title">
              <h2 className="pub-note__title" id="consent-title">
                {t('people.aboutProfileTitle')}
              </h2>
              <p className="pub-note__body">{typo(t('people.consentNote'))}</p>
            </section>
            {!isMe ? (
              <section className="pub-note pub-note--tint" aria-labelledby="isyou-title">
                <h2 className="pub-note__title" id="isyou-title">
                  {t('personPage.isYou')}
                </h2>
                <p className="pub-note__body">{typo(t('personPage.isYouBody'))}</p>
                <NextLink href={`/login?next=${encodeURIComponent('/app/me')}`} className="pub-btn">
                  {t('personPage.edit')}
                </NextLink>
              </section>
            ) : null}
            <section className="pub-note" aria-labelledby="report-title">
              <h2 className="pub-note__title" id="report-title">
                {t('publicPages.reportIssue')}
              </h2>
              <NextLink href="/#help" className="pub-more">
                {t('personPage.reportIssue')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
          </aside>
        </div>
      </div>

      <AgentTrigger kind="person" className="cp-fab">
        <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
        <span>{t('personPage.agentShort')}</span>
      </AgentTrigger>
      <PersonAssistant brief={brief} />
      <span hidden>
        <Wrench size={1} />
      </span>
    </div>
  );
}
