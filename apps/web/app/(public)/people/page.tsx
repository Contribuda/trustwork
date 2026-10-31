import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight, ArrowUpRight, Briefcase, ChevronRight, Compass, Eye, HardHat, Factory, FileText, FolderOpen, ListChecks, ShoppingCart, Truck, UserRound, Wrench, X } from 'lucide-react';
import { Button, ButtonLink, EmptyState, MediaFrame, TextField } from '@/components/ui';
import { CompanyMark } from '@/components/public/CompanyMark';
import { Dropdown } from '@/components/public/Dropdown';
import { FilterBar } from '@/components/public/FilterBar';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { SignalBadge } from '@/components/public/SignalBadge';
import { SRLogo, SRMark } from '@/components/public/SRMark';
import { formatLabel, regionLabel, topicLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import type { PersonCard, PersonField, PersonSignalKind, RegionKey, TopicKey } from '@/app/_lib/data/types';
import { projectCover, storyCover } from '@/app/_lib/media';
import { getPrincipal, hrefFor, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { regionCodes } from '@/app/_lib/country';
import { withBase } from '@/app/_lib/base-path';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('people.title'), description: t('people.lede') };
}

const FIELDS: PersonField[] = ['management', 'engineering', 'design', 'procurement', 'sales', 'production', 'construction', 'logistics', 'control', 'client'];
const FIELD_ICON = {
  management: Briefcase,
  engineering: Wrench,
  design: Compass,
  procurement: ShoppingCart,
  sales: UserRound,
  production: Factory,
  construction: HardHat,
  logistics: Truck,
  control: ListChecks,
  client: Eye,
} as const;
const SIGNALS: PersonSignalKind[] = ['openToWork', 'openToProjects', 'hiring', 'lookingForPartners', 'consulting', 'busy'];
const REGIONS: RegionKey[] = regionCodes();
const TOPICS: TopicKey[] = ['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events'];
const SORTS = ['relevance', 'name', 'newest'] as const;
const PAGE = 8;

type Sort = (typeof SORTS)[number];
type Filters = {
  q?: string;
  field?: PersonField;
  signal?: PersonSignalKind;
  work?: 'company' | 'independent';
  region?: RegionKey;
  spec?: string;
  topic?: TopicKey;
  verified?: '1';
  cert?: '1';
  sort?: Sort;
  show?: number;
};
type Facet = 'field' | 'signal' | 'work' | 'region' | 'spec' | 'topic' | 'verified' | 'cert';

function href(f: Partial<Filters>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'show' && v === PAGE) && !(k === 'sort' && v === 'relevance')) params.set(k, String(v));
  const s = params.toString();
  return s ? `/people?${s}` : '/people';
}

