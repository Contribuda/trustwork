import { Button, type ButtonProps } from 'react-aria-components';
import { cx } from '../../utils/cx';
import styles from './Avatar.module.css';

export type AvatarSize = 24 | 32 | 36 | 40 | 48 | 64 | 96;

export type AvatarProps = {
  /** Person's name: used for initials and, when informative, as the image alt. */
  name: string;
  /** Consented, licensed image; absent → initials fallback. */
  src?: string | undefined;
  size?: AvatarSize | undefined;
  /** Decorative when the name is rendered next to it. */
  decorative?: boolean | undefined;
  className?: string | undefined;
};

export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/** Circular avatar: image or initials; `alt` = name when informative, empty when decorative. */
export function Avatar({ name, src, size = 40, decorative = false, className }: AvatarProps) {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) };
  if (src) {
    return <img src={src} alt={decorative ? '' : name} width={size} height={size} className={cx(styles.avatar, styles.image, className)} style={style} />;
  }
  return <span className={cx(styles.avatar, styles.initials, className)} style={style} data-initials={initialsOf(name)} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })} />;
}

export type AvatarButtonProps = Omit<ButtonProps, 'children' | 'className' | 'style'> & {
  name: string;
  src?: string | undefined;
  /** Accessible name of the control, e.g. «Аккаунт». The person's name is not in the header (R24). */
  'aria-label': string;
  size?: AvatarSize | undefined;
  className?: string | undefined;
};

/** The only account control: a circular avatar button with `aria-haspopup="menu"` (no name, no chevron). */
export function AvatarButton({ name, src, size = 40, className, ...rest }: AvatarButtonProps) {
  return (
    <Button {...rest} aria-haspopup="menu" className={cx(styles.button, className)}>
      <Avatar name={name} src={src} size={size} decorative />
    </Button>
  );
}
