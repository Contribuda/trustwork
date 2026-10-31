import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, ArrowUpRight, Building2, EyeOff, Globe, Users } from 'lucide-react';
import { KindBadge, StatusChip } from '@/components/ui';
import { CompanyTabs } from '@/components/public/CompanyTabs';
import { CompanyMark } from '@/components/public/CompanyMark';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { regionLabel } from '@/components/public/parts';
import { SRMark } from '@/components/public/SRMark';
import { DecisionList, PageHeader, ProjectRows } from '@/components/workspace/parts';
import { PublicationListRow } from '@/components/workspace/WorkRows';
import { DATA_SOURCE, data } from '@/app/_lib/data';
import { CompanyStatusChip } from '@/components/public/parts';
import { CompanyCreateForm } from './_components/CompanyCreateForm';
import { InviteMemberForm } from './_components/InviteMemberForm';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { formatMoney, longDate, t, tDynamic } from '@/app/_lib/i18n';
import { currencyCode, identifierLabel } from '@/app/_lib/country';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('company.title') };
}

/**
 * «Компания»: shared hub for the one current employer (no switcher). Without a company: purposeful empty
 * state with optional join/create; the rest of the workspace keeps working. Private floors only with the grant.
 * Live API (WEB-004): the empty state creates the company page, administrators with `company.members.manage`
 * invite colleagues, and the member list shows names only of public profiles.
 */
