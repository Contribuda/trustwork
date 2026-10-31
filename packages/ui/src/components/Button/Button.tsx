import type { ReactNode, Ref } from 'react';
import { Button as AriaButton, Link as AriaLink, type ButtonProps as AriaButtonProps, type LinkProps as AriaLinkProps } from 'react-aria-components';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../../utils/cx';
import { Icon } from '../Icon/Icon';
import { Spinner } from '../Spinner/Spinner';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';

type BaseProps = Omit<AriaButtonProps, 'children' | 'className' | 'style' | 'isPending'> & {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  /** Leading icon (decorative; the visible label names the control). */
  icon?: LucideIcon | undefined;
  /** Shows a spinner, sets `aria-busy`/disabled behaviour via React Aria `isPending`, and swaps the label when `pendingLabel` is given. */
  isLoading?: boolean | undefined;
  pendingLabel?: string | undefined;
  fullWidth?: boolean | undefined;
  className?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
};

export type ButtonProps = BaseProps & { children: ReactNode };

/** Native `button` through React Aria; variants primary (navy), accent (blue), secondary (outlined), ghost (text), danger. */
export function Button({ variant = 'primary', size = 'md', icon, isLoading = false, pendingLabel, fullWidth = false, className, children, ...rest }: ButtonProps) {
  return (
    <AriaButton {...rest} isPending={isLoading} className={cx(styles.root, styles[variant], styles[size], fullWidth && styles.fullWidth, className)} data-variant={variant}>
      {({ isPending }) => (
        <>
          {isPending ? <Spinner size={size === 'sm' ? 16 : 20} className={styles.spinner} /> : icon ? <Icon icon={icon} size={size === 'sm' ? 16 : 20} /> : null}
          <span className={styles.label}>{isPending && pendingLabel ? pendingLabel : children}</span>
        </>
      )}
    </AriaButton>
  );
}

export type IconButtonProps = BaseProps & {
  icon: LucideIcon;
  /** Required Russian accessible name (WCAG 4.1.2); the icon alone never names the control. */
  'aria-label': string;
  /** Pressed state for toggles such as «Показать пароль» (`aria-pressed`). */
  isPressed?: boolean | undefined;
};

/** Icon-only button: 40×40 default (24×24 minimum for `sm`), always with an accessible name. */
export function IconButton({ variant = 'ghost', size = 'md', icon, isLoading = false, className, isPressed, ...rest }: IconButtonProps) {
  return (
    <AriaButton
      {...rest}
      isPending={isLoading}
      {...(isPressed === undefined ? {} : { 'aria-pressed': isPressed })}
      className={cx(styles.root, styles.iconOnly, styles[variant], styles[size], className)}
      data-variant={variant}
    >
      {({ isPending }) => (isPending ? <Spinner size={size === 'sm' ? 16 : 20} /> : <Icon icon={icon} size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />)}
    </AriaButton>
  );
}

export type ButtonLinkProps = Omit<AriaLinkProps, 'children' | 'className' | 'style'> & {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  icon?: LucideIcon | undefined;
  fullWidth?: boolean | undefined;
  className?: string | undefined;
};

/** Navigation styled as a button (a real anchor; never nest a link inside a button). */
export function ButtonLink({ variant = 'primary', size = 'md', icon, fullWidth = false, className, children, ...rest }: ButtonLinkProps) {
  return (
    <AriaLink {...rest} className={cx(styles.root, styles[variant], styles[size], fullWidth && styles.fullWidth, className)} data-variant={variant}>
      {icon ? <Icon icon={icon} size={size === 'sm' ? 16 : 20} /> : null}
      <span className={styles.label}>{children}</span>
    </AriaLink>
  );
}

export type IconLinkProps = Omit<AriaLinkProps, 'children' | 'className' | 'style'> & {
  icon: LucideIcon;
  'aria-label': string;
  href: string;
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  className?: string | undefined;
};

/** Icon-only link styled like IconButton (navigation, e.g. «Открыть страницу»). */
export function IconLink({ variant = 'ghost', size = 'md', icon, className, ...rest }: IconLinkProps) {
  return (
    <AriaLink {...rest} className={cx(styles.root, styles.iconOnly, styles[variant], styles[size], className)} data-variant={variant}>
      <Icon icon={icon} size={size === 'sm' ? 16 : size === 'lg' ? 24 : 20} />
    </AriaLink>
  );
}
