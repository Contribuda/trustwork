import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { cx } from '../../utils/cx';
import type { MediaRef } from '../../media/index';
import { MediaFrame, type MediaRatio, type MediaSource } from '../MediaFrame/MediaFrame';
import { Kicker, Meta } from '../Typography/Typography';
import styles from './StoryCard.module.css';

export type StoryCardSize = 's' | 'm' | 'l';

export type StoryCardProps = {
  title: string;
  href: string;
  /** Kicker text (rubric). Chips for topics go into `chips`. */
  kicker?: string | undefined;
  /** Topic chips rendered next to the kicker (plain text, not links: the card has exactly one link). */
  chips?: readonly string[] | undefined;
  dek?: string | undefined;
  /** Meta row items: byline, date, reading time. */
  meta?: readonly ReactNode[] | undefined;
  media?: MediaRef | MediaSource | undefined;
  ratio?: MediaRatio | undefined;
  size?: StoryCardSize | undefined;
  layout?: 'vertical' | 'horizontal' | undefined;
  headingLevel?: 2 | 3 | 4 | undefined;
  /** Index for the staggered enter animation inside `.trustwork-enter-group`. */
  enterIndex?: number | undefined;
  className?: string | undefined;
};

/**
 * The one editorial card family: media on top (or left in `horizontal`), kicker + chips, title, dek, meta.
 * Rests on e1, lifts to e2 with translateY(-2px) and a 1.03 media scale on hover; the title is the single link.
 */
export function StoryCard({ title, href, kicker, chips, dek, meta, media, ratio, size = 'm', layout = 'vertical', headingLevel = 3, enterIndex, className }: StoryCardProps) {
  const Heading = `h${headingLevel}` as const;
  const frameRatio: MediaRatio = ratio ?? (layout === 'horizontal' ? '4/3' : size === 'l' ? '16/10' : '16/10');
  return (
    <article className={cx(styles.card, styles[size], styles[layout], !media && styles.noMedia, className)} {...(enterIndex !== undefined ? { style: { ['--enter-index' as string]: enterIndex } } : {})}>
      {media ? <MediaFrame media={media} ratio={frameRatio} radius="none" hoverScale sizes={size === 'l' ? '(max-width: 767px) 100vw, 800px' : '(max-width: 767px) 100vw, 400px'} className={styles.media} /> : null}
      <div className={styles.body}>
        {kicker || (chips && chips.length) ? (
          <div className={styles.rubric}>
            {kicker ? <Kicker as="span">{kicker}</Kicker> : null}
            {chips?.map((chip) => (
              <span key={chip} className={styles.chip}>
                {chip}
              </span>
            ))}
          </div>
        ) : null}
        <Heading className={cx(size === 'l' ? 'trustwork-h2' : size === 'm' ? 'trustwork-h3' : 'trustwork-h4', styles.title)}>
          <AriaLink href={href} className={cx(styles.link)}>
            {title}
          </AriaLink>
        </Heading>
        {dek ? <p className={cx(size === 's' ? 'trustwork-body-sm' : 'trustwork-body', styles.dek)}>{dek}</p> : null}
        {meta && meta.length ? <Meta items={meta} className={styles.meta} /> : null}
      </div>
    </article>
  );
}
