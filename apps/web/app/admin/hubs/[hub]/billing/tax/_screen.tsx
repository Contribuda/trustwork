import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Empty, loadProduct, versioned, yesNo } from '../../modules/_kit/parts';

const TREATMENTS = ['taxable', 'exempt', 'needs_advice'] as const;

async function Tax(ctx: HubContext) {
  const { tax } = (await loadProduct(ctx)).billing;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.billing.tax.title')} lede={t('admin.billing.tax.lede')} />
      <Panel id="tax-treatment" title={t('admin.billing.tax.treatment')}>
        {tax.feesTaxable.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.billing.tax.region')}</th>
                <th scope="col">{t('admin.billing.tax.treatmentLabel')}</th>
                <th scope="col">{t('admin.billing.tax.source')}</th>
              </tr>
            </thead>
            <tbody>
              {tax.feesTaxable.map((row) => (
                <tr key={row.region}>
                  <td data-label={t('admin.billing.tax.region')}>
                    <code className="admin-code">{row.region}</code>
                  </td>
                  <td data-label={t('admin.billing.tax.treatmentLabel')}>{tDynamic(`admin.billing.tax.treatments.${row.treatment}`, row.treatment)}</td>
                  <td data-label={t('admin.billing.tax.source')}>
                    <a href={row.source} rel="noopener noreferrer" target="_blank">
                      {t('admin.billing.tax.sourceLink')}
                      <span className="admin-visually-hidden"> {t('admin.common.opensNewTab')}</span>
                    </a>
                    <span className="admin-meta"> · {t('admin.billing.tax.checked', { date: longDate(row.checkedAt) })}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.billing.tax.none')}</Empty>
        )}
        <KeyValues
          rows={[
            { label: t('admin.billing.tax.version'), value: t('admin.common.version', { version: tax.version }) },
            { label: t('admin.billing.tax.eInvoicing'), value: tDynamic(`admin.billing.tax.eModes.${tax.eInvoicing}`, tax.eInvoicing) },
            { label: t('admin.billing.tax.withTax'), value: yesNo(tax.pricesShownWithTax) },
          ]}
        />
        <p className="admin-note">{t('admin.billing.tax.advice')}</p>
      </Panel>
      <Panel id="tax-edit" title={t('admin.billing.tax.edit')}>
        <ConsoleForm action={submitConsoleCommand} hidden={versioned(ctx, 'billing.tax.save', tax.version)} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.offer.edit'), ctx.offline)}>
          <div className="admin-form__grid">
            <TextInput name="region" label={t('admin.billing.tax.region')} description={t('admin.billing.tax.regionHelp')} isRequired />
            <SelectField name="treatment" label={t('admin.billing.tax.treatmentLabel')} options={TREATMENTS.map((x) => ({ value: x, label: tDynamic(`admin.billing.tax.treatments.${x}`, x) }))} />
            <TextInput name="source" label={t('admin.billing.tax.sourceUrl')} description={t('admin.billing.tax.sourceHelp')} isRequired />
          </div>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-95 Tax: tax treatment of the hub's own fees with sources, per state in the US example; e-invoicing settings. */
export const screen: Screen = { group: 'billing', id: 'tax', title: () => t('admin.billing.tax.title'), render: Tax };
