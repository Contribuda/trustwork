import type { ReactNode } from 'react';
import { Avatar, Button, Card, EntityCard, EvidenceLabel, Hero, Kicker, Link, MediaFrame, Meta, RecordStatusChip, SectionHeader, StatusChip, StoryCard, TextField, VisuallyHidden } from '@/components/ui';
import type { CompanyCard, PersonCard, ProjectCard, PublicationCard, TopicKey } from '@/app/_lib/data';
import { entityCover, storyCover, type MediaRef } from '@/app/_lib/media';
import { longDate, shortDate, t, tDynamic } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { localHref } from '@/app/_lib/localize';

/**
 * Server-safe building blocks for public pages: view-model → design-system component mappings
 * (no hooks; components come through the client boundary in `components/ui.ts`).
 */

/** Page header: h1 in the h1 style, optional kicker/lede and trailing actions. Exactly one per page. */
export function PageHead({ title, lede, actions, kicker, id = 'page-title' }: { title: string; lede?: string | undefined; actions?: ReactNode; kicker?: string | undefined; id?: string | undefined }) {
  return (
    <header className="pg-head trustwork-enter">
      <SectionHeader id={id} headingLevel={1} size="lg" kicker={kicker} title={typo(title)} description={lede ? typo(lede) : undefined} action={actions} />
    </header>
  );
}

/** Page section with a section header and the stagger animation on its content. */
export function Section({
  title,
  kicker,
  description,
  action,
  children,
  id,
  size = 'md',
  tight = false,
}: {
  title: string;
  kicker?: string | undefined;
  description?: string | undefined;
  action?: ReactNode;
  children: ReactNode;
  id?: string | undefined;
  size?: 'md' | 'sm';
  tight?: boolean;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={tight ? 'pg-section pg-section--sm' : 'pg-section'} aria-labelledby={headingId} {...(id ? { id } : {})}>
      <SectionHeader id={headingId} headingLevel={2} size={size} kicker={kicker} title={typo(title)} description={description ? typo(description) : undefined} action={action} />
      <div className="stack" style={{ marginTop: 'var(--space-6)' }}>
        {children}
      </div>
    </section>
  );
}

export function topicLabel(key: TopicKey): string {
  return t(`taxonomy.topics.${key}`);
}

import { regionLabel } from '@/app/_lib/country';

export { regionLabel };

export function formatLabel(card: Pick<PublicationCard, 'format' | 'articleFormat'>): string {
  if (card.format === 'news') return t('publications.format.news');
  if (card.articleFormat) return t(`articles.formats.${card.articleFormat}`);
  return tDynamic(`publications.format.${card.format}`, card.format);
}

export function authorKindLabel(kind: PublicationCard['authorKind']): string {
  return t(`articles.authorKind.${kind}`);
}

type ProjectStatus = 'planned' | 'active' | 'suspended' | 'completed' | 'cancelled';
const PROJECT_TONE: Record<ProjectStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { planned: 'neutral', active: 'info', suspended: 'warning', completed: 'success', cancelled: 'danger' };

/** Project lifecycle in the contract's own words (`projectStatus.*`): «Реализуется», «Завершён» — never the generic lifecycle chip. */
export function ProjectStatusChip({ status, size }: { status: ProjectStatus; size?: 'sm' | 'md' | undefined }) {
  return (
    <StatusChip tone={PROJECT_TONE[status]} size={size}>
      {t(`projectStatus.${status}`)}
    </StatusChip>
  );
}

