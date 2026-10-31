import type { ReactNode } from 'react';
import { ProjectRow } from '@/components/workspace/ProjectRow';
import { Card, KindBadge, Link, Skeleton, SkeletonGroup, StatusChip } from '@/components/ui';
import type { DecisionRow, EventRow, LeadRow, RfqRow, WorkspaceProjectRow } from '@/app/_lib/data';
import { longDate, shortDate, t, tDynamic } from '@/app/_lib/i18n';

/** Server-safe building blocks for workspace pages. */

export function PageHeader({ title, lede, kicker, actions, children }: { title: string; lede?: string | undefined; kicker?: string | undefined; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ws-head">
      {children}
      <div className="ws-head__row">
        <div className="ws-head__text">
          {kicker ? <span className="ws-head__kicker">{kicker}</span> : null}
          <h1 tabIndex={-1} className="ws-h1">
            {title}
          </h1>
          {lede ? <p className="ws-lede">{lede}</p> : null}
        </div>
        {actions ? <div className="ws-head__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

export function WorkspaceCard({
  id,
  title,
  count,
  allHref,
  allLabel,
  children,
}: {
  id: string;
  title: string;
  count?: number | undefined;
  allHref?: string | undefined;
  allLabel?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Card
      id={id}
      title={title}
      aside={
        <span className="meta">
          {count !== undefined && count > 0 ? (
            <StatusChip size="sm" tone="info">
              {count}
            </StatusChip>
          ) : null}
          {allHref ? (
            <Link href={allHref} variant="standalone">
              {allLabel ?? t('overview.all')}
            </Link>
          ) : null}
        </span>
      }
    >
      {children}
    </Card>
  );
}

export function CardSkeleton({ label }: { label: string }) {
  return (
    <SkeletonGroup label={label}>
      <Skeleton variant="row" lines={3} />
    </SkeletonGroup>
  );
}

export function rfqStatusLabel(status: string): string {
  return tDynamic(`rfqStatus.${status}`, status);
}

export function leadStatusLabel(status: string): string {
  return tDynamic(`leadStatus.${status}`, status);
}

export function projectLifecycle(status: WorkspaceProjectRow['status']) {
  return status === 'planned' ? 'draft' : status === 'active' ? 'active' : status === 'suspended' ? 'paused' : status === 'completed' ? 'closed' : 'cancelled';
}

export function DecisionList({ rows }: { rows: DecisionRow[] }) {
  return (
    <ul className="list">
      {rows.map((row) => (
        <li key={row.id} className="row">
          <p className="row__title">
            <Link href={row.href}>{row.title}</Link>
          </p>
          <p className="meta">
            <span>{row.context}</span>
            <span>{t('overview.due', { date: longDate(row.due) })}</span>
          </p>
          {row.digestChanged ? (
            <p className="banner banner--warning" role="status">
              {t('overview.digestChanged')}
            </p>
          ) : null}
          <div className="row__actions">
            <Link href={row.href} variant="standalone">
              {row.action}
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RfqList({ rows, href }: { rows: RfqRow[]; href: string }) {
  return (
    <ul className="list">
      {rows.map((row) => (
        <li key={row.id} className="row">
          <p className="row__title">
            <Link href={href}>{row.title}</Link>
          </p>
          <p className="meta">
            <KindBadge kind={row.kind} size="sm" />
            <StatusChip size="sm" tone={row.needsDecision ? 'warning' : 'neutral'}>
              {rfqStatusLabel(row.status)}
            </StatusChip>
            <span>{t('procurement.versionShort', { version: row.version })}</span>
            <span>
              {t('procurement.col.quotes')}: {row.quotesCount}
            </span>
            <span>{t('overview.due', { date: shortDate(row.deadline) })}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function LeadList({ rows, href }: { rows: LeadRow[]; href: string }) {
  return (
    <ul className="list">
      {rows.map((row) => (
        <li key={row.id} className="row">
          <p className="row__title">
            <Link href={href}>{row.request}</Link>
          </p>
          <p className="meta">
            <span>{row.buyer}</span>
            <StatusChip size="sm" tone={row.needsDecision ? 'warning' : 'neutral'}>
              {leadStatusLabel(row.status)}
            </StatusChip>
            <span>{t(`leadSource.${row.source}`)}</span>
            <span>{t('overview.due', { date: shortDate(row.deadline) })}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function ProjectRows({ rows }: { rows: WorkspaceProjectRow[] }) {
  return (
    <ul className="ws-list">
      {rows.map((row) => (
        <ProjectRow key={row.id} row={row} compact />
      ))}
    </ul>
  );
}

export function EventList({ rows }: { rows: EventRow[] }) {
  return (
    <ul className="list">
      {rows.map((row) => (
        <li key={row.id} className="row" style={{ gridTemplateColumns: 'auto minmax(0, 1fr)', alignItems: 'center', gap: 'var(--space-3)' }}>
          <time dateTime={row.date} className="kicker" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {shortDate(row.date)}
          </time>
          <Link href={row.href}>{row.title}</Link>
        </li>
      ))}
    </ul>
  );
}
