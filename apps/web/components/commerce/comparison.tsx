import { StatusChip } from '@/components/ui';
import { t } from '@/app/_lib/i18n';

export type GridCell = { kind: 'comparable'; value: string } | { kind: 'nonComparable'; value?: string; reason: 'unit' | 'scope' | 'substitution' | 'missingLine'; detail?: string };
export type GridOffer = { id: string; supplier: string; version: string; stale: boolean; note: string | null; total: string | null; anchor: string | null };

/**
 * Quote comparison rendered on the server (WEB-002): RFQ lines are row headers (`th scope="row"`, sticky), suppliers
 * are column headers; a non-comparable cell says so in text with a native disclosure for the reason (no colour-only
 * state, no client JavaScript). Below 768 px each line becomes a card with every supplier's value labelled. Totals
 * appear only where every line matched; stale versions are marked and never totalled.
 */
export function ComparisonGrid({ caption, lines, offers, cells }: { caption: string; lines: { id: string; label: string; detail: string }[]; offers: GridOffer[]; cells: Record<string, Record<string, GridCell>> }) {
  return (
    <div className="ws-table-wrap cm-compare" role="region" aria-label={caption} tabIndex={0}>
      <table className="ws-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('compare.line')}</th>
            {offers.map((o) => (
              <th key={o.id} scope="col" className={o.stale ? 'cm-stale' : undefined}>
                {o.supplier}
                <span className="cm-spec">{t('commerce.versionN', { version: o.version })}</span>
                {o.stale ? (
                  <StatusChip tone="warning" size="sm">
                    {o.note ?? t('compare.stale')}
                  </StatusChip>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id}>
              <th scope="row">
                {line.label}
                <span className="cm-spec">{line.detail}</span>
              </th>
              {offers.map((o) => {
                const cell = cells[line.id]?.[o.id] ?? ({ kind: 'nonComparable', reason: 'missingLine' } as const);
                return (
                  <td key={o.id} data-label={`${o.supplier}, ${t('commerce.versionN', { version: o.version })}`} className={o.stale ? 'cm-stale' : undefined}>
                    {cell.kind === 'comparable' ? (
                      cell.value
                    ) : (
                      <details>
                        <summary>
                          <StatusChip tone="warning" size="sm">
                            {t('compare.notComparable')}
                          </StatusChip>
                        </summary>
                        <p>
                          {t('compare.whyNotComparable')}: {t(`compare.reason.${cell.reason}`)}
                        </p>
                        {cell.value ? <p>{cell.value}</p> : null}
                        {cell.detail ? <p>{cell.detail}</p> : null}
                      </details>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{t('compare.total')}</th>
            {offers.map((o) => (
              <td key={o.id} data-label={`${o.supplier}: ${t('compare.total')}`} className={o.stale ? 'cm-stale' : undefined}>
                {o.total ?? <span className="ws-muted">{t('compare.totalIncomplete')}</span>}
                {o.anchor ? (
                  <a href={`#${o.anchor}`} className="cm-spec">
                    {t('commerce.compare.selectThis', { supplier: o.supplier })}
                  </a>
                ) : null}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
