import type { ReactNode } from 'react';
import { cx } from '../../utils/cx';
import styles from './Skeleton.module.css';

export type SkeletonProps = {
  variant?: 'text' | 'card' | 'row' | 'circle' | 'table' | undefined;
  /** Number of repeated lines/rows. */
  lines?: number | undefined;
  width?: number | string | undefined;
  height?: number | string | undefined;
  className?: string | undefined;
};

/**
 * Loading placeholder; `aria-hidden` itself. The container that is loading must carry `aria-busy="true"`
 * and a visible/announced status (see `SkeletonGroup`).
 */
export function Skeleton({ variant = 'text', lines = 1, width, height, className }: SkeletonProps) {
  const style = { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
  if (variant === 'table') {
    return (
      <div aria-hidden="true" className={cx(styles.table, className)}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={styles.tableRow}>
            <span className={cx(styles.bone, styles.text)} style={{ width: '30%' }} />
            <span className={cx(styles.bone, styles.text)} style={{ width: '20%' }} />
            <span className={cx(styles.bone, styles.text)} style={{ width: '15%' }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={cx(styles.group, className)}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={cx(styles.bone, styles[variant])} style={style} />
      ))}
    </div>
  );
}

export type SkeletonGroupProps = { label: string; children: ReactNode; className?: string | undefined };

/** Region that announces loading once (`role="status"`) and marks itself busy. */
export function SkeletonGroup({ label, children, className }: SkeletonGroupProps) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      {children}
    </div>
  );
}
