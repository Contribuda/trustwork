import type { Metadata } from 'next';
import NextLink from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  BriefcaseBusiness,
  Building2,
  ChevronRight,
  Compass,
  Factory,
  FileText,
  FlaskConical,
  FolderOpen,
  Hammer,
  HardHat,
  LayoutList,
  Map as MapIcon,
  MapPin,
  Package,
  Settings2,
  ShieldCheck,
  Truck,
  Users,
  X,
} from 'lucide-react';
import { Button, ButtonLink, EmptyState, MediaFrame, RecordStatusChip, TextField } from '@/components/ui';
import { CompanyMark, initials } from '@/components/public/CompanyMark';
import { SignalBadge, signalLabel } from '@/components/public/SignalBadge';
import { SRLogo, SRMark } from '@/components/public/SRMark';
import { Dropdown } from '@/components/public/Dropdown';
import { FilterBar } from '@/components/public/FilterBar';
import { MapSearch, type MapItem, type MapLegendEntry } from '@/components/public/MapSearch';
import { formatLabel, regionLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import type { CompanyCard, CompanyKind, CompanySignalKind, CompanyStatus, RegionKey } from '@/app/_lib/data/types';
import { projectCover, storyCover } from '@/app/_lib/media';
import { shortDate, t } from '@/app/_lib/i18n';
import { regionCodes } from '@/app/_lib/country';
import { withBase } from '@/app/_lib/base-path';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('companies.title'), description: t('companies.lede') };
}

const KINDS: CompanyKind[] = ['developer', 'client', 'generalContractor', 'contractor', 'designer', 'manufacturer', 'supplier', 'equipment', 'services', 'logistics'];
const REGIONS: RegionKey[] = regionCodes();
const STATUSES: CompanyStatus[] = ['verified', 'claimed', 'sourced'];
const SIGNALS: CompanySignalKind[] = ['hiring', 'acceptingOrders', 'lookingForSubcontractors', 'lookingForSuppliers', 'lookingForPartners', 'lookingForProjects', 'paused'];
const KIND_ICON = {
  developer: Building2,
  client: BriefcaseBusiness,
  generalContractor: Hammer,
  contractor: HardHat,
  designer: Compass,
  manufacturer: Factory,
  supplier: Boxes,
  equipment: Settings2,
  services: FlaskConical,
  logistics: Truck,
} as const;
const SORTS = ['trust', 'experience', 'name', 'newest'] as const;
const PAGE = 6;

type Sort = (typeof SORTS)[number];
type Filters = {
  q?: string;
  kind?: CompanyKind;
  spec?: string;
  region?: RegionKey;
  status?: CompanyStatus;
  signal?: CompanySignalKind;
  has?: 'projects' | 'publications' | 'catalogue';
  verified?: '1';
  sort?: Sort;
  show?: number;
  view?: 'map';
  bbox?: string;
};
type Facet = 'kind' | 'spec' | 'region' | 'status' | 'signal' | 'has' | 'verified';

function href(f: Partial<Filters>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'show' && v === PAGE) && !(k === 'sort' && v === 'trust')) params.set(k, String(v));
  const s = params.toString();
  return s ? `/companies?${s}` : '/companies';
}

