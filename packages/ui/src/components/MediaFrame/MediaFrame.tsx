import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../utils/cx';
import type { MediaRef } from '../../media/index';
import styles from './MediaFrame.module.css';

export type MediaRatio = '16/10' | '4/3' | '1/1' | '21/9' | '3/4' | 'auto' | 'fill';
export type MediaScrim = 'none' | 'bottom' | 'left' | 'full';

export type MediaSource = {
  src: string;
  /** Required: a Russian description, or an empty string for a purely decorative image inside a named control. */
  alt: string;
  srcSet?: string | undefined;
  sizes?: string | undefined;
  placeholder?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
};

export type MediaFrameProps = {
  /** A `coverFor()` result or a plain source. */
  media: MediaRef | MediaSource;
  /** Aspect ratio; `auto` keeps the image's own height, `fill` covers a positioned parent (backdrops). */
  ratio?: MediaRatio | undefined;
  /** Navy gradient for white text overlays; `bottom` for cards and heroes, `left` for wide heroes, `full` for bands. */
  scrim?: MediaScrim | undefined;
  radius?: 'media' | 'card' | 'none' | undefined;
  /** Overlay content (kicker, title, meta) positioned at the bottom-left by default. */
  children?: ReactNode;
  overlayAlign?: 'bottom' | 'center' | 'top' | undefined;
  /** `eager` for the lead image above the fold: fetched first and shown as soon as it is decoded, without waiting for scripts. */
  loading?: 'lazy' | 'eager' | undefined;
  /** When the frame sits inside a hover-lifted card, the parent sets this to enable the 1.03 media scale. */
  hoverScale?: boolean | undefined;
  /** Default `sizes` when the media does not define it. */
  sizes?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
};

function toSource(media: MediaRef | MediaSource): MediaSource {
  if ('type' in media) {
    if (media.type === 'photo') return { src: media.src, alt: media.alt, srcSet: media.srcSet, placeholder: media.placeholder, width: media.width, height: media.height };
    return { src: media.src, alt: media.alt };
  }
  return media;
}

const ratioClass: Record<MediaRatio, string> = { '16/10': 'r1610', '4/3': 'r43', '1/1': 'r11', '21/9': 'r219', '3/4': 'r34', auto: 'rAuto', fill: 'rFill' };

/**
 * Media frame with aspect ratio, blur-up placeholder, optional scrim and overlay slot. The image is a real `img`
 * with required `alt`; the placeholder is a tiny data URI painted behind it until `load` fires. With a scrim, the
 * bottom overlay block carries a second, text-anchored navy gradient (`--scrim-text`) so white text keeps AA
 * contrast however tall the text block is (verified by tests/e2e/contrast.spec.ts against the real pixels).
 */
export function MediaFrame({ media, ratio = '16/10', scrim = 'none', radius = 'media', children, overlayAlign = 'bottom', loading = 'lazy', hoverScale = false, sizes, className, style }: MediaFrameProps) {
  const source = toSource(media);
  const imgRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (imgRef.current?.complete) setLoaded(true);
  }, [source.src]);
  const isArtwork = 'type' in media && media.type === 'artwork';
  const backgroundStyle: CSSProperties = source.placeholder ? { backgroundImage: `url("${source.placeholder}")` } : isArtwork ? { backgroundColor: media.dominant } : {};
  return (
    <div
      className={cx(
        styles.frame,
        styles[ratioClass[ratio]],
        styles[`radius${radius.charAt(0).toUpperCase()}${radius.slice(1)}`],
        scrim !== 'none' && styles[`scrim${scrim.charAt(0).toUpperCase()}${scrim.slice(1)}`],
        hoverScale && styles.hoverScale,
        className,
      )}
      style={style}
      data-loaded={loaded || undefined}
      data-eager={loading === 'eager' || undefined}
    >
      <div className={styles.placeholder} style={backgroundStyle} aria-hidden="true" />
      <img
        ref={imgRef}
        src={source.src}
        {...(source.srcSet ? { srcSet: source.srcSet } : {})}
        {...(source.srcSet ? { sizes: source.sizes ?? sizes ?? '(max-width: 767px) 100vw, 50vw' } : {})}
        alt={source.alt}
        {...(source.width && source.height ? { width: source.width, height: source.height } : {})}
        loading={loading}
        {...(loading === 'eager' ? { fetchPriority: 'high' as const } : {})}
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={styles.image}
      />
      {children ? (
        <div className={cx(styles.overlay, styles[`overlay${overlayAlign.charAt(0).toUpperCase()}${overlayAlign.slice(1)}`])}>
          <div className={cx(styles.overlayInner, scrim !== 'none' && overlayAlign === 'bottom' && styles.overlayAnchored)}>{children}</div>
        </div>
      ) : null}
    </div>
  );
}
