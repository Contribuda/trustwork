import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ButtonLink, EmptyState, Link } from '@/components/ui';
import { CreateMenu } from '@/components/workspace/CreateMenu';
import { CardSkeleton, DecisionList, EventList, PageHeader, ProjectRows, WorkspaceCard } from '@/components/workspace/parts';
import { LeadListRow, PublicationListRow, RfqListRow } from '@/components/workspace/WorkRows';
import { data, type AuthenticatedPrincipal } from '@/app/_lib/data';
import { hrefFor, requirePrincipal, scenarioDelay, type PageSearchParams } from '@/app/_lib/principal';
import { longDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('overview.title') };
}

/**
 * Daily overview (R23): decisions on top, procurement and sales side by side for the mixed persona, projects,
 * events, publications and one assistant line. Panels appear by capability and content; the sidebar never changes.
 */
export default async function OverviewPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app');
  const overview = await data.getOverview(principal);
  const createItems: Array<{ id: 'need' | 'quote' | 'project' | 'publication'; href: string }> = [
    ...(overview.procurement.show ? [{ id: 'need' as const, href: hrefFor(principal, '/app/procurement') }] : []),
    ...(overview.sales.show ? [{ id: 'quote' as const, href: hrefFor(principal, '/app/sales') }] : []),
    { id: 'project', href: hrefFor(principal, '/app/projects') },
    { id: 'publication', href: hrefFor(principal, '/app/publications') },
  ];
  return (
    <>
      <PageHeader title={t('overview.title')} kicker={longDate(new Date().toISOString())} lede={t(`overview.subtitle.${overview.variant}`)} actions={<CreateMenu items={createItems} />} />
      <Suspense fallback={<CardSkeleton label={t('ws.loading')} />}>
        <OverviewBody principal={principal} />
      </Suspense>
    </>
  );
}

async function OverviewBody({ principal }: { principal: AuthenticatedPrincipal }) {
  await scenarioDelay(principal.demo);
  const o = await data.getOverview(principal);
  const link = (path: string) => hrefFor(principal, path);
  return (
    <div className="ws-section" style={{ gap: 24 }}>
      {o.decisions.length ? (
        <WorkspaceCard id="decisions" title={t('overview.decisions')} count={o.decisions.length}>
          <DecisionList rows={o.decisions} />
        </WorkspaceCard>
      ) : null}

      {o.procurement.show || o.sales.show ? (
        <div className={`ws-grid ${o.procurement.show && o.sales.show ? 'ws-grid--2' : ''}`}>
          {o.procurement.show ? (
            <WorkspaceCard id="procurement" title={t('overview.procurement.title')} count={o.procurement.inProgress} allHref={link('/app/procurement')} allLabel={t('overview.procurement.all')}>
              {o.procurement.rows.length ? (
                <ul className="ws-list">
                  {o.procurement.rows.map((row) => (
                    <RfqListRow key={row.id} row={row} projectHref={row.projectId ? link(`/app/projects/${row.projectId}`) : null} />
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title={t('overview.procurement.empty')}
                  headingLevel={3}
                  actions={
                    <>
                      <ButtonLink href={link('/app/procurement')} size="sm">
                        {t('overview.procurement.createNeed')}
                      </ButtonLink>
                      <ButtonLink href="/companies" size="sm" variant="secondary">
                        {t('overview.procurement.findSupplier')}
                      </ButtonLink>
                    </>
                  }
                />
              )}
            </WorkspaceCard>
          ) : null}
          {o.sales.show ? (
            <WorkspaceCard id="sales" title={t('overview.sales.title')} count={o.sales.inProgress} allHref={link('/app/sales')} allLabel={t('overview.sales.allQuotes')}>
              {o.sales.rows.length ? (
                <>
                  <ul className="ws-list">
                    {o.sales.rows.map((row) => (
                      <LeadListRow key={row.id} row={row} />
                    ))}
                  </ul>
                  <p style={{ marginTop: 'var(--space-3)' }}>
                    <Link href={link('/app/company#catalogue')} variant="standalone">
                      {t('overview.sales.catalogue')}
                    </Link>
                  </p>
                </>
              ) : (
                <EmptyState
                  title={t('overview.sales.empty')}
                  headingLevel={3}
                  actions={
                    o.sales.canFillCatalogue ? (
                      <ButtonLink href={link('/app/company#catalogue')} size="sm">
                        {t('overview.sales.fillCatalogue')}
                      </ButtonLink>
                    ) : undefined
                  }
                />
              )}
            </WorkspaceCard>
          ) : null}
        </div>
      ) : null}

      <div className="ws-grid ws-grid--main">
        <WorkspaceCard id="projects" title={t('overview.projects.title')} allHref={link('/app/projects')} allLabel={t('overview.projects.all')}>
          {o.projects.length ? (
            <ProjectRows rows={o.projects} />
          ) : (
            <EmptyState
              title={t('overview.projects.empty')}
              headingLevel={3}
              actions={
                <ButtonLink href={link('/app/projects')} size="sm">
                  {t('overview.projects.create')}
                </ButtonLink>
              }
            >
              <p>{t('projectsWs.emptyHint')}</p>
            </EmptyState>
          )}
        </WorkspaceCard>
        <WorkspaceCard id="events" title={t('overview.events.title')}>
          {o.events.length ? <EventList rows={o.events} /> : <EmptyState title={t('overview.events.empty')} headingLevel={3} />}
        </WorkspaceCard>
      </div>

      <div className="ws-grid ws-grid--2">
        <WorkspaceCard id="publications" title={t('overview.publications.title')} allHref={link('/app/publications')} allLabel={t('overview.publications.all')}>
          {o.publications.length ? (
            <ul className="ws-list">
              {o.publications.map((row) => (
                <PublicationListRow key={row.id} row={row} />
              ))}
            </ul>
          ) : (
            <EmptyState
              title={t('overview.publications.empty')}
              headingLevel={3}
              actions={
                <ButtonLink href={link('/app/publications')} size="sm">
                  {t('overview.publications.write')}
                </ButtonLink>
              }
            />
          )}
        </WorkspaceCard>
        <WorkspaceCard id="assistant" title={t('overview.assistant.title')} allHref={link('/app/assistant')} allLabel={t('overview.assistant.open')}>
          <p>{t('overview.assistant.summary', { running: o.assistant.running, approvals: o.assistant.approvals, unknown: o.assistant.unknown })}</p>
        </WorkspaceCard>
      </div>

      {o.industryPicks.length ? (
        <WorkspaceCard id="industry" title={t('overview.industryPicks')} allHref="/" allLabel={t('publicExit')}>
          <ul className="ws-chips">
            {o.industryPicks.map((card) => (
              <li key={card.id}>
                <Link href={card.href} className="ws-chip">
                  {card.title}
                </Link>
              </li>
            ))}
          </ul>
        </WorkspaceCard>
      ) : null}
    </div>
  );
}