function apply(list: CompanyCard[], f: Filters, except?: Facet): CompanyCard[] {
  const q = f.q?.trim().toLowerCase();
  return list.filter((c) => {
    if (except !== 'kind' && f.kind && !c.kinds.includes(f.kind)) return false;
    if (except !== 'spec' && f.spec && !c.directions.includes(f.spec)) return false;
    if (except !== 'region' && f.region && c.region !== f.region) return false;
    if (except !== 'status' && f.status && c.status !== f.status) return false;
    if (except !== 'signal' && f.signal && !c.signals.some((x) => x.kind === f.signal)) return false;
    if (except !== 'verified' && f.verified && !c.verified) return false;
    if (except !== 'has') {
      if (f.has === 'projects' && c.projectsCount === 0) return false;
      if (f.has === 'publications' && c.publicationsCount === 0) return false;
      if (f.has === 'catalogue' && !c.evidence.catalogue) return false;
    }
    if (q) {
      const hay = [c.name, c.description ?? '', ...c.directions, regionLabel(c.region), ...c.kinds.map((k) => t(`companies.kinds.${k}`))].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Companies hub (editorial system). Honest signals only: record status (sourced / claimed / verified), what the
 * company declared and what is confirmed, published projects, publications and catalogue. No ratings, no stars,
 * no invented review counts (product constraint O07). Filters are query parameters; every state has a URL.
 */
export default async function CompaniesPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const focus = str('focus')?.slice(0, 80) ?? null;
  const filters: Filters = {
    q: str('q')?.slice(0, 80),
    kind: KINDS.find((k) => k === str('kind')),
    spec: str('spec')?.slice(0, 80),
    sort: SORTS.find((x) => x === str('sort')) ?? 'trust',
    region: REGIONS.find((r) => r === str('region')),
    status: STATUSES.find((s) => s === str('status')),
    signal: SIGNALS.find((s) => s === str('signal')),
    verified: str('verified') === '1' ? '1' : undefined,
    view: str('view') === 'map' ? 'map' : undefined,
    bbox: /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(str('bbox') ?? '') ? str('bbox') : undefined,
    has: (['projects', 'publications', 'catalogue'] as const).find((h) => h === str('has')),
    show: Math.min(60, Math.max(PAGE, Number.parseInt(str('show') ?? '', 10) || PAGE)),
  };
  const all = await data.listCompanies();
  const bbox = filters.view === 'map' && filters.bbox ? (filters.bbox.split(',').map(Number) as [number, number, number, number]) : null;
  const inBox = (c: CompanyCard) => !bbox || (c.location !== null && c.location.lng >= bbox[0] && c.location.lng <= bbox[2] && c.location.lat >= bbox[1] && c.location.lat <= bbox[3]);
  const since = (c: CompanyCard) => Date.parse(c.claimedAt ?? c.provenance?.observedAt ?? '') || 0;
  const experience = (c: CompanyCard) => c.projectsCount * 2 + c.publicationsCount + (c.evidence.catalogue ? 1 : 0) + c.evidence.publicMembers;
  const byTrust = (a: CompanyCard, b: CompanyCard) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || experience(b) - experience(a) || a.name.localeCompare(b.name, 'ru');
  const sorters: Record<Sort, (a: CompanyCard, b: CompanyCard) => number> = {
    trust: byTrust,
    experience: (a, b) => experience(b) - experience(a) || byTrust(a, b),
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
    newest: (a, b) => since(b) - since(a) || byTrust(a, b),
  };
  const matched = apply(all, filters).sort(sorters[filters.sort ?? 'trust']);
  const items = matched.filter(inBox);
  const specs = [...new Set(all.flatMap((c) => c.directions))].sort((a, b) => a.localeCompare(b, 'ru'));
  const shown = items.slice(0, filters.show);
  const count = (except: Facet, pred: (c: CompanyCard) => boolean) => apply(all, filters, except).filter(pred).length;
  // One detail lookup per company, in parallel (the list projection does not carry publications or projects).
  const details = new Map(await Promise.all(all.map(async (c) => [c.id, await data.getCompany(c.handle)] as const)));
  const articles = await data.listArticles();
  const linked = new Set(all.flatMap((c) => details.get(c.id)?.publications.map((p) => p.id) ?? []));
  const sharing = [
    ...articles.filter((card) => card.authorKind === 'company' || linked.has(card.id)),
    ...articles.filter((card) => card.authorKind !== 'company' && !linked.has(card.id) && (card.articleFormat === 'experience' || card.articleFormat === 'practice' || card.articleFormat === 'projectStory')),
  ].slice(0, 3);
  const projects = (await data.listPublicProjects())
    .filter((p) => p.publicParticipants.length > 0)
    .slice(0, 2);
  const companyByHref = new Map(all.map((c) => [c.href, c]));

  const chips: Array<{ label: string; to: string }> = [];
  if (filters.q) chips.push({ label: `${t('events.searchPrefix')}: ${filters.q}`, to: href({ ...filters, q: undefined, show: undefined }) });
  if (filters.kind) chips.push({ label: t(`companies.kinds.${filters.kind}`), to: href({ ...filters, kind: undefined, show: undefined }) });
  if (filters.spec) chips.push({ label: filters.spec, to: href({ ...filters, spec: undefined, show: undefined }) });
  if (filters.region) chips.push({ label: regionLabel(filters.region), to: href({ ...filters, region: undefined, show: undefined }) });
  if (filters.status) chips.push({ label: t(`status.${filters.status}`), to: href({ ...filters, status: undefined, show: undefined }) });
  if (filters.signal) chips.push({ label: t(`signals.company.${filters.signal}`), to: href({ ...filters, signal: undefined, show: undefined }) });
  if (filters.verified) chips.push({ label: t('sr.filter'), to: href({ ...filters, verified: undefined, show: undefined }) });
  if (filters.view === 'map' && filters.bbox) chips.push({ label: t('map.areaFilter'), to: href({ ...filters, bbox: undefined, show: undefined }) });
  if (filters.has)
    chips.push({
      label: t(filters.has === 'projects' ? 'companies.withProjects' : filters.has === 'publications' ? 'companies.withPublications' : 'companies.withCatalogue'),
      to: href({ ...filters, has: undefined, show: undefined }),
    });
  const hidden = Object.entries(filters).filter(([k, v]) => k !== 'q' && k !== 'show' && k !== 'bbox' && v) as Array<[string, string]>;
  const baseQuery = new URLSearchParams(Object.entries(filters).filter(([k, v]) => v && k !== 'view' && k !== 'bbox' && k !== 'show') as Array<[string, string]>).toString();
  const legend: MapLegendEntry[] = [
    { tone: 'blue', label: t('sr.markShort') },
    { tone: 'navy', label: t('status.claimed') },
    { tone: 'grey', label: t('status.sourced') },
  ];
  const mapItems: MapItem[] = matched
    .filter((c) => c.location)
    .map((c) => ({
      id: c.id,
      href: c.href,
      title: c.name,
      kicker: c.kinds.map((k) => t(`companies.kindOne.${k}`)).join(' · '),
      subtitle: c.directions.slice(0, 3).join(' · ') || null,
      description: c.description,
      lat: c.location!.lat,
      lng: c.location!.lng,
      pin: initials(c.name),
      pinTone: c.verified ? 'blue' : c.status === 'claimed' ? 'navy' : 'grey',
      cover: (() => {
        const first = details.get(c.id)?.projects[0];
        return first ? projectCover(first.handle).src : null;
      })(),
      mark: { name: c.name, seed: c.handle },
      status: c.verified ? { label: t('sr.markShort'), tone: 'sr' } : { label: t(`status.${c.status}`), tone: c.status === 'claimed' ? 'free' : 'muted' },
      signals: c.signals.slice(0, 3).map((sg) => signalLabel('company', sg.kind)),
      facts: [
        { icon: 'region', label: regionLabel(c.region) },
        { icon: 'projects', label: t('companies.projectsCount', { count: c.projectsCount }) },
        { icon: 'publications', label: t('companies.publicationsCount', { count: c.publicationsCount }) },
        ...(c.website ? [{ icon: 'site' as const, label: c.website.replace(/^https?:\/\//, '').replace(/\/$/, ''), href: c.website }] : []),
      ],
      progress: null,
      agentHref: `${c.href}#rep-title`,
    }));
  const mapHref = (id: string) => `${href({ ...filters, view: 'map', bbox: undefined, show: undefined })}&focus=${encodeURIComponent(id)}`;

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <header className="pub-head">
          <div className="pub-head__text">
            <h1 className="pub-h1" id="page-title">
              {typo(t('companies.title'))}
            </h1>
            <p className="pub-lede">{typo(t('companies.lede'))}</p>
          </div>
          <div className="pub-head__action">
            <ButtonLink href="/login?next=%2Fapp%2Fcompany" variant="secondary">
              {t('companies.present')}
            </ButtonLink>
          </div>
        </header>

        <div className="pub-search">
          <form className="search-row" action={withBase('/companies')} method="get" role="search" aria-label={t('publicPages.find')}>
            <TextField name="q" label={t('publicPages.find')} placeholder={t('companies.searchPlaceholder')} inputMode="search" autoComplete="off" defaultValue={filters.q ?? ''} />
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
            label={t('companies.roleLabel')}
            value={filters.kind ? t(`companies.kinds.${filters.kind}`) : undefined}
            groups={[
              {
                items: [
                  { label: t('companies.allRoles'), n: count('kind', () => true), active: !filters.kind, to: href({ ...filters, kind: undefined, show: undefined }) },
                  ...KINDS.map((k) => ({
                    label: t(`companies.kinds.${k}`),
                    n: count('kind', (c) => c.kinds.includes(k)),
                    active: filters.kind === k,
                    to: href({ ...filters, kind: filters.kind === k ? undefined : k, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('companies.signalLabel')}
            value={filters.signal ? t(`signals.company.${filters.signal}`) : undefined}
            groups={[
              {
                items: [
                  { label: t('companies.signalAll'), n: count('signal', () => true), active: !filters.signal, to: href({ ...filters, signal: undefined, show: undefined }) },
                  ...SIGNALS.map((sg) => ({
                    label: t(`signals.company.${sg}`),
                    n: count('signal', (c) => c.signals.some((x) => x.kind === sg)),
                    active: filters.signal === sg,
                    to: href({ ...filters, signal: filters.signal === sg ? undefined : sg, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('companies.specLabel')}
            value={filters.spec}
            groups={[
              {
                items: [
                  { label: t('companies.allSpecs'), n: count('spec', () => true), active: !filters.spec, to: href({ ...filters, spec: undefined, show: undefined }) },
                  ...specs
                    .map((sp) => ({ label: sp, n: count('spec', (c) => c.directions.includes(sp)), active: filters.spec === sp, to: href({ ...filters, spec: filters.spec === sp ? undefined : sp, show: undefined }) }))
                    .filter((it) => it.n > 0 || it.active),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('companies.regionLabel')}
            value={filters.region ? regionLabel(filters.region) : undefined}
            groups={[
              {
                items: [
                  { label: t('companies.allRegions'), n: count('region', () => true), active: !filters.region, to: href({ ...filters, region: undefined, show: undefined }) },
                  ...REGIONS.map((r) => ({
                    label: regionLabel(r),
                    n: count('region', (c) => c.region === r),
                    active: filters.region === r,
                    to: href({ ...filters, region: filters.region === r ? undefined : r, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('companies.statusLabel')}
            value={filters.status ? t(`status.${filters.status}`) : undefined}
            groups={[
              {
                items: [
                  { label: t('companies.allStatuses'), n: count('status', () => true), active: !filters.status, to: href({ ...filters, status: undefined, show: undefined }) },
                  ...STATUSES.map((s) => ({
                    label: t(`status.${s}`),
                    n: count('status', (c) => c.status === s),
                    active: filters.status === s,
                    to: href({ ...filters, status: filters.status === s ? undefined : s, show: undefined }),
                  })),
                ],
              },
            ]}
          />
          <Dropdown
            label={t('companies.experienceLabel')}
            value={filters.has ? t(filters.has === 'projects' ? 'companies.withProjects' : filters.has === 'publications' ? 'companies.withPublications' : 'companies.withCatalogue') : undefined}
            groups={[
              {
                items: [
                  { label: t('companies.experienceAny'), n: count('has', () => true), active: !filters.has, to: href({ ...filters, has: undefined, show: undefined }) },
                  {
                    label: t('companies.withProjects'),
                    n: count('has', (c) => c.projectsCount > 0),
                    active: filters.has === 'projects',
                    to: href({ ...filters, has: filters.has === 'projects' ? undefined : 'projects', show: undefined }),
                  },
                  {
                    label: t('companies.withPublications'),
                    n: count('has', (c) => c.publicationsCount > 0),
                    active: filters.has === 'publications',
                    to: href({ ...filters, has: filters.has === 'publications' ? undefined : 'publications', show: undefined }),
                  },
                  {
                    label: t('companies.withCatalogue'),
                    n: count('has', (c) => Boolean(c.evidence.catalogue)),
                    active: filters.has === 'catalogue',
                    to: href({ ...filters, has: filters.has === 'catalogue' ? undefined : 'catalogue', show: undefined }),
                  },
                ],
              },
            ]}
          />
          <NextLink href={href({ ...filters, verified: filters.verified ? undefined : '1', show: undefined })} className="sr-toggle" {...(filters.verified ? { 'aria-current': 'true' as const } : {})} scroll={false}>
            <span className="srm__tile">
              <SRLogo size={11} tone="white" />
            </span>
            {t('sr.filter')}
            <span className="pub-chip__n">{count('verified', (c) => c.verified)}</span>
          </NextLink>
          <span className="ev-filters__spacer" aria-hidden="true" />
          <Dropdown
            label={t('companies.sortLabel')}
            value={filters.sort && filters.sort !== 'trust' ? t(`companies.sort${filters.sort.charAt(0).toUpperCase()}${filters.sort.slice(1)}` as 'companies.sortName') : undefined}
            groups={[
              {
                items: SORTS.map((x) => ({
                  label: t(`companies.sort${x.charAt(0).toUpperCase()}${x.slice(1)}` as 'companies.sortName'),
                  n: items.length,
                  active: (filters.sort ?? 'trust') === x,
                  to: href({ ...filters, sort: x }),
                })),
              },
            ]}
          />
        </FilterBar>

        <div className={filters.view === 'map' ? 'pub-feed co-feed co-feed--map' : 'pub-feed co-feed'} id="partners">
          <div aria-label={t('companies.findPartner')}>
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="partners-title">
                {typo(t('companies.findPartner'))}
              </h2>
            </div>
            <div className="ev-results" role="status">
              <span className="ev-results__count">
                {t('companies.found')}: <strong>{items.length}</strong> {t('companies.foundNoun', { count: items.length })}
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
                  <NextLink href="/companies" className="ev-active__reset" scroll={false}>
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
                basePath="/companies"
                bbox={bbox}
                total={matched.filter((c) => c.location).length}
                listHref={href({ ...filters, view: undefined, bbox: undefined })}
              />
            ) : shown.length === 0 ? (
              <EmptyState
                title={t('companies.empty')}
                actions={
                  <ButtonLink href="/companies" variant="secondary">
                    {t('news.resetFilters')}
                  </ButtonLink>
                }
              />
            ) : (
              <div className="co-list">
                {shown.map((c) => {
                  const detail = details.get(c.id) ?? null;
                  const projects = detail?.projects ?? [];
                  const updated = detail?.publications[0]?.publishedAt ?? c.evidence.catalogue?.publishedAt ?? c.claimedAt ?? c.provenance?.observedAt ?? null;
                  return (
                    <article key={c.id} className="co-row">
                      <div className="co-row__main">
                        <div className="co-row__head">
                          <CompanyMark name={c.name} seed={c.handle} size={52} />
                          <div className="co-row__who">
                            <h3 className="co-row__name">
                              <NextLink href={c.href} className="co-row__link">
                                {c.name}
                              </NextLink>
                              {c.verified ? (
                                <SRMark compact size="sm" />
                              ) : (
                                <span className="co-row__status" title={t(`companies.statusHint${c.status.charAt(0).toUpperCase()}${c.status.slice(1)}` as 'companies.statusHintSourced')}>
                                  <RecordStatusChip status={c.status} size="sm" />
                                </span>
                              )}
                            </h3>
                            <p className="co-row__dirs">
                              {c.kinds.map((k) => t(`companies.kindOne.${k}`)).join(' · ')}
                              <span className="co-row__dot"> · </span>
                              <MapPin size={13} strokeWidth={2} aria-hidden="true" />
                              {regionLabel(c.region)}
                              {c.location ? (
                                <NextLink href={mapHref(c.id)} className="co-row__map" scroll={false}>
                                  {t('map.onMap')}
                                </NextLink>
                              ) : null}
                              {c.website ? (
                                <>
                                  <span className="co-row__dot"> · </span>
                                  <a href={c.website} className="co-row__site" target="_blank" rel="noopener noreferrer">
                                    {c.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                                    <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
                                  </a>
                                </>
                              ) : null}
                            </p>
                          </div>
                        </div>
                        {c.signals.length ? (
                          <p className="pp-card__signals">
                            {c.signals.slice(0, 3).map((sg) => (
                              <SignalBadge key={sg.kind} scope="company" signal={sg} size="sm" />
                            ))}
                          </p>
                        ) : null}
                        <p className="co-row__desc">{c.description ? typo(c.description) : t('companies.noDescription')}</p>
                        <ul className="co-stats" aria-label={t('companies.whatVisible')}>
                          <li className={c.projectsCount ? '' : 'is-zero'}>
                            <FolderOpen size={15} strokeWidth={2} aria-hidden="true" />
                            {t('companies.projectsCount', { count: c.projectsCount })}
                          </li>
                          <li className={c.publicationsCount ? '' : 'is-zero'}>
                            <FileText size={15} strokeWidth={2} aria-hidden="true" />
                            {t('companies.publicationsCount', { count: c.publicationsCount })}
                          </li>
                          <li className={c.evidence.catalogue?.entries ? '' : 'is-zero'}>
                            <Package size={15} strokeWidth={2} aria-hidden="true" />
                            {c.evidence.catalogue?.entries ? t('companies.catalogueEntries', { count: c.evidence.catalogue.entries }) : t('companies.evCatalogueNone')}
                          </li>
                          {c.evidence.publicMembers ? (
                            <li>
                              <Users size={15} strokeWidth={2} aria-hidden="true" />
                              {t('companies.teamCount', { count: c.evidence.publicMembers })}
                            </li>
                          ) : null}
                        </ul>
                        <p className="co-row__tags">
                          {c.directions.map((d) => (
                            <NextLink key={d} href={href({ spec: d })} className="co-tag" scroll={false}>
                              {d}
                            </NextLink>
                          ))}
                        </p>
                      </div>
                      <div className="co-row__side">
                        {projects.length ? (
                          <div className="co-row__thumbs">
                            {projects.slice(0, 3).map((p) => (
                              <NextLink key={p.id} href={p.href} className="co-row__thumb" title={t('companies.openProjectTitle', { name: p.name })} aria-label={t('companies.openProjectTitle', { name: p.name })}>
                                <MediaFrame media={projectCover(p.handle)} ratio="fill" radius="none" sizes="120px" />
                                <span className="co-row__thumb-cap">{p.name}</span>
                              </NextLink>
                            ))}
                          </div>
                        ) : (
                          <div className="co-row__noproj">
                            <FolderOpen size={18} strokeWidth={1.75} aria-hidden="true" />
                            <span>{t('companies.noProjectsYet')}</span>
                          </div>
                        )}
                        <p className="co-row__src">
                          {c.provenance
                            ? t('companies.sourceLine', { source: c.provenance.source, date: shortDate(c.provenance.observedAt) })
                            : c.claimedAt
                              ? t('companies.claimedLine', { date: shortDate(c.claimedAt) })
                              : null}
                          {updated ? <span className="co-row__upd"> · {t('companies.updatedLine', { date: shortDate(updated) })}</span> : null}
                        </p>
                        <div className="co-row__actions">
                          <NextLink href={c.href} className="pub-btn pub-btn--dark">
                            {t('companies.profile')}
                          </NextLink>
                          <NextLink href={`/login?next=${encodeURIComponent(`/app/rfq/new?company=${c.handle}`)}`} className="pub-btn">
                            {t('companies.requestQuote')}
                          </NextLink>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {filters.view !== 'map' && items.length > shown.length ? (
              <div className="pub-feed__more">
                <NextLink href={`${href({ ...filters, show: (filters.show ?? PAGE) + PAGE })}#partners`} className="pub-btn" scroll={false}>
                  {t('companies.showMore')}
                </NextLink>
              </div>
            ) : null}
          </div>

          <aside className="pub-aside" aria-label={t('companies.byRoles')}>
            <section aria-labelledby="kinds-title">
              <h3 className="pub-aside__title" id="kinds-title">
                {t('companies.byRoles')}
              </h3>
              <ul className="co-kind-list">
                {KINDS.map((k) => {
                  const Icon = KIND_ICON[k];
                  const n = all.filter((c) => c.kinds.includes(k)).length;
                  if (!n) return null;
                  return (
                    <li key={k}>
                      <NextLink href={href({ kind: k })} className="co-kind" aria-current={filters.kind === k ? 'true' : undefined} scroll={false}>
                        <span className="co-kind__icon">
                          <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                        </span>
                        <span className="co-kind__text">
                          <span className="co-kind__name">{t(`companies.kinds.${k}`)}</span>
                          <span className="co-kind__hint">{t(`companies.kindHint.${k}`)}</span>
                        </span>
                        <span className="ev-facet__count">{n}</span>
                        <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
                      </NextLink>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="pub-note" aria-labelledby="visible-title">
              <h3 className="pub-note__title" id="visible-title">
                {t('companies.whatVisible')}
              </h3>
              <ul className="co-visible">
                {[FileText, Users, FileText, ShieldCheck].map((Icon, i) => (
                  <li key={i}>
                    <Icon size={16} strokeWidth={2} aria-hidden="true" />
                    {t(`companies.visibleItems.${i}` as 'companies.visibleItems.0')}
                  </li>
                ))}
              </ul>
              <NextLink href="/#about" className="pub-more">
                {t('companies.aboutReputation')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
            <section className="pub-note pub-note--tint" aria-labelledby="claim-title">
              <h3 className="pub-note__title" id="claim-title">
                {t('companies.claimTitle')}
              </h3>
              <p className="pub-note__body">{typo(t('companies.claimBody'))}</p>
              <NextLink href="/login?next=%2Fapp%2Fcompany" className="pub-btn">
                {t('companies.claimAction')}
              </NextLink>
            </section>
          </aside>
        </div>

        {sharing.length ? (
          <section className="pub-section" aria-labelledby="sharing-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="sharing-title">
                {typo(t('companies.sharingTitle'))}
              </h2>
              <NextLink href="/articles" className="pub-more">
                {t('companies.sharingAll')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="pub-people">
              {sharing.map((card) => {
                const company = card.authorHref ? companyByHref.get(card.authorHref) : undefined;
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
                      {company ? <CompanyMark name={company.name} seed={company.handle} size={20} /> : null}
                      {card.authorHref ? <NextLink href={card.authorHref}>{card.authorLabel}</NextLink> : <span>{card.authorLabel}</span>}
                      {card.readMinutes ? <span className="co-story__sep">· {t('articles.readTime', { minutes: card.readMinutes })}</span> : null}
                    </p>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {projects.length ? (
          <section className="pub-section" aria-labelledby="co-projects-title">
            <div className="pub-h2-row">
              <h2 className="pub-h2" id="co-projects-title">
                {typo(t('companies.projectsTitle'))}
              </h2>
              <NextLink href="/projects" className="pub-more">
                {t('companies.projectsAll')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="co-projects">
              {projects.map((p) => (
                <article key={p.id} className="co-project">
                  <NextLink href={p.href} className="co-project__media" aria-hidden="true" tabIndex={-1}>
                    <MediaFrame media={projectCover(p.handle)} ratio="fill" radius="none" sizes="(max-width: 767px) 100vw, 320px" />
                  </NextLink>
                  <div className="co-project__body">
                    <span className="pub-kicker">
                      {t('publicNav.6')} · {regionLabel(p.region)}
                    </span>
                    <h3 className="co-project__title">
                      <NextLink href={p.href}>{typo(p.name)}</NextLink>
                    </h3>
                    {p.summary ? <p className="co-project__summary">{typo(p.summary)}</p> : null}
                    <p className="co-project__label">{t('companies.projectParticipants')}</p>
                    <p className="co-row__tags">
                      {p.publicParticipants.slice(0, 4).map((pp) =>
                        pp.href ? (
                          <NextLink key={pp.label} href={pp.href} className="co-tag">
                            {pp.label}
                          </NextLink>
                        ) : (
                          <span key={pp.label} className="co-tag">
                            {pp.label}
                          </span>
                        ),
                      )}
                    </p>
                    <NextLink href={p.href} className="pub-more">
                      {t('companies.openProject')}
                      <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                    </NextLink>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <section className="pub-cta" aria-labelledby="co-cta-title">
        <div className="pub-wrap pub-cta__inner">
          <div>
            <h2 className="pub-cta__title" id="co-cta-title">
              {typo(t('companies.ctaTitle'))}
            </h2>
            <p className="pub-cta__body">{typo(t('companies.ctaBody'))}</p>
          </div>
          <div className="pub-cta__actions">
            <NextLink href="/login?next=%2Fapp%2Fcompany" className="pub-btn pub-btn--light">
              {t('companies.ctaCreate')}
            </NextLink>
            <NextLink href="/login" className="pub-cta__link">
              {t('companies.ctaSignIn')}
              <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
      </section>
    </div>
  );
}
