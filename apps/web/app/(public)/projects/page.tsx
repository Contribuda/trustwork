import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight, ArrowUpRight, FileText, FolderOpen, Layers, LayoutList, Map as MapIcon, MapPin, ShoppingCart, Users, X } from 'lucide-react';
import { Button, ButtonLink, EmptyState, MediaFrame, TextField } from '@/components/ui';
import { CompanyMark } from '@/components/public/CompanyMark';
import { Dropdown } from '@/components/public/Dropdown';
import { FilterBar } from '@/components/public/FilterBar';
import { MapSearch, type MapItem, type MapLegendEntry } from '@/components/public/MapSearch';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { ProjectStatusChip, formatLabel, regionLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import type { ProjectCard, ProjectStatus, RegionKey } from '@/app/_lib/data/types';
import { fixtureMedia, projectCover, storyCover } from '@/app/_lib/media';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import { regionCodes } from '@/app/_lib/country';
import { withBase } from '@/app/_lib/base-path';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('projects.title'), description: t('projects.lede') };
}

const CATEGORIES = ['housing', 'education', 'industrial', 'publicSpace', 'infrastructure'] as const;
const STAGES: ProjectStatus[] = ['planned', 'active', 'suspended', 'completed', 'cancelled'];
const REGIONS: RegionKey[] = regionCodes();
const SORTS = ['recent', 'progress', 'name'] as const;
const PAGE = 6;

type Category = (typeof CATEGORIES)[number];
type Sort = (typeof SORTS)[number];
type Filters = { q?: string; category?: Category; stage?: ProjectStatus; region?: RegionKey; needs?: '1'; sort?: Sort; show?: number; view?: 'map'; bbox?: string };
type Facet = 'category' | 'stage' | 'region' | 'needs';

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function href(f: Partial<Filters>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'show' && v === PAGE) && !(k === 'sort' && v === 'recent')) params.set(k, String(v));
  const s = params.toString();
  return s ? `/projects?${s}` : '/projects';
}

