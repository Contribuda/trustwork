import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';
import { cx } from '../../utils/cx';
import styles from './Typography.module.css';

export type HeadingLevel = 1 | 2 | 3 | 4;
export type HeadingStyle = 'display' | 'h1' | 'h2' | 'h3' | 'h4';
export type TextStyle = 'bodyLg' | 'body' | 'bodySm' | 'caption' | 'serif';
export type TextTone = 'default' | 'muted' | 'subtle' | 'inverse' | 'inverseMuted' | 'accent';

const headingClass: Record<HeadingStyle, string> = { display: 'trustwork-display', h1: 'trustwork-h1', h2: 'trustwork-h2', h3: 'trustwork-h3', h4: 'trustwork-h4' };
const textClass: Record<TextStyle, string> = { bodyLg: 'trustwork-body-lg', body: 'trustwork-body', bodySm: 'trustwork-body-sm', caption: 'trustwork-caption', serif: 'trustwork-serif' };

export type HeadingProps = {
  /** Semantic level (the HTML element); defaults to 2. */
  level?: HeadingLevel | undefined;
  /** Visual style; defaults to the style matching the level. `display` is for the public H1 and hero only. */
  styleAs?: HeadingStyle | undefined;
  tone?: TextTone | undefined;
  /** Balance line breaks (default true for headings). */
  balance?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};

/** Heading with separated semantics (`level`) and appearance (`styleAs`). Tight tracking lives in the tokens. */
export function Heading({ level = 2, styleAs, tone = 'default', balance = true, id, className, children }: HeadingProps) {
  const Tag = `h${level}` as const;
  const visual = styleAs ?? (`h${level}` as HeadingStyle);
  return (
    <Tag {...(id ? { id } : {})} className={cx(headingClass[visual], styles[tone], !balance && styles.noBalance, className)}>
      {children}
    </Tag>
  );
}

export type TextProps<T extends ElementType = 'p'> = {
  as?: T | undefined;
  styleAs?: TextStyle | undefined;
  tone?: TextTone | undefined;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold' | undefined;
  /** Tabular figures (tables, counters). */
  tabular?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'className' | 'children'>;

/** Body text primitive. Default `p`; `styleAs="serif"` is reserved for magazine/article bodies and pull quotes. */
export function Text<T extends ElementType = 'p'>({ as, styleAs = 'body', tone = 'default', weight, tabular = false, className, children, ...rest }: TextProps<T>) {
  const Tag = (as ?? 'p') as ElementType;
  return (
    <Tag {...rest} className={cx(textClass[styleAs], styles[tone], weight && styles[`weight${weight.charAt(0).toUpperCase()}${weight.slice(1)}`], tabular && 'trustwork-tabular', className)}>
      {children}
    </Tag>
  );
}

export type KickerProps = {
  as?: 'p' | 'span' | 'div' | undefined;
  tone?: 'accent' | 'muted' | 'inverse' | undefined;
  className?: string | undefined;
  children: ReactNode;
};

/** Kicker: 12 px uppercase, +0.08em, semibold. Accent blue by default; `inverse` over dark bands and scrims. */
export function Kicker({ as = 'p', tone = 'accent', className, children }: KickerProps) {
  const Tag = as;
  return <Tag className={cx('trustwork-kicker', styles[`kicker${tone.charAt(0).toUpperCase()}${tone.slice(1)}`], className)}>{children}</Tag>;
}

export type MetaItem = ReactNode;

export type MetaProps = {
  /** Items separated by middle dots: «Редакция · 21 окт 2026 · 6 мин». Nullish items are skipped. */
  items: readonly (MetaItem | null | undefined | false)[];
  tone?: 'muted' | 'inverse' | 'default' | undefined;
  size?: 'sm' | 'caption' | undefined;
  /** Leading 16 px icon slot. */
  icon?: ReactNode;
  as?: 'p' | 'div' | 'span' | undefined;
  className?: string | undefined;
};

/** The one meta row style of the system: 14 px, muted, middle-dot separators (hidden from assistive technology). */
export function Meta({ items, tone = 'muted', size = 'sm', icon, as = 'p', className }: MetaProps) {
  const Tag = as;
  const visible = items.filter((item): item is MetaItem => item !== null && item !== undefined && item !== false);
  return (
    <Tag className={cx(styles.meta, size === 'caption' ? 'trustwork-caption' : 'trustwork-body-sm', styles[`meta${tone.charAt(0).toUpperCase()}${tone.slice(1)}`], className)}>
      {icon ? <span className={styles.metaIcon}>{icon}</span> : null}
      {visible.map((item, index) => (
        <span key={index} className={styles.metaItem}>
          {index > 0 ? (
            <span aria-hidden="true" className={styles.dot}>
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </Tag>
  );
}
