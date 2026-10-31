import type { ReactNode } from 'react';
import { cx } from '../../utils/cx';
import styles from './Quote.module.css';

export type QuoteProps = {
  children: ReactNode;
  /** Who said it (name, role). */
  cite?: string | undefined;
  /** Where it was said (publication, interview) — rendered inside `cite`. */
  source?: string | undefined;
  /** `pull` = magazine pull quote (serif, large, blue rule); `inline` = compact block quote in prose. */
  variant?: 'pull' | 'inline' | undefined;
  tone?: 'default' | 'inverse' | undefined;
  className?: string | undefined;
};

/** Pull quote in PT Serif with a blue rule and the editorial «» marks; semantics via `blockquote` + `figcaption`. */
export function Quote({ children, cite, source, variant = 'pull', tone = 'default', className }: QuoteProps) {
  return (
    <figure className={cx(styles.figure, styles[variant], styles[tone], className)}>
      <blockquote className={styles.quote}>
        <p className={cx(variant === 'pull' ? styles.pullText : 'trustwork-serif', styles.text)}>
          <span aria-hidden="true" className={styles.mark}>
            «
          </span>
          {children}
          <span aria-hidden="true" className={styles.mark}>
            »
          </span>
        </p>
      </blockquote>
      {cite || source ? (
        <figcaption className={cx('trustwork-body-sm', styles.caption)}>
          {cite ? <span className={styles.cite}>{cite}</span> : null}
          {cite && source ? <span aria-hidden="true"> · </span> : null}
          {source ? <cite className={styles.source}>{source}</cite> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
