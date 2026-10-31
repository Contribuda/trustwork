import type { ReactNode } from 'react';
import { Link as AriaLink, type LinkProps as AriaLinkProps } from 'react-aria-components';
import { ArrowUpRight, ArrowRight } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './Link.module.css';

export type LinkVariant = 'inline' | 'standalone' | 'external' | 'nav';

export type LinkProps = Omit<AriaLinkProps, 'children' | 'className' | 'style'> & {
  variant?: LinkVariant | undefined;
  children: ReactNode;
  className?: string | undefined;
};

/**
 * Native anchor through React Aria. `inline` underlines inside text; `standalone` adds an arrow;
 * `external` adds the arrow icon, `rel="noopener"` and visually hidden «внешняя ссылка».
 */
export function Link({ variant = 'inline', className, children, ...rest }: LinkProps) {
  const external = variant === 'external';
  return (
    <AriaLink {...rest} {...(external ? { rel: rest.rel ?? 'noopener', target: rest.target ?? '_blank' } : {})} className={cx(styles.root, styles[variant], className)}>
      <span>{children}</span>
      {variant === 'standalone' ? <Icon icon={ArrowRight} size={16} /> : null}
      {external ? (
        <>
          <Icon icon={ArrowUpRight} size={16} />
          <VisuallyHidden>{t('common.externalLink')}</VisuallyHidden>
        </>
      ) : null}
    </AriaLink>
  );
}
