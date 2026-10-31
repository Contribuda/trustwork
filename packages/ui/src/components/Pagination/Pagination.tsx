import type { ReactNode } from 'react';
import { Button, Link } from 'react-aria-components';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from '../../utils/cx';
import { formatNumber, t } from '../../i18n';
import { Icon } from '../Icon/Icon';
import styles from './Pagination.module.css';

export type PaginationProps = {
  page: number;
  pageCount: number;
  /** Builds a link for a page (server-rendered lists); when absent, buttons call `onPageChange`. */
  hrefFor?: ((page: number) => string) | undefined;
  onPageChange?: ((page: number) => void) | undefined;
  isLoading?: boolean | undefined;
  className?: string | undefined;
};

function range(page: number, pageCount: number): Array<number | 'gap'> {
  const pages = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  let previous = 0;
  for (const p of sorted) {
    if (previous && p - previous > 1) out.push('gap');
    out.push(p);
    previous = p;
  }
  return out;
}

/** `nav[aria-label="Страницы"]`; current page has `aria-current="page"`; ends are disabled, not hidden. */
export function Pagination({ page, pageCount, hrefFor, onPageChange, isLoading = false, className }: PaginationProps) {
  if (pageCount <= 1) return null;
  const item = (target: number, label: string, children: ReactNode, extra: Record<string, unknown> = {}) => {
    const disabled = isLoading || target < 1 || target > pageCount;
    const isCurrent = target === page;
    const cls = cx(styles.item, isCurrent && styles.current);
    if (hrefFor && !disabled) {
      return (
        <Link href={hrefFor(target)} aria-label={label} className={cls} {...(isCurrent ? { 'aria-current': 'page' } : {})} {...extra}>
          {children}
        </Link>
      );
    }
    return (
      <Button aria-label={label} className={cls} isDisabled={disabled} onPress={() => onPageChange?.(target)} {...(isCurrent ? { 'aria-current': 'page' } : {})} {...extra}>
        {children}
      </Button>
    );
  };
  return (
    <nav aria-label={t('common.pagination')} className={cx(styles.nav, className)} {...(isLoading ? { 'aria-busy': true } : {})}>
      <ul className={styles.list}>
        <li>{item(page - 1, t('common.previousPage'), <Icon icon={ChevronLeft} size={16} />)}</li>
        {range(page, pageCount).map((entry, index) =>
          entry === 'gap' ? (
            <li key={`gap-${index}`} aria-hidden="true" className={styles.gap}>
              …
            </li>
          ) : (
            <li key={entry}>{item(entry, entry === page ? t('common.currentPage', { page: entry }) : t('common.page', { page: entry }), formatNumber(entry))}</li>
          ),
        )}
        <li>{item(page + 1, t('common.nextPage'), <Icon icon={ChevronRight} size={16} />)}</li>
      </ul>
    </nav>
  );
}
