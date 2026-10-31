import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound } from 'next/navigation';
import {
  ArrowRight,
  ArrowUpRight,
  Calendar,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  FileCheck2,
  FileText,
  Flag,
  Handshake,
  Images,
  MapPin,
  MessageSquareText,
  Newspaper,
  Package,
  PauseCircle,
  Play,
  Presentation,
  Send,
  ShoppingCart,
  Sparkles,
  Store,
  Users,
} from 'lucide-react';
import { Breadcrumb, MediaFrame } from '@/components/ui';
import { CompanyMark } from '@/components/public/CompanyMark';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { ProjectAssistant, type ProjectBrief } from '@/components/public/agent/project';
import { AgentTrigger } from '@/components/public/agent/PublicAssistant';
import { SectionNav } from '@/components/public/SectionNav';
import { ShareRow } from '@/components/public/ShareRow';
import { EvidenceChip, ProjectStatusChip, formatLabel, regionLabel } from '@/components/public/parts';
import { data } from '@/app/_lib/data';
import type { PartyRole, ProjectParticipant } from '@/app/_lib/data/types';
import { fixtureMedia, projectCover, storyCover } from '@/app/_lib/media';
import { NotOwner, OwnerAction } from '@/components/public/viewer';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';

type Params = { params: Promise<{ lang: string; handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  const { lang, handle } = await params;
  const project = await data.getPublicProject(handle);
  return { alternates: languageAlternates(`/projects/${handle}`, lang), title: project ? project.name : t('error.notFoundTitle'), description: project?.summary ?? undefined };
}

const ROLE_ORDER: PartyRole[] = ['developer', 'investor', 'client', 'technicalClient', 'designer', 'generalContractor', 'subcontractor', 'supplier', 'supervision', 'operator', 'other'];

function PartyMark({ p, size = 48 }: { p: ProjectParticipant; size?: 32 | 36 | 48 }) {
  return p.kind === 'person' ? <PersonAvatar name={p.label} portrait={p.portrait} size={size} /> : <CompanyMark name={p.label} seed={p.href ?? p.label} size={size} />;
}

/**
 * Project page (same system as company and person pages): gallery and identity, readiness, owner and leader,
 * sticky section nav over sections: overview with key figures and plans, roadmap with milestone states and
 * client-driven changes, participants, open needs (no prices), news with evidence labels, media and public
 * files, partner note and contact, publications; aside with the project agent, share, similar projects and
 * «is this yours». Budgets, offers and private files never appear.
 */
export default async function ProjectPage({ params }: Params) {
  await primePublicLocale((await params).lang);
  const { handle } = await params;
  const project = await data.getPublicProject(handle);
  if (!project) notFound();
  // Whether the visitor owns the project is decided in the browser: public pages never read the session (WEB-005).
  const ownership = { ownerKey: project.owner.href?.split('/').pop() ?? null };
  const show = project.showcase;
  const gallery = show.gallery.length ? show.gallery.map((g) => ({ id: g.id, media: fixtureMedia(g.photo, 'project'), caption: g.caption })) : [{ id: 'cover', media: projectCover(project.handle), caption: null }];
  const main = gallery[0]!;
  const thumbs = gallery.slice(1, 4);
  const respondHref = `/login?next=${encodeURIComponent(`/app/rfq?project=${project.handle}`)}`;
  const writeHref = `/login?next=${encodeURIComponent(`/app/messages/new?project=${project.handle}`)}`;
  const joinHref = `/login?next=${encodeURIComponent(`/app/projects/join?project=${project.handle}`)}`;
  const owner = project.participants.find((p) => p.role === 'owner') ?? null;
  const nextDue = project.progress.current ? (project.progress.current.changedDue ?? project.progress.current.baselineDue) : null;
  const lastMs = project.milestones[project.milestones.length - 1];
  const stateKey = project.status === 'completed' ? 'stateDone' : project.milestones.length === 0 ? 'statePlanned' : project.progress.delayed ? 'stateDelayed' : 'stateOnTrack';
  const similar = (await data.listPublicProjects())
    .filter((p) => p.id !== project.id)
    .map((p) => ({ p, score: (p.category === project.category ? 2 : 0) + (p.region === project.region ? 1 : 0) + (p.status === project.status ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.p);

  const brief: ProjectBrief = {
    name: project.name,
    handle: project.handle,
    category: project.category ? t(`projects.category.${project.category}`) : '',
    region: regionLabel(project.region),
    status: t(`projectStatus.${project.status}`),
    owner: project.owner,
    story: project.story,
    highlights: show.highlights,
    progress: {
      percent: project.progress.percent,
      done: project.progress.done,
      total: project.progress.total,
      current: project.progress.current?.title ?? null,
      nextDue: nextDue ? shortDate(nextDue) : null,
      started: project.startedAt ? shortDate(project.startedAt) : '',
    },
    milestones: project.milestones.map((m) => ({ title: m.title, state: t(`projectPage.${m.state}`), date: shortDate(m.actual ?? m.changedDue ?? m.baselineDue) })),
    participants: project.participants.map((p) => ({ label: p.label, role: `${t(`projectPage.partyRole.${p.partyRole}`)} · ${p.roleTitle}`, href: p.href })),
    needs: project.openNeeds.map((n) => ({ title: n.title, kind: t(`projects.needKind.${n.kind}`), deadline: shortDate(n.deadline), summary: n.summary })),
    updates: project.updates.map((u) => ({ title: u.title, date: shortDate(u.date), type: t(`projects.updateType.${u.type}`) })),
    plans: show.plans.map((p) => ({ title: p.title, when: p.when })),
    partnerNote: show.partnerNote,
    contact: show.contact ? { label: show.contact.label, href: show.contact.href } : null,
    photos: show.gallery.length,
    files: project.publicFiles.length,
    publications: project.publications.map((p) => ({ title: p.title, href: p.href })),
    passport: show.passport ? { type: show.passport.objectType, address: show.passport.address } : null,
    materials: show.materials.map((m) => ({ name: m.name, supplier: m.supplier?.label ?? null, status: t(`projectPage.materialStatus.${m.status}`) })),
    plan: show.procurementPlan.map((pp) => ({ title: pp.title, when: pp.when, status: t(`projectPage.planStatus.${pp.status}`) })),
    commercial: show.commercial
      ? {
          offering: show.commercial.offering,
          items: show.commercial.audiences.map((a) => ({ title: `${t(`projectPage.audienceKind.${a.kind}`)}: ${a.title}`, detail: a.units.map((u) => u.title).join(', ') || a.description })),
        }
      : null,
    documents: show.documents.map((d) => ({ name: d.name, kind: t(`projectPage.docKind.${d.kind}`), evidence: t(`evidence.${d.evidence}`) })),
    openRoles: show.openRoles.map((r) => ({ title: r.title, when: r.when })),
    respondHref,
    writeHref,
  };

  const sections = (
    [
      ['overview', true],
      ['roadmap', true],
      ['participants', true],
      ['needs', true],
      ['updates', true],
      ['media', true],
      ['clients', Boolean(show.commercial)],
      ['partners', true],
      ['documents', true],
      ['publications', project.publications.length > 0 || show.press.length > 0],
    ] as const
  ).filter(([, on]) => on);
  const nav = sections.map(([id]) => ({ id, label: t(`projectPage.nav.${id}`) }));
  const StateIcon = project.status === 'completed' ? CheckCircle2 : project.progress.delayed ? PauseCircle : Play;

  return (
    <div className="pub pub-page cp">
      <div className="pub-wrap">
        <Breadcrumb
          items={[
            { id: 'home', label: t('publicNav.0'), href: '/' },
            { id: 'projects', label: t('publicNav.6'), href: '/projects' },
            { id: 'self', label: project.name },
          ]}
        />
      </div>

      <div className="pub-wrap">
        <header className="pj-hero">
          <div className="pj-gallery" aria-label={t('projectPage.mediaTitle')}>
            <figure className="pj-gallery__main">
              <MediaFrame media={main.media} ratio="fill" radius="none" loading="eager" sizes="(max-width: 1023px) 100vw, 60vw" />
              {main.caption ? <figcaption className="pj-gallery__cap">{typo(main.caption)}</figcaption> : null}
            </figure>
            {thumbs.map((g, i) =>
              i === 2 && gallery.length > 4 ? (
                <a key={g.id} href="#media" className="pj-gallery__thumb pj-gallery__thumb--more" aria-label={t('projectPage.mediaTitle')}>
                  +{gallery.length - 3}
                </a>
              ) : (
                <figure key={g.id} className="pj-gallery__thumb">
                  <MediaFrame media={g.media} ratio="fill" radius="none" sizes="200px" />
                </figure>
              ),
            )}
          </div>
          <div className="pj-head">
            <p className="pj-head__chips">
              <ProjectStatusChip status={project.status} />
              {project.category ? <span className="co-tag">{t(`projects.category.${project.category}`)}</span> : null}
              <span className="co-tag">
                <MapPin size={12} strokeWidth={2} aria-hidden="true" /> {regionLabel(project.region)}
              </span>
            </p>
            <h1 className="pj-title" tabIndex={-1}>
              {typo(project.name)}
            </h1>
            {project.summary ? <p className="pj-summary">{typo(project.summary)}</p> : null}
            <div className="pj-head__progress">
              <div className="pj-progress">
                <div className="pj-progress__row">
                  <span>
                    {t('projects.progress')}
                    {project.progress.total ? ` · ${t('projects.progressOf', { done: project.progress.done, total: project.progress.total })}` : ''}
                  </span>
                  <strong>{project.progress.percent}%</strong>
                </div>
                <div className="pj-progress__bar" aria-hidden="true">
                  <span className="pj-progress__fill" style={{ width: `${project.progress.percent}%` }} />
                </div>
                <div className="pj-progress__row">
                  {project.startedAt ? (
                    <span>
                      <Calendar size={12} strokeWidth={2} aria-hidden="true" /> {t('projectPage.started', { date: shortDate(project.startedAt) })}
                    </span>
                  ) : null}
                  {project.status === 'completed' && lastMs?.actual ? (
                    <span>{t('projectPage.completedAt', { date: shortDate(lastMs.actual) })}</span>
                  ) : lastMs ? (
                    <span>{t('projectPage.finish', { date: shortDate(lastMs.changedDue ?? lastMs.baselineDue) })}</span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="pj-owner">
              <div className="pj-owner__row">
                {owner ? <PartyMark p={owner} size={36} /> : <CompanyMark name={project.owner.label} seed={project.owner.label} size={36} />}
                <span>
                  <span className="pj-owner__label">{t('projectPage.owner')}</span>
                  {project.owner.href ? (
                    <NextLink href={project.owner.href} className="pj-owner__name">
                      {project.owner.label}
                    </NextLink>
                  ) : (
                    <span className="pj-owner__name">{project.owner.label}</span>
                  )}
                </span>
              </div>
              {project.leader ? (
                <div className="pj-owner__row">
                  <PersonAvatar name={project.leader.label} portrait={project.leader.portrait} size={36} />
                  <span>
                    <span className="pj-owner__label">{t('projectPage.leader')}</span>
                    {project.leader.href ? (
                      <NextLink href={project.leader.href} className="pj-owner__name">
                        {project.leader.label}
                      </NextLink>
                    ) : (
                      <span className="pj-owner__name">{project.leader.label}</span>
                    )}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="pj-head__actions">
              <OwnerAction match={ownership} href="/app/projects" label={t('projectPage.manage')}>
                {project.openNeeds.length ? (
                  <NextLink href={respondHref} className="pub-btn pub-btn--dark">
                    <ShoppingCart size={16} strokeWidth={2} aria-hidden="true" />
                    {t('projectPage.respond')}
                  </NextLink>
                ) : (
                  <NextLink href={writeHref} className="pub-btn pub-btn--dark">
                    <Send size={16} strokeWidth={2} aria-hidden="true" />
                    {t('projectPage.write')}
                  </NextLink>
                )}
              </OwnerAction>
              <AgentTrigger kind="project" className="pub-btn cp-ask">
                <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
                {t('projectPage.askAgent')}
              </AgentTrigger>
            </div>
          </div>
        </header>

        <dl className="ev-facts-grid co-facts cp-facts">
          <div>
            <dt>{t('projectPage.factStage')}</dt>
            <dd>{project.progress.current ? project.progress.current.title : project.status === 'completed' ? t('projectPage.stateDone') : t('projects.noMilestones')}</dd>
          </div>
          <div>
            <dt>{t('projectPage.factParticipants')}</dt>
            <dd>{project.participants.length}</dd>
          </div>
          <div>
            <dt>{t('projectPage.factNeeds')}</dt>
            <dd>{project.openNeeds.length}</dd>
          </div>
          <div>
            <dt>{t('projectPage.factUpdates')}</dt>
            <dd>{project.updates.length}</dd>
          </div>
          <div>
            <dt>{t('projectPage.factPhotos')}</dt>
            <dd>{show.gallery.length}</dd>
          </div>
        </dl>

        <SectionNav items={nav} label={project.name} />

        <div className="pub-feed cp-body">
          <div className="cp-main">
            <section className="cp-section" id="overview" aria-labelledby="overview-title">
              <h2 className="pub-h2 cp-section__title" id="overview-title">
                {t('projectPage.aboutTitle')}
              </h2>
              <div className={`pj-state pj-state--${project.status === 'completed' ? 'done' : project.progress.delayed ? 'delayed' : 'ok'}`}>
                <span className="pj-state__icon" aria-hidden="true">
                  <StateIcon size={20} strokeWidth={2} />
                </span>
                <div>
                  <p className="pj-state__title">{t(`projectPage.${stateKey}` as 'projectPage.stateOnTrack', { stage: project.progress.current?.title ?? '' })}</p>
                  {nextDue && project.status !== 'completed' ? <p className="pj-state__meta">{t('projectPage.finish', { date: shortDate(nextDue) })}</p> : null}
                </div>
              </div>
              <div className="cp-about">
                {(project.story ?? project.summary ?? '').split(/\n\n+/).map((para, i) => (
                  <p key={i} className={i === 0 ? 'cp-about__lead' : undefined}>
                    {typo(para)}
                  </p>
                ))}
              </div>
              {show.highlights.length ? (
                <>
                  <h3 className="cp-sub">{t('projectPage.highlightsTitle')}</h3>
                  <dl className="cp-dl">
                    {show.highlights.map((h) => (
                      <div key={h.label}>
                        <dt>{h.label}</dt>
                        <dd>{h.value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
              {show.passport ? (
                <>
                  <h3 className="cp-sub">{t('projectPage.passportTitle')}</h3>
                  <dl className="cp-dl pj-passport">
                    {(
                      [
                        ['address', show.passport.address],
                        ['objectType', show.passport.objectType],
                        ['totalArea', show.passport.totalArea],
                        ['floors', show.passport.floors],
                        ['siteArea', show.passport.siteArea],
                        ['designer', show.passport.designer],
                        ['commissioning', show.passport.commissioning],
                      ] as const
                    )
                      .filter(([, v]) => Boolean(v))
                      .map(([k, v]) => (
                        <div key={k}>
                          <dt>{t(`projectPage.passport.${k}`)}</dt>
                          <dd>{typo(String(v))}</dd>
                        </div>
                      ))}
                  </dl>
                </>
              ) : null}
              <h3 className="cp-sub">{t('projectPage.plansTitle')}</h3>
              {show.plans.length ? (
                <ul className="pj-plans">
                  {show.plans.map((p) => (
                    <li key={p.id} className="pj-plan">
                      <span>{typo(p.title)}</span>
                      <span className="pj-plan__when">{p.when}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cp-section__note">{t('projectPage.plansEmpty')}</p>
              )}
            </section>

            <section className="cp-section" id="roadmap" aria-labelledby="roadmap-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="roadmap-title">
                  {t('projectPage.roadmapTitle')}
                </h2>
                <p className="cp-section__lede">{typo(t('projectPage.roadmapLede'))}</p>
              </div>
              {project.milestones.length ? (
                <ol className="pj-roadmap">
                  {project.milestones.map((m) => (
                    <li key={m.id} className={`pj-ms pj-ms--${m.state}`}>
                      <span className="pj-ms__dot" aria-hidden="true">
                        {m.state === 'done' ? <Check size={14} strokeWidth={3} /> : m.state === 'current' ? <Flag size={13} strokeWidth={2.5} /> : <Circle size={10} strokeWidth={2} />}
                      </span>
                      <div className="pj-ms__body">
                        <p className="pj-ms__title">{typo(m.title)}</p>
                        <p className="pj-ms__dates">
                          <span>
                            {t('projectPage.baseline')}: {m.changedDue ? <s>{shortDate(m.baselineDue)}</s> : shortDate(m.baselineDue)}
                          </span>
                          {m.changedDue ? (
                            <span>
                              {t('projectPage.changed')}: {shortDate(m.changedDue)}
                              {m.changedByClient ? ` · ${t('projectPage.byClient')}` : ''}
                            </span>
                          ) : null}
                          {m.actual ? (
                            <span>
                              {t('projectPage.actual')}: {shortDate(m.actual)}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <span className="pj-ms__state">{t(`projectPage.${m.state}`)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="cp-empty">
                  <Flag size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('projectPage.milestonesEmpty')}</p>
                </div>
              )}
            </section>

            <section className="cp-section" id="participants" aria-labelledby="participants-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="participants-title">
                  {t('projectPage.teamTitle')}
                </h2>
                <p className="cp-section__lede">{t('projectPage.teamLede')}</p>
              </div>
              {project.participants.length ? (
                <div className="pj-team">
                  {ROLE_ORDER.filter((r) => project.participants.some((p) => p.partyRole === r)).map((r) => (
                    <div key={r} className="pj-team__group">
                      <h3 className="pj-team__role">{t(`projectPage.partyRole.${r}`)}</h3>
                      <div className="pj-parts">
                        {project.participants
                          .filter((p) => p.partyRole === r)
                          .map((p) => {
                            const inner = (
                              <>
                                <PartyMark p={p} />
                                <span className="pj-part__text">
                                  <span className="pj-part__name">{p.label}</span>
                                  <span className="pj-part__role">{p.roleTitle}</span>
                                  <span className="pj-part__badge">{t(`projectPage.role.${p.role}`)}</span>
                                </span>
                              </>
                            );
                            return p.href ? (
                              <NextLink key={p.label} href={p.href} className="pj-part">
                                {inner}
                              </NextLink>
                            ) : (
                              <div key={p.label} className="pj-part">
                                {inner}
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="cp-empty">
                  <Users size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('projectPage.participantsEmpty')}</p>
                </div>
              )}
              <h3 className="cp-sub">{t('projectPage.openRolesTitle')}</h3>
              {show.openRoles.length ? (
                <ul className="pj-needs">
                  {show.openRoles.map((r) => (
                    <li key={r.id} className="pj-need pj-need--role">
                      <div>
                        <p className="co-row__tags">
                          <span className="co-tag">{t(`projectPage.partyRole.${r.role}`)}</span>
                          {r.when ? <span className="co-tag">{r.when}</span> : null}
                        </p>
                        <h4 className="pj-need__title">{typo(r.title)}</h4>
                        {r.note ? <p className="pj-need__summary">{typo(r.note)}</p> : null}
                      </div>
                      <NextLink href={joinHref} className="pub-btn">
                        {t('projectPage.applyRole')}
                      </NextLink>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cp-section__note">{t('projectPage.openRolesEmpty')}</p>
              )}
            </section>

            <section className="cp-section" id="needs" aria-labelledby="needs-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="needs-title">
                  {t('projectPage.supplyTitle')}
                </h2>
                <p className="cp-section__lede">{typo(t('projectPage.supplyLede'))}</p>
              </div>
              <h3 className="cp-sub">{t('projectPage.needsNow')}</h3>
              {project.openNeeds.length ? (
                <ul className="pj-needs">
                  {project.openNeeds.map((n) => (
                    <li key={n.id} className="pj-need">
                      <div>
                        <p className="co-row__tags">
                          <span className="co-tag">{t(`projects.needKind.${n.kind}`)}</span>
                          {n.quantity ? (
                            <span className="co-tag">
                              {n.quantity} {n.unit ?? ''}
                            </span>
                          ) : null}
                        </p>
                        <h3 className="pj-need__title">{typo(n.title)}</h3>
                        {n.summary ? <p className="pj-need__summary">{typo(n.summary)}</p> : null}
                        <p className="pj-need__meta">
                          <span>
                            <Clock size={13} strokeWidth={2} aria-hidden="true" /> <strong>{t('projectPage.needDeadline', { date: longDate(n.deadline) })}</strong>
                          </span>
                          <span>{n.quotesCount ? t('projectPage.needQuotes', { count: n.quotesCount }) : t('projectPage.needQuotesNone')}</span>
                        </p>
                      </div>
                      <NextLink href={`${respondHref}%26need%3D${n.id}`} className="pub-btn pub-btn--dark">
                        {t('projectPage.respond')}
                      </NextLink>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="cp-empty">
                  <ShoppingCart size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('projectPage.needsEmpty')}</p>
                  <NextLink href={writeHref} className="pub-more">
                    {t('projectPage.write')}
                    <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                  </NextLink>
                </div>
              )}
              <h3 className="cp-sub">{t('projectPage.materialsTitle')}</h3>
              {show.materials.length ? (
                <ul className="pj-materials">
                  {show.materials.map((m) => (
                    <li key={m.id} className="pj-material">
                      <Package size={16} strokeWidth={2} aria-hidden="true" />
                      <span className="pj-material__text">
                        <span className="pj-material__name">{typo(m.name)}</span>
                        <span className="pj-material__meta">
                          {m.supplier ? (
                            <>
                              {t('projectPage.supplierOf')}: {m.supplier.href ? <NextLink href={m.supplier.href}>{m.supplier.label}</NextLink> : m.supplier.label}
                            </>
                          ) : null}
                        </span>
                      </span>
                      <span className={`sig sig--sm sig--${m.status === 'inUse' ? 'green' : m.status === 'approved' ? 'blue' : 'grey'}`}>{t(`projectPage.materialStatus.${m.status}`)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cp-section__note">{t('projectPage.materialsEmpty')}</p>
              )}
              <h3 className="cp-sub">{t('projectPage.planTitle')}</h3>
              {show.procurementPlan.length ? (
                <ol className="pj-plan-list">
                  {show.procurementPlan.map((pp) => (
                    <li key={pp.id} className={`pj-plan-row pj-plan-row--${pp.status}`}>
                      <span className="pj-plan-row__when">{pp.when}</span>
                      <span className="pj-plan-row__body">
                        <span className="pj-plan-row__title">{typo(pp.title)}</span>
                        <span className="pj-plan-row__kind">{t(`projects.needKind.${pp.kind}`)}</span>
                      </span>
                      {pp.status === 'open' && pp.rfqId ? (
                        <a href="#needs" className="sig sig--sm sig--green">
                          {t('projectPage.planStatus.open')}
                        </a>
                      ) : (
                        <span className={`sig sig--sm sig--${pp.status === 'closed' ? 'grey' : 'amber'}`}>{t(`projectPage.planStatus.${pp.status}`)}</span>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="cp-section__note">{t('projectPage.planEmpty')}</p>
              )}
              <h3 className="cp-sub">{t('projectPage.termsTitle')}</h3>
              {show.supplierTerms.length ? (
                <ul className="cp-vacancy__list pj-terms">
                  {show.supplierTerms.map((term) => (
                    <li key={term}>{typo(term)}</li>
                  ))}
                </ul>
              ) : (
                <p className="cp-section__note">{t('projectPage.termsEmpty')}</p>
              )}
            </section>

            <section className="cp-section" id="updates" aria-labelledby="updates-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="updates-title">
                  {t('projectPage.updatesTitle')}
                </h2>
                <p className="cp-section__lede">{t('projectPage.updatesLede')}</p>
              </div>
              {project.updates.length ? (
                <ol className="cp-timeline">
                  {[...project.updates].reverse().map((u) => (
                    <li key={u.id} className="cp-tl">
                      <span className="cp-tl__icon" aria-hidden="true">
                        {u.type === 'result' ? <CheckCircle2 size={16} strokeWidth={2} /> : u.type === 'discussion' ? <MessageSquareText size={16} strokeWidth={2} /> : <FileText size={16} strokeWidth={2} />}
                      </span>
                      <span className="cp-tl__body">
                        <span className="cp-tl__meta">
                          {longDate(u.date)} · {t(`projects.updateType.${u.type}`)}
                        </span>
                        <span className="cp-tl__title">
                          {typo(u.title)} <EvidenceChip state={u.evidence} />
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="cp-empty">
                  <FileText size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('projectPage.updatesEmpty')}</p>
                </div>
              )}
            </section>

            <section className="cp-section" id="media" aria-labelledby="media-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="media-title">
                  {t('projectPage.mediaTitle')}
                </h2>
                <p className="cp-section__lede">{t('projectPage.mediaLede')}</p>
              </div>
              {show.gallery.length ? (
                <div className="pj-media">
                  {show.gallery.map((g) => (
                    <figure key={g.id}>
                      <MediaFrame media={fixtureMedia(g.photo, 'project')} ratio="fill" radius="none" sizes="(max-width: 767px) 50vw, 300px" />
                      {g.caption ? <figcaption>{typo(g.caption)}</figcaption> : null}
                    </figure>
                  ))}
                </div>
              ) : (
                <div className="cp-empty">
                  <Images size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('projectPage.galleryEmpty')}</p>
                </div>
              )}
              <h3 className="cp-sub">{t('projectPage.video')}</h3>
              {show.video ? (
                <a href={show.video.url} className="pj-file" target="_blank" rel="noopener noreferrer">
                  <Play size={16} strokeWidth={2} aria-hidden="true" />
                  {show.video.title}
                  <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                </a>
              ) : (
                <p className="cp-section__note">{t('projectPage.videoNone')}</p>
              )}
              <h3 className="cp-sub">{t('projectPage.files')}</h3>
              {project.publicFiles.length ? (
                <ul className="pj-files">
                  {project.publicFiles.map((f) => (
                    <li key={f.id} className="pj-file">
                      {f.kind === 'presentation' || f.kind === 'brochure' ? <Presentation size={16} strokeWidth={2} aria-hidden="true" /> : <FileText size={16} strokeWidth={2} aria-hidden="true" />}
                      {f.name}
                      <span className="pj-file__kind">{t(`projectPage.fileKind.${f.kind}`)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cp-section__note">{t('projectPage.filesEmpty')}</p>
              )}
            </section>

            {show.commercial ? (
              <section className="cp-section" id="clients" aria-labelledby="clients-title">
                <div className="cp-section__head">
                  <h2 className="pub-h2 cp-section__title" id="clients-title">
                    {t('projectPage.clientsTitle')}
                  </h2>
                  <p className="cp-section__lede">{t('projectPage.clientsLede')}</p>
                </div>
                <div className="pj-clients-intro">
                  <p className="cp-about__lead">{typo(show.commercial.offering)}</p>
                  {show.commercial.infrastructure.length ? (
                    <>
                      <h3 className="cp-sub">{t('projectPage.infrastructureTitle')}</h3>
                      <ul className="pj-infra">
                        {show.commercial.infrastructure.map((item) => (
                          <li key={item}>
                            <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                            {typo(item)}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
                <div className="pj-audiences">
                  {show.commercial.audiences.map((a) => {
                    const actionHref =
                      a.action === 'viewing'
                        ? `${writeHref}%26kind%3Dviewing%26audience%3D${a.kind}`
                        : a.action === 'join'
                          ? `${writeHref}%26kind%3Djoin%26audience%3D${a.kind}`
                          : `${writeHref}%26kind%3Dclient%26audience%3D${a.kind}`;
                    return (
                      <article key={a.id} className="pj-aud" aria-labelledby={`aud-${a.id}`}>
                        <span className="pub-kicker">{t(`projectPage.audienceKind.${a.kind}`)}</span>
                        <h3 className="pj-aud__title" id={`aud-${a.id}`}>
                          {typo(a.title)}
                        </h3>
                        {a.description ? <p className="pj-aud__desc">{typo(a.description)}</p> : null}
                        {a.units.length ? (
                          <>
                            <h4 className="pj-aud__sub">{t('projectPage.unitsTitle')}</h4>
                            <ul className="pj-offer">
                              {a.units.map((u) => (
                                <li key={u.id}>
                                  <Store size={16} strokeWidth={2} aria-hidden="true" />
                                  <span>
                                    <span className="pj-offer__title">{typo(u.title)}</span>
                                    {u.detail ? <span className="pj-offer__detail">{typo(u.detail)}</span> : null}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        {a.terms.length ? (
                          <>
                            <h4 className="pj-aud__sub">{t('projectPage.termsClientsTitle')}</h4>
                            <ul className="cp-vacancy__list pj-terms">
                              {a.terms.map((term) => (
                                <li key={term}>{typo(term)}</li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        {a.commercialTerms.length ? (
                          <>
                            <h4 className="pj-aud__sub">{t('projectPage.commercialTermsTitle')}</h4>
                            <ul className="pj-cterms">
                              {a.commercialTerms.map((term) => (
                                <li key={term}>
                                  <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                                  {typo(term)}
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        {a.files.length ? (
                          <>
                            <h4 className="pj-aud__sub">{t('projectPage.clientFiles')}</h4>
                            <ul className="pj-files">
                              {a.files.map((f) => (
                                <li key={f.id} className="pj-file">
                                  {f.kind === 'presentation' || f.kind === 'brochure' ? <Presentation size={16} strokeWidth={2} aria-hidden="true" /> : <FileText size={16} strokeWidth={2} aria-hidden="true" />}
                                  {f.name}
                                  <span className="pj-file__kind">{t(`projectPage.fileKind.${f.kind}`)}</span>
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : null}
                        {a.faq.length ? (
                          <div className="cp-faq">
                            {a.faq.map((f) => (
                              <details key={f.q} className="cp-faq__item">
                                <summary>{typo(f.q)}</summary>
                                <p>{typo(f.a)}</p>
                              </details>
                            ))}
                          </div>
                        ) : null}
                        <div className="pub-actions pj-aud__actions">
                          <NextLink href={actionHref} className="pub-btn pub-btn--dark">
                            {t(`projectPage.action${a.action.charAt(0).toUpperCase()}${a.action.slice(1)}` as 'projectPage.actionViewing')}
                          </NextLink>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className="pj-partners__contact pj-sales">
                  <span className="pub-kicker">{t('projectPage.salesContact')}</span>
                  {show.commercial.contact ? (
                    <div className="pj-owner__row">
                      <PartyMark p={show.commercial.contact} size={36} />
                      <span>
                        {show.commercial.contact.href ? (
                          <NextLink href={show.commercial.contact.href} className="pj-owner__name">
                            {show.commercial.contact.label}
                          </NextLink>
                        ) : (
                          <span className="pj-owner__name">{show.commercial.contact.label}</span>
                        )}
                        <span className="pj-owner__label">{show.commercial.contact.roleTitle}</span>
                      </span>
                    </div>
                  ) : null}
                  {show.commercial.salesOffice ? (
                    <p className="pj-sales__office">
                      <MapPin size={14} strokeWidth={2} aria-hidden="true" /> {typo(show.commercial.salesOffice)}
                    </p>
                  ) : null}
                  {show.commercial.note ? <p className="cp-section__note">{typo(show.commercial.note)}</p> : null}
                </div>
              </section>
            ) : null}

            <section className="cp-section" id="partners" aria-labelledby="partners-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="partners-title">
                  {t('projectPage.partnersTitle')}
                </h2>
                <p className="cp-section__lede">{t('projectPage.partnersLede')}</p>
              </div>
              <div className="pj-partners">
                <div className="pj-partners__note">{show.partnerNote ? typo(show.partnerNote) : t('projectPage.partnersEmpty')}</div>
                <div className="pj-partners__contact">
                  <span className="pub-kicker">{t('projectPage.partnerContact')}</span>
                  {show.contact ? (
                    <div className="pj-owner__row">
                      <PartyMark p={show.contact} size={36} />
                      <span>
                        {show.contact.href ? (
                          <NextLink href={show.contact.href} className="pj-owner__name">
                            {show.contact.label}
                          </NextLink>
                        ) : (
                          <span className="pj-owner__name">{show.contact.label}</span>
                        )}
                        <span className="pj-owner__label">{show.contact.roleTitle}</span>
                      </span>
                    </div>
                  ) : null}
                  <div className="pub-actions">
                    {project.openNeeds.length ? (
                      <a href="#needs" className="pub-btn pub-btn--dark">
                        {t('projectPage.viewNeeds')}
                      </a>
                    ) : null}
                    <NextLink href={writeHref} className="pub-btn">
                      <Handshake size={16} strokeWidth={2} aria-hidden="true" />
                      {t('projectPage.join')}
                    </NextLink>
                  </div>
                </div>
              </div>
            </section>

            <section className="cp-section" id="documents" aria-labelledby="documents-title">
              <div className="cp-section__head">
                <h2 className="pub-h2 cp-section__title" id="documents-title">
                  {t('projectPage.documentsTitle')}
                </h2>
                <p className="cp-section__lede">{t('projectPage.documentsLede')}</p>
              </div>
              {show.documents.length ? (
                <ul className="cp-certs">
                  {show.documents.map((d) => (
                    <li key={d.id} className="cp-cert">
                      <span className="cp-cert__text">
                        <span className="cp-cert__name">
                          <span className="co-tag cp-cert__kind">{t(`projectPage.docKind.${d.kind}`)}</span> {typo(d.name)}
                        </span>
                        <span className="cp-cert__meta">
                          {d.number ? `${t('sr.number', { number: d.number })}` : ''}
                          {d.number && d.date ? ' · ' : ''}
                          {d.date ? longDate(d.date) : ''}
                        </span>
                      </span>
                      <EvidenceChip state={d.evidence} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="cp-empty">
                  <FileCheck2 size={20} strokeWidth={1.75} aria-hidden="true" />
                  <p>{t('projectPage.documentsEmpty')}</p>
                </div>
              )}
            </section>

            {project.publications.length || show.press.length ? (
              <section className="cp-section" id="publications" aria-labelledby="publications-title">
                <h2 className="pub-h2 cp-section__title" id="publications-title">
                  {t('projectPage.publicationsTitle')}
                </h2>
                {project.publications.length ? (
                  <ul className="cp-articles">
                    {project.publications.map((card) => (
                      <li key={card.id} className="cp-article">
                        <NextLink href={card.href} className="cp-article__media" aria-hidden="true" tabIndex={-1}>
                          <MediaFrame media={storyCover(card)} ratio="fill" radius="none" sizes="(max-width: 767px) 112px, 200px" />
                        </NextLink>
                        <div className="cp-article__body">
                          <span className="pub-kicker">
                            {formatLabel(card)} · {card.authorLabel}
                          </span>
                          <h3 className="cp-article__title">
                            <NextLink href={card.href}>{typo(card.title)}</NextLink>
                          </h3>
                          <p className="cp-article__lede">{typo(card.lede)}</p>
                          <p className="cp-article__meta">{longDate(card.publishedAt)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <h3 className="cp-sub">{t('projectPage.pressTitle')}</h3>
                {show.press.length ? (
                  <ul className="pj-files">
                    {show.press.map((pr) => (
                      <li key={pr.id}>
                        <a href={pr.url} className="pj-file" target="_blank" rel="noopener noreferrer">
                          <Newspaper size={16} strokeWidth={2} aria-hidden="true" />
                          <span className="pj-file__text">
                            {typo(pr.title)}
                            <span className="pj-file__kind">
                              {pr.source} · {shortDate(pr.date)}
                            </span>
                          </span>
                          <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cp-section__note">{t('projectPage.pressEmpty')}</p>
                )}
              </section>
            ) : null}
          </div>

          <aside className="pub-aside cp-aside">
            <section className="pub-note cp-rep" aria-labelledby="rep-title">
              <div className="cp-rep__head">
                <span className="cp-rep__icon" aria-hidden="true">
                  <Sparkles size={18} strokeWidth={2} />
                </span>
                <h2 className="pub-note__title" id="rep-title">
                  {t('projectPage.agentShort')}
                </h2>
              </div>
              <p className="pub-note__body">{typo(t('projectPage.agentStatus'))}</p>
              <div className="cp-rep__chips">
                {[1, 3, 5, 9].map((i) => (
                  <AgentTrigger kind="project" key={i} className="cp-rep__q" question={t(`projectPage.agentQuestions.${i}` as 'projectPage.agentQuestions.0')}>
                    {t(`projectPage.agentQuestions.${i}` as 'projectPage.agentQuestions.0')}
                    <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                  </AgentTrigger>
                ))}
              </div>
              <AgentTrigger kind="project" className="pub-btn pub-btn--dark cp-rep__open">{t('projectPage.askAgent')}</AgentTrigger>
            </section>
            <section className="pub-note" aria-labelledby="share-title">
              <h2 className="pub-note__title" id="share-title">
                {t('events.share')}
              </h2>
              <ShareRow path={project.href} title={project.name} />
            </section>
            {similar.length ? (
              <section className="pub-note" aria-labelledby="similar-title">
                <h2 className="pub-note__title" id="similar-title">
                  {t('projectPage.similarTitle')}
                </h2>
                <ul className="cp-similar">
                  {similar.map((p) => (
                    <li key={p.id}>
                      <NextLink href={p.href} className="cp-similar__item">
                        <span className="pj-move__thumb" aria-hidden="true" style={{ width: 36, height: 36 }}>
                          <MediaFrame media={p.cover ? fixtureMedia(p.cover, 'project') : projectCover(p.handle)} ratio="fill" radius="none" sizes="36px" />
                        </span>
                        <span className="cp-similar__text">
                          <span className="cp-similar__name">{p.name}</span>
                          <span className="cp-similar__meta">
                            {t(`projectStatus.${p.status}`)} · {regionLabel(p.region)}
                          </span>
                        </span>
                      </NextLink>
                    </li>
                  ))}
                </ul>
                <NextLink href={`/projects?category=${project.category}`} className="pub-more">
                  {t('projectPage.similarAll')}
                  <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                </NextLink>
              </section>
            ) : null}
            <section className="pub-note" aria-labelledby="visible-title">
              <h2 className="pub-note__title" id="visible-title">
                {t('projects.whatVisible')}
              </h2>
              <p className="pub-note__body">{typo(t('projects.whatVisibleBody'))}</p>
              {project.projectionDate ? <p className="cp-section__note">{t('projects.publishedVersion', { date: shortDate(project.projectionDate) })}</p> : null}
            </section>
            <NotOwner match={ownership}>
              <section className="pub-note pub-note--tint" aria-labelledby="yours-title">
                <h2 className="pub-note__title" id="yours-title">
                  {t('projectPage.isYours')}
                </h2>
                <p className="pub-note__body">{typo(t('projectPage.isYoursBody'))}</p>
                <NextLink href="/login?next=%2Fapp%2Fprojects" className="pub-btn">
                  {t('projectPage.manage')}
                </NextLink>
              </section>
            </NotOwner>
            <section className="pub-note" aria-labelledby="report-title">
              <h2 className="pub-note__title" id="report-title">
                {t('publicPages.reportIssue')}
              </h2>
              <NextLink href="/#help" className="pub-more">
                {t('projectPage.reportIssue')}
                <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            </section>
          </aside>
        </div>
      </div>

      <AgentTrigger kind="project" className="cp-fab">
        <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
        <span>{t('projectPage.agentShort')}</span>
      </AgentTrigger>
      <ProjectAssistant brief={brief} />
    </div>
  );
}
