import { shortDate, t } from '@/app/_lib/i18n';
import type { Accreditation } from '@/app/_lib/data/types';

/** The three brand squares (top-left slot empty), sized by `size`; decorative. */
export function SRLogo({ size = 16, tone = 'brand' }: { size?: number; tone?: 'brand' | 'white' }) {
  const fill = tone === 'white' ? '#fff' : 'var(--color-brand-blue, #2563eb)';
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="0" y="11" width="9" height="9" rx="1.6" fill={fill} />
      <rect x="11" y="11" width="9" height="9" rx="1.6" fill={fill} />
      <rect x="11" y="0" width="9" height="9" rx="1.6" fill={fill} />
    </svg>
  );
}

/**
 * Platform accreditation («verified by the platform») mark: the brand squares in a small tile plus a label; the title lists what was
 * checked and when. `compact` shows the tile only (cards, lists).
 */
export function SRMark({ accreditation = null, compact = false, size = 'md' }: { accreditation?: Accreditation; compact?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const title = accreditation ? t('sr.markHint', { scope: accreditation.scope.join(', ').toLowerCase(), date: shortDate(accreditation.verifiedAt) }) : t('sr.mark');
  const px = size === 'lg' ? 18 : size === 'sm' ? 11 : 13;
  return (
    <span className={`srm srm--${size}${compact ? ' srm--compact' : ''}`} title={title} role="img" aria-label={t('sr.mark')}>
      <span className="srm__tile">
        <SRLogo size={px} tone="white" />
      </span>
      {compact ? null : <span className="srm__label">{size === 'sm' ? t('sr.markShort') : t('sr.mark')}</span>}
    </span>
  );
}
