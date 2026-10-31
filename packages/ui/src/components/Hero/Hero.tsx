import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { cx } from '../../utils/cx';
import type { MediaRef } from '../../media/index';
import { MediaFrame, type MediaSource } from '../MediaFrame/MediaFrame';
import { Kicker, Meta } from '../Typography/Typography';
import styles from './Hero.module.css';

export type HeroProps = {
  media: MediaRef | MediaSource;
  kicker?: string | undefined;
  title: string;
  /** Deck: one or two sentences under the headline. */
  dek?: string | undefined;
  /** Meta row items («Редакция», date, reading time). */
  meta?: readonly ReactNode[] | undefined;
  href: string;
  headingLevel?: 1 | 2 | undefined;
  /** `lg` = 21:9 lead story (display size), `md` = 16:10 (h1 size), `sm` = 16:10 secondary tile (h3 size, compact). */
  size?: 'lg' | 'md' | 'sm' | undefined;
  /** Secondary slot rendered under the meta (for example a «Читать» button); keep it non-interactive or place interactive content outside the hero. */
  footer?: ReactNode;
  className?: string | undefined;
};

/**
 * Editorial lead story: photograph with a navy scrim, kicker, display headline, dek and meta. The whole hero is one
 * link (the title), stretched over the frame; white text sits in the scrim zone that the unit test proves AA.
 */
export function Hero({ media, kicker, title, dek, meta, href, headingLevel = 1, size = 'lg', footer, className }: HeroProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <article className={cx(styles.hero, styles[size], className)}>
      <MediaFrame
        media={media}
        ratio={size === 'lg' ? '21/9' : '16/10'}
        scrim={size === 'lg' ? 'left' : 'bottom'}
        radius="media"
        loading={size === 'sm' ? 'lazy' : 'eager'}
        sizes={size === 'sm' ? '(max-width: 767px) 100vw, 400px' : '(max-width: 767px) 100vw, 1200px'}
        hoverScale
        className={styles.frame}
      >
        <div className={styles.content}>
          {kicker ? <Kicker tone="inverse">{kicker}</Kicker> : null}
          <Heading className={cx(size === 'lg' ? 'trustwork-display' : size === 'md' ? 'trustwork-h1' : 'trustwork-h3', styles.title)}>
            <AriaLink href={href} className={cx(styles.link)}>
              {title}
            </AriaLink>
          </Heading>
          {dek && size !== 'sm' ? <p className={cx('trustwork-body-lg', styles.dek)}>{dek}</p> : null}
          {meta && meta.length ? <Meta items={meta} tone="inverse" className={styles.meta} /> : null}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      </MediaFrame>
    </article>
  );
}
