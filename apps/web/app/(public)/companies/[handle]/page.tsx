import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, ArrowUpRight, Briefcase, Building2, ChevronDown, Clock, FileCheck2, FileText, FolderOpen, Globe, Mail, MapPin, MessageSquareText, Package, Phone, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { Breadcrumb, ButtonLink, KindBadge, MediaFrame } from '@/components/ui';
import { CompanyAssistant, type CompanyBrief } from '@/components/public/agent/company';
import { AgentTrigger } from '@/components/public/agent/PublicAssistant';
import { CompanyMark } from '@/components/public/CompanyMark';
import { SignalBadge, signalLabel } from '@/components/public/SignalBadge';
import { SRLogo, SRMark } from '@/components/public/SRMark';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { SectionNav } from '@/components/public/SectionNav';
import { ShareRow } from '@/components/public/ShareRow';
import { CompanyStatusChip, EvidenceChip, ProjectStatusChip, formatLabel, regionLabel, topicLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import type { CompanyUpdate } from '@/app/_lib/data/types';
import { projectCover, storyCover } from '@/app/_lib/media';
import { getPrincipal, hrefFor, type PageSearchParams } from '@/app/_lib/principal';
import { formatMoney, longDate, shortDate, t } from '@/app/_lib/i18n';
import { currencyCode, identifierLabel } from '@/app/_lib/country';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ handle: string }>; searchParams: PageSearchParams };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primeLocale();
  const { handle } = await params;
  const company = await data.getCompany(handle);
  return { title: company ? company.name : t('error.notFoundTitle'), description: company?.profile.tagline ?? company?.description ?? undefined };
}

const UPDATE_ICON = { news: FileText, project: FolderOpen, catalogue: Package, certificate: FileCheck2, team: Users } as const;

/**
 * Company profile: cover and identity, honest fact strip, sticky section navigation, long-scroll sections
 * (overview with FAQ, products and services from the public catalogue, projects, team, news and publications,
 * vacancies, documents and confirmations, contacts), sticky aside (representative, share, similar companies,
 * claim, report). The representative is a demo dialog grounded in this page's public data only. No ratings.
 */