/** Filter chips as real links (`aria-current` marks the active one). */
export function Chips({ items, label }: { items: Array<{ label: string; href: string; isCurrent?: boolean }>; label: string }) {
  return (
    <nav aria-label={label}>
      <ul className="chips">
        {items.map((item) => (
          <li key={item.href + item.label}>
            <Link href={item.href} className="chip" {...(item.isCurrent ? { 'aria-current': 'true' } : {})}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Meta row items for a publication: author · date · read time · corrections. */
export function storyMeta(card: PublicationCard, options: { showEvent?: boolean; short?: boolean } = {}): ReactNode[] {
  const date = options.short ? shortDate(card.publishedAt) : longDate(card.publishedAt);
  const items: ReactNode[] = [
    <span key="author">
      <VisuallyHidden>{t('publicPages.author')}: </VisuallyHidden>
      {card.authorLabel}
    </span>,
    <time key="date" dateTime={card.publishedAt}>
      <VisuallyHidden>{t('publicPages.published')}: </VisuallyHidden>
      {date}
    </time>,
  ];
  if (options.showEvent && card.eventTime && card.eventTime.slice(0, 10) !== card.publishedAt.slice(0, 10)) {
    items.push(
      <span key="event">
        {t('news.eventTime')}: <time dateTime={card.eventTime}>{longDate(card.eventTime)}</time>
      </span>,
    );
  }
  if (card.readMinutes) items.push(t('articles.readTime', { minutes: card.readMinutes }));
  if (card.assistantAssisted) items.push(t('articles.assistantAssisted'));
  if (card.isCorrected && card.correctedAt) items.push(`${t('common.corrected')} ${shortDate(card.correctedAt)}`);
  return items;
}

/** Byline paragraph for detail pages (author as a link where the author has a page). */
export function Byline({ card, showEvent = false }: { card: PublicationCard; showEvent?: boolean }) {
  const items = storyMeta(card, { showEvent });
  if (card.authorHref) {
    items[0] = (
      <span key="author">
        <VisuallyHidden>{t('publicPages.author')}: </VisuallyHidden>
        <Link href={card.authorHref}>{card.authorLabel}</Link>
      </span>
    );
  }
  return <Meta items={items} />;
}

/** Publication → StoryCard. `size="s"` text-only tiles carry the accent top rule; others get a cover. */
export function Story({
  card,
  size = 'm',
  layout = 'vertical',
  withMedia = size !== 's',
  headingLevel = 3,
  enterIndex,
  showEvent = false,
  chips = true,
}: {
  card: PublicationCard;
  size?: 's' | 'm' | 'l';
  layout?: 'vertical' | 'horizontal';
  withMedia?: boolean;
  headingLevel?: 2 | 3 | 4;
  enterIndex?: number | undefined;
  showEvent?: boolean;
  chips?: boolean;
}) {
  return (
    <StoryCard
      title={typo(card.title)}
      href={card.href}
      kicker={formatLabel(card)}
      chips={chips ? card.topics.slice(0, 2).map(topicLabel) : undefined}
      dek={size === 's' ? undefined : typo(card.lede)}
      meta={storyMeta(card, { showEvent, short: size === 's' })}
      media={withMedia ? storyCover(card) : undefined}
      size={size}
      layout={layout}
      headingLevel={headingLevel}
      enterIndex={enterIndex}
    />
  );
}

/** Publication → Hero (lead stories). */
export function StoryHero({ card, size, headingLevel = 2, media }: { card: PublicationCard; size: 'lg' | 'md' | 'sm'; headingLevel?: 1 | 2; media?: MediaRef | undefined }) {
  return (
    <Hero
      size={size}
      headingLevel={headingLevel}
      media={media ?? storyCover(card)}
      kicker={formatLabel(card)}
      title={typo(card.title)}
      dek={size === 'sm' ? undefined : typo(card.lede)}
      meta={storyMeta(card, { short: size === 'sm' })}
      href={card.href}
    />
  );
}

export function CompanyEntity({ company, layout = 'vertical', headingLevel = 3, enterIndex }: { company: CompanyCard; layout?: 'vertical' | 'horizontal'; headingLevel?: 2 | 3 | 4; enterIndex?: number | undefined }) {
  return (
    <EntityCard
      kind="company"
      name={company.name}
      href={company.href}
      description={company.description ? typo(company.description) : company.directions.join(', ')}
      status={company.status === 'registered' ? undefined : company.status}
      media={entityCover('company', company.id)}
      facts={[
        { label: t('companies.factRegion'), value: regionLabel(company.region) },
        { label: t('companies.factProjects'), value: String(company.projectsCount) },
        { label: t('companies.factPublications'), value: String(company.publicationsCount) },
      ]}
      meta={[
        company.provenance ? t('provenance.source', { source: company.provenance.source, date: shortDate(company.provenance.observedAt) }) : null,
        company.claimedAt ? t('provenance.claimedBy', { date: shortDate(company.claimedAt) }) : null,
        company.status === 'registered' ? t('status.registered') : null,
      ].filter(Boolean)}
      layout={layout}
      headingLevel={headingLevel}
      enterIndex={enterIndex}
    />
  );
}

export function PersonEntity({
  person,
  layout = 'vertical',
  headingLevel = 3,
  enterIndex,
  suffix,
}: {
  person: PersonCard;
  layout?: 'vertical' | 'horizontal';
  headingLevel?: 2 | 3 | 4;
  enterIndex?: number | undefined;
  suffix?: string | undefined;
}) {
  return (
    <EntityCard
      kind="person"
      name={suffix ? `${person.displayName} · ${suffix}` : person.displayName}
      href={person.href}
      description={typo(person.roleLine)}
      media={entityCover('person', person.id)}
      facts={[
        { label: t('companies.factRegion'), value: regionLabel(person.region) },
        { label: t('people.factProjects'), value: String(person.projectsCount) },
        { label: t('people.factPublications'), value: String(person.publicationsCount) },
      ]}
      meta={[person.employer ? person.employer.name : t('people.independent')]}
      layout={layout}
      headingLevel={headingLevel}
      enterIndex={enterIndex}
    />
  );
}

export function ProjectEntity({ project, layout = 'vertical', headingLevel = 3, enterIndex }: { project: ProjectCard; layout?: 'vertical' | 'horizontal'; headingLevel?: 2 | 3 | 4; enterIndex?: number | undefined }) {
  return (
    <EntityCard
      kind="project"
      name={project.name}
      href={project.href}
      description={project.summary ? typo(project.summary) : project.category ? t(`projects.category.${project.category}`) : undefined}
      media={entityCover('project', project.id)}
      facts={[
        { label: t('projects.factStage'), value: t(`projectStatus.${project.status}`) },
        { label: t('companies.factRegion'), value: regionLabel(project.region) },
        { label: t('projects.factOwner'), value: project.owner.label },
        ...(project.openNeedsCount ? [{ label: t('projects.factNeeds'), value: String(project.openNeedsCount) }] : []),
      ]}
      meta={[project.category ? t(`projects.category.${project.category}`) : null, project.projectionDate ? t('projects.publishedVersion', { date: shortDate(project.projectionDate) }) : null]}
      layout={layout}
      headingLevel={headingLevel}
      enterIndex={enterIndex}
    />
  );
}

/**
 * Entity page header: cover (photograph or artwork) with kicker, status chips and the h1 over the scrim;
 * facts row and actions on the card surface below. Interactive controls never sit inside the overlay.
 */
export function CoverHead({
  media,
  kicker,
  title,
  chips,
  facts,
  actions,
  children,
  person,
}: {
  media: MediaRef;
  kicker: string;
  title: string;
  chips?: ReactNode;
  facts?: Array<{ label: string; value: ReactNode }>;
  actions?: ReactNode;
  children?: ReactNode;
  person?: string | undefined;
}) {
  return (
    <header className="cover-head trustwork-enter">
      <MediaFrame media={media} ratio="21/9" scrim="bottom" radius="none" loading="eager" sizes="(max-width: 767px) 100vw, 1200px">
        <div className="cover-head__overlay">
          {chips ? <div className="cover-head__chips">{chips}</div> : null}
          <div className={person ? 'cover-head__person' : undefined}>
            {person ? <Avatar name={person} size={64} decorative className="cover-head__avatar" /> : null}
            <div>
              <Kicker tone="inverse">{kicker}</Kicker>
              <h1 tabIndex={-1} className="trustwork-h1" style={{ color: 'var(--color-navy-text)', textWrap: 'balance' }}>
                {typo(title)}
              </h1>
            </div>
          </div>
          {children}
        </div>
      </MediaFrame>
      {(facts && facts.length) || actions ? (
        <div className="cover-head__body">
          {facts && facts.length ? (
            <dl className="facts" aria-label={t('publicPages.factsLabel')}>
              {facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {actions ? <div className="actions">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}

/** Aside card with a heading and a small gap stack. */
export function RailCard({ title, children, headingLevel = 2, id }: { title: string; children: ReactNode; headingLevel?: 2 | 3; id?: string | undefined }) {
  return (
    <Card title={title} headingLevel={headingLevel} id={id ?? `rail-${title.replace(/\W+/g, '-').toLowerCase()}`}>
      <div className="stack stack--sm">{children}</div>
    </Card>
  );
}

export function EvidenceChip({ state }: { state: 'asserted' | 'confirmed' | 'disputed' | 'superseded' }) {
  return <EvidenceLabel state={state} size="sm" />;
}

/**
 * Company record status. `registered` (created on the platform by its administrator, WEB-004) is neither sourced nor
 * claimed nor verified, so it gets its own neutral chip instead of borrowing one of the record states.
 */
export function CompanyStatusChip({ status, size }: { status: CompanyCard['status']; size?: 'sm' | 'md' }) {
  if (status === 'registered') return <StatusChip tone="neutral" size={size}>{t('status.registered')}</StatusChip>;
  return <RecordStatusChip status={status} size={size} />;
}

export function RecordChip({ status, size }: { status: CompanyCard['status']; size?: 'sm' | 'md' }) {
  return <CompanyStatusChip status={status} size={size} />;
}

/** GET search form built from design-system controls; works without JavaScript (native submit to the list route). */
export function SearchForm({ placeholder, action, label }: { placeholder: string; action: string; label: string }) {
  return (
    <form className="search-row" action={localHref(action)} method="get" role="search" aria-label={label}>
      <TextField name="q" label={label} placeholder={placeholder} inputMode="search" autoComplete="off" />
      <Button type="submit" variant="primary">
        {t('publicPages.find')}
      </Button>
    </form>
  );
}
