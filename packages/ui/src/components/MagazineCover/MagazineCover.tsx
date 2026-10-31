import { Link as AriaLink } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import type { MediaRef } from '../../media/index';
import { Brand } from '../Brand/Brand';
import { MediaFrame, type MediaSource } from '../MediaFrame/MediaFrame';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './MagazineCover.module.css';

export type MagazineCoverProps = {
  issue: number;
  /** Already formatted: «26 октября — 1 ноября 2026». */
  dateRange: string;
  title: string;
  /** Up to three short lines at the foot of the cover (rubrics of the issue). */
  topics?: readonly string[] | undefined;
  media: MediaRef | MediaSource;
  /** `lg` = lead cover (~300 px wide), `md` = archive grid, `sm` = thumbnail. */
  size?: 'sm' | 'md' | 'lg' | undefined;
  /**
   * `issue` (default) prints the issue title over the photograph; `brand` is the generic cover used on
   * promotional bands: the wordmark and the tagline on top, the issue number and dates at the foot.
   */
  variant?: 'issue' | 'brand' | undefined;
  /** Link to the issue; the cover becomes the single link named «Обложка выпуска № N …» from its own text. */
  href?: string | undefined;
  /** Perspective tilt with a hover straightening (off under reduced motion). */
  tilt?: boolean | undefined;
  className?: string | undefined;
};

const BRAND_HEIGHT = { lg: 44, md: 30, sm: 20 } as const;

/**
 * Printed-magazine cover: 3:4 photograph with a slate masthead gradient, the inverse wordmark, the issue number
 * and dates, the title (or the tagline for the brand variant) and the rubric strip at the foot. The card sits in
 * perspective with a layered shadow and a spine highlight, so it reads as an object rather than a picture.
 */
export function MagazineCover({ issue, dateRange, title, topics, media, size = 'lg', variant = 'issue', href, tilt = true, className }: MagazineCoverProps) {
  const taglineLines = t('publicShell.tagline')
    .split('.')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${line}.`);
  const cover = (
    <div className={cx(styles.cover, styles[size], styles[variant], tilt && styles.tilt)}>
      <VisuallyHidden>{t('magazine.coverPrefix')} </VisuallyHidden>
      <MediaFrame media={media} ratio="3/4" radius="none" className={styles.frame} sizes={size === 'lg' ? '(max-width: 767px) 70vw, 320px' : '(max-width: 767px) 45vw, 240px'} />
      <span className={styles.shade} aria-hidden="true" />
      <div className={styles.masthead}>
        <Brand variant="full" tone="inverse" height={BRAND_HEIGHT[size]} decorative />
        {variant === 'issue' ? (
          <div className={styles.issue}>
            <span className={styles.issueNumber}>{t('magazine.issueShort', { number: issue })}</span>
            <span className={styles.issueDate}>{dateRange}</span>
          </div>
        ) : null}
      </div>
      {variant === 'brand' ? (
        <p className={styles.tagline} aria-hidden="true">
          {taglineLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </p>
      ) : null}
      <div className={styles.foot}>
        {variant === 'issue' ? (
          <p className={cx(styles.title, size === 'lg' ? styles.titleLg : size === 'md' ? styles.titleMd : styles.titleSm)}>{title}</p>
        ) : (
          <p className={styles.footMeta}>
            <span className={styles.issueNumber}>{t('magazine.issueShort', { number: issue })}</span>
            <span className={styles.issueDate}>{dateRange}</span>
            <VisuallyHidden>{title}</VisuallyHidden>
          </p>
        )}
        {topics && topics.length && size !== 'sm' ? (
          <ul className={styles.topics}>
            {topics.slice(0, 3).map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <span className={styles.spine} aria-hidden="true" />
    </div>
  );
  if (!href) {
    return <figure className={cx(styles.root, className)}>{cover}</figure>;
  }
  return (
    <AriaLink href={href} className={cx(styles.root, styles.link, className)}>
      {cover}
    </AriaLink>
  );
}
