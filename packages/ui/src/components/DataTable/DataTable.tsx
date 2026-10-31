import { useState, type ReactNode } from 'react';
import { Cell, Column, Row, Table, TableBody, TableHeader, type SortDescriptor, type Key } from 'react-aria-components';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { Icon } from '../Icon/Icon';
import { Skeleton, SkeletonGroup } from '../Skeleton/Skeleton';
import { EmptyState } from '../EmptyState/EmptyState';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import styles from './DataTable.module.css';

export type DataTableColumn<Row extends object> = {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** Sortable columns render a sort button with `aria-sort`. */
  sortable?: boolean | undefined;
  /** Numeric columns right-align with tabular figures. */
  align?: 'start' | 'end' | undefined;
  /** First column acts as the row header on cards. */
  isRowHeader?: boolean | undefined;
  width?: number | undefined;
};

export type DataTableProps<Row extends object> = {
  /** Visible caption (also the region label). */
  caption: string;
  hideCaption?: boolean | undefined;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => Key;
  /** Controlled sorting; the table never sorts data itself. */
  sort?: SortDescriptor | undefined;
  onSortChange?: ((descriptor: SortDescriptor) => void) | undefined;
  /** Per-row actions rendered in the last column (table) or card footer. */
  rowActions?: ((row: Row) => ReactNode) | undefined;
  state?: 'idle' | 'loading' | 'error' | undefined;
  emptyTitle?: string | undefined;
  emptyBody?: ReactNode;
  errorAction?: ReactNode;
  /** Force layout (stories/tests); defaults to the viewport (< 768 px → cards). */
  layout?: 'auto' | 'table' | 'cards' | undefined;
  className?: string | undefined;
};

/**
 * Sortable data table (React Aria grid semantics, `aria-sort` on sortable headers). On tablet it scrolls inside a
 * labelled focusable region; below 768 px it collapses to a list of cards that keep every column label.
 */
export function DataTable<Row extends object>({
  caption,
  hideCaption = false,
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  rowActions,
  state = 'idle',
  emptyTitle,
  emptyBody,
  errorAction,
  layout = 'auto',
  className,
}: DataTableProps<Row>) {
  const isMobile = useIsMobile();
  const asCards = layout === 'cards' || (layout === 'auto' && isMobile);
  const [internalSort, setInternalSort] = useState<SortDescriptor | undefined>(undefined);
  const activeSort = sort ?? internalSort;

  if (state === 'loading') {
    return (
      <SkeletonGroup label={t('table.loading')} className={className}>
        <Skeleton variant="table" lines={4} />
      </SkeletonGroup>
    );
  }
  if (state === 'error') {
    return <EmptyState tone="error" title={t('table.error')} actions={errorAction} className={className} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState title={emptyTitle ?? t('table.empty')} className={className}>
        {emptyBody}
      </EmptyState>
    );
  }

  if (asCards) {
    const headerColumn = columns.find((c) => c.isRowHeader) ?? columns[0];
    return (
      <div className={cx(styles.cards, className)}>
        {hideCaption ? <VisuallyHidden as="p">{caption}</VisuallyHidden> : <p className={styles.caption}>{caption}</p>}
        <ul className={styles.cardList}>
          {rows.map((row) => (
            <li key={String(rowKey(row))} className={styles.card}>
              {headerColumn ? <p className={styles.cardTitle}>{headerColumn.cell(row)}</p> : null}
              <dl className={styles.cardFields}>
                {columns
                  .filter((c) => c !== headerColumn)
                  .map((c) => (
                    <div key={c.id} className={styles.cardField}>
                      <dt>{c.header}</dt>
                      <dd>{c.cell(row)}</dd>
                    </div>
                  ))}
              </dl>
              {rowActions ? <div className={styles.cardActions}>{rowActions(row)}</div> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div role="region" aria-label={t('table.regionLabel', { caption })} tabIndex={0} className={cx(styles.region, className)}>
      <Table
        aria-label={caption}
        className={cx(styles.table)}
        {...(activeSort ? { sortDescriptor: activeSort } : {})}
        onSortChange={(descriptor) => {
          setInternalSort(descriptor);
          onSortChange?.(descriptor);
        }}
      >
        <TableHeader className={cx(styles.thead)}>
          {columns.map((column) => (
            <Column
              key={column.id}
              id={column.id}
              isRowHeader={column.isRowHeader ?? column === columns[0]}
              allowsSorting={column.sortable ?? false}
              className={cx(styles.th, column.align === 'end' && styles.alignEnd)}
              {...(column.width !== undefined ? { width: column.width } : {})}
            >
              {({ allowsSorting, sortDirection }) => (
                <span className={styles.thContent}>
                  <span>{column.header}</span>
                  {allowsSorting ? (
                    <span className={styles.sortIcon}>
                      <Icon icon={sortDirection === 'ascending' ? ArrowUp : sortDirection === 'descending' ? ArrowDown : ArrowUpDown} size={16} />
                      <VisuallyHidden>{sortDirection === 'ascending' ? t('common.sortAscending') : sortDirection === 'descending' ? t('common.sortDescending') : t('common.sortNone')}</VisuallyHidden>
                    </span>
                  ) : null}
                </span>
              )}
            </Column>
          ))}
          {rowActions ? (
            <Column id="__actions" className={cx(styles.th, styles.alignEnd)}>
              <VisuallyHidden>{t('table.rowActions')}</VisuallyHidden>
            </Column>
          ) : null}
        </TableHeader>
        <TableBody className={cx(styles.tbody)}>
          {rows.map((row) => (
            <Row key={String(rowKey(row))} id={rowKey(row)} className={cx(styles.tr)}>
              {columns.map((column) => (
                <Cell key={column.id} className={cx(styles.td, column.align === 'end' && styles.alignEnd)}>
                  {column.cell(row)}
                </Cell>
              ))}
              {rowActions ? <Cell className={cx(styles.td, styles.alignEnd)}>{rowActions(row)}</Cell> : null}
            </Row>
          ))}
        </TableBody>
      </Table>
      {!hideCaption ? <p className={styles.captionBelow}>{caption}</p> : null}
      <p className={styles.scrollHint}>{t('common.tableScrollHint')}</p>
    </div>
  );
}
