import { useState, type ReactNode } from 'react';
import { Button as AriaButton, Disclosure, DisclosurePanel } from 'react-aria-components';
import { ChevronDown } from 'lucide-react';
import { cx } from '../../utils/cx';
import { t } from '../../i18n';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { Button } from '../Button/Button';
import { Icon } from '../Icon/Icon';
import { Select } from '../Select/Select';
import { StatusChip } from '../Badge/Badge';
import styles from './ComparisonTable.module.css';

export type ComparisonReason = 'unit' | 'scope' | 'substitution' | 'missingLine';

export type ComparisonCell = { kind: 'comparable'; value: ReactNode } | { kind: 'nonComparable'; value?: ReactNode; reason: ComparisonReason; detail?: ReactNode } | { kind: 'missing' };

export type ComparisonLine = { id: string; label: string; detail?: string | undefined };
export type ComparisonOffer = { id: string; supplier: string; version?: string | undefined; isStale?: boolean | undefined; isExcluded?: boolean | undefined };

export type ComparisonTableProps = {
  caption: string;
  lines: readonly ComparisonLine[];
  offers: readonly ComparisonOffer[];
  /** cells[lineId][offerId] */
  cells: Readonly<Record<string, Readonly<Record<string, ComparisonCell>>>>;
  /** Totals per offer; `null` = incomplete (text explains). */
  totals?: Readonly<Record<string, ReactNode | null>> | undefined;
  onSelectOffer?: ((offerId: string) => void) | undefined;
  layout?: 'auto' | 'table' | 'accordion' | undefined;
  className?: string | undefined;
};

