import { Suspense, type ReactNode } from 'react';
import NextLink from 'next/link';
import { ButtonLink, EmptyState, Skeleton, SkeletonGroup, StatusChip } from '@/components/ui';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { STAFF_PERSONA_IDS, consoleHref, type ConsoleRequest } from '../_data/personas';
import type { StaffViewer } from '../_data/port';
import { sectionById, type GroupDef, type SectionRef, type SectionStatus } from '../_data/sections';
import { resolveHub, type HubContext, type HubParams, type PageSearchParams } from './context';
import { list } from './format';
import { NavSheet } from './NavSheet';

/* ---------- Small server parts ---------- */

/** Live / Demo / Contract / Designed / Proposed, always as text (never colour alone). */
export function StatusLabel({ status }: { status: SectionStatus | 'live' | 'contract' | 'proposed' }) {
  const tone = status === 'live' ? 'success' : status === 'demo' ? 'info' : 'neutral';
  return (
    <StatusChip size="sm" tone={tone}>
      {tDynamic(`admin.status.${status}`, status)}
    </StatusChip>
  );
}

/** Every page header names the one hub it acts on (no hub switcher anywhere). */
export function ConsoleHeader({ ctx, title, lede, status = 'demo', actions }: { ctx: HubContext; title: string; lede?: string | undefined; status?: SectionStatus; actions?: ReactNode }) {
  return (
    <header className="admin-head">
      <p className="admin-head__kicker" data-testid="acts-on">
        {t('admin.hubBand.actsOn')}{' '}
        <strong lang={ctx.hubName.lang}>{ctx.hubName.text}</strong>
      </p>
      <div className="admin-head__row">
        <h1 tabIndex={-1} className="admin-h1">
          {title}
        </h1>
        <StatusLabel status={status} />
      </div>
      {lede ? <p className="admin-lede">{lede}</p> : null}
      {actions ? <div className="admin-head__actions">{actions}</div> : null}
    </header>
  );
}

