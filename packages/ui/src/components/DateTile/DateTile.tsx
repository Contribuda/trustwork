import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { formatDate, intlTag } from '../../i18n';
import { Meta } from '../Typography/Typography';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './DateTile.module.css';

export type DateTileProps = {
  /** ISO date or timestamp. */
  date: string;
  size?: 'sm' | 'md' | undefined;
  tone?: 'default' | 'accent' | 'warning' | undefined;
  className?: string | undefined;
};

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

function parts(value: string): { day: string; month: string; iso: string; label: string } {
  const date = new Date(dateOnly.test(value) ? `${value}T00:00:00Z` : value);
  const zone = dateOnly.test(value) ? { timeZone: 'UTC' as const } : {};
  const day = new Intl.DateTimeFormat(intlTag(), { day: 'numeric', ...zone }).format(date);
  const month = new Intl.DateTimeFormat(intlTag(), { month: 'short', ...zone }).format(date).replace(/\.$/, '');
  return { day, month, iso: value, label: formatDate(value) };
}

/** Calendar tile: day number (tabular, bold) over a 3-letter month; the full date is visually hidden text inside `time[datetime]`. */
export function DateTile({ date, size = 'md', tone = 'default', className }: DateTileProps) {
  const p = parts(date);
  return (
    <time dateTime={p.iso} className={cx(styles.tile, styles[size], styles[tone], className)}>
      <span aria-hidden="true" className={styles.day}>
        {p.day}
      </span>
      <span aria-hidden="true" className={styles.month}>
        {p.month}
      </span>
      <VisuallyHidden>{p.label}</VisuallyHidden>
    </time>
  );
}

export type EventItem = {
  id: string;
  date: string;
  title: string;
  /** Context line: project or counterparty. */
  context?: string | undefined;
  /** Extra meta items after the context. */
  meta?: readonly ReactNode[] | undefined;
  href?: string | undefined;
  tone?: DateTileProps['tone'] | undefined;
};

export type EventListProps = {
  /** Accessible name of the list («Ближайшие события»). */
  label: string;
  items: readonly EventItem[];
  className?: string | undefined;
};

/** Upcoming events with date tiles and a connecting rail; each item has at most one link (its title). */
export function EventList({ label, items, className }: EventListProps) {
  return (
    <ol aria-label={label} className={cx(styles.list, className)}>
      {items.map((item) => (
        <li key={item.id} className={styles.item}>
          <DateTile date={item.date} size="sm" tone={item.tone ?? 'default'} />
          <div className={styles.body}>
            <p className={cx('trustwork-body', styles.title)}>
              {item.href ? (
                <AriaLink href={item.href} className={cx(styles.link)}>
                  {item.title}
                </AriaLink>
              ) : (
                item.title
              )}
            </p>
            {item.context || (item.meta && item.meta.length) ? <Meta items={[item.context, ...(item.meta ?? [])]} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
