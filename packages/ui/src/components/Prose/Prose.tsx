import type { ReactNode } from 'react';
import { cx } from '../../utils/cx';
import styles from './Prose.module.css';

export type ProseProps = {
  children: ReactNode;
  /** `serif` = magazine/article body in PT Serif 19/1.65; `sans` = help and platform pages. */
  family?: 'serif' | 'sans' | undefined;
  /** Max measure: `reader` (720 px) or `none`. */
  measure?: 'reader' | 'none' | undefined;
  /** Rendered element; `article` for a whole body, `div` for fragments. */
  as?: 'article' | 'div' | 'section' | undefined;
  lang?: string | undefined;
  id?: string | undefined;
  className?: string | undefined;
};

/**
 * Article body typography: headings, paragraphs, lists, figures with captions, tables with tabular figures,
 * block quotes and ink links with a blue hover underline. Hyphenation is on (`.trustwork-prose`).
 */
export function Prose({ children, family = 'serif', measure = 'reader', as = 'article', lang, id, className }: ProseProps) {
  const Tag = as;
  return (
    <Tag {...(id ? { id } : {})} {...(lang ? { lang } : {})} className={cx('trustwork-prose', styles.prose, styles[family], measure === 'reader' && styles.reader, className)}>
      {children}
    </Tag>
  );
}