/** A titled panel (the console's card): `section` labelled by its heading; the heading may carry a data language. */
export function Panel({ id, title, titleLang, level = 2, aside, children, className }: { id: string; title: string; titleLang?: string | undefined; level?: 2 | 3; aside?: ReactNode; children: ReactNode; className?: string | undefined }) {
  const Heading = `h${level}` as const;
  return (
    <section className={`admin-panel ${className ?? ''}`} aria-labelledby={`${id}-title`} id={id}>
      <div className="admin-panel__head">
        <Heading id={`${id}-title`} className={level === 2 ? 'admin-h2' : 'admin-h3'} {...(titleLang ? { lang: titleLang } : {})}>
          {title}
        </Heading>
        {aside ? <div className="admin-panel__aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function KeyValues({ rows }: { rows: ReadonlyArray<{ label: string; value: ReactNode; lang?: string | undefined }> }) {
  return (
    <dl className="admin-dl">
      {rows.map((row) => (
        <div key={row.label} className="admin-dl__row">
          <dt>{row.label}</dt>
          <dd {...(row.lang ? { lang: row.lang } : {})}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function roleList(roles: readonly string[]): string {
  return list(roles.map((r) => tDynamic(`admin.roles.${r}`, r)));
}

/* ---------- Navigation ---------- */

function ConsoleNav({ groups, current, href }: { groups: readonly GroupDef[]; current: SectionRef | null; href: (path: string) => string }) {
  return (
    <nav aria-label={t('admin.navLabel')} className="admin-nav">
      {groups.map((group) => {
        const open = group.id === 'home' || group.id === 'hub' || group.id === current?.group.id;
        return (
          <details key={group.id} className="admin-nav__group" open={open}>
            <summary className="admin-nav__summary">{tDynamic(`admin.nav.${group.id}`, group.id)}</summary>
            <ul className="admin-nav__list">
              {group.sections.map((section) => {
                const isCurrent = current?.group.id === group.id && current.section.id === section.id;
                return (
                  <li key={section.id}>
                    <NextLink href={href(section.path)} className="admin-nav__link" {...(isCurrent ? { 'aria-current': 'page' as const } : {})}>
                      <span>{tDynamic(`admin.sections.${group.id}.${section.id}`, section.id)}</span>
                      {section.status === 'designed' ? <span className="admin-nav__status">{t('admin.status.designed')}</span> : null}
                    </NextLink>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </nav>
  );
}

/* ---------- Bands under the header ---------- */

function PersonaSwitch({ request, selfPath }: { request: Extract<ConsoleRequest, { demo: true }>; selfPath: string }) {
  const current = request.persona ? tDynamic(`admin.demo.personas.${request.persona}`, request.persona) : t('admin.demo.nobody');
  return (
    <details className="admin-personas">
      <summary>{t('admin.demo.current', { persona: current })}</summary>
      <ul className="admin-personas__list" aria-label={t('admin.demo.choose')}>
        {STAFF_PERSONA_IDS.map((id) => (
          <li key={id}>
            <NextLink href={consoleHref(selfPath, { demo: true, persona: id, scenario: 'default' })} {...(id === request.persona ? { 'aria-current': 'true' as const } : {})}>
              {tDynamic(`admin.demo.personas.${id}`, id)}
            </NextLink>
          </li>
        ))}
      </ul>
    </details>
  );
}

export type ShellHub = { name: { text: string; lang: string }; lifecycle: string; demoData: boolean; maintenance: boolean; engagedSwitches: string[] };

function Bands({ hub, request, selfPath, offline, showPersonas }: { hub: ShellHub | null; request: ConsoleRequest; selfPath: string; offline: boolean; showPersonas: boolean }) {
  const demo = request.demo;
  if (!demo && !hub?.maintenance && !hub?.engagedSwitches.length && !offline) return null;
  return (
    <div className="admin-bands">
      {demo || hub?.demoData ? (
        <div className="admin-bands__row admin-bands__row--demo" data-testid="admin-demo-band">
          <p>{t('admin.bands.demo')}</p>
          {request.demo && showPersonas ? <PersonaSwitch request={request} selfPath={selfPath} /> : null}
        </div>
      ) : null}
      {hub?.maintenance ? (
        <p className="admin-bands__row admin-bands__row--warning" data-testid="admin-maintenance-band">
          {t('admin.bands.maintenance')}
        </p>
      ) : null}
      {hub?.engagedSwitches.map((scope) => (
        <p key={scope} className="admin-bands__row admin-bands__row--danger" data-testid="admin-kill-switch-band">
          {t('admin.bands.killSwitch', { scope: tDynamic(`admin.killSwitch.scopes.${scope}`, scope) })}
        </p>
      ))}
      {offline ? (
        <p className="admin-bands__row admin-bands__row--warning" data-testid="admin-offline-band">
          {t('admin.bands.offline')}
        </p>
      ) : null}
    </div>
  );
}

/* ---------- Shell ---------- */

/**
 * `AdminShell` (docs/engine/hub-console/README.md): a distinct navy band labelled "Administration" with the one hub
 * this page acts on and its lifecycle stage, the viewer, Help in the same place on every page and the way back to the
 * workspace; demo, maintenance, kill-switch and offline bands under it; the permission-filtered navigation (a sheet
 * below 768 px). There is no hub switcher: other hubs are reached from the node's hub list or by address.
 */
export function AdminShell({
  request,
  hub,
  viewer,
  roles,
  nav,
  current,
  navHref,
  helpHref,
  selfPath,
  offline = false,
  showPersonas = true,
  label,
  children,
}: {
  request: ConsoleRequest;
  hub: ShellHub | null;
  viewer: StaffViewer | null;
  roles: readonly string[];
  nav: readonly GroupDef[] | null;
  current: SectionRef | null;
  navHref: (path: string) => string;
  helpHref: string | null;
  selfPath: string;
  offline?: boolean;
  showPersonas?: boolean;
  /** A label after "Administration" when no hub is named (the setup wizard). */
  label?: string | undefined;
  children: ReactNode;
}) {
  const navigation = nav && nav.length ? <ConsoleNav groups={nav} current={current} href={navHref} /> : null;
  return (
    <div className="admin" data-testid="admin-shell">
      <a href="#admin-main" className="admin-skip">
        {t('shell.skipToContent')}
      </a>
      <header className="admin-band">
        <div className="admin-band__title">
          <span className="admin-band__label">{t('admin.title')}</span>
          {hub ? (
            <>
              <span className="admin-band__hub" lang={hub.name.lang} data-testid="admin-hub-name">
                {hub.name.text}
              </span>
              <span className="admin-band__stage">{t('admin.hubBand.stage', { stage: tDynamic(`admin.lifecycle.${hub.lifecycle}`, hub.lifecycle) })}</span>
            </>
          ) : label ? (
            <span className="admin-band__hub">{label}</span>
          ) : null}
        </div>
        <div className="admin-band__side">
          {viewer ? (
            <p className="admin-band__viewer">
              <span lang={viewer.person.nameLang}>{viewer.person.displayName}</span>
              {roles.length ? <span className="admin-band__roles"> · {roleList(roles)}</span> : null}
            </p>
          ) : null}
          <nav aria-label={t('admin.bandLinks')} className="admin-band__links">
            {helpHref ? (
              <NextLink href={helpHref} className="admin-band__link">
                {t('admin.helpLink')}
              </NextLink>
            ) : null}
            <NextLink href="/app" className="admin-band__link">
              {t('admin.backToWorkspace')}
            </NextLink>
          </nav>
          {navigation ? (
            <NavSheet label={t('admin.menu')} title={t('admin.navLabel')}>
              {navigation}
            </NavSheet>
          ) : null}
        </div>
      </header>
      <Bands hub={hub} request={request} selfPath={selfPath} offline={offline} showPersonas={showPersonas} />
      <div className={`admin-layout${navigation ? '' : ' admin-layout--plain'}`}>
        {navigation ? <aside className="admin-sidebar">{navigation}</aside> : null}
        <main id="admin-main" tabIndex={-1} className="admin-main">
          {children}
        </main>
      </div>
    </div>
  );
}

/* ---------- States ---------- */

export function DeniedState({ title, body, roles }: { title: string; body?: string | undefined; roles?: readonly string[] | undefined }) {
  return (
    <div className="admin-state" data-testid="admin-denied">
      <EmptyState tone="denied" title={title} headingLevel={2}>
        {body ? <p>{body}</p> : null}
        {roles && roles.length ? <p>{t('admin.denied.rolesGrant', { roles: roleList(roles) })}</p> : null}
      </EmptyState>
    </div>
  );
}

function ElevationGate({ ctx }: { ctx: HubContext }) {
  return (
    <div className="admin-state" data-testid="admin-elevation">
      <EmptyState
        title={t('admin.elevation.title')}
        headingLevel={2}
        actions={<ButtonLink href={consoleHref(ctx.href(ctx.current.section.path).split('?')[0] ?? '', ctx.request.demo ? { ...ctx.request, scenario: 'default' } : ctx.request)}>{t('admin.elevation.action')}</ButtonLink>}
      >
        <p>{t('admin.elevation.body')}</p>
        {ctx.request.demo ? <p>{t('admin.elevation.demoNote')}</p> : null}
      </EmptyState>
    </div>
  );
}

async function Delayed({ children }: { children: ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, 6000));
  return <>{children}</>;
}

function LoadingSkeleton() {
  return (
    <SkeletonGroup label={t('admin.common.loading')}>
      <Skeleton variant="row" lines={4} />
    </SkeletonGroup>
  );
}

export function shellHub(ctx: HubContext): ShellHub {
  return {
    name: ctx.hubName,
    lifecycle: ctx.record.hub.lifecycle,
    demoData: ctx.record.modes.dataMode === 'demo',
    maintenance: ctx.record.modes.maintenance,
    engagedSwitches: ctx.record.killSwitches.filter((k) => k.state === 'engaged').map((k) => k.scope.kind),
  };
}

/**
 * The frame of every hub console page: resolves the viewer, the hub and the section, then renders the shell with the
 * page, the elevation gate or the denied state. Demo scenarios: `error` throws to the error boundary, `loading`
 * streams a skeleton first, `offline` disables every form, `maintenance` and `kill-switch-engaged` show their bands.
 */
export async function HubConsolePage({
  params,
  searchParams,
  section,
  children,
}: {
  params: HubParams;
  searchParams: PageSearchParams;
  section: SectionRef | { group: string; id: string };
  children: (ctx: HubContext) => ReactNode | Promise<ReactNode>;
}) {
  await primeLocale();
  const current = 'section' in section ? section : sectionById(section.group, section.id);
  const resolution = await resolveHub(params, searchParams, current);
  const { ctx } = resolution;
  const showNav = resolution.kind === 'ok' || (resolution.kind === 'denied' && resolution.reason === 'section');
  let body: ReactNode;
  if (resolution.kind === 'elevation') body = <ElevationGate ctx={ctx} />;
  else if (resolution.kind === 'denied') {
    body =
      resolution.reason === 'section' ? (
        <DeniedState title={t('admin.denied.title')} roles={await ctx.port.rolesGranting(current.section)} />
      ) : (
        <DeniedState title={t('admin.denied.noStaffTitle')} body={t(resolution.reason === 'hub_not_covered' ? 'admin.denied.hubNotCovered' : 'admin.denied.noStaffBody')} />
      );
  } else {
    if (ctx.request.demo && ctx.request.scenario === 'error') throw new Error('Demo scenario: simulated console failure');
    const content = await children(ctx);
    body =
      ctx.request.demo && ctx.request.scenario === 'loading' ? (
        <Suspense fallback={<LoadingSkeleton />}>
          <Delayed>{content}</Delayed>
        </Suspense>
      ) : (
        content
      );
  }
  return (
    <AdminShell
      request={ctx.request}
      hub={shellHub(ctx)}
      viewer={ctx.viewer}
      roles={ctx.access.roles}
      nav={showNav ? ctx.nav : null}
      current={current}
      navHref={(path) => ctx.href(path)}
      helpHref={showNav ? ctx.href('help') : null}
      selfPath={ctx.href(current.section.path).split('?')[0] ?? '/admin'}
      offline={ctx.offline}
    >
      {body}
    </AdminShell>
  );
}