function apply(list: ProjectCard[], f: Filters, except?: Facet): ProjectCard[] {
  const q = f.q?.trim().toLowerCase();
  return list.filter((p) => {
    if (except !== 'category' && f.category && p.category !== f.category) return false;
    if (except !== 'stage' && f.stage && p.status !== f.stage) return false;
    if (except !== 'region' && f.region && p.region !== f.region) return false;
    if (except !== 'needs' && f.needs && p.openNeedsCount === 0) return false;
    if (q) {
      const hay = [p.name, p.summary ?? '', p.owner.label, ...p.publicParticipants.map((x) => x.label), regionLabel(p.region), t(`projects.category.${p.category}`)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function cardCover(p: ProjectCard) {
  return p.cover ? fixtureMedia(p.cover, 'project') : projectCover(p.slug);
}

/**
 * Projects hub (editorial system): a featured project, search, one filter bar (type, stage, region, open needs,
 * sort) with counts, cards with cover, status, readiness bar, owner and public participants, open needs; aside
 * with what is visible, open needs and how the information is structured; latest public updates across
 * projects; articles about teams; CTA. Budgets, offers and private files never appear.
 */
export default async function ProjectsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const focus = str('focus')?.slice(0, 80) ?? null;
  const filters: Filters = {
    q: str('q')?.slice(0, 80),
    category: CATEGORIES.find((x) => x === str('category')),
    stage: STAGES.find((x) => x === str('stage')),
    region: REGIONS.find((x) => x === str('region')),
    needs: str('needs') === '1' ? '1' : undefined,
    view: str('view') === 'map' ? 'map' : undefined,
    bbox: /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(str('bbox') ?? '') ? str('bbox') : undefined,
    sort: SORTS.find((x) => x === str('sort')) ?? 'recent',
    show: Math.min(60, Math.max(PAGE, Number.parseInt(str('show') ?? '', 10) || PAGE)),
  };
  const all = data.listPublicProjects();
  const bbox = filters.view === 'map' && filters.bbox ? (filters.bbox.split(',').map(Number) as [number, number, number, number]) : null;
  const inBox = (p: ProjectCard) => !bbox || (p.location !== null && p.location.lng >= bbox[0] && p.location.lng <= bbox[2] && p.location.lat >= bbox[1] && p.location.lat <= bbox[3]);
  const sorters: Record<Sort, (a: ProjectCard, b: ProjectCard) => number> = {
    recent: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    progress: (a, b) => b.progressPercent - a.progressPercent || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
  };
  const matched = apply(all, filters).sort(sorters[filters.sort ?? 'recent']);
  const items = matched.filter(inBox);
  const shown = items.slice(0, filters.show);
  const count = (except: Facet, pred: (p: ProjectCard) => boolean) => apply(all, filters, except).filter(pred).length;
  const active = Boolean(filters.q || filters.category || filters.stage || filters.region || filters.needs || filters.view);
  const featured = !active ? ([...all].sort((a, b) => b.openNeedsCount - a.openNeedsCount || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null) : null;
  const moving = all
    .flatMap((p) => (data.getPublicProject(p.slug)?.updates ?? []).map((u) => ({ ...u, project: p })))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);
  const articles = data
    .listArticles()
    .filter((c) => c.articleFormat === 'projectStory' || c.articleFormat === 'experience')
    .slice(0, 2);
  const people = new Map(data.listPeople().map((p) => [p.href, p]));

  const chips: Array<{ label: string; to: string }> = [];
  if (filters.q) chips.push({ label: `${t('events.searchPrefix')}: ${filters.q}`, to: href({ ...filters, q: undefined, show: undefined }) });
  if (filters.category) chips.push({ label: t(`projects.category.${filters.category}`), to: href({ ...filters, category: undefined, show: undefined }) });
  if (filters.stage) chips.push({ label: t(`projectStatus.${filters.stage}`), to: href({ ...filters, stage: undefined, show: undefined }) });
  if (filters.region) chips.push({ label: regionLabel(filters.region), to: href({ ...filters, region: undefined, show: undefined }) });
  if (filters.needs) chips.push({ label: t('projects.needsOpen'), to: href({ ...filters, needs: undefined, show: undefined }) });
  if (filters.view === 'map' && filters.bbox) chips.push({ label: t('map.areaFilter'), to: href({ ...filters, bbox: undefined, show: undefined }) });
  const hidden = Object.entries(filters).filter(([k, v]) => k !== 'q' && k !== 'show' && k !== 'bbox' && v && !(k === 'sort' && v === 'recent')) as Array<[string, string]>;
  const baseQuery = new URLSearchParams(Object.entries(filters).filter(([k, v]) => v && k !== 'view' && k !== 'bbox' && k !== 'show' && !(k === 'sort' && v === 'recent')) as Array<[string, string]>).toString();
  const legend: MapLegendEntry[] = [
    { tone: 'blue', label: t('projectStatus.active') },
    { tone: 'green', label: t('projectStatus.completed') },
    { tone: 'amber', label: t('projectStatus.planned') },
    { tone: 'grey', label: t('map.legendOther') },
  ];
  const mapItems: MapItem[] = matched
    .filter((p) => p.location)
    .map((p) => ({
      id: p.id,
      href: p.href,
      title: p.name,
      kicker: t(`projects.category.${p.category}`),
      subtitle: `${t('projects.owner')}: ${p.owner.label}`,
      description: p.summary,
      lat: p.location!.lat,
      lng: p.location!.lng,
      pin: `${p.progressPercent}%`,
      pinTone: p.status === 'completed' ? 'green' : p.status === 'active' ? 'blue' : p.status === 'planned' ? 'amber' : 'grey',
      cover: cardCover(p).src,
      mark: null,
      status: { label: t(`projectStatus.${p.status}`), tone: p.status === 'completed' ? 'free' : p.status === 'active' ? 'paid' : 'muted' },
      signals: [],
      facts: [
        { icon: 'region', label: regionLabel(p.region) },
        ...(p.openNeedsCount ? [{ icon: 'needs' as const, label: t('projects.needsCount', { count: p.openNeedsCount }) }] : []),
        ...(p.publicParticipants.length ? [{ icon: 'people' as const, label: t('map.participantsCount', { count: p.publicParticipants.length }) }] : []),
        { icon: 'updated', label: t('projects.updatedLine', { date: shortDate(p.updatedAt) }) },
      ],
      progress: p.progressPercent,
      agentHref: `${p.href}#rep-title`,
    }));
  const mapHref = (id: string) => `${href({ ...filters, view: 'map', bbox: undefined, show: undefined })}&focus=${encodeURIComponent(id)}`;

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('projects.title'))}
            </h1>
            <p className="pub-lede">{typo(t('projects.lede'))}</p>
          </div>
          <div className="pub-head__action">
            <ButtonLink href="/login?next=%2Fapp%2Fprojects" variant="secondary">
              {t('projects.present')}
            </ButtonLink>
          </div>
        </header>

        {featured ? (
          <section className="news-lead ev-lead" aria-labelledby="featured-title">
            <div className="news-lead__media">
              <MediaFrame media={cardCover(featured)} ratio="fill" radius="none" loading="eager" sizes="(max-width: 1023px) 100vw, 55vw" />
            </div>
            <div className="news-lead__panel">
              <span className="pub-kicker">
                {t('projects.featured')} · {t(`projects.category.${featured.category}`)}
              </span>
              <h2 className="news-lead__title" id="featured-title">
                <NextLink href={featured.href}>{typo(featured.name)}</NextLink>
              </h2>
              {featured.summary ? <p className="news-lead__dek">{typo(featured.summary)}</p> : null}
              <ul className="ev-facts ev-facts--inline">
                <li>
                  <ProjectStatusChip status={featured.status} size="sm" />
                </li>
                <li>
                  <MapPin size={14} strokeWidth={2} aria-hidden="true" />
                  {regionLabel(featured.region)}
                </li>
                <li>
                  {t('projects.progress')}: {featured.progressPercent}%
                </li>
                {featured.openNeedsCount ? <li className="pj-card__needs">{t('projects.needsCount', { count: featured.openNeedsCount })}</li> : null}
              </ul>
              <div className="pub-actions" style={{ marginTop: 'var(--space-2)' }}>
                <NextLink href={featured.href} className="pub-btn pub-btn--dark">
                  {t('projects.open')}
                </NextLink>
                <NextLink href={`${featured.href}#participants`} className="pub-more">
                  {t('projects.participantsAndRoles')}
                  <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </div>
            </div>
          </section>
        ) : null}

        <div className="pub-search">
          <form className="search-row" action={withBase('/projects')} method="get" role="search" aria-label={t('publicPages.find')}>
            <TextField name="q" label={t('publicPages.find')} placeholder={t('projects.searchPlaceholder')} inputMode="search" autoComplete="off" defaultValue={filters.q ?? ''} />
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
            label={t('projects.categoryLabel')}
            value={filters.category ? t(`projects.category.${filters.category}`) : undefined}
            groups={[
              {
                items: [
                  { label: t('projects.allCategories'), n: count('category', () => true), active: !filters.category, to: href({ ...filters, category: undefined, show: undefined }) },
                  ...CATEGORIES.map((c) => ({
                    label: t(`projects.category.${c}`),
                    n: count('category', (p) => p.category === c),
                    active: filters.category === c,
                    to: href({ ...filters, category: filters.category === c ? undefined : c, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('projects.stageLabel')}
            value={filters.stage ? t(`projectStatus.${filters.stage}`) : undefined}
            groups={[
              {
                items: [
                  { label: t('projects.allStages'), n: count('stage', () => true), active: !filters.stage, to: href({ ...filters, stage: undefined, show: undefined }) },
                  ...STAGES.map((st) => ({
                    label: t(`projectStatus.${st}`),
                    n: count('stage', (p) => p.status === st),
                    active: filters.stage === st,
                    to: href({ ...filters, stage: filters.stage === st ? undefined : st, show: undefined }),
                  })).filter((it) => it.n > 0 || it.active),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('projects.regionLabel')}
            value={filters.region ? regionLabel(filters.region) : undefined}
            groups={[
              {
                items: [
                  { label: t('projects.allRegions'), n: count('region', () => true), active: !filters.region, to: href({ ...filters, region: undefined, show: undefined }) },
                  ...REGIONS.map((r) => ({
                    label: regionLabel(r),
                    n: count('region', (p) => p.region === r),
                    active: filters.region === r,
                    to: href({ ...filters, region: filters.region === r ? undefined : r, show: undefined }),
                  })).filter((it) => it.n > 0 || it.active),
                ],
              },
            ]}
          />
          <NextLink href={href({ ...filters, needs: filters.needs ? undefined : '1', show: undefined })} className="sr-toggle sr-toggle--cert" {...(filters.needs ? { 'aria-current': 'true' as const } : {})} scroll={false}>
            <ShoppingCart size={14} strokeWidth={2} aria-hidden="true" />
            {t('projects.needsOpen')}
            <span className="pub-chip__n">{count('needs', (p) => p.openNeedsCount > 0)}</span>
          </NextLink>
          <span className="ev-filters__spacer" aria-hidden="true" />
          <Dropdown
            label={t('projects.sortLabel')}
            value={filters.sort && filters.sort !== 'recent' ? t(`projects.sort${filters.sort.charAt(0).toUpperCase()}${filters.sort.slice(1)}` as 'projects.sortName') : undefined}
            groups={[
              {
                items: SORTS.map((x) => ({
                  label: t(`projects.sort${x.charAt(0).toUpperCase()}${x.slice(1)}` as 'projects.sortName'),
                  n: items.length,
                  active: (filters.sort ?? 'recent') === x,
                  to: href({ ...filters, sort: x }),
                })),
              },
            ]}
          />
        </FilterBar>

        <div className={filters.view === 'map' ? 'pub-feed co-feed co-feed--map' : 'pub-feed co-feed'} id="list">
          <div aria-label={t('projects.title')}>
            <div className="ev-results" role="status">
              <span className="ev-results__count">
                {t('projects.found')}: <strong>{items.length}</strong> {plural(items.length, t('projects.foundOne'), t('projects.foundFew'), t('projects.foundMany'))}
              </span>
              <span className="ms-toggle" role="group" aria-label={t('map.viewMap')}>
                <NextLink href={href({ ...filters, view: undefined, bbox: undefined, show: undefined })} className="ms-toggle__btn" aria-current={filters.view ? undefined : 'true'} scroll={false}>
                  <LayoutList size={14} strokeWidth={2} aria-hidden="true" />
                  {t('map.viewList')}
                </NextLink>
                <NextLink href={href({ ...filters, view: 'map', show: undefined })} className="ms-toggle__btn" aria-current={filters.view ? 'true' : undefined} scroll={false}>
                  <MapIcon size={14} strokeWidth={2} aria-hidden="true" />
                  {t('map.viewMap')}
                </NextLink>
              </span>
              {chips.length ? (
                <span className="ev-active">
                  {chips.map((c) => (
                    <NextLink key={c.label} href={c.to} className="ev-active__chip" aria-label={`${t('events.removeFilter')}: ${c.label}`} scroll={false}>
                      {c.label}
                      <X size={12} strokeWidth={2.5} aria-hidden="true" />
                    </NextLink>
                  ))}
                  <NextLink href="/projects" className="ev-active__reset" scroll={false}>
                    {t('events.resetAll')}
                  </NextLink>
                </span>
              ) : null}
            </div>

            {filters.view === 'map' ? (
              <MapSearch
                items={mapItems}
                legend={legend}
                focusId={focus}
                baseQuery={baseQuery}
                basePath="/projects"
                bbox={bbox}
                total={matched.filter((p) => p.location).length}
                listHref={href({ ...filters, view: undefined, bbox: undefined })}
              />
            ) : shown.length === 0 ? (
              <EmptyState
                title={t('projects.empty')}
                actions={
                  <ButtonLink href="/projects" variant="secondary">
                    {t('news.resetFilters')}
                  </ButtonLink>
                }
              />
            ) : (
              <div className="pj-grid">
                {shown.map((p) => (
                  <article key={p.id} className="pj-card">
                    <NextLink href={p.href} className="pj-card__media" aria-hidden="true" tabIndex={-1}>
                      <MediaFrame media={cardCover(p)} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 480px" />
                      <span className="pj-card__status">
                        <ProjectStatusChip status={p.status} size="sm" />
                      </span>
                    </NextLink>
                    <div className="pj-card__body">
                      <span className="pub-kicker">{t(`projects.category.${p.category}`)}</span>
                      <h3 className="pj-card__title">
                        <NextLink href={p.href} className="pj-card__link">
                          {typo(p.name)}
                        </NextLink>
                      </h3>
                      <p className="pj-card__meta">
                        <span>
                          <MapPin size={13} strokeWidth={2} aria-hidden="true" />
                          {regionLabel(p.region)}
                          {p.location ? (
                            <NextLink href={mapHref(p.id)} className="co-row__map" scroll={false}>
                              {t('map.onMap')}
                            </NextLink>
                          ) : null}
                        </span>
                        <span>
                          {t('projects.owner')}: {p.owner.label}
                        </span>
                        <span>{t('projects.updatedLine', { date: shortDate(p.updatedAt) })}</span>
                      </p>
                      {p.summary ? <p className="pj-card__summary">{typo(p.summary)}</p> : null}
                      <div className="pj-progress">
                        <div className="pj-progress__row">
                          <span>{t('projects.progress')}</span>
                          <strong>{p.progressPercent}%</strong>
                        </div>
                        <div className="pj-progress__bar" aria-hidden="true">
                          <span className="pj-progress__fill" style={{ width: `${p.progressPercent}%` }} />
                        </div>
                      </div>
                      {p.publicParticipants.length ? (
                        <p className="pj-card__people">
                          {p.publicParticipants.slice(0, 3).map((pp) => {
                            const person = pp.href ? people.get(pp.href) : undefined;
                            const inner = (
                              <>
                                {person ? <PersonAvatar name={person.displayName} portrait={person.portrait} size={32} /> : <CompanyMark name={pp.label} seed={pp.href ?? pp.label} size={18} />}
                                {pp.label}
                              </>
                            );
                            return pp.href ? (
                              <NextLink key={pp.label} href={pp.href} className="co-tag" title={pp.roleTitle}>
                                {inner}
                              </NextLink>
                            ) : (
                              <span key={pp.label} className="co-tag" title={pp.roleTitle}>
                                {inner}
                              </span>
                            );
                          })}
                          {p.publicParticipants.length > 3 ? <span className="co-tag co-tag--more">{t('projects.moreParticipants', { count: p.publicParticipants.length - 3 })}</span> : null}
                        </p>
                      ) : null}
                      <div className="pj-card__foot">
                        {p.openNeedsCount ? (
                          <span className="pj-card__needs">
                            <ShoppingCart size={14} strokeWidth={2} aria-hidden="true" />
                            {t('projects.needsCount', { count: p.openNeedsCount })}
                          </span>
                        ) : (
                          <span className="pj-card__needs pj-card__needs--none">{t('projects.openNeedsEmpty')}</span>
                        )}
                        <NextLink href={p.href} className="pub-btn pub-btn--dark pj-card__open">
                          {t('projects.open')}
                        </NextLink>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {filters.view !== 'map' && items.length > shown.length ? (
              <div className="pub-feed__more">
                <NextLink href={`${href({ ...filters, show: (filters.show ?? PAGE) + PAGE })}#list`} className="pub-btn" scroll={false}>
                  {t('projects.showMore')}
                </NextLink>
              </div>
            ) : null}
          </div>

          <aside className="pub-aside">
            <section className="pub-note" aria-labelledby="visible-title">
              <h3 className="pub-note__title" id="visible-title">
                {t('projects.whatVisible')}
              </h3>
              <ul className="co-visible">
                {[
                  [FileText, t('projectPage.nav.overview')],
                  [Users, t('projects.participantsAndRoles')],
                  [Layers, t('projectPage.nav.roadmap')],
                  [FolderOpen, t('projectPage.nav.media')],
                ].map(([Icon, label], i) => {
                  const I = Icon as typeof FileText;
                  return (
                    <li key={i}>
                      <I size={16} strokeWidth={2} aria-hidden="true" />
                      {String(label)}
                    </li>
                  );
                })}
              </ul>
              <p className="pub-note__body">{typo(t('projects.whatVisibleBody'))}</p>
            </section>
            <section className="pub-note pub-note--tint" aria-labelledby="needs-title">
              <h3 className="pub-note__title" id="needs-title">
                {t('projects.needsTitle')}
              </h3>
              <p className="pub-note__body">{typo(t('projects.needsBody'))}</p>
              <NextLink href={href({ needs: '1' })} className="pub-btn" scroll={false}>
                {t('projects.viewNeeds')}
              </NextLink>
            </section>
            <section className="pub-note" aria-labelledby="sources-title">
              <h3 className="pub-note__title" id="sources-title">
                {t('projects.sourcesTitle')}
              </h3>
              <p className="pub-note__body">{typo(t('projects.sourcesBody'))}</p>
              <NextLink href="/#about" className="pub-more">
                {t('projects.howInfo')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
          </aside>
        </div>

        {moving.length ? (
          <section className="pub-section" aria-labelledby="moving-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="moving-title">
                {typo(t('projects.movingTitle'))}
              </h2>
            </div>
            <div className="pj-moving">
              {moving.map((u) => (
                <article key={u.id} className="pj-move">
                  <NextLink href={`${u.project.href}#updates`} className="pj-move__thumb" aria-hidden="true" tabIndex={-1}>
                    <MediaFrame media={cardCover(u.project)} ratio="fill" radius="none" sizes="72px" />
                  </NextLink>
                  <div className="pj-move__body">
                    <span className="pj-move__project">{u.project.name}</span>
                    <span className="pub-kicker">
                      {t(`projects.updateType.${u.type}`)} · {longDate(u.date)}
                    </span>
                    <h3 className="pj-move__title">
                      <NextLink href={`${u.project.href}#updates`}>{typo(u.title)}</NextLink>
                    </h3>
                    <NextLink href={u.project.href} className="pub-more">
                      {t('projects.toProject')}
                      <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                    </NextLink>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {articles.length ? (
          <section className="pub-section" aria-labelledby="people-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="people-title">
                {typo(t('projects.peopleTitle'))}
              </h2>
              <span className="pub-h2-row__links">
                <NextLink href="/companies?has=projects" className="pub-more">
                  {t('projects.companiesIn')}
                  <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
                <NextLink href="/people" className="pub-more">
                  {t('projects.peopleIn')}
                  <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </span>
            </div>
            <div className="co-projects">
              {articles.map((card) => (
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
                    <p className="co-story__by">
                      {card.authorHref ? <NextLink href={card.authorHref}>{card.authorLabel}</NextLink> : <span>{card.authorLabel}</span>}
                      {card.readMinutes ? <span className="co-story__sep">· {t('articles.readTime', { minutes: card.readMinutes })}</span> : null}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <section className="pub-cta" aria-labelledby="projects-cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="projects-cta-title">
              {typo(t('projects.ctaTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('projects.ctaBody'))}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/login?next=%2Fapp%2Fprojects" className="pub-btn pub-btn--light">
              {t('projects.ctaCreate')}
            </NextLink>
            <NextLink href="/login" className="pub-cta__link">
              {t('projects.ctaSignIn')}
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
