import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Cohort, Empty, loadProduct, moneyMinor, planName, StatePill } from '../../modules/_kit/parts';

async function Invoices(ctx: HubContext) {
  const { billing } = await loadProduct(ctx);
  const failed = billing.invoiceRuns.filter((r) => r.failed > 0);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.billing.invoices.title')} lede={t('admin.billing.invoices.lede')} />
      <p className="admin-callout" role="note">
        {t('admin.billing.invoices.noMoneyHeld')}
      </p>
      <Panel id="invoice-runs" title={t('admin.billing.invoices.runs')}>
        {billing.invoiceRuns.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.billing.invoices.period')}</th>
                <th scope="col">{t('admin.billing.invoices.state')}</th>
                <th scope="col">{t('admin.billing.invoices.invoices')}</th>
                <th scope="col">{t('admin.billing.invoices.byOffer')}</th>
                <th scope="col">{t('admin.billing.invoices.eInvoicing')}</th>
              </tr>
            </thead>
            <tbody>
              {billing.invoiceRuns.map((r) => (
                <tr key={r.id}>
                  <td data-label={t('admin.billing.invoices.period')}>
                    <code className="admin-code">{r.period}</code>
                  </td>
                  <td data-label={t('admin.billing.invoices.state')}>
                    <StatePill state={r.state} />
                    {r.failed ? <span className="admin-warning"> · {t('admin.billing.invoices.failed', { count: r.failed })}</span> : null}
                  </td>
                  <td data-label={t('admin.billing.invoices.invoices')}>
                    <Cohort value={r.invoices} /> · {moneyMinor(r.total.minorUnits, r.total.currency)}
                  </td>
                  <td data-label={t('admin.billing.invoices.byOffer')}>
                    {r.byOffer.map((o) => (
                      <span key={o.offerCode}>
                        {planName(o.offerCode)} {moneyMinor(o.total.minorUnits, o.total.currency)}{' '}
                      </span>
                    ))}
                  </td>
                  <td data-label={t('admin.billing.invoices.eInvoicing')}>{tDynamic(`admin.billing.invoices.eStates.${r.eInvoicing}`, r.eInvoicing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.billing.invoices.none')}</Empty>
        )}
        <p className="admin-note">{t('admin.billing.invoices.linesNameVersions')}</p>
      </Panel>
      {failed.length ? (
        <Panel id="invoice-retry" title={t('admin.billing.invoices.retry')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.invoice.retry')} labels={formLabels({ submit: t('admin.billing.invoices.retry') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.offer.edit'), ctx.offline)}>
            <SelectField name="runId" label={t('admin.billing.invoices.run')} options={failed.map((r) => ({ value: r.id, label: r.period }))} />
            <p className="admin-note">{t('admin.billing.invoices.retryNote')}</p>
          </ConsoleForm>
        </Panel>
      ) : null}
    </>
  );
}

/** HC-92 Invoices: invoice runs, states and totals by offer; failed issuance is retried idempotently. */
export const screen: Screen = { group: 'billing', id: 'invoices', title: () => t('admin.billing.invoices.title'), render: Invoices };
