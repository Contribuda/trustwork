import type { ReactNode } from 'react';
import { CheckCircle2, CircleAlert, CircleDashed, CircleHelp, Flag, GitCommitHorizontal } from 'lucide-react';
import { cx } from '../../utils/cx';
import { formatDate, t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { EvidenceLabel, type EvidenceState } from '../Badge/Badge';
import styles from './Timeline.module.css';

export type TimelineMark = 'done' | 'pending' | 'baseline' | 'changed' | 'disputed' | 'outcomeUnknown';

export type TimelineEvent = {
  id: string;
  title: string;
  /** ISO timestamp. */
  at?: string | undefined;
  mark?: TimelineMark | undefined;
  description?: ReactNode;
  /** Evidence receipts or attachments. */
  evidence?: EvidenceState | undefined;
  meta?: string | undefined;
};

export type TimelineProps = { label?: string | undefined; events: readonly TimelineEvent[]; className?: string | undefined };

const markMeta: Record<TimelineMark, { icon: typeof Flag; tone: string }> = {
  done: { icon: CheckCircle2, tone: 'success' },
  pending: { icon: CircleDashed, tone: 'neutral' },
  baseline: { icon: Flag, tone: 'info' },
  changed: { icon: GitCommitHorizontal, tone: 'warning' },
  disputed: { icon: CircleAlert, tone: 'warning' },
  outcomeUnknown: { icon: CircleHelp, tone: 'warning' },
};

/** Ordered list of events; every mark has a text label (baseline vs changed, disputed, outcome unknown) — never colour-only. */
export function Timeline({ label = t('timeline.label'), events, className }: TimelineProps) {
  return (
    <ol aria-label={label} className={cx(styles.list, className)}>
      {events.map((event) => {
        const mark = event.mark ?? 'done';
        const meta = markMeta[mark];
        return (
          <li key={event.id} className={cx(styles.item, styles[`tone${meta.tone.charAt(0).toUpperCase()}${meta.tone.slice(1)}`])}>
            <span className={styles.marker}>
              <Icon icon={meta.icon} size={16} />
            </span>
            <div className={styles.body}>
              <p className={styles.title}>
                <span className={styles.markLabel}>{t(`timeline.${mark}`)}</span>
                <span>{event.title}</span>
              </p>
              {event.at || event.meta ? (
                <p className={styles.meta}>
                  {event.at ? <time dateTime={event.at}>{formatDate(event.at)}</time> : null}
                  {event.at && event.meta ? ' · ' : null}
                  {event.meta}
                </p>
              ) : null}
              {event.description ? <div className={styles.description}>{event.description}</div> : null}
              {event.evidence ? <EvidenceLabel state={event.evidence} size="sm" /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export type EvidenceListItem = { id: string; title: string; state: EvidenceState; source: string; observedAt?: string | undefined; href?: string | undefined };

/** Evidence list: each entry carries its state label and provenance line. */
export function EvidenceList({ items, label, className }: { items: readonly EvidenceListItem[]; label: string; className?: string | undefined }) {
  return (
    <ul aria-label={label} className={cx(styles.evidence, className)}>
      {items.map((item) => (
        <li key={item.id} className={styles.evidenceItem}>
          <div className={styles.evidenceHead}>
            {item.href ? (
              <a href={item.href} className={styles.evidenceLink}>
                {item.title}
              </a>
            ) : (
              <span className={styles.evidenceTitle}>{item.title}</span>
            )}
            <EvidenceLabel state={item.state} size="sm" />
          </div>
          <p className={styles.meta}>{item.observedAt ? t('search.freshness', { source: item.source, observedAt: formatDate(item.observedAt, 'short') }) : item.source}</p>
        </li>
      ))}
    </ul>
  );
}
