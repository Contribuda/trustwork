import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { coverFor, type MediaRef } from '../../media/index';
import { Avatar } from '../Avatar/Avatar';
import { RecordStatusChip, type RecordStatus } from '../Badge/Badge';
import { MediaFrame, type MediaSource } from '../MediaFrame/MediaFrame';
import { Kicker, Meta } from '../Typography/Typography';
import styles from './EntityCard.module.css';

export type EntityKind = 'company' | 'person' | 'project';

export type EntityFact = { label: string; value: ReactNode };

export type EntityCardProps = {
  kind: EntityKind;
  name: string;
  href: string;
  /** One line under the name: activity, role or project stage. */
  description?: string | undefined;
  /** Record status chip (sourced / claimed / verified). Never invent `verified`. */
  status?: RecordStatus | undefined;
  /** Cover; defaults to `coverFor(kind, name)`. People never get photographs (artwork + initials). */
  media?: MediaRef | MediaSource | undefined;
  /** Up to four facts rendered as a row: «Регион», «Проекты», «Публикации». */
  facts?: readonly EntityFact[] | undefined;
  /** Meta row under the facts (location, updated date). */
  meta?: readonly ReactNode[] | undefined;
  layout?: 'vertical' | 'horizontal' | undefined;
  headingLevel?: 2 | 3 | 4 | undefined;
  enterIndex?: number | undefined;
  className?: string | undefined;
};

/** Company / person / project card: cover, record status badge, name, description and a facts row. One link (the name). */
export function EntityCard({ kind, name, href, description, status, media, facts, meta, layout = 'vertical', headingLevel = 3, enterIndex, className }: EntityCardProps) {
  const Heading = `h${headingLevel}` as const;
  const cover = media ?? coverFor(kind, name);
  return (
    <article className={cx(styles.card, styles[layout], styles[kind], className)} {...(enterIndex !== undefined ? { style: { ['--enter-index' as string]: enterIndex } } : {})}>
      <div className={styles.cover}>
        <MediaFrame media={cover} ratio={layout === 'horizontal' ? '1/1' : kind === 'person' ? '21/9' : '16/10'} radius="none" hoverScale sizes="(max-width: 767px) 100vw, 400px" className={styles.frame} />
        {status ? (
          <div className={styles.badge}>
            <RecordStatusChip status={status} size="sm" />
          </div>
        ) : null}
        {kind === 'person' ? (
          <div className={styles.avatar}>
            <Avatar name={name} size={layout === 'horizontal' ? 48 : 64} decorative />
          </div>
        ) : null}
      </div>
      <div className={styles.body}>
        <Kicker as="span" tone="muted">
          {t(`entity.${kind}`)}
        </Kicker>
        <Heading className={cx('trustwork-h3', styles.title)}>
          <AriaLink href={href} className={cx(styles.link)}>
            {name}
          </AriaLink>
        </Heading>
        {description ? <p className={cx('trustwork-body-sm', styles.description)}>{description}</p> : null}
        {facts && facts.length ? (
          <dl className={styles.facts}>
            {facts.slice(0, 4).map((fact) => (
              <div key={fact.label} className={styles.fact}>
                <dt className={styles.factLabel}>{fact.label}</dt>
                <dd className={styles.factValue}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {meta && meta.length ? <Meta items={meta} size="caption" className={styles.meta} /> : null}
      </div>
    </article>
  );
}
