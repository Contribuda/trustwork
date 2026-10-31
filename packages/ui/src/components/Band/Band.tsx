import type { ReactNode } from 'react';
import { cx } from '../../utils/cx';
import type { MediaRef } from '../../media/index';
import { MediaFrame, type MediaSource } from '../MediaFrame/MediaFrame';
import styles from './Band.module.css';

export type BandTone = 'navy' | 'tint' | 'warm' | 'surface';

export type BandProps = {
  tone?: BandTone | undefined;
  /** Vertical padding: `md` = section rhythm, `lg` = large rhythm, `sm` = compact strip. */
  padding?: 'sm' | 'md' | 'lg' | undefined;
  /** Stretches the background to the viewport edges when the band is rendered inside a centred container. */
  fullBleed?: boolean | undefined;
  /** Optional photograph behind a navy band (rendered with the full scrim, text stays AA). */
  backdrop?: MediaRef | MediaSource | undefined;
  /** Inner content width: `container` (1200 px) or `fluid`. */
  width?: 'container' | 'fluid' | undefined;
  as?: 'section' | 'div' | 'aside' | 'footer' | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-label'?: string | undefined;
  id?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};

/** Full-bleed band: dark navy (light text, blue link hover), light blue tint, warm sand or plain surface. */
export function Band({ tone = 'navy', padding = 'md', fullBleed = false, backdrop, width = 'container', as = 'section', id, className, children, ...aria }: BandProps) {
  const Tag = as;
  return (
    <Tag {...aria} {...(id ? { id } : {})} className={cx(styles.band, styles[tone], styles[`pad${padding.charAt(0).toUpperCase()}${padding.slice(1)}`], fullBleed && styles.fullBleed, className)} data-tone={tone}>
      {backdrop ? <MediaFrame media={backdrop} ratio="fill" scrim="full" className={styles.backdrop} sizes="100vw" /> : null}
      <div className={cx(styles.inner, width === 'container' && 'trustwork-container')}>{children}</div>
    </Tag>
  );
}
