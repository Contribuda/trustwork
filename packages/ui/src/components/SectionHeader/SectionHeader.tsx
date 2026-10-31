import type { ReactNode } from 'react';
import { cx } from '../../utils/cx';
import { Heading, Kicker } from '../Typography/Typography';
import styles from './SectionHeader.module.css';

export type SectionHeaderProps = {
  title: string;
  kicker?: string | undefined;
  description?: string | undefined;
  /** Trailing action, usually `<Link variant="standalone">Все новости</Link>`. */
  action?: ReactNode;
  headingLevel?: 1 | 2 | 3 | undefined;
  /** Visual size: `lg` uses the h1 style (page header), `md` the h2 style (section). */
  size?: 'lg' | 'md' | 'sm' | undefined;
  tone?: 'default' | 'inverse' | undefined;
  id?: string | undefined;
  className?: string | undefined;
};

/** Section header: kicker, heading, description and a trailing action aligned to the heading baseline. */
export function SectionHeader({ title, kicker, description, action, headingLevel = 2, size = 'md', tone = 'default', id, className }: SectionHeaderProps) {
  return (
    <header className={cx(styles.header, styles[size], styles[tone], className)}>
      <div className={styles.text}>
        {kicker ? <Kicker tone={tone === 'inverse' ? 'inverse' : 'accent'}>{kicker}</Kicker> : null}
        <Heading level={headingLevel} styleAs={size === 'lg' ? 'h1' : size === 'sm' ? 'h3' : 'h2'} tone={tone === 'inverse' ? 'inverse' : 'default'} {...(id ? { id } : {})}>
          {title}
        </Heading>
        {description ? <p className={cx(size === 'lg' ? 'trustwork-body-lg' : 'trustwork-body', styles.description)}>{description}</p> : null}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </header>
  );
}