function apply(list: PersonCard[], f: Filters, except?: Facet): PersonCard[] {
  const q = f.q?.trim().toLowerCase();
  return list.filter((p) => {
    if (except !== 'field' && f.field && p.field !== f.field) return false;
    if (except !== 'signal' && f.signal && !p.signals.some((s) => s.kind === f.signal)) return false;
    if (except !== 'work' && f.work && (f.work === 'independent') !== p.independent) return false;
    if (except !== 'region' && f.region && p.region !== f.region) return false;
    if (except !== 'spec' && f.spec && !p.expertise.includes(f.spec)) return false;
    if (except !== 'topic' && f.topic && !p.topics.includes(f.topic)) return false;
    if (except !== 'verified' && f.verified && !p.verified) return false;
    if (except !== 'cert' && f.cert && p.platformCertificatesCount === 0) return false;
    if (q) {
      const hay = [p.displayName, p.roleLine, p.headline ?? '', p.employer?.name ?? '', ...p.expertise, regionLabel(p.region), t(`people.fields.${p.field}`)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * People hub (editorial system): search, one filter bar (field, status, form of work, region, specialisation,
 * topics, sort) with counts, cards with portrait or initials, role, employer or «independent», self-declared
 * statuses, specialisation tags, facts; aside with shared interests; sections with specialists' articles,
 * interviews and projects where people meet. Portraits and employers appear only with the person's consent.
 */
export default async function PeoplePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const sp = await searchParams;
  const principal = await getPrincipal(searchParams);
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const filters: Filters = {
    q: str('q')?.slice(0, 80),
    field: FIELDS.find((x) => x === str('field')),
    signal: SIGNALS.find((x) => x === str('signal')),
    work: str('work') === 'company' || str('work') === 'independent' ? (str('work') as 'company' | 'independent') : undefined,
    region: REGIONS.find((x) => x === str('region')),
    spec: str('spec')?.slice(0, 80),
    topic: TOPICS.find((x) => x === str('topic')),
    verified: str('verified') === '1' ? '1' : undefined,
    cert: str('cert') === '1' ? '1' : undefined,
    sort: SORTS.find((x) => x === str('sort')) ?? 'relevance',
    show: Math.min(80, Math.max(PAGE, Number.parseInt(str('show') ?? '', 10) || PAGE)),
  };
  const all = await data.listPeople();
  const activity = (p: PersonCard) => p.projectsCount * 2 + p.publicationsCount + p.portfolioCount + p.servicesCount + p.signals.length;
  const sorters: Record<Sort, (a: PersonCard, b: PersonCard) => number> = {
    relevance: (a, b) => activity(b) - activity(a) || a.displayName.localeCompare(b.displayName, 'ru'),
    name: (a, b) => a.displayName.localeCompare(b.displayName, 'ru'),
    newest: (a, b) => all.indexOf(b) - all.indexOf(a),
  };
  const items = apply(all, filters).sort(sorters[filters.sort ?? 'relevance']);
  const shown = items.slice(0, filters.show);
  const count = (except: Facet, pred: (p: PersonCard) => boolean) => apply(all, filters, except).filter(pred).length;
  const specs = [...new Set(all.flatMap((p) => p.expertise))].sort((a, b) => a.localeCompare(b, 'ru'));
  const myId = principal.kind === 'person' ? principal.personId : null;

  const articles = await data.listArticles();
  const writing = articles.filter((c) => c.authorKind === 'person' && c.articleFormat !== 'interview').slice(0, 3);
  const talks = articles.filter((c) => c.articleFormat === 'interview').slice(0, 2);
  const meet = (await data.listPublicProjects())
    .filter((p) => p.publicParticipants.some((pp) => pp.href?.startsWith('/people/')))
    .slice(0, 1);
  const byHref = new Map(all.map((p) => [p.href, p]));

  const chips: Array<{ label: string; to: string }> = [];
  if (filters.q) chips.push({ label: `${t('events.searchPrefix')}: ${filters.q}`, to: href({ ...filters, q: undefined, show: undefined }) });
  if (filters.field) chips.push({ label: t(`people.fields.${filters.field}`), to: href({ ...filters, field: undefined, show: undefined }) });
  if (filters.signal) chips.push({ label: t(`signals.person.${filters.signal}`), to: href({ ...filters, signal: undefined, show: undefined }) });
  if (filters.work) chips.push({ label: filters.work === 'company' ? t('people.workCompany') : t('people.workIndependent'), to: href({ ...filters, work: undefined, show: undefined }) });
  if (filters.region) chips.push({ label: regionLabel(filters.region), to: href({ ...filters, region: undefined, show: undefined }) });
  if (filters.spec) chips.push({ label: filters.spec, to: href({ ...filters, spec: undefined, show: undefined }) });
  if (filters.topic) chips.push({ label: topicLabel(filters.topic), to: href({ ...filters, topic: undefined, show: undefined }) });
  if (filters.verified) chips.push({ label: t('sr.filter'), to: href({ ...filters, verified: undefined, show: undefined }) });
  if (filters.cert) chips.push({ label: t('sr.certFilter'), to: href({ ...filters, cert: undefined, show: undefined }) });
  const hidden = Object.entries(filters).filter(([k, v]) => k !== 'q' && k !== 'show' && v && !(k === 'sort' && v === 'relevance')) as Array<[string, string]>;

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('people.title'))}
            </h1>
            <p className="pub-lede">{typo(t('people.lede'))}</p>
          </div>
          <div className="pub-head__action">
            {principal.kind === 'person' ? (
              <ButtonLink href={hrefFor(principal, '/app/me')} variant="secondary">
                {t('people.myPage')}
              </ButtonLink>
            ) : (
              <ButtonLink href="/signup" variant="secondary">
                {t('people.createProfile')}
              </ButtonLink>
            )}
          </div>
        </header>

        <div className="pub-search">
          <form className="search-row" action={withBase('/people')} method="get" role="search" aria-label={t('publicPages.find')}>
            <TextField name="q" label={t('publicPages.find')} placeholder={t('people.searchPlaceholder')} inputMode="search" autoComplete="off" defaultValue={filters.q ?? ''} />
            <Button type="submit" variant="primary">
              {t('publicPages.find')}
            </Button>
            {hidden.map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          </form>
        </div>

        <FilterBar label={t('events.filtersTitle')}>
          <Dropdown
            label={t('people.fieldLabel')}
            value={filters.field ? t(`people.fields.${filters.field}`) : undefined}
            groups={[
              {
                items: [
                  { label: t('people.allFields'), n: count('field', () => true), active: !filters.field, to: href({ ...filters, field: undefined, show: undefined }) },
                  ...FIELDS.map((f) => ({
                    label: t(`people.fields.${f}`),
                    n: count('field', (p) => p.field === f),
                    active: filters.field === f,
                    to: href({ ...filters, field: filters.field === f ? undefined : f, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('people.statusLabel')}
            value={filters.signal ? t(`signals.person.${filters.signal}`) : undefined}
            groups={[
              {
                items: [
                  { label: t('signals.all'), n: count('signal', () => true), active: !filters.signal, to: href({ ...filters, signal: undefined, show: undefined }) },
                  ...SIGNALS.map((sg) => ({
                    label: t(`signals.person.${sg}`),
                    n: count('signal', (p) => p.signals.some((x) => x.kind === sg)),
                    active: filters.signal === sg,
                    to: href({ ...filters, signal: filters.signal === sg ? undefined : sg, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('people.workLabel')}
            value={filters.work ? (filters.work === 'company' ? t('people.workCompany') : t('people.workIndependent')) : undefined}
            groups={[
              {
                items: [
                  { label: t('people.workAny'), n: count('work', () => true), active: !filters.work, to: href({ ...filters, work: undefined, show: undefined }) },
                  {
                    label: t('people.workCompany'),
                    n: count('work', (p) => !p.independent),
                    active: filters.work === 'company',
                    to: href({ ...filters, work: filters.work === 'company' ? undefined : 'company', show: undefined }),
                  },
                  {
                    label: t('people.workIndependent'),
                    n: count('work', (p) => p.independent),
                    active: filters.work === 'independent',
                    to: href({ ...filters, work: filters.work === 'independent' ? undefined : 'independent', show: undefined }),
                  },
                ],
              },
            ]}
          />
          <Dropdown
            label={t('people.regionLabel')}
            value={filters.region ? regionLabel(filters.region) : undefined}
            groups={[
              {
                items: [
                  { label: t('people.allRegions'), n: count('region', () => true), active: !filters.region, to: href({ ...filters, region: undefined, show: undefined }) },
                  ...REGIONS.map((r) => ({
                    label: regionLabel(r),
                    n: count('region', (p) => p.region === r),
                    active: filters.region === r,
                    to: href({ ...filters, region: filters.region === r ? undefined : r, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('people.specLabel')}
            value={filters.spec}
            groups={[
              {
                items: [
                  { label: t('people.allSpecs'), n: count('spec', () => true), active: !filters.spec, to: href({ ...filters, spec: undefined, show: undefined }) },
                  ...specs
                    .map((s) => ({ label: s, n: count('spec', (p) => p.expertise.includes(s)), active: filters.spec === s, to: href({ ...filters, spec: filters.spec === s ? undefined : s, show: undefined }) }))
                    .filter((it) => it.n > 0 || it.active),
                ],
              },
            ]}
          />
          <NextLink href={href({ ...filters, verified: filters.verified ? undefined : '1', show: undefined })} className="sr-toggle" {...(filters.verified ? { 'aria-current': 'true' as const } : {})} scroll={false}>
            <span className="srm__tile">
              <SRLogo size={11} tone="white" />
            </span>
            {t('sr.filter')}
            <span className="pub-chip__n">{count('verified', (p) => p.verified)}</span>
          </NextLink>
          <NextLink href={href({ ...filters, cert: filters.cert ? undefined : '1', show: undefined })} className="sr-toggle sr-toggle--cert" {...(filters.cert ? { 'aria-current': 'true' as const } : {})} scroll={false}>
            {t('sr.certFilter')}
            <span className="pub-chip__n">{count('cert', (p) => p.platformCertificatesCount > 0)}</span>
          </NextLink>
          <span className="ev-filters__spacer" aria-hidden="true" />
          <Dropdown
            label={t('people.sortLabel')}
            value={filters.sort && filters.sort !== 'relevance' ? t(`people.sort${filters.sort.charAt(0).toUpperCase()}${filters.sort.slice(1)}` as 'people.sortName') : undefined}
            groups={[
              {
                items: SORTS.map((x) => ({
                  label: t(`people.sort${x.charAt(0).toUpperCase()}${x.slice(1)}` as 'people.sortName'),
                  n: items.length,
                  active: (filters.sort ?? 'relevance') === x,
                  to: href({ ...filters, sort: x }),
                })),
              },
            ]}
          />
        </FilterBar>

        <div className="pub-feed co-feed" id="list">
          <div aria-label={t('people.title')}>
            <div className="ev-results" role="status">
              <span className="ev-results__count">
                {t('people.found')}: <strong>{items.length}</strong> {t('people.foundNoun', { count: items.length })}
              </span>
              {chips.length ? (
                <span className="ev-active">
                  {chips.map((c) => (
                    <NextLink key={c.label} href={c.to} className="ev-active__chip" aria-label={`${t('events.removeFilter')}: ${c.label}`} scroll={false}>
                      {c.label}
                      <X size={12} strokeWidth={2.5} aria-hidden="true" />
                    </NextLink>
                  ))}
                  <NextLink href="/people" className="ev-active__reset" scroll={false}>
                    {t('events.resetAll')}
                  </NextLink>
                </span>
              ) : null}
            </div>

            {shown.length === 0 ? (
              <EmptyState
                title={t('people.empty')}
                actions={
                  <ButtonLink href="/people" variant="secondary">
                    {t('news.resetFilters')}
                  </ButtonLink>
                }
              />
            ) : (
              <div className="pp-grid">
                {shown.map((p) => (
                  <article key={p.id} className="pp-card">
                    <div className="pp-card__head">
                      <NextLink href={p.href} className="pp-card__avatar" aria-hidden="true" tabIndex={-1}>
                        <PersonAvatar name={p.displayName} portrait={p.portrait} size={64} />
                      </NextLink>
                      <div className="pp-card__who">
                        <h3 className="pp-card__name">
                          <NextLink href={p.href} className="pp-card__link">
                            {p.displayName}
                          </NextLink>
                          {p.verified ? <SRMark compact size="sm" /> : null}
                          {myId === p.id ? <span className="pp-card__you">{t('people.itsYou')}</span> : null}
                        </h3>
                        <p className="pp-card__role">{p.roleLine}</p>
                        <p className="pp-card__org">
                          {p.employer ? (
                            <>
                              <CompanyMark name={p.employer.name} seed={p.employer.href} size={18} />
                              <NextLink href={p.employer.href}>{p.employer.name}</NextLink>
                            </>
                          ) : (
                            <>
                              <UserRound size={14} strokeWidth={2} aria-hidden="true" />
                              {t('people.independentShort')}
                            </>
                          )}
                          <span className="pp-card__dot">·</span>
                          {regionLabel(p.region)}
                        </p>
                      </div>
                    </div>
                    {p.signals.length ? (
                      <p className="pp-card__signals">
                        {p.signals.slice(0, 2).map((sg) => (
                          <SignalBadge key={sg.kind} scope="person" signal={sg} size="sm" />
                        ))}
                      </p>
                    ) : null}
                    {p.headline ? <p className="pp-card__headline">{typo(p.headline)}</p> : null}
                    <p className="co-row__tags">
                      {p.expertise.slice(0, 3).map((e) => (
                        <NextLink key={e} href={href({ spec: e })} className="co-tag" scroll={false}>
                          {e}
                        </NextLink>
                      ))}
                    </p>
                    <ul className="co-stats pp-card__stats">
                      <li className={p.projectsCount ? '' : 'is-zero'}>
                        <FolderOpen size={14} strokeWidth={2} aria-hidden="true" />
                        {t('people.projectsCount', { count: p.projectsCount })}
                      </li>
                      <li className={p.publicationsCount ? '' : 'is-zero'}>
                        <FileText size={14} strokeWidth={2} aria-hidden="true" />
                        {t('people.publicationsCount', { count: p.publicationsCount })}
                      </li>
                      {p.servicesCount ? (
                        <li>
                          <Wrench size={14} strokeWidth={2} aria-hidden="true" />
                          {t('people.servicesCount', { count: p.servicesCount })}
                        </li>
                      ) : null}
                      {p.platformCertificatesCount ? (
                        <li className="pp-card__cert">
                          <SRLogo size={12} />
                          {t('sr.certsCount', { count: p.platformCertificatesCount })}
                        </li>
                      ) : null}
                    </ul>
                    <NextLink href={p.href} className="pub-btn pub-btn--dark pp-card__open">
                      {t('people.openProfile')}
                    </NextLink>
                  </article>
                ))}
              </div>
            )}
            {items.length > shown.length ? (
              <div className="pub-feed__more">
                <NextLink href={`${href({ ...filters, show: (filters.show ?? PAGE) + PAGE })}#list`} className="pub-btn" scroll={false}>
                  {t('people.showMore')}
                </NextLink>
              </div>
            ) : null}
          </div>

          <aside className="pub-aside">
            <section aria-labelledby="fields-title">
              <h3 className="pub-aside__title" id="fields-title">
                {t('people.fieldLabel')}
              </h3>
              <ul className="co-kind-list">
                {FIELDS.map((f) => {
                  const Icon = FIELD_ICON[f];
                  const n = all.filter((p) => p.field === f).length;
                  if (!n) return null;
                  return (
                    <li key={f}>
                      <NextLink href={href({ field: f })} className="co-kind" aria-current={filters.field === f ? 'true' : undefined} scroll={false}>
                        <span className="co-kind__icon">
                          <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                        </span>
                        <span className="co-kind__text">
                          <span className="co-kind__name">{t(`people.fields.${f}`)}</span>
                          <span className="co-kind__hint">{t(`people.fieldHint.${f}`)}</span>
                        </span>
                        <span className="ev-facet__count">{n}</span>
                        <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
                      </NextLink>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="pub-note" aria-labelledby="interests-title">
              <h3 className="pub-note__title" id="interests-title">
                {t('people.interestsTitle')}
              </h3>
              <ul className="ev-facet__list">
                {TOPICS.map((tp) => {
                  const n = all.filter((p) => p.topics.includes(tp)).length;
                  if (!n) return null;
                  return (
                    <li key={tp}>
                      <NextLink href={href({ topic: tp })} className="ev-facet__item" aria-current={filters.topic === tp ? 'true' : undefined} scroll={false}>
                        <span>{topicLabel(tp)}</span>
                        <span className="ev-facet__count">{n}</span>
                      </NextLink>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="pub-note" aria-labelledby="about-profile-title">
              <h3 className="pub-note__title" id="about-profile-title">
                {t('people.aboutProfileTitle')}
              </h3>
              <p className="pub-note__body">{typo(t('people.aboutProfileBody'))}</p>
            </section>
            <section className="pub-note pub-note--tint" aria-labelledby="share-exp-title">
              <h3 className="pub-note__title" id="share-exp-title">
                {t('people.shareExperience')}
              </h3>
              <p className="pub-note__body">{typo(t('people.experienceStaysBody'))}</p>
              <NextLink href="/login?next=%2Fapp%2Fpublications" className="pub-more">
                {t('people.writeArticle')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
          </aside>
        </div>

        {writing.length ? (
          <section className="pub-section" aria-labelledby="writing-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="writing-title">
                {typo(t('people.writingTitle'))}
              </h2>
              <NextLink href="/articles" className="pub-more">
                {t('people.writingAll')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="pub-people">
              {writing.map((card) => {
                const author = card.authorHref ? byHref.get(card.authorHref) : undefined;
                return (
                  <article key={card.id} className="story-card">
                    <div className="story-card__media" aria-hidden="true">
                      <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 76vw, 33vw" />
                    </div>
                    <span className="pub-kicker">{formatLabel(card)}</span>
                    <h3 className="story-card__title">
                      <NextLink href={card.href}>{typo(card.title)}</NextLink>
                    </h3>
                    <p className="story-card__dek">{typo(card.lede)}</p>
                    <p className="co-story__by">
                      {author ? <PersonAvatar name={author.displayName} portrait={author.portrait} size={32} /> : null}
                      {card.authorHref ? <NextLink href={card.authorHref}>{card.authorLabel}</NextLink> : <span>{card.authorLabel}</span>}
                      {card.readMinutes ? <span className="co-story__sep">· {t('articles.readTime', { minutes: card.readMinutes })}</span> : null}
                    </p>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {talks.length ? (
          <section className="pub-section" aria-labelledby="talk-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="talk-title">
                {typo(t('people.talkTitle'))}
              </h2>
              <NextLink href="/articles?format=interview" className="pub-more">
                {t('people.talkAll')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="co-projects">
              {talks.map((card) => (
                <article key={card.id} className="co-project">
                  <NextLink href={card.href} className="co-project__media" aria-hidden="true" tabIndex={-1}>
                    <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 320px" />
                  </NextLink>
                  <div className="co-project__body">
                    <span className="pub-kicker">{formatLabel(card)}</span>
                    <h3 className="co-project__title">
                      <NextLink href={card.href}>{typo(card.title)}</NextLink>
                    </h3>
                    <p className="co-project__summary">{typo(card.lede)}</p>
                    <NextLink href={card.href} className="pub-more">
                      {t('people.readInterview')}
                      <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                    </NextLink>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {meet.length ? (
          <section className="pub-section" aria-labelledby="meet-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="meet-title">
                {typo(t('people.meetTitle'))}
              </h2>
              <NextLink href="/projects" className="pub-more">
                {t('people.meetAll')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            {meet.map((p) => (
              <article key={p.id} className="pp-meet">
                <NextLink href={p.href} className="pp-meet__media" aria-hidden="true" tabIndex={-1}>
                  <MediaFrame media={projectCover(p.handle)} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 520px" />
                </NextLink>
                <div className="pp-meet__body">
                  <span className="pub-kicker">
                    {t('publicNav.6')} · {regionLabel(p.region)}
                  </span>
                  <h3 className="co-project__title">
                    <NextLink href={p.href}>{typo(p.name)}</NextLink>
                  </h3>
                  <p className="co-project__summary">{typo(t('people.meetLede'))}</p>
                  <p className="pp-meet__label">{t('people.participants')}</p>
                  <ul className="pp-meet__people">
                    {p.publicParticipants.slice(0, 4).map((pp) => {
                      const person = pp.href ? byHref.get(pp.href) : undefined;
                      return (
                        <li key={pp.label}>
                          {pp.href ? (
                            <NextLink href={pp.href} className="pp-meet__person">
                              {person ? <PersonAvatar name={person.displayName} portrait={person.portrait} size={32} /> : <CompanyMark name={pp.label} seed={pp.href} size={32} />}
                              <span>
                                <span className="pp-meet__pname">{pp.label}</span>
                                <span className="pp-meet__prole">{pp.roleTitle}</span>
                              </span>
                            </NextLink>
                          ) : (
                            <span className="pp-meet__person">
                              <CompanyMark name={pp.label} seed={pp.label} size={32} />
                              <span>
                                <span className="pp-meet__pname">{pp.label}</span>
                                <span className="pp-meet__prole">{pp.roleTitle}</span>
                              </span>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </article>
            ))}
          </section>
        ) : null}
      </div>

      <section className="pub-cta" aria-labelledby="people-cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="people-cta-title">
              {typo(t('people.ctaTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('people.ctaBody'))}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/signup" className="pub-btn pub-btn--light">
              {t('people.ctaCreate')}
            </NextLink>
            <NextLink href="/login" className="pub-cta__link">
              {t('people.ctaSignIn')}
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
