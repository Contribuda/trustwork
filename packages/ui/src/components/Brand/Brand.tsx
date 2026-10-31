import { Link } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { localeTag, t } from '../../i18n';
import { logoGeometry, wordmarkGeometry, wordmarks } from './wordmark';
import { overlayWordmark } from '../../brand';
import styles from './Brand.module.css';

export type BrandVariant = 'full' | 'mark';
export type BrandTone = 'color' | 'mono' | 'inverse';

export type BrandProps = {
  /** `full` = mark + stacked wordmark; `mark` = three squares only (collapsed sidebar, favicon-like uses). */
  variant?: BrandVariant | undefined;
  tone?: BrandTone | undefined;
  /** Height in CSS px; width follows the logo's aspect ratio. */
  height?: number | undefined;
  /** When set, the logo is rendered as a link whose accessible name is `brand.logoLabel` (e.g. «Trustwork — home»). */
  href?: string | undefined;
  /** Decorative when a nearby heading already names the brand. */
  decorative?: boolean | undefined;
  className?: string | undefined;
};

function Squares({ fill }: { fill: string }) {
  const { square, gap, radius } = logoGeometry;
  const positions: Array<[number, number]> = [
    [0, square + gap],
    [square + gap, square + gap],
    [square + gap, 0],
  ];
  return (
    <>
      {positions.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={square} height={square} rx={radius} fill={fill} />
      ))}
    </>
  );
}

/**
 * Canonical brand lockup rendered inline from the same geometry as `packages/ui/brand/*.svg`.
 * Three blue squares in an L arrangement (top-left slot empty) plus the black stacked wordmark that
 * reads «trustwork» by default; a deployment's brand overlay replaces it per locale (the reference deployment
 * letters «build reputation» in six languages, see apps/web/brand). Unknown locales fall back to the engine lockup.
 */
export function Brand({ variant = 'full', tone = 'color', height = 40, href, decorative = false, className }: BrandProps) {
  const blue = tone === 'color' ? 'var(--color-brand-blue)' : 'currentColor';
  const ink = tone === 'color' ? 'var(--color-brand-ink)' : 'currentColor';
  const name = t('brand.name');
  const tag = localeTag();
  const wordmark = overlayWordmark(tag) ?? wordmarks[tag] ?? wordmarks.en!;
  const viewBoxWidth = wordmark.viewBoxWidth;
  const { viewBoxHeight, markScale, markX, markY, wordX } = logoGeometry;
  const svg =
    variant === 'mark' ? (
      <svg
        className={cx(styles.svg, tone === 'inverse' && styles.inverse)}
        viewBox="0 0 100 100"
        height={height}
        width={height}
        focusable="false"
        {...(decorative || href ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
      >
        <Squares fill={blue} />
      </svg>
    ) : (
      <svg
        className={cx(styles.svg, tone === 'inverse' && styles.inverse)}
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
        height={height}
        width={(height * viewBoxWidth) / viewBoxHeight}
        focusable="false"
        {...(decorative || href ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
      >
        <g transform={`translate(${markX} ${markY}) scale(${markScale})`}>
          <Squares fill={blue} />
        </g>
        <g fill={ink} transform={`translate(${wordX} ${wordmarkGeometry.baseline1}) scale(${wordmarkGeometry.fontSize})`}>
          {wordmark.line1.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        <g fill={ink} transform={`translate(${wordX} ${wordmarkGeometry.baseline2}) scale(${wordmarkGeometry.fontSize})`}>
          {wordmark.line2.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      </svg>
    );
  if (href) {
    return (
      <Link href={href} className={cx(styles.link, className)} aria-label={t('brand.logoLabel')}>
        {svg}
      </Link>
    );
  }
  return <span className={cx(styles.root, className)}>{svg}</span>;
}
