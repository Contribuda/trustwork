import type { Metadata } from 'next';
import NextLink from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { StatusChip } from '@/components/ui';
import { CompanyTabs } from '@/components/public/CompanyTabs';
import { MeLearning } from '@/components/workspace/MeLearning';
import { MeProfileCard } from '@/components/workspace/MeProfileCard';
import { MePublicEditor } from '@/components/workspace/MePublicEditor';
import { DecisionList, PageHeader, ProjectRows } from '@/components/workspace/parts';
import { data, DATA_SOURCE } from '@/app/_lib/data';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { longDate, shortDate, t, tDynamic } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import type { OnboardingState } from '@/components/onboarding/onboarding-state';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('me.title') };
}

/**
 * "My page" (`me.title`): identity card with completeness, then tabs: Work (`me.tabs.work`: decisions, projects by
 * role, mandates), Publications, Interests, Learning (reading progress, bookmarks, certificates, courses), History and
 * Public profile (`me.tabs.publicProfile`: editor with live preview). The private view and the public projection stay
 * separate; on the live API the public profile exists only with the person's consent (PPL-001).
 */
export default async function MePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/me');
  const me = await data.getMe(principal);
  const person = await data.getPerson(principal.handle);
  const issues = (await data.getMagazine()).archive.map((i) => ({ number: i.number, title: i.title, readerHref: i.readerHref, items: i.items.map((x) => ({ position: x.position, title: x.title })) }));
  const certificates = (person?.profile.platformCertificates ?? []).map((c) => ({ id: c.id, title: c.course.title, issuedAt: c.issuedAt, score: c.score, href: `/certificates/${c.id}` }));
  const courses = (await data.listCourses())
    .slice(0, 3)
    .map((c) => ({ id: c.id, title: c.title, modules: c.modules, minutes: c.durationMinutes }));
  const membershipLabel = (status: string, endedAt: string | null) =>
    status === 'active'
      ? t('me.membership.active')
      : status === 'invited'
        ? t('me.membership.invited')
        : status === 'ended' && endedAt
          ? t('me.membership.ended', { date: shortDate(endedAt) })
          : tDynamic(`company.member.status_${status}`, status);
  const baseline = Math.round(([Boolean(me.roleLine), me.topics.length > 0, Boolean(principal.company), me.isPublished, me.publications.length > 0].filter(Boolean).length / 5) * 100);
  const seed: Partial<OnboardingState> = {
    headline: me.headline ?? '',
    topics: me.topics,
    publish: me.isPublished,
    portraitConsent: me.portraitConsent,
    showEmployer: me.showEmployer,
    employment: principal.company ? 'company' : null,
    company: principal.company?.name ?? '',
  };
  const employer = principal.company ? { name: principal.company.name, href: hrefFor(principal, '/app/company') } : null;

  const tabs = [
    {
      id: 'work',
      label: t('me.tabs.work'),
      content: (
        <div className="ws-grid ws-grid--main">
          <div className="ws-section">
            <div className="ws-h2-row">
              <h3 className="ws-h2">
                {t('me.decisions')}
                {me.decisions.length ? <span className="ev-badge ev-badge--paid">{me.decisions.length}</span> : null}
              </h3>
            </div>
            {me.decisions.length ? (
              <DecisionList rows={me.decisions} />
            ) : (
              <div className="ws-empty">
                <strong>{t('overview.decisionsEmpty')}</strong>
              </div>
            )}
            <div className="ws-h2-row">
              <h3 className="ws-h2">{t('me.projectsByRole')}</h3>
              <NextLink href={hrefFor(principal, '/app/projects')} className="ws-more">
                {t('overview.projects.all')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            {me.projects.length ? (
              <ProjectRows rows={me.projects} />
            ) : (
              <div className="ws-empty">
                <strong>{t('me.startHint')}</strong>
                <NextLink href={hrefFor(principal, '/app/projects')} className="ws-more">
                  {t('overview.projects.create')}
                </NextLink>
              </div>
            )}
          </div>
          <div className="ws-section">
            <div className="ws-card ws-card--navy">
              <h3 className="ws-h2">
                <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
                {t('me.mandates')}
              </h3>
              <p className="ws-muted">{t('me.mandatesCount', { count: me.mandatesCount })}</p>
              <NextLink href={hrefFor(principal, '/app/assistant')} className="ws-more">
                {t('overview.assistant.open')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
            <div className="ws-card">
              <h3 className="ws-h2">{t('me.tabs.publications')}</h3>
              {me.publications.length ? (
                <ul className="ws-list">
                  {me.publications.slice(0, 3).map((row) => (
                    <li key={row.id} className="ws-row">
                      <span className="ws-row__main">
                        {row.href ? (
                          <NextLink href={row.href} className="ws-row__title">
                            {typo(row.title)}
                          </NextLink>
                        ) : (
                          <span className="ws-row__title">{typo(row.title)}</span>
                        )}
                        <span className="ws-row__meta">
                          <StatusChip size="sm" tone={row.status === 'published' || row.status === 'corrected' ? 'success' : row.status === 'in_review' ? 'info' : 'neutral'}>
                            {tDynamic(`pubState.${row.status}`, row.status, { date: shortDate(row.updatedAt) })}
                          </StatusChip>
                          <span>{t('common.updated', { date: shortDate(row.updatedAt) })}</span>
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ws-muted">{t('publications.empty')}</p>
              )}
              <NextLink href={hrefFor(principal, '/app/publications')} className="ws-more">
                {t('overview.publications.all')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'publications',
      label: t('me.tabs.publications'),
      content: me.publications.length ? (
        <ul className="ws-list">
          {me.publications.map((row) => (
            <li key={row.id} className="ws-row">
              <span className="ws-row__main">
                {row.href ? (
                  <NextLink href={row.href} className="ws-row__title">
                    {typo(row.title)}
                  </NextLink>
                ) : (
                  <span className="ws-row__title">{typo(row.title)}</span>
                )}
                <span className="ws-row__meta">
                  <span>{tDynamic(`publications.format.${row.format}`, row.format)}</span>
                  <span>{row.authorLabel}</span>
                  <span>{t('common.updated', { date: shortDate(row.updatedAt) })}</span>
                </span>
              </span>
              <span className="ws-row__side">
                <StatusChip size="sm" tone={row.status === 'published' || row.status === 'corrected' ? 'success' : row.status === 'in_review' ? 'info' : 'neutral'}>
                  {tDynamic(`pubState.${row.status}`, row.status, { date: shortDate(row.updatedAt) })}
                </StatusChip>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ws-empty">
          <strong>{t('publications.empty')}</strong>
          <NextLink href={hrefFor(principal, '/app/publications')} className="ws-more">
            {t('publications.write')}
          </NextLink>
        </div>
      ),
    },
    {
      id: 'interests',
      label: t('me.tabs.interests'),
      content: (
        <div className="ws-section" style={{ maxWidth: '48rem' }}>
          <p className="ws-muted">{t('me.interestsHint')}</p>
          <ul className="ws-chips" aria-label={t('onboarding3.steps.goals')}>
            {(['buying', 'selling', 'industryParticipation'] as const)
              .filter((k) => principal.preferences[k])
              .map((k) => (
                <li key={k} className="ws-chip ws-chip--on">
                  {t(k === 'buying' ? 'onboarding3.goal.buy.title' : k === 'selling' ? 'onboarding3.goal.sell.title' : 'onboarding3.goal.learn.title')}
                </li>
              ))}
          </ul>
          <ul className="ws-chips" aria-label={t('me.public.topics')}>
            {me.topics.map((topic) => (
              <li key={topic} className="ws-chip">
                {t(`taxonomy.topics.${topic}`)}
              </li>
            ))}
          </ul>
          <div>
            <NextLink href={hrefFor(principal, '/onboarding')} className="pub-btn">
              {t('me.editInterests')}
            </NextLink>
          </div>
        </div>
      ),
    },
    { id: 'learning', label: t('me.tabs.learning'), content: <MeLearning issues={issues} certificates={certificates} courses={courses} academyHref="/magazine#academy-title" /> },
    {
      id: 'history',
      label: t('me.tabs.history'),
      content: me.memberships.length ? (
        <div className="ws-table-wrap">
          <table className="ws-table">
            <caption>{t('me.tabs.history')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('me.history.org')}</th>
                <th scope="col">{t('me.history.role')}</th>
                <th scope="col">{t('me.history.from')}</th>
                <th scope="col">{t('me.history.to')}</th>
                <th scope="col">{t('me.history.status')}</th>
              </tr>
            </thead>
            <tbody>
              {me.memberships.map((m) => (
                <tr key={m.id}>
                  <td data-label={t('me.history.org')}>{m.companyName}</td>
                  <td data-label={t('me.history.role')}>{t(`role.${m.role}`)}</td>
                  <td data-label={t('me.history.from')}>{m.validFrom ? longDate(m.validFrom) : '—'}</td>
                  <td data-label={t('me.history.to')}>{m.endedAt ? longDate(m.endedAt) : '—'}</td>
                  <td data-label={t('me.history.status')}>{membershipLabel(m.status, m.endedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ws-empty">
          <strong>{t('me.history.empty')}</strong>
        </div>
      ),
    },
    {
      id: 'public',
      label: t('me.tabs.publicProfile'),
      // On the live API the editor saves the profile, its consents and visibility through /v1/me/* (PPL-001).
      content: <MePublicEditor name={principal.displayName} roleLine={me.roleLine} employer={principal.company?.name ?? null} publicHref={me.publicHref} seed={seed} live={DATA_SOURCE === 'api'} />,
    },
  ];

  return (
    <>
      <PageHeader title={t('me.title')} lede={t('me.workIntro')} />
      <div style={{ display: 'grid', gap: 24 }}>
        <MeProfileCard
          name={principal.displayName}
          roleLine={me.roleLine}
          employer={employer}
          publicHref={me.publicHref}
          settingsHref={hrefFor(principal, '/app/settings')}
          onboardingHref={hrefFor(principal, '/onboarding')}
          baseline={baseline}
          seed={seed}
        />
        <CompanyTabs tabs={tabs} label={t('me.title')} />
      </div>
    </>
  );
}
