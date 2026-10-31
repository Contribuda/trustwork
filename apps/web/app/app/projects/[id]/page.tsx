import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, ArrowUpRight, Check, EyeOff, FileText, Lock, Users } from 'lucide-react';
import { Breadcrumb, EvidenceLabel, MediaFrame, StatusChip, Timeline } from '@/components/ui';
import type { TimelineEvent } from '@trustwork/ui';
import { ProjectStatusChip, regionLabel } from '@/components/public/parts';
import { CompanyTabs } from '@/components/public/CompanyTabs';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { initials } from '@/components/public/CompanyMark';
import { RfqList } from '@/components/workspace/parts';
import { DateTile } from '@/components/workspace/ProjectRow';
import { data, type WorkspaceParticipant } from '@/app/_lib/data';
import { projectCover } from '@/app/_lib/media';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { longDate, shortDate, t, tDynamic } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ id: string }>; searchParams: PageSearchParams };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/projects/${id}`);
  const project = data.getWorkspaceProject(principal, id);
  return { title: project ? project.name : t('ws.notFoundTitle') };
}

function Party({ p }: { p: WorkspaceParticipant }) {
  return p.kind === 'person' ? (
    <PersonAvatar name={p.label} portrait={p.portrait} size={40} />
  ) : (
    <span className="ws-mark" aria-hidden="true">
      {initials(p.label)}
    </span>
  );
}

/**
 * Project detail with object-level tabs. Participants see shared milestones without budgets and only
 * non-private files; the budget tab is owner-only; a project the principal has no grant for is 404.
 */
export default async function WorkspaceProjectPage({ params, searchParams }: Params) {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/projects/${id}`);
  const project = data.getWorkspaceProject(principal, id);
  if (!project) notFound();
  const cover = projectCover(project.slug);
  const current = project.milestones.find((m) => m.state === 'current') ?? null;
  const upcoming = project.milestones.filter((m) => m.state === 'upcoming').slice(0, 2);
  const events: TimelineEvent[] = project.milestones.map((m) => ({
    id: m.id,
    title: m.title,
    at: m.due,
    mark: m.state === 'done' ? 'done' : m.changedDue ? 'changed' : m.state === 'current' ? 'baseline' : 'pending',
    meta: [
      m.actual ? t('projectsWs.plan.actual', { date: shortDate(m.actual) }) : null,
      m.changedDue ? t('projectsWs.plan.changedFrom', { date: shortDate(m.baselineDue) }) : null,
      m.changedByClient ? t('milestone.changedByClient') : null,
      m.budget ? `${t('projectsWs.tabs.budget')}: ${m.budget}` : null,
      !m.shared ? t('projectsWs.plan.privateMilestone') : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  const filesByAudience = {
    public: project.files.filter((f) => f.audience === 'public').length,
    participants: project.files.filter((f) => f.audience === 'participants').length,
    private: project.files.filter((f) => f.audience === 'private').length,
  };

  const tabs = [
    {
      id: 'overview',
      label: t('projectsWs.tabs.overview'),
      content: (
        <div className="ws-grid ws-grid--main">
          <div className="ws-section">
            <h3 className="ws-h2">{t('projectsWs.overview.nextSteps')}</h3>
            {current ? (
              <div className={`ws-row${current.changedDue ? ' ws-row--attention' : ''}`}>
                <span className="ws-row__main">
                  <span className="ws-row__meta">
                    <StatusChip size="sm" tone="info">
                      {t('projectsWs.plan.currentChip')}
                    </StatusChip>
                    {current.changedDue ? <span className="ws-note--warn">{t('milestone.changed')}</span> : null}
                  </span>
                  <span className="ws-row__title">{typo(current.title)}</span>
                  <span className="ws-row__meta">
                    <span>
                      {t('milestone.due')}: {longDate(current.due)}
                    </span>
                    {current.changedDue ? <span>{t('projectsWs.plan.changedFrom', { date: shortDate(current.baselineDue) })}</span> : null}
                    {current.budget ? <span>{current.budget}</span> : null}
                  </span>
                </span>
                <DateTile date={current.due} tone={current.changedDue ? 'warn' : 'default'} />
              </div>
            ) : (
              <div className="ws-empty">
                <strong>{project.milestones.length ? t('projectsWs.overview.noCurrent') : t('projectsWs.plan.empty')}</strong>
              </div>
            )}
            {upcoming.length ? (
              <ul className="ws-list">
                {upcoming.map((m) => (
                  <li key={m.id} className="ws-row">
                    <span className="ws-row__main">
                      <span className="ws-row__title">{typo(m.title)}</span>
                      <span className="ws-row__meta">
                        <span>{t('projectsWs.plan.upcoming')}</span>
                        <span>{longDate(m.due)}</span>
                      </span>
                    </span>
                    <DateTile date={m.due} />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="ws-h2-row">
              <h3 className="ws-h2">{t('projectsWs.overview.recent')}</h3>
            </div>
            {project.updates.length ? (
              <ul className="ws-list">
                {project.updates.slice(0, 3).map((u) => (
                  <li key={u.id} className="ws-row">
                    <span className="ws-row__main">
                      <span className="ws-row__meta">
                        <StatusChip size="sm">{t(`updateType.${u.type}`)}</StatusChip>
                        <EvidenceLabel state={u.evidence} size="sm" />
                      </span>
                      <span className="ws-row__title">{typo(u.title)}</span>
                    </span>
                    <span className="ws-row__side">
                      <time dateTime={u.date}>{longDate(u.date)}</time>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ws-muted">{t('projectsWs.execution.empty')}</p>
            )}
          </div>
          <div className="ws-section">
            <div className="ws-card">
              <h3 className="ws-h2">{t('ws.factsLabel')}</h3>
              <dl className="ws-facts">
                <div>
                  <dt>{t('projectsWs.col.owner')}</dt>
                  <dd>{project.ownerKind === 'person' ? t('projectsWs.ownerPerson') : project.ownerHref ? <NextLink href={project.ownerHref}>{project.ownerLabel}</NextLink> : project.ownerLabel}</dd>
                </div>
                <div>
                  <dt>{t('projectsWs.leader')}</dt>
                  <dd>{project.leader ? project.leader.href ? <NextLink href={project.leader.href}>{project.leader.label}</NextLink> : project.leader.label : t('projectsWs.noLeader')}</dd>
                </div>
                <div>
                  <dt>{t('projectsWs.col.role')}</dt>
                  <dd>{t(`role.${project.myRole}`)}</dd>
                </div>
                <div>
                  <dt>{t('projectsWs.hero.region')}</dt>
                  <dd>{regionLabel(project.region)}</dd>
                </div>
                <div>
                  <dt>{t('projectsWs.col.updated')}</dt>
                  <dd>{longDate(project.updatedAt)}</dd>
                </div>
                <div>
                  <dt>{t('projectsWs.tabs.publication')}</dt>
                  <dd>{project.publicity.enabled ? t('projectsWs.publication.on') : t('projectsWs.notPublished')}</dd>
                </div>
              </dl>
            </div>
            <div className="ws-card">
              <h3 className="ws-h2">
                <Users size={18} strokeWidth={2} aria-hidden="true" />
                {t('projectsWs.overview.team')}
              </h3>
              <span className="ws-avatars" aria-hidden="true">
                {project.participants.slice(0, 6).map((p) => (
                  <Party key={p.label + p.role} p={p} />
                ))}
              </span>
              <p className="ws-muted">{t('projectsWs.participants.count', { count: project.participants.length })}</p>
            </div>
            <div className="ws-card ws-card--muted">
              <h3 className="ws-h2">
                <FileText size={18} strokeWidth={2} aria-hidden="true" />
                {t('projectsWs.tabs.files')}
              </h3>
              <p className="ws-muted">
                {t('projectsWs.overview.filesCount', { count: project.files.length })}
                {filesByAudience.private ? ` · ${t('projectsWs.overview.privateCount', { count: filesByAudience.private })}` : ''}
              </p>
            </div>
            {project.myRole !== 'participant' ? (
              <div className="ws-card ws-card--navy">
                <h3 className="ws-h2">{t('projectsWs.overview.purchases')}</h3>
                <p className="ws-muted">{t('projectsWs.overview.purchasesCount', { count: project.purchases.length })}</p>
                <NextLink href={hrefFor(principal, '/app/procurement')} className="ws-more">
                  {t('overview.procurement.all')}
                  <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </div>
            ) : null}
          </div>
        </div>
      ),
    },
    {
      id: 'plan',
      label: t('projectsWs.tabs.plan'),
      content: project.milestones.length ? (
        <div className="ws-grid ws-grid--main">
          <div className="ws-section">
            <Timeline label={t('projectsWs.plan.timeline')} events={events} />
          </div>
          <div className="ws-section">
            <ul className="ws-stats ws-stats--3">
              <li className="ws-stat">
                <strong>{project.milestones.filter((m) => m.state === 'done').length}</strong>
                <span>{t('projectsWs.plan.done')}</span>
              </li>
              <li className="ws-stat">
                <strong>{project.milestones.filter((m) => m.state === 'current').length}</strong>
                <span>{t('projectsWs.plan.current')}</span>
              </li>
              <li className="ws-stat">
                <strong>{project.milestones.filter((m) => m.state === 'upcoming').length}</strong>
                <span>{t('projectsWs.plan.upcoming')}</span>
              </li>
            </ul>
            <p className="ws-note">{project.myRole === 'participant' ? t('projectsWs.plan.sharedOnly') : project.canSeeBudget ? t('projectsWs.plan.budgetsVisible') : t('projectsWs.plan.budgetHidden')}</p>
          </div>
        </div>
      ) : (
        <div className="ws-empty">
          <strong>{t('projectsWs.plan.empty')}</strong>
        </div>
      ),
    },
    {
      id: 'execution',
      label: t('projectsWs.tabs.execution'),
      content: project.updates.length ? (
        <ul className="ws-list" style={{ maxWidth: '56rem' }}>
          {project.updates.map((u) => (
            <li key={u.id} className="ws-row">
              <span className="ws-row__main">
                <span className="ws-row__meta">
                  <StatusChip size="sm">{t(`updateType.${u.type}`)}</StatusChip>
                  <EvidenceLabel state={u.evidence} size="sm" />
                </span>
                <span className="ws-row__title">{typo(u.title)}</span>
              </span>
              <DateTile date={u.date} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="ws-empty">
          <strong>{t('projectsWs.execution.empty')}</strong>
          <span>{t('projectsWs.execution.hint')}</span>
        </div>
      ),
    },
    {
      id: 'acceptance',
      label: t('projectsWs.tabs.acceptance'),
      content: (
        <div className="ws-empty">
          <strong>{t('projectsWs.acceptance.empty')}</strong>
          <span>{t('projectsWs.acceptance.hint')}</span>
        </div>
      ),
    },
    {
      id: 'disputes',
      label: t('projectsWs.tabs.disputes'),
      content: (
        <div className="ws-empty">
          <strong>{t('projectsWs.disputes.empty')}</strong>
          <span>{t('projectsWs.disputes.claimNotFact')}</span>
        </div>
      ),
    },
    {
      id: 'purchases',
      label: t('projectsWs.tabs.purchases'),
      content: project.purchases.length ? (
        <RfqList rows={project.purchases} href={hrefFor(principal, '/app/procurement')} />
      ) : (
        <div className="ws-empty">
          <strong>{t('projectsWs.purchases.empty')}</strong>
          {project.myRole === 'participant' ? <span>{t('projectsWs.purchases.participantNote')}</span> : null}
        </div>
      ),
    },
    {
      id: 'participants',
      label: t('projectsWs.tabs.participants'),
      content: project.participants.length ? (
        <ul className="ws-list ws-grid--2" style={{ display: 'grid' }}>
          {project.participants.map((p) => (
            <li key={p.label + p.role} className="ws-person">
              <Party p={p} />
              <span className="ws-row__main">
                {p.href ? (
                  <NextLink href={p.href} className="ws-row__title">
                    {p.label}
                  </NextLink>
                ) : (
                  <span className="ws-row__title">{p.label}</span>
                )}
                <span className="ws-row__meta">
                  <span>{p.roleTitle}</span>
                  <StatusChip size="sm" tone={p.role === 'owner' ? 'info' : 'neutral'}>
                    {t(`role.${p.role}`)}
                  </StatusChip>
                  <span>{tDynamic(`projectsWs.participants.grantLabel.${p.grant}`, p.grant)}</span>
                  {!p.isPublic ? (
                    <span>
                      <EyeOff size={12} strokeWidth={2} aria-hidden="true" /> {t('projectsWs.participants.hidden')}
                    </span>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ws-empty">
          <strong>{t('projectsWs.participants.empty')}</strong>
        </div>
      ),
    },
    {
      id: 'files',
      label: t('projectsWs.tabs.files'),
      content: project.files.length ? (
        <ul className="ws-list" style={{ maxWidth: '56rem' }}>
          {project.files.map((f) => (
            <li key={f.id} className="ws-row">
              <span className="ws-row__main ws-row__main--icon">
                <span className="ws-mark ws-mark--file" aria-hidden="true">
                  {f.audience === 'private' ? <Lock size={16} strokeWidth={2} /> : <FileText size={16} strokeWidth={2} />}
                </span>
                <span>
                  <span className="ws-row__title">{f.name}</span>
                  <span className="ws-row__meta">
                    <StatusChip size="sm" tone={f.audience === 'public' ? 'success' : f.audience === 'participants' ? 'info' : 'neutral'}>
                      {t(`projectsWs.files.audience.${f.audience}`)}
                    </StatusChip>
                  </span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ws-empty">
          <strong>{t('projectsWs.files.empty')}</strong>
        </div>
      ),
    },
    {
      id: 'correspondence',
      label: t('projectsWs.tabs.correspondence'),
      content: (
        <div className="ws-empty">
          <strong>{t('projectsWs.correspondence.empty')}</strong>
          <span>{t('projectsWs.correspondence.hint')}</span>
        </div>
      ),
    },
    ...(project.canSeeBudget
      ? [
          {
            id: 'budget',
            label: t('projectsWs.tabs.budget'),
            content: project.budget ? (
              <div className="ws-section" style={{ maxWidth: '40rem' }}>
                <ul className="ws-stats ws-stats--3">
                  <li className="ws-stat">
                    <strong>{project.budget.limit}</strong>
                    <span>{t('projectsWs.budget.limit')}</span>
                  </li>
                  <li className="ws-stat">
                    <strong>{project.budget.reserved}</strong>
                    <span>
                      {t('projectsWs.budget.reserved')} · {t('projectsWs.budget.share', { percent: project.budget.reservedShare })}
                    </span>
                  </li>
                  <li className="ws-stat">
                    <strong>{project.budget.settled}</strong>
                    <span>
                      {t('projectsWs.budget.settled')} · {t('projectsWs.budget.share', { percent: project.budget.settledShare })}
                    </span>
                  </li>
                </ul>
                <span className="ws-bar ws-bar--lg" style={{ ['--p' as string]: `${project.budget.reservedShare}%`, ['--p2' as string]: `${project.budget.settledShare}%` }} aria-hidden="true">
                  <span />
                  <i />
                </span>
                <p className="ws-note">{t('projectsWs.budget.note')}</p>
              </div>
            ) : (
              <p className="ws-note">{t('projectsWs.budget.ownerOnly')}</p>
            ),
          },
        ]
      : []),
    {
      id: 'publication',
      label: t('projectsWs.tabs.publication'),
      content: (
        <div className="ws-section" style={{ maxWidth: '40rem' }}>
          <h3 className="ws-h2">{t('projectsWs.publication.fields')}</h3>
          <ul className="ws-list">
            {(['story', 'milestones', 'participants'] as const).map((f) => {
              const on = project.publicity.fields.includes(f);
              return (
                <li key={f} className="ws-check">
                  <span className={`ws-check__icon${on ? ' is-on' : ''}`} aria-hidden="true">
                    {on ? <Check size={14} strokeWidth={2.5} /> : <EyeOff size={13} strokeWidth={2} />}
                  </span>
                  <span>
                    <strong>{t(`projectsWs.publication.field.${f}`)}</strong>
                    <span className="ws-note"> · {on ? t('projectsWs.publication.on') : t('projectsWs.publication.off')}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ws-note">{t('projectsWs.publication.note')}</p>
          {project.publicity.publicHref ? (
            <div>
              <NextLink href={project.publicity.publicHref} className="pub-btn">
                {t('projectsWs.publication.preview')}
                <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </div>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <Breadcrumb
        items={[
          { id: 'projects', label: t('projectsWs.title'), href: hrefFor(principal, '/app/projects') },
          { id: 'self', label: project.name },
        ]}
      />
      <section className="ws-hero" aria-label={project.name}>
        <div className="ws-hero__body">
          <span className="ws-head__kicker">
            {project.ownerKind === 'person' ? t('projectsWs.ownerPerson') : t('projectsWs.ownerCompany')} · {regionLabel(project.region)}
          </span>
          <h1 tabIndex={-1} className="ws-h1">
            {typo(project.name)}
          </h1>
          {project.summary ? <p className="ws-lede">{typo(project.summary)}</p> : null}
          <span className="ws-hero__chips">
            <ProjectStatusChip status={project.status} size="sm" />
            <span className="ws-chip">{t(`role.${project.myRole}`)}</span>
            {project.publicity.publicHref ? (
              <NextLink href={project.publicity.publicHref} className="ws-chip ws-chip--accent">
                {t('projectsWs.hero.publicPage')} <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            ) : (
              <span className="ws-chip">{t('projectsWs.notPublished')}</span>
            )}
          </span>
          <div className="ws-hero__facts">
            <span className="ws-ring-row">
              <span className={`ws-ring${project.progress.delayed ? ' ws-ring--warn' : ''}`} style={{ ['--p' as string]: `${project.progress.percent}%` }} aria-hidden="true">
                <span>{project.progress.percent}%</span>
              </span>
              <span>
                <strong>{t('projectsWs.progressOf', { done: project.progress.done, total: project.progress.total })}</strong>
                <span>{project.progress.delayed ? t('projectsWs.delayed') : t('projectsWs.hero.onTrack')}</span>
              </span>
            </span>
            {project.nextMilestone ? (
              <span className="ws-project__next">
                <DateTile date={project.nextMilestone.due} tone={project.nextMilestone.changed ? 'warn' : 'default'} />
                <span>
                  <span className="ws-note">{t('projectsWs.nextMilestone')}</span>
                  <strong>{typo(project.nextMilestone.title)}</strong>
                </span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="ws-hero__cover">
          <MediaFrame media={cover} ratio="4/3" radius="none" loading="eager" sizes="(max-width: 767px) 100vw, 320px" />
        </div>
      </section>
      <CompanyTabs tabs={tabs} label={project.name} />
    </>
  );
}
