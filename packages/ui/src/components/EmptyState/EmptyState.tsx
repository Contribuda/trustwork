import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';
import { coverFor, type MediaRef } from '../../media/index';
import { Icon } from '../Icon/Icon';
import { MediaFrame, type MediaSource } from '../MediaFrame/MediaFrame';
import styles from './EmptyState.module.css';

export type EmptyStateProps = {
  title: string;
  children?: ReactNode;
  /** Up to two actions (primary first). */
  actions?: ReactNode;
  icon?: LucideIcon | undefined;
  /** Artwork from the media set: `'auto'` picks one deterministically from the title; a `MediaRef` pins it. Decorative. */
  illustration?: MediaRef | MediaSource | 'auto' | undefined;
  /** Heading level matching the surrounding outline. */
  headingLevel?: 2 | 3 | 4 | undefined;
  tone?: 'neutral' | 'error' | 'denied' | undefined;
  /** `card` (default) = bordered surface; `plain` = inside an existing card. */
  variant?: 'card' | 'plain' | undefined;
  className?: string | undefined;
};

/** Purposeful empty / error / no-access state with an optional artwork from the media set. Never reveals object existence. */
export function EmptyState({ title, children, actions, icon, illustration, headingLevel = 2, tone = 'neutral', variant = 'card', className }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  const media = illustration === 'auto' ? coverFor('article', title, { prefer: 'artwork' }) : illustration;
  return (
    <div className={cx(styles.root, styles[tone], styles[variant], className)}>
      {media ? (
        <div className={styles.illustration}>
          <MediaFrame media={{ src: media.src, alt: '' }} ratio="4/3" radius="media" className={styles.illustrationFrame} />
        </div>
      ) : null}
      {icon && !media ? (
        <span className={styles.icon}>
          <Icon icon={icon} size={24} />
        </span>
      ) : null}
      <Heading className={cx('trustwork-h3', styles.title)}>{title}</Heading>
      {children ? <div className={styles.body}>{children}</div> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
