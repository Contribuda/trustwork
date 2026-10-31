import { Breadcrumb as AriaBreadcrumb, Breadcrumbs as AriaBreadcrumbs, Link } from 'react-aria-components';
import { ChevronRight } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import styles from './Breadcrumb.module.css';

export type BreadcrumbItem = { id: string; label: string; href?: string | undefined };

export type BreadcrumbProps = { items: readonly BreadcrumbItem[]; className?: string | undefined };

/** `nav[aria-label="Навигация"]`; the last item is the current page (`aria-current="page"`). Show only when depth > 1. */
export function Breadcrumb({ items, className }: BreadcrumbProps) {
  return (
    <nav aria-label={t('common.breadcrumbs')} className={cx(styles.nav, className)}>
      <AriaBreadcrumbs className={cx(styles.list)}>
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <AriaBreadcrumb key={item.id} className={cx(styles.item)}>
              {isLast ? (
                <span aria-current="page" className={cx(styles.link, styles.current)}>
                  {item.label}
                </span>
              ) : (
                <Link className={cx(styles.link)} {...(item.href ? { href: item.href } : {})}>
                  {item.label}
                </Link>
              )}
              {!isLast ? <Icon icon={ChevronRight} size={16} className={styles.separator} /> : null}
            </AriaBreadcrumb>
          );
        })}
      </AriaBreadcrumbs>
    </nav>
  );
}