function CellContent({ cell }: { cell: ComparisonCell }) {
  if (cell.kind === 'missing') return <span className={styles.missing}>{t('compare.noOffer')}</span>;
  if (cell.kind === 'comparable') return <span>{cell.value}</span>;
  return (
    <Disclosure className={cx(styles.disclosure)}>
      {({ isExpanded }) => (
        <>
          <div>
            <AriaButton slot="trigger" className={cx(styles.disclosureButton)}>
              <StatusChip tone="warning" size="sm">
                {t('compare.notComparable')}
              </StatusChip>
              <Icon icon={ChevronDown} size={16} className={cx(styles.chevron, isExpanded && styles.chevronOpen)} />
            </AriaButton>
          </div>
          <DisclosurePanel className={cx(styles.disclosurePanel)}>
            <p>
              <strong>{t('compare.whyNotComparable')}:</strong> {t(`compare.reason.${cell.reason}`)}
            </p>
            {cell.value !== undefined ? <p>{cell.value}</p> : null}
            {cell.detail ? <p>{cell.detail}</p> : null}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}

function OfferHeading({ offer }: { offer: ComparisonOffer }) {
  return (
    <span className={styles.offerHeading}>
      <span>{offer.supplier}</span>
      {offer.version ? <span className={styles.offerMeta}>{t('version.item', { version: offer.version })}</span> : null}
      {offer.isStale ? (
        <StatusChip tone="warning" size="sm">
          {t('compare.stale')}
        </StatusChip>
      ) : null}
      {offer.isExcluded ? (
        <StatusChip tone="neutral" size="sm">
          {t('compare.excluded')}
        </StatusChip>
      ) : null}
    </span>
  );
}

/**
 * Quote comparison: RFQ lines are row headers (`th scope="row"`), suppliers are column headers; sticky first column
 * and header; non-comparable cells show text plus a disclosure with the reason. Below 768 px: one accordion per line
 * with a supplier switcher. Totals and exclusions are also rendered as text.
 */
export function ComparisonTable({ caption, lines, offers, cells, totals, onSelectOffer, layout = 'auto', className }: ComparisonTableProps) {
  const isMobile = useIsMobile();
  const asAccordion = layout === 'accordion' || (layout === 'auto' && isMobile);
  const [activeOffer, setActiveOffer] = useState<string>(offers[0]?.id ?? '');
  const totalIncomplete = totals ? Object.values(totals).some((value) => value === null) : false;

  if (asAccordion) {
    const offer = offers.find((o) => o.id === activeOffer) ?? offers[0];
    return (
      <div className={cx(styles.accordion, className)}>
        <h3 className={styles.caption}>{caption}</h3>
        <Select label={t('compare.mobileSupplierSwitch')} options={offers.map((o) => ({ id: o.id, label: o.supplier }))} selectedKey={activeOffer} onSelectionChange={(key) => setActiveOffer(String(key))} />
        {offer ? (
          <>
            <OfferHeading offer={offer} />
            <ul className={styles.accordionList}>
              {lines.map((line) => {
                const cell = cells[line.id]?.[offer.id] ?? { kind: 'missing' as const };
                return (
                  <li key={line.id} className={styles.accordionItem}>
                    <p className={styles.lineLabel}>
                      {line.label}
                      {line.detail ? <span className={styles.lineDetail}> · {line.detail}</span> : null}
                    </p>
                    <CellContent cell={cell} />
                  </li>
                );
              })}
            </ul>
            {totals ? (
              <p className={styles.totalText}>
                <strong>{t('compare.total')}:</strong> {totals[offer.id] === null || totals[offer.id] === undefined ? t('compare.totalIncomplete') : totals[offer.id]}
              </p>
            ) : null}
            {onSelectOffer && !offer.isExcluded ? (
              <Button variant="accent" onPress={() => onSelectOffer(offer.id)} aria-label={t('compare.selectSupplier', { supplier: offer.supplier })}>
                {t('compare.select')}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cx(styles.wrapper, className)}>
      <div role="region" aria-label={caption} tabIndex={0} className={styles.region}>
        <table className={styles.table}>
          <caption className={styles.tableCaption}>{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={cx(styles.th, styles.stickyColumn)}>
                {t('compare.line')}
              </th>
              {offers.map((offer) => (
                <th key={offer.id} scope="col" className={cx(styles.th, offer.isExcluded && styles.excluded)}>
                  <OfferHeading offer={offer} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <th scope="row" className={cx(styles.rowHeader, styles.stickyColumn)}>
                  {line.label}
                  {line.detail ? <span className={styles.lineDetail}>{line.detail}</span> : null}
                </th>
                {offers.map((offer) => (
                  <td key={offer.id} className={cx(styles.td, offer.isExcluded && styles.excluded)}>
                    <CellContent cell={cells[line.id]?.[offer.id] ?? { kind: 'missing' }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals || onSelectOffer ? (
            <tfoot>
              {totals ? (
                <tr>
                  <th scope="row" className={cx(styles.rowHeader, styles.stickyColumn)}>
                    {t('compare.total')}
                  </th>
                  {offers.map((offer) => (
                    <td key={offer.id} className={cx(styles.td, styles.totalCell)}>
                      {totals[offer.id] === null || totals[offer.id] === undefined ? <span className={styles.missing}>{t('compare.totalIncomplete')}</span> : totals[offer.id]}
                    </td>
                  ))}
                </tr>
              ) : null}
              {onSelectOffer ? (
                <tr>
                  <th scope="row" className={cx(styles.rowHeader, styles.stickyColumn)}>
                    {t('compare.select')}
                  </th>
                  {offers.map((offer) => (
                    <td key={offer.id} className={styles.td}>
                      {!offer.isExcluded ? (
                        <Button size="sm" variant="accent" onPress={() => onSelectOffer(offer.id)} aria-label={t('compare.selectSupplier', { supplier: offer.supplier })}>
                          {t('compare.select')}
                        </Button>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ) : null}
            </tfoot>
          ) : null}
        </table>
      </div>
      {totalIncomplete ? (
        <p role="status" className={styles.totalText}>
          {t('compare.totalIncomplete')}
        </p>
      ) : null}
      <p className={styles.scrollHint}>{t('common.tableScrollHint')}</p>
    </div>
  );
}