export default async function CompanyWorkspacePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/company');
  const view = await data.getCompanyWorkspace(principal);
  const live = DATA_SOURCE === 'api';
  if (!view) {
    return (
      <>
        <PageHeader title={t('company.title')} lede={t('company.empty.lede')} />
        <div className="ws-grid ws-grid--main">
          <div className="ws-empty">
            <strong>{t('company.empty.title')}</strong>
            <span>{typo(t('company.empty.body'))}</span>
            {live ? (
              <span className="ws-note">{t('company.empty.invitationByEmail')}</span>
            ) : (
              <span className="ws-actions">
                <NextLink href={hrefFor(principal, '/app/company#join')} className="pub-btn">
                  {t('company.empty.join')}
                </NextLink>
                <NextLink href={hrefFor(principal, '/app/company#create')} className="pub-btn pub-btn--ghost">
                  {t('company.empty.create')}
                </NextLink>
              </span>
            )}
            <span className="ws-note">{t('company.empty.policyNote')}</span>
          </div>
          <div className="ws-card ws-card--navy">
            <h2 className="ws-h2">{t('company.empty.find')}</h2>
            <p className="ws-muted">{t('company.empty.findHint')}</p>
            <NextLink href="/companies" className="ws-more">
              {t('publicNav.1')}
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        </div>
        {live ? <CompanyCreateForm /> : null}
      </>
    );
  }
  const isAdmin = view.myRole === 'administrator';
  const canInvite = live && view.permissions.includes('company.members.manage');
  const c = view.company;
  const publicMembers = view.members.filter((m) => m.isPublic).length;
  const activeMembers = view.members.filter((m) => m.status === 'active').length;

  const tabs = [
    {
      id: 'overview',
      label: t('company.tabs.overview'),
      content: (
        <div className="ws-grid ws-grid--main">
          <div className="ws-section">
            <div className="ws-h2-row">
              <h3 className="ws-h2">
                {t('company.decisions')}
                {view.decisions.length ? <span className="ev-badge ev-badge--paid">{view.decisions.length}</span> : null}
              </h3>
            </div>
            {view.decisions.length ? (
              <DecisionList rows={view.decisions} />
            ) : (
              <div className="ws-empty">
                <strong>{t('overview.decisionsEmpty')}</strong>
              </div>
            )}
            <div className="ws-h2-row">
              <h3 className="ws-h2">{t('company.tabs.wall')}</h3>
              <NextLink href={hrefFor(principal, '/app/publications')} className="ws-more">
                {t('overview.publications.all')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            {view.wall.length ? (
              <ul className="ws-list">
                {view.wall.slice(0, 3).map((row) => (
                  <PublicationListRow key={row.id} row={row} />
                ))}
              </ul>
            ) : (
              <p className="ws-muted">{t('company.wallEmpty')}</p>
            )}
          </div>
          <div className="ws-section">
            <div className="ws-card">
              <h3 className="ws-h2">{t('company.claim.title')}</h3>
              <span className="ws-hero__chips">
                <CompanyStatusChip status={c.status} size="sm" />
                {c.verified ? <SRMark compact size="sm" /> : null}
              </span>
              <p className="ws-muted">{typo(t(`company.claim.${c.status}`))}</p>
              {isAdmin && view.pendingRequests ? <p className="ws-row__banner">{t('company.claim.pendingRequests', { count: view.pendingRequests })}</p> : null}
              <NextLink href={c.href} className="ws-more">
                {t('company.publicPage')}
                <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="ws-card">
              <h3 className="ws-h2">{t('company.evidence.title')}</h3>
              <dl className="ws-facts">
                <div>
                  <dt>{t('company.evidence.identifier')}</dt>
                  <dd>{c.evidence.identifier ? `${identifierLabel(c.evidence.identifier.kind)} · ${t(`company.claim.${c.evidence.identifier.status}`)}` : t('company.evidence.none')}</dd>
                </div>
                <div>
                  <dt>{t('company.evidence.domain')}</dt>
                  <dd>{c.evidence.domainVerified ? t('company.evidence.domainYes') : t('company.evidence.domainNo')}</dd>
                </div>
                <div>
                  <dt>{t('company.tabs.catalogue')}</dt>
                  <dd>{view.catalogue ? t('company.catalogue.version', { version: view.catalogue.version, date: longDate(view.catalogue.publishedAt) }) : t('company.catalogue.empty')}</dd>
                </div>
                <div>
                  <dt>{t('company.evidence.publicMembers')}</dt>
                  <dd>{publicMembers}</dd>
                </div>
              </dl>
              <p className="ws-note">{t('company.evidence.note')}</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'wall',
      label: t('company.tabs.wall'),
      content: view.wall.length ? (
        <ul className="ws-list" style={{ maxWidth: '56rem' }}>
          {view.wall.map((row) => (
            <PublicationListRow key={row.id} row={row} />
          ))}
        </ul>
      ) : (
        <div className="ws-empty">
          <strong>{t('company.wallEmpty')}</strong>
        </div>
      ),
    },
    {
      id: 'people',
      label: t('company.tabs.people'),
      content: view.members.length ? (
        <div className="ws-section">
          <p className="ws-muted">{t('company.peopleHint')}</p>
          <ul className="ws-list ws-grid--2" style={{ display: 'grid' }}>
            {view.members.map((m) => (
              <li key={m.id} className="ws-person">
                <PersonAvatar name={m.name || t('company.member.privateName')} portrait={null} size={40} />
                <span className="ws-row__main">
                  <span className="ws-row__title">{m.name || t('company.member.privateName')}</span>
                  <span className="ws-row__meta">
                    <StatusChip size="sm" tone={m.role === 'administrator' ? 'info' : 'neutral'}>
                      {t(`role.${m.role}`)}
                    </StatusChip>
                    <span>{tDynamic(`company.member.status_${m.status}`, m.status)}</span>
                    {m.since ? <span>{t('company.member.sinceDate', { date: longDate(m.since) })}</span> : null}
                    {!m.isPublic ? (
                      <span>
                        <EyeOff size={12} strokeWidth={2} aria-hidden="true" /> {t('company.member.hidden')}
                      </span>
                    ) : null}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {canInvite ? <InviteMemberForm companyId={c.id} /> : isAdmin ? <p className="ws-note">{t('company.member.inviteNote')}</p> : null}
        </div>
      ) : (
        <div className="ws-empty">
          <strong>{t('company.membersEmpty')}</strong>
          {canInvite ? <InviteMemberForm companyId={c.id} /> : null}
        </div>
      ),
    },
    {
      id: 'catalogue',
      label: t('company.tabs.catalogue'),
      content:
        view.catalogue && view.catalogue.entries.length ? (
          <div className="ws-section" id="catalogue">
            <p className="ws-muted">
              {t('company.catalogue.version', { version: view.catalogue.version, date: longDate(view.catalogue.publishedAt) })} · {t('company.catalogue.count', { count: view.catalogue.entries.length })}
            </p>
            <div className="ws-table-wrap">
              <table className="ws-table">
                <caption>{t('company.catalogue.version', { version: view.catalogue.version, date: longDate(view.catalogue.publishedAt) })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('company.catalogue.name')}</th>
                    <th scope="col">{t('company.catalogue.kind')}</th>
                    <th scope="col">{t('company.catalogue.unit')}</th>
                    <th scope="col">{t('company.catalogue.price')}</th>
                    <th scope="col">{t('company.catalogue.public')}</th>
                    {view.canSeeFloors ? <th scope="col">{t('company.catalogue.privateFloor')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {view.catalogue.entries.map((e) => (
                    <tr key={e.id}>
                      <td data-label={t('company.catalogue.name')}>
                        <strong>{typo(e.name)}</strong>
                      </td>
                      <td data-label={t('company.catalogue.kind')}>
                        <KindBadge kind={e.kind} size="sm" />
                      </td>
                      <td data-label={t('company.catalogue.unit')}>{tDynamic(`unitLabel.${e.unit}`, e.unit)}</td>
                      <td data-label={t('company.catalogue.price')}>{e.priceOnRequest ? t('company.catalogue.priceOnRequest') : '—'}</td>
                      <td data-label={t('company.catalogue.public')}>{e.isPublic ? t('company.catalogue.yes') : t('company.catalogue.no')}</td>
                      {view.canSeeFloors ? <td data-label={t('company.catalogue.privateFloor')}>{e.privateFloorMinorUnits ? formatMoney(e.privateFloorMinorUnits, currencyCode()) : '—'}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="ws-note">{view.canSeeFloors ? t('company.catalogue.floorNote') : t('company.catalogue.publicNote')}</p>
          </div>
        ) : (
          <div className="ws-empty" id="catalogue">
            <strong>{t('company.catalogue.empty')}</strong>
            <span>{t('company.catalogue.emptyHint')}</span>
          </div>
        ),
    },
    {
      id: 'projects',
      label: t('company.tabs.projects'),
      content: view.projects.length ? (
        <ProjectRows rows={view.projects} />
      ) : (
        <div className="ws-empty">
          <strong>{t('company.projectsEmpty')}</strong>
        </div>
      ),
    },
    {
      id: 'reputation',
      label: t('company.tabs.reputation'),
      content: (
        <div className="ws-empty" style={{ maxWidth: '40rem' }}>
          <strong>{t('reputation.insufficient')}</strong>
          <span>{typo(t('company.reputationNote'))}</span>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('company.title')} lede={t('company.lede')} />
      <div style={{ display: 'grid', gap: 24 }}>
        <section className="ws-identity" aria-label={c.name}>
          <CompanyMark name={c.name} seed={c.handle} size={64} />
          <div className="ws-identity__body">
            <span className="ws-identity__name">{typo(c.name)}</span>
            <span className="ws-identity__role">{c.kinds.map((k) => t(`companies.kindOne.${k}` as 'companies.kindOne.supplier')).join(' · ')}</span>
            <span className="ws-identity__meta">
              <span>
                <Building2 size={12} strokeWidth={2} aria-hidden="true" /> {regionLabel(c.region)}
              </span>
              {c.website ? (
                <a href={c.website} rel="noreferrer">
                  <Globe size={12} strokeWidth={2} aria-hidden="true" /> {t('company.website')}
                </a>
              ) : null}
              <NextLink href={c.href}>
                {t('company.publicPage')} <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </span>
            <span className="ws-identity__signals">
              <CompanyStatusChip status={c.status} size="sm" />
              <span className="ws-chip ws-chip--sm">{t(`role.${view.myRole}`)}</span>
              {isAdmin && view.pendingRequests ? <span className="ws-chip ws-chip--sm ws-chip--accent">{t('company.claim.pendingRequests', { count: view.pendingRequests })}</span> : null}
            </span>
          </div>
          <div className="ws-identity__side">
            <ul className="ws-stats ws-stats--2 ws-stats--tight">
              <li className="ws-stat">
                <strong>{activeMembers}</strong>
                <span>{t('company.stats.members')}</span>
              </li>
              <li className="ws-stat">
                <strong>{view.catalogue?.entries.length ?? 0}</strong>
                <span>{t('company.stats.catalogue')}</span>
              </li>
              <li className="ws-stat">
                <strong>{view.projects.length}</strong>
                <span>{t('company.stats.projects')}</span>
              </li>
              <li className="ws-stat">
                <strong>{view.wall.length}</strong>
                <span>{t('company.stats.wall')}</span>
              </li>
            </ul>
            {isAdmin ? (
              <NextLink href={hrefFor(principal, '/app/company#settings')} className="ws-more">
                <Users size={14} strokeWidth={2} aria-hidden="true" />
                {t('company.settings')}
              </NextLink>
            ) : null}
          </div>
        </section>
        <CompanyTabs tabs={tabs} label={c.name} />
      </div>
    </>
  );
}
