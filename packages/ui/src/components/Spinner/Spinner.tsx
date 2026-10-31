import { ProgressBar } from 'react-aria-components';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import styles from './Spinner.module.css';

export type SpinnerProps = { label?: string | undefined; size?: 16 | 20 | 24 | 32 | undefined; className?: string | undefined };

/** Indeterminate progress indicator with an accessible Russian label (`role="progressbar"`). */
export function Spinner({ label = t('common.loading'), size = 20, className }: SpinnerProps) {
  return (
    <ProgressBar aria-label={label} isIndeterminate className={cx(styles.root, className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className={styles.svg}>
        <circle className={styles.track} cx="12" cy="12" r="9" fill="none" strokeWidth="3" />
        <circle className={styles.arc} cx="12" cy="12" r="9" fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray="28 56" />
      </svg>
    </ProgressBar>
  );
}
