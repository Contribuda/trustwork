import type { LucideIcon, LucideProps } from 'lucide-react';
import { cx } from '../../utils/cx';
import styles from './Icon.module.css';

export type IconSize = 12 | 14 | 16 | 20 | 24;

export type IconProps = {
  icon: LucideIcon;
  size?: IconSize | undefined;
  /** Russian accessible name when the icon stands alone; omit when it decorates a labelled control. */
  label?: string | undefined;
  className?: string | undefined;
} & Pick<LucideProps, 'strokeWidth'>;

/** Lucide icon wrapper (ISC licence; see packages/ui/licenses). Decorative by default. */
export function Icon({ icon: Svg, size = 20, label, className, strokeWidth = 1.75 }: IconProps) {
  return <Svg className={cx(styles.root, className)} width={size} height={size} strokeWidth={strokeWidth} focusable="false" {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })} />;
}