export default async function CompanyPage({ params, searchParams }: Params) {
  await primeLocale();
  const { handle } = await params;
  const company = await data.getCompany(handle);
  if (!company) notFound();
  const principal = await getPrincipal(searchParams);
  const isMember = principal.kind === 'person' && principal.company?.id === company.id;
  const profile = company.profile;
  const catalogue = company.catalogue;
  const quoteHref = `/login?next=${encodeURIComponent(`/app/rfq/new?company=${company.handle}`)}`;
  const statusHint = t(`companies.statusHint${company.status.charAt(0).toUpperCase()}${company.status.slice(1)}` as 'companies.statusHintSourced');
  const sourceLine = company.provenance
    ? t('companies.sourceLine', { source: company.provenance.source, date: shortDate(company.provenance.observedAt) })
    : company.claimedAt
      ? t('companies.claimedLine', { date: longDate(company.claimedAt) })
      : null;
  const identifierLine = company.evidence.identifier ? `${identifierLabel(company.evidence.identifier.kind)} · ${t(`status.${company.evidence.identifier.status}`)}` : t('companies.evIdentifierNone');
  const domainLine = company.evidence.domainVerified ? t('companies.evDomainYes') : t('companies.evDomainNo');
  const coverProject = company.projects[0];

  const updates: CompanyUpdate[] = [
    ...profile.updates,
    ...company.publications.map((p) => ({ id: `pub-${p.id}`, date: p.publishedAt.slice(0, 10), kind: 'news' as const, title: p.title, href: p.href })),
    ...(catalogue && !profile.updates.some((u) => u.kind === 'catalogue')
      ? [{ id: 'cat', date: catalogue.publishedAt.slice(0, 10), kind: 'catalogue' as const, title: t('companyPage.catalogueVersion', { version: catalogue.version, date: shortDate(catalogue.publishedAt) }), href: null }]
      : []),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const similar = (await data.listCompanies())
    .filter((c) => c.id !== company.id)
    .map((c) => ({ c, score: c.kinds.filter((k) => company.kinds.includes(k)).length * 2 + (c.region === company.region ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.c);

  const salary = (from: string | null, to: string | null) =>
    from && to
      ? t('companyPage.salaryRange', { from: formatMoney(from, currencyCode()), to: formatMoney(to, currencyCode()) })
      : from
        ? t('companyPage.salaryFrom', { amount: formatMoney(from, currencyCode()) })
        : t('companyPage.salaryHidden');
  const brief: CompanyBrief = {
    name: company.name,
    handle: company.handle,
    description: company.description,
    roles: company.kinds.map((k) => t(`companies.kindOne.${k}`)),
    directions: company.directions,
    region: regionLabel(company.region),
    geography: profile.geography,
    statusLabel: t(`status.${company.status}`),
    statusHint,
    identifier: identifierLine,
    domain: domainLine,
    certificates: [
      ...(profile.accreditation ? [{ name: `${t('sr.mark')} · ${shortDate(profile.accreditation.verifiedAt)}`, evidence: profile.accreditation.scope.join(', ') }] : []),
      ...profile.certificates.map((c) => ({ name: c.name, evidence: t(`evidence.${c.evidence}`) })),
    ],
    signals: profile.signals.map((s) => `${signalLabel('company', s.kind)}${s.until ? ` · ${t('signals.until', { date: shortDate(s.until) })}` : ''}${s.note ? ` — ${s.note}` : ''}`),
    projects: company.projects.map((p) => ({ name: p.name, status: t(`projectStatus.${p.status}`), href: p.href, summary: p.summary })),
    catalogue: catalogue
      ? {
          version: t('companyPage.catalogueVersion', { version: catalogue.version, date: shortDate(catalogue.publishedAt) }),
          entries: catalogue.entries.map((e) => ({ name: e.name, kind: t(`kind.${e.kind}`), unit: t(`unitLabel.${e.unit as 't' | 'm2' | 'm3' | 'pcs' | 'set'}`) })),
        }
      : null,
    people: company.people.map((p) => ({ name: p.displayName, role: p.roleLine, href: p.href })),
    contacts: [
      profile.contacts?.phone ? { label: t('companyPage.phone'), value: profile.contacts.phone, href: `tel:${profile.contacts.phone.replace(/[^\d+]/g, '')}` } : null,
      profile.contacts?.email ? { label: t('companyPage.email'), value: profile.contacts.email, href: `mailto:${profile.contacts.email}` } : null,
      company.website ? { label: t('companyPage.site'), value: t('companyPage.siteOpen'), href: company.website } : null,
      profile.contacts?.address ? { label: t('companyPage.address'), value: profile.contacts.address, href: `https://www.openstreetmap.org/search?query=${encodeURIComponent(profile.contacts.address)}` } : null,
      profile.contacts?.hours ? { label: t('companyPage.hours'), value: profile.contacts.hours, href: null } : null,
    ].filter((x): x is { label: string; value: string; href: string | null } => Boolean(x)),
    vacancies: profile.vacancies.map((v) => ({ title: v.title, location: v.location, salary: salary(v.salaryFromMinorUnits, v.salaryToMinorUnits), href: `/login?next=${encodeURIComponent(`/app/jobs/${v.id}`)}` })),
    updates: updates.slice(0, 5).map((u) => ({ date: shortDate(u.date), title: u.title, href: u.href })),
    faq: profile.faq,
    quoteHref,
    website: company.website,
  };

  const nav = (['overview', 'products', 'projects', 'team', 'updates', 'vacancies', 'certificates', 'documents', 'contacts'] as const).map((id) => ({ id, label: t(`companyPage.nav.${id}`) }));

  return (
    <div className="pub pub-page cp">
      <div className="pub-wrap">
        <Breadcrumb
          items={[
            { id: 'home', label: t('publicNav.0'), href: '/' },
            { id: 'companies', label: t('publicNav.4'), href: '/companies' },
            { id: 'self', label: company.name },
          ]}
        />
      </div>

      <div className="pub-wrap">
        <header className="cp-hero">
          <div className="cp-cover" aria-hidden="true">
            {coverProject ? <MediaFrame media={projectCover(coverProject.handle)} ratio="fill" radius="none" loading="eager" sizes="(max-width: 767px) 100vw, 1480px" /> : <div className="cp-cover__pattern" />}
          </div>
          <div className="cp-identity">
            <div className="cp-identity__mark">
              <CompanyMark name={company.name} seed={company.handle} size={96} />
            </div>
            <div className="cp-identity__text">
              <p className="co-row__tags">
                <span title={statusHint}>
                  <CompanyStatusChip status={company.status} />
                </span>
                {company.kinds.map((k) => (
                  <NextLink key={k} href={`/companies?kind=${k}`} className="co-tag">
                    {t(`companies.kindOne.${k}`)}
                  </NextLink>
                ))}
              </p>
              <h1 className="cp-name cp-name--mark" tabIndex={-1}>
                {company.name}
                {profile.accreditation ? <SRMark accreditation={profile.accreditation} size="lg" /> : null}
              </h1>
              <p className="cp-tagline">{profile.tagline ? typo(profile.tagline) : company.directions.join(' · ')}</p>
              {profile.signals.length ? (
                <p className="pp-signals">
                  {profile.signals.map((s) => (
                    <SignalBadge key={s.kind} scope="company" signal={s} />
                  ))}
                </p>
              ) : null}
              <ul className="cp-meta">
                <li>
                  <MapPin size={14} strokeWidth={2} aria-hidden="true" />
                  {regionLabel(company.region)}
                  {profile.geography.length > 1 ? ` +${profile.geography.length - 1}` : ''}
                </li>
                {profile.founded ? (
                  <li>
                    <Building2 size={14} strokeWidth={2} aria-hidden="true" />
                    {t('companyPage.founded', { year: profile.founded })}
                  </li>
                ) : null}
                {company.claimedAt ? (
                  <li>
                    <Clock size={14} strokeWidth={2} aria-hidden="true" />
                    {t('companyPage.onPlatform', { date: shortDate(company.claimedAt) })}
                  </li>
                ) : sourceLine ? (
                  <li>
                    <Clock size={14} strokeWidth={2} aria-hidden="true" />
                    {sourceLine}
                  </li>
                ) : null}
                {company.website ? (
                  <li>
                    <Globe size={14} strokeWidth={2} aria-hidden="true" />
                    <a href={company.website} target="_blank" rel="noopener noreferrer">
                      {t('companyPage.siteOpen')}
                    </a>
                  </li>
                ) : null}
              </ul>
            </div>
            <div className="cp-identity__actions">
              {isMember ? (
                <ButtonLink href={hrefFor(principal, '/app/company')} variant="secondary">
                  {t('companies.openInWorkspace')}
                </ButtonLink>
              ) : null}
              <NextLink href={quoteHref} className="pub-btn pub-btn--dark">
                {t('companyPage.requestQuote')}
              </NextLink>
              <AgentTrigger kind="company" className="pub-btn cp-ask">
                <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
                {t('companyPage.askRep')}
              </AgentTrigger>
            </div>
          </div>
        </header>

        <dl className="ev-facts-grid co-facts cp-facts">
          <div>
            <dt>{t('companies.factProjects')}</dt>
            <dd>{company.projectsCount}</dd>
          </div>
          <div>
            <dt>{t('companies.factPublications')}</dt>
            <dd>{company.publicationsCount}</dd>
          </div>
          <div>
            <dt>{t('companies.factCatalogue')}</dt>
            <dd>{company.evidence.catalogue ? t('companies.catalogueEntries', { count: company.evidence.catalogue.entries }) : t('companies.evCatalogueNone')}</dd>
          </div>
          <div>
            <dt>{t('companies.factTeam')}</dt>
            <dd>{company.evidence.publicMembers ? t('companies.evMembersCount', { count: company.evidence.publicMembers }) : t('companies.evMembersNone')}</dd>
          </div>
          <div>
            <dt>{t('companyPage.factVacancies')}</dt>
            <dd>{profile.vacancies.length}</dd>
          </div>
        </dl>

        <SectionNav items={nav} label={company.name} />

        <div className="pub-feed cp-body">
          <div className="cp-main">
            <section className="cp-section" id="overview" aria-labelledby="overview-title">
              <h2 className="pub-h2 cp-section__title" id="overview-title">
                {t('companyPage.aboutTitle')}
              </h2>
              <div className="cp-about">
                {(profile.about ?? company.description ?? t('companies.noDescription')).split(/\n\n+/).map((para, i) => (
                  <p key={i} className={i === 0 ? 'cp-about__lead' : undefined}>
                    {typo(para)}
                  </p>
                ))}
              </div>
              <dl className="cp-dl">
                <div>
                  <dt>{t('companies.directions')}</dt>
                  <dd className="co-row__tags">
                    {company.directions.map((d) => (
                      <NextLink key={d} href={`/companies?spec=${encodeURIComponent(d)}`} className="co-tag">
                        {d}
                      </NextLink>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt>{t('companyPage.geography')}</dt>
                  <dd>{(profile.geography.length ? profile.geography : [regionLabel(company.region)]).join(', ')}</dd>
                </div>
                <div>
                  <dt>{t('companies.roleLabel')}</dt>
                  <dd>{company.kinds.map((k) => t(`companies.kinds.${k}`)).join(', ')}</dd>
                </div>
              </dl>
              {profile.signals.length ? (
                <div className="pp-status-list">
                  <h3 className="cp-sub">{t('companyPage.signalsTitle')}</h3>
                  {profile.signals.map((s) => (
                    <div key={s.kind} className="pp-status">
                      <SignalBadge scope="company" signal={s} />
                      {s.note ? <span className="pp-status__note">{typo(s.note)}</span> : null}
                    </div>
                  ))}
                  <p className="cp-section__note">{t('signals.declared')}</p>
                </div>
              ) : null}
              {profile.faq.length ? (
                <div className="cp-faq">
                  <h3 className="cp-sub">{t('companyPage.faqTitle')}</h3>
                  {profile.faq.map((f) => (
                    <details key={f.q} className="cp-faq__item">
                      <summary>{typo(f.q)}</summary>
                      <p>{typo(f.a)}</p>
                    </details>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="cp-section" id="products" aria-labelledby="products-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="products-title">
                  {t('companyPage.productsTitle')}
                </h2>
                <p className="cp-section__lede">{typo(t('companyPage.productsLede'))}</p>
              </div>
              {catalogue && catalogue.entries.length ? (
                <>
                  <div className="cp-products">
                    {catalogue.entries.map((e) => (
                      <article key={e.id} className="cp-product">
                        <KindBadge kind={e.kind} size="sm" />
                        <h3 className="cp-product__name">{typo(e.name)}</h3>
                        <p className="cp-product__unit">
                          {t('company.catalogue.unit')}: {t(`unitLabel.${e.unit as 't' | 'm2' | 'm3' | 'pcs' | 'set'}`)}
                        </p>
                        <p className="cp-product__price">{e.priceOnRequest ? t('company.catalogue.priceOnRequest') : '—'}</p>
                        <NextLink href={quoteHref} className="pub-more">
                          {t('companyPage.askPrice')}
                          <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                        </NextLink>
                      </article>
                    ))}
                  </div>
                  <p className="cp-section__note">{t('companyPage.catalogueVersion', { version: catalogue.version, date: longDate(catalogue.publishedAt) })}</p>
                </>
              ) : (
                <div className="cp-empty">
                  <Package size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('companyPage.productsEmpty')}</p>
                  <NextLink href={quoteHref} className="pub-more">
                    {t('companyPage.requestQuote')}
                    <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                  </NextLink>
                </div>
              )}
            </section>

            <section className="cp-section" id="projects" aria-labelledby="projects-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="projects-title">
                  {t('companyPage.projectsTitle')}
                </h2>
                <p className="cp-section__lede">{t('companyPage.projectsLede')}</p>
              </div>
              {company.projects.length ? (
                <div className="cp-projects">
                  {company.projects.map((p) => {
                    const role = p.publicParticipants.find((pp) => pp.href === company.href)?.roleTitle;
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
                          {role ? <p className="cp-project__role">{t('companyPage.roleInProject', { role })}</p> : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="cp-empty">
                  <FolderOpen size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('companyPage.projectsEmpty')}</p>
                </div>
              )}
            </section>

            <section className="cp-section" id="team" aria-labelledby="team-title">
              <h2 className="pub-h2 cp-section__title" id="team-title">
                {t('companyPage.teamTitle')}
              </h2>
              {company.people.length ? (
                <div className="ev-speakers cp-team">
                  {company.people.map((person) => (
                    <NextLink key={person.id} href={person.href} className="ev-speaker">
                      <PersonAvatar name={person.displayName} portrait={person.portrait} size={64} />
                      <span className="ev-speaker__text">
                        <span className="ev-speaker__name">{person.displayName}</span>
                        <span className="ev-speaker__role">{person.roleLine}</span>
                      </span>
                    </NextLink>
                  ))}
                </div>
              ) : (
                <div className="cp-empty">
                  <Users size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('companyPage.teamEmpty')}</p>
                </div>
              )}
            </section>

            <section className="cp-section" id="updates" aria-labelledby="updates-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="updates-title">
                  {t('companyPage.publicationsTitle')}
                </h2>
                <p className="cp-section__lede">{t('companyPage.publicationsLede')}</p>
              </div>
              {company.publications.length ? (
                <ul className="cp-articles">
                  {company.publications.map((card) => (
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
                  <p>{t('companyPage.publicationsEmpty')}</p>
                  {isMember ? (
                    <NextLink href={hrefFor(principal, '/app/publications')} className="pub-more">
                      {t('companyPage.writeArticle')}
                      <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                    </NextLink>
                  ) : null}
                </div>
              )}
              {company.mentions.length ? (
                <>
                  <h3 className="cp-sub">{t('companyPage.mentionsTitle')}</h3>
                  <ul className="srch-list">
                    {company.mentions.map((card) => (
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
              {updates.length ? (
                <>
                  <h3 className="cp-sub">{t('companyPage.chronicleTitle')}</h3>
                  <ol className="cp-timeline">
                    {updates.map((u) => {
                      const Icon = UPDATE_ICON[u.kind];
                      return (
                        <li key={u.id} className="cp-tl">
                          <span className="cp-tl__icon" aria-hidden="true">
                            <Icon size={16} strokeWidth={2} />
                          </span>
                          <span className="cp-tl__body">
                            <span className="cp-tl__meta">
                              {shortDate(u.date)} · {t(`companyPage.updateKind.${u.kind}`)}
                            </span>
                            <span className="cp-tl__title">{u.href ? <NextLink href={u.href}>{typo(u.title)}</NextLink> : typo(u.title)}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </>
              ) : null}
            </section>

            <section className="cp-section" id="vacancies" aria-labelledby="vacancies-title">
              <h2 className="pub-h2 cp-section__title" id="vacancies-title">
                {t('companyPage.vacanciesTitle')}
              </h2>
              {profile.vacancies.length ? (
                <ul className="cp-vacancies">
                  {profile.vacancies.map((v) => (
                    <li key={v.id}>
                      <details className="cp-vacancy">
                        <summary className="cp-vacancy__summary">
                          <div className="cp-vacancy__body">
                            <h3 className="cp-vacancy__title">{typo(v.title)}</h3>
                            <p className="cp-vacancy__meta">
                              <span>
                                <MapPin size={13} strokeWidth={2} aria-hidden="true" />
                                {v.location}
                              </span>
                              <span>{t(`companyPage.vacancyFormat.${v.format}`)}</span>
                              <span>{t(`companyPage.employment.${v.employment}`)}</span>
                              <span className="cp-vacancy__posted">{t('companyPage.posted', { date: shortDate(v.postedAt) })}</span>
                            </p>
                          </div>
                          <div className="cp-vacancy__side">
                            <span className="cp-vacancy__salary">{salary(v.salaryFromMinorUnits, v.salaryToMinorUnits)}</span>
                            <span className="cp-vacancy__toggle">
                              {t('companyPage.vacDetails')}
                              <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
                            </span>
                          </div>
                        </summary>
                        <div className="cp-vacancy__details">
                          {v.description ? <p className="cp-vacancy__desc">{typo(v.description)}</p> : null}
                          <div className="cp-vacancy__cols">
                            {(
                              [
                                ['vacResponsibilities', v.responsibilities],
                                ['vacRequirements', v.requirements],
                                ['vacConditions', v.conditions],
                              ] as const
                            ).map(([key, list]) =>
                              list.length ? (
                                <div key={key}>
                                  <h4 className="cp-vacancy__col-title">{t(`companyPage.${key}`)}</h4>
                                  <ul className="cp-vacancy__list">
                                    {list.map((item) => (
                                      <li key={item}>{typo(item)}</li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null,
                            )}
                          </div>
                          <div className="pub-actions cp-vacancy__actions">
                            <NextLink href={`/login?next=${encodeURIComponent(`/app/jobs/${v.id}`)}`} className="pub-btn pub-btn--dark">
                              {t('companyPage.apply')}
                            </NextLink>
                            <AgentTrigger kind="company" className="pub-btn cp-ask" question={`${t('companyPage.vacAskAgent')}: ${v.title}`}>
                              <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
                              {t('companyPage.vacAskAgent')}
                            </AgentTrigger>
                          </div>
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="cp-empty">
                  <Briefcase size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('companyPage.vacanciesEmpty')}</p>
                </div>
              )}
            </section>

            <section className="cp-section" id="certificates" aria-labelledby="certificates-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="certificates-title">
                  {t('sr.sectionTitle')}
                </h2>
                <p className="cp-section__lede">{typo(t('sr.sectionLedeCompany'))}</p>
              </div>
              {profile.certificates.length ? (
                <ul className="cp-certs">
                  {profile.certificates.map((c) => (
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
                <div className="cp-empty">
                  <FileCheck2 size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('sr.certificatesEmpty')}</p>
                </div>
              )}
            </section>

            <section className="cp-section" id="documents" aria-labelledby="documents-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="documents-title">
                  {t('companyPage.documentsTitle')}
                </h2>
                <p className="cp-section__lede">{t('companyPage.documentsLede')}</p>
              </div>
              <div className={profile.accreditation ? 'sr-accred' : 'sr-accred sr-accred--none'}>
                <span className="sr-accred__logo" aria-hidden="true">
                  <SRLogo size={20} tone={profile.accreditation ? 'white' : 'brand'} />
                </span>
                <div>
                  <p className="sr-accred__title">{profile.accreditation ? t('sr.mark') : t('sr.accreditationNone')}</p>
                  {profile.accreditation ? (
                    <p className="sr-accred__meta">
                      {t('sr.accreditationScope')}: {profile.accreditation.scope.join(', ').toLowerCase()} · {t('sr.accreditationDate')}: {shortDate(profile.accreditation.verifiedAt)}
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
                <div className="cp-doc">
                  <ShieldCheck size={18} strokeWidth={2} aria-hidden="true" />
                  <div>
                    <p className="cp-doc__name">{t('companies.statusLabel')}</p>
                    <p className="cp-doc__value">
                      <CompanyStatusChip status={company.status} size="sm" /> <span>{statusHint}</span>
                    </p>
                  </div>
                </div>
                <div className="cp-doc">
                  <FileCheck2 size={18} strokeWidth={2} aria-hidden="true" />
                  <div>
                    <p className="cp-doc__name">{t('companyPage.identifier')}</p>
                    <p className="cp-doc__value">{identifierLine}</p>
                  </div>
                </div>
                <div className="cp-doc">
                  <Globe size={18} strokeWidth={2} aria-hidden="true" />
                  <div>
                    <p className="cp-doc__name">{t('companyPage.domain')}</p>
                    <p className="cp-doc__value">{domainLine}</p>
                  </div>
                </div>
              </div>
              <NextLink href="/#about" className="pub-more">
                {t('companyPage.howStatuses')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>

            <section className="cp-section" id="contacts" aria-labelledby="contacts-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="contacts-title">
                  {t('companyPage.contactsTitle')}
                </h2>
                <p className="cp-section__lede">{t('companyPage.contactsLede')}</p>
              </div>
              {profile.contacts || company.website ? (
                <dl className="cp-contacts">
                  {profile.contacts?.phone ? (
                    <div>
                      <dt>
                        <Phone size={16} strokeWidth={2} aria-hidden="true" />
                        {t('companyPage.phone')}
                      </dt>
                      <dd>
                        <a href={`tel:${profile.contacts.phone.replace(/[^\d+]/g, '')}`}>{profile.contacts.phone}</a>
                      </dd>
                    </div>
                  ) : null}
                  {profile.contacts?.email ? (
                    <div>
                      <dt>
                        <Mail size={16} strokeWidth={2} aria-hidden="true" />
                        {t('companyPage.email')}
                      </dt>
                      <dd>
                        <a href={`mailto:${profile.contacts.email}`}>{profile.contacts.email}</a>
                      </dd>
                    </div>
                  ) : null}
                  {company.website ? (
                    <div>
                      <dt>
                        <Globe size={16} strokeWidth={2} aria-hidden="true" />
                        {t('companyPage.site')}
                      </dt>
                      <dd>
                        <a href={company.website} target="_blank" rel="noopener noreferrer">
                          {t('companyPage.siteOpen')}
                        </a>
                      </dd>
                    </div>
                  ) : null}
                  {profile.contacts?.address ? (
                    <div>
                      <dt>
                        <MapPin size={16} strokeWidth={2} aria-hidden="true" />
                        {t('companyPage.address')}
                      </dt>
                      <dd>
                        {profile.contacts.address}
                        <br />
                        <a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(profile.contacts.address)}`} target="_blank" rel="noopener noreferrer" className="pub-more">
                          {t('companyPage.openMap')}
                          <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                        </a>
                      </dd>
                    </div>
                  ) : null}
                  {profile.contacts?.hours ? (
                    <div>
                      <dt>
                        <Clock size={16} strokeWidth={2} aria-hidden="true" />
                        {t('companyPage.hours')}
                      </dt>
                      <dd>{profile.contacts.hours}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <div className="cp-empty">
                  <MessageSquareText size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('companyPage.contactsEmpty')}</p>
                </div>
              )}
              <div className="pub-actions cp-contacts__actions">
                <NextLink href={quoteHref} className="pub-btn pub-btn--dark">
                  {t('companyPage.requestQuote')}
                </NextLink>
                <AgentTrigger kind="company" className="pub-btn cp-ask">
                  <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
                  {t('companyPage.askRep')}
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
                  {t('companyPage.repTitle')}
                </h2>
              </div>
              <p className="pub-note__body">{typo(t('companyPage.repLede'))}</p>
              <div className="cp-rep__chips">
                {[0, 1, 2, 3].map((i) => (
                  <AgentTrigger kind="company" key={i} className="cp-rep__q" question={t(`companyPage.repQuestions.${i}` as 'companyPage.repQuestions.0')}>
                    {t(`companyPage.repQuestions.${i}` as 'companyPage.repQuestions.0')}
                    <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                  </AgentTrigger>
                ))}
              </div>
              <AgentTrigger kind="company" className="pub-btn pub-btn--dark cp-rep__open">{t('companyPage.askRep')}</AgentTrigger>
            </section>
            <section className="pub-note" aria-labelledby="share-title">
              <h2 className="pub-note__title" id="share-title">
                {t('events.share')}
              </h2>
              <ShareRow path={company.href} title={company.name} />
            </section>
            {similar.length ? (
              <section className="pub-note" aria-labelledby="similar-title">
                <h2 className="pub-note__title" id="similar-title">
                  {t('companyPage.similarTitle')}
                </h2>
                <ul className="cp-similar">
                  {similar.map((c) => (
                    <li key={c.id}>
                      <NextLink href={c.href} className="cp-similar__item">
                        <CompanyMark name={c.name} seed={c.handle} size={36} />
                        <span className="cp-similar__text">
                          <span className="cp-similar__name">{c.name}</span>
                          <span className="cp-similar__meta">
                            {c.kinds.map((k) => t(`companies.kindOne.${k}`)).join(' · ')} · {regionLabel(c.region)}
                          </span>
                        </span>
                      </NextLink>
                    </li>
                  ))}
                </ul>
                <NextLink href={`/companies?kind=${company.kinds[0]}`} className="pub-more">
                  {t('companyPage.similarAll')}
                  <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </section>
            ) : null}
            <section className="pub-note" aria-labelledby="visible-title">
              <h2 className="pub-note__title" id="visible-title">
                {t('companies.whatVisible')}
              </h2>
              <p className="pub-note__body">{typo(t('companies.whatVisibleBody'))}</p>
            </section>
            {!isMember ? (
              <section className="pub-note pub-note--tint" aria-labelledby="claim-title">
                <h2 className="pub-note__title" id="claim-title">
                  {t('companies.claimTitle')}
                </h2>
                <p className="pub-note__body">{typo(t('companies.claimBody'))}</p>
                <NextLink href="/login?next=%2Fapp%2Fcompany" className="pub-btn">
                  {t('companies.claimAction')}
                </NextLink>
              </section>
            ) : null}
            <section className="pub-note" aria-labelledby="report-title">
              <h2 className="pub-note__title" id="report-title">
                {t('publicPages.reportIssue')}
              </h2>
              <NextLink href="/#help" className="pub-more">
                {t('companies.reportIssue')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
          </aside>
        </div>
      </div>

      <AgentTrigger kind="company" className="cp-fab">
        <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
        <span>{t('companyPage.askRepShort')}</span>
      </AgentTrigger>
      <CompanyAssistant brief={brief} />
    </div>
  );
}
