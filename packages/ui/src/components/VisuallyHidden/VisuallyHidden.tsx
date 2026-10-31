import type { ElementType, ReactNode } from 'react';
import styles from './VisuallyHidden.module.css';

export type VisuallyHiddenProps = { children: ReactNode; as?: ElementType | undefined; id?: string | undefined };

/** Screen-reader-only text (not display:none, so it is announced). */
export function VisuallyHidden({ children, as: Tag = 'span', id }: VisuallyHiddenProps) {
  return (
    <Tag className={styles.root} {...(id ? { id } : {})}>
      {children}
    </Tag>
  );
}

export const visuallyHiddenClass = styles.root;
