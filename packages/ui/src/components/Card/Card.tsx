import type { ReactNode } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { cx } from '../../utils/cx';
import styles from './Card.module.css';

export type CardProps = {
  children: ReactNode;
  /** Section heading rendered inside the card header. */
  title?: string | undefined;
  headingLevel?: 2 | 3 | 4 | undefined;
  /** Header-right slot (link «Все», count chip). */
  aside?: ReactNode;
  footer?: ReactNode;
  padding?: 'none' | 'sm' | 'md' | undefined;
  /** Renders as `section` with `aria-labelledby` when a title exists. */
  id?: string | undefined;
  isSelected?: boolean | undefined;
  className?: string | undefined;
};

/** Surface card. Interactive cards have one primary link (`CardLink`); never nest interactive content inside a link. */
export function Card({ children, title, headingLevel = 2, aside, footer, padding = 'md', id, isSelected = false, className }: CardProps) {
  const Heading = `h${headingLevel}` as const;
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      className={cx(styles.card, styles[`pad${padding.charAt(0).toUpperCase()}${padding.slice(1)}`], isSelected && styles.selected, className)}
      {...(id ? { id } : {})}
      {...(headingId && title ? { 'aria-labelledby': headingId } : {})}
    >
      {title || aside ? (
        <header className={styles.header}>
          {title ? (
            <Heading className={styles.title} {...(headingId ? { id: headingId } : {})}>
              {title}
            </Heading>
          ) : null}
          {aside ? <div className={styles.aside}>{aside}</div> : null}
        </header>
      ) : null}
      <div className={styles.body}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </section>
  );
}

export type CardLinkProps = { href: string; children: ReactNode; className?: string | undefined };

/** The single primary link of an interactive card; stretches over the card via CSS so the whole card is the target. */
export function CardLink({ href, children, className }: CardLinkProps) {
  return (
    <AriaLink href={href} className={cx(styles.link, className)}>
      {children}
    </AriaLink>
  );
}
