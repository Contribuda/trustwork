import type { Metadata } from 'next';
import NextLink from 'next/link';
import { Button } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { ProjectRow } from '@/components/workspace/ProjectRow';
import { data } from '@/app/_lib/data';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('projectsWs.title') };
}

const STATUSES = ['active', 'planned', 'suspended', 'completed'] as const;
const ROLES = ['owner', 'leader', 'participant'] as const;

/**
 * Workspace projects: own, led and participated projects only; a personal project needs no company.
 * Filters are plain links (status, my role) so the list stays shareable and works without JavaScript.
 */
export default async function WorkspaceProjectsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/projects');
  const sp = await searchParams;
  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status) ? sp.status : 'all';
  const role = typeof sp.role === 'string' && (ROLES as readonly string[]).includes(sp.role) ? sp.role : 'all';
  const all = await data.listWorkspaceProjects(principal);
  const rows = all.filter((r) => (status === 'all' || r.status === status) && (role === 'all' || r.myRole === role));
  const link = (s: string, r: string) => {
    const q = [s !== 'all' ? `status=${s}` : '', r !== 'all' ? `role=${r}` : ''].filter(Boolean).join('&');
    return hrefFor(principal, `/app/projects${q ? `?${q}` : ''}`);
  };
  const stats = {
    total: all.length,
    active: all.filter((r) => r.status === 'active').length,
    delayed: all.filter((r) => r.progress.delayed).length,
    published: all.filter((r) => r.isPublished).length,
  };
  return (
    <>
      <PageHeader
        title={t('projectsWs.title')}
        lede={t('projectsWs.lede')}
        actions={
          <Button variant="accent" isDisabled aria-describedby="projects-create-note">
            {t('projectsWs.create')}
          </Button>
        }
      />
      {all.length === 0 ? (
        <div className="ws-empty">
          <strong>{t('projectsWs.empty')}</strong>
          <span>{t('projectsWs.emptyHint')}</span>
        </div>
      ) : (
        <div className="ws-section" style={{ gap: 20 }}>
          <ul className="ws-stats">
            <li className="ws-stat">
              <strong>{stats.total}</strong>
              <span>{t('projectsWs.stats.total')}</span>
            </li>
            <li className="ws-stat">
              <strong>{stats.active}</strong>
              <span>{t('projectsWs.stats.active')}</span>
            </li>
            <li className="ws-stat">
              <strong>{stats.delayed}</strong>
              <span>{t('projectsWs.stats.delayed')}</span>
            </li>
            <li className="ws-stat">
              <strong>{stats.published}</strong>
              <span>{t('projectsWs.stats.published')}</span>
            </li>
          </ul>
          <div className="ws-filters">
            <nav className="ws-filter" aria-label={t('projectsWs.filter.status')}>
              <span className="ws-filter__label">{t('projectsWs.filter.status')}</span>
              <NextLink href={link('all', role)} className={`ws-chip${status === 'all' ? ' ws-chip--on' : ''}`} aria-current={status === 'all' ? 'true' : undefined}>
                {t('projectsWs.filter.all')}
              </NextLink>
              {STATUSES.map((s) => (
                <NextLink key={s} href={link(s, role)} className={`ws-chip${status === s ? ' ws-chip--on' : ''}`} aria-current={status === s ? 'true' : undefined}>
                  {t(`projectStatus.${s}`)}
                </NextLink>
              ))}
            </nav>
            <nav className="ws-filter" aria-label={t('projectsWs.filter.role')}>
              <span className="ws-filter__label">{t('projectsWs.filter.role')}</span>
              <NextLink href={link(status, 'all')} className={`ws-chip${role === 'all' ? ' ws-chip--on' : ''}`} aria-current={role === 'all' ? 'true' : undefined}>
                {t('projectsWs.filter.all')}
              </NextLink>
              {ROLES.map((r) => (
                <NextLink key={r} href={link(status, r)} className={`ws-chip${role === r ? ' ws-chip--on' : ''}`} aria-current={role === r ? 'true' : undefined}>
                  {t(`role.${r}`)}
                </NextLink>
              ))}
            </nav>
          </div>
          {rows.length ? (
            <ul className="ws-list" aria-label={t('projectsWs.list')}>
              {rows.map((row) => (
                <ProjectRow key={row.id} row={row} />
              ))}
            </ul>
          ) : (
            <div className="ws-empty">
              <strong>{t('projectsWs.noMatch')}</strong>
              <NextLink href={link('all', 'all')} className="ws-more">
                {t('projectsWs.resetFilters')}
              </NextLink>
            </div>
          )}
        </div>
      )}
      <p id="projects-create-note" className="ws-note" style={{ marginTop: 24 }}>
        {t('projectsWs.createDisabled')}
      </p>
    </>
  );
}
