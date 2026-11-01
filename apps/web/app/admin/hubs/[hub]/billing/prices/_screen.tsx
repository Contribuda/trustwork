import { unitMargin } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { ActivationRequest, Cohort, Empty, GuardRails, loadProduct, MarginText, moduleName, moneyMinor, PendingRequests, StatePill } from '../../modules/_kit/parts';
import type { PriceRow } from '../../modules/_kit/schemas';

const subjectId = (r: PriceRow) => `${r.subject.kind}:${r.subject.key}${r.subject.kind === 'model' ? `:${r.subject.direction}` : ''}`;

function Subject({ row }: { row: PriceRow }) {
  const s = row.subject;
  if (s.kind === 'module') return <>{t('admin.billing.prices.subjectModule', { name: moduleName(s.key) })}</>;
  if (s.kind === 'capability') return <>{t('admin.billing.prices.subjectCapability')} <code className="admin-code">{s.key}</code></>;
  return (
    <>
      {t('admin.billing.prices.subjectModel')} <code className="admin-code">{s.key}</code> · {tDynamic(`admin.billing.prices.directions.${s.direction}`, s.direction)}
    </>
  );
}

const margin = (r: PriceRow, cost = r.price.costPerUnitMinor) => unitMargin({ costPricePerUnitMinor: cost, salePricePerUnitMinor: r.price.salePerUnitMinor });

async function Prices(ctx: HubContext) {
  const { billing } = await loadProduct(ctx);
  const drafts = billing.prices.filter((r) => r.status === 'draft');
  const costChanged = billing.prices.filter((r) => r.status === 'active' && r.costChanged);
  const subjects = [...new Map(billing.prices.map((r) => [subjectId(r), r])).values()];
  const canDraft = ctx.can('admin.commerce.price.draft');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.billing.prices.title')} lede={t('admin.billing.prices.lede')} />
      <PendingRequests ctx={ctx} actions={['commerce.activate_price_version']} />
      {costChanged.map((r) => (
        <p key={r.price.priceVersionId} className="admin-callout admin-callout--warning" data-testid="cost-changed">
          {t('admin.billing.prices.costChanged', {
            cost: moneyMinor(r.costChanged!.newCostPerUnitMinor, r.price.currency),
            date: longDate(r.costChanged!.observedAt),
            margin: moneyMinor(margin(r, r.costChanged!.newCostPerUnitMinor), r.price.currency),
          })}{' '}
          <Subject row={r} />
        </p>
      ))}
      <Panel id="price-versions" title={t('admin.billing.prices.versions')}>
        {billing.prices.length ? (
          <table className="plain-table" data-testid="price-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.billing.prices.subject')}</th>
                <th scope="col">{t('admin.billing.prices.costSale')}</th>
                <th scope="col">{t('admin.product.margin')}</th>
                <th scope="col">{t('admin.billing.prices.effective')}</th>
                <th scope="col">{t('admin.billing.prices.status')}</th>
              </tr>
            </thead>
            <tbody>
              {billing.prices.map((r) => (
                <tr key={r.price.priceVersionId}>
                  <td data-label={t('admin.billing.prices.subject')}>
                    <Subject row={r} />
                    <span className="admin-meta">
                      {' · '}
                      {t('admin.common.version', { version: r.price.version })} · {tDynamic(`admin.product.units.${r.price.unit}`, r.price.unit)}
                    </span>
                  </td>
                  <td data-label={t('admin.billing.prices.costSale')}>
                    {t('admin.product.cost')} {moneyMinor(r.price.costPerUnitMinor, r.price.currency)} · {t('admin.product.sale')} {moneyMinor(r.price.salePerUnitMinor, r.price.currency)}
                    <span className="admin-meta">
                      {' · '}
                      {r.basis.kind === 'markup' ? t('admin.billing.prices.markup', { percent: r.basis.percent }) : t('admin.billing.prices.flat')}
                    </span>
                  </td>
                  <td data-label={t('admin.product.margin')}>
                    <MarginText margin={margin(r)} currency={r.price.currency} />
                  </td>
                  <td data-label={t('admin.billing.prices.effective')}>
                    {longDate(r.effectiveFrom)}
                    <span className="admin-meta">
                      {' · '}
                      {t('admin.billing.prices.acceptanceText')} <code className="admin-code">{r.acceptanceTextVersion}</code> · {tDynamic(`admin.billing.prices.notice.${r.notice}`, r.notice)}
                    </span>
                  </td>
                  <td data-label={t('admin.billing.prices.status')}>
                    <StatePill state={r.status} />
                    <span className="admin-meta">
                      {' · '}
                      {r.status === 'draft' ? t('admin.billing.prices.notAcceptedYet') : <>{t('admin.billing.prices.acceptances')} <Cohort value={r.acceptances} /></>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.billing.prices.none')}</Empty>
        )}
        <p className="admin-note">{t('admin.billing.prices.readOnlyActive')}</p>
      </Panel>
      {billing.meterRates.length ? (
        <Panel id="meter-rates" title={t('admin.billing.prices.meterRates')}>
          <ul className="admin-list">
            {billing.meterRates.map(({ rate, cost }) => (
              <li key={rate.id} className="admin-list__row">
                <span>{tDynamic(`admin.billing.prices.meters.${rate.meter}`, rate.meter)}</span>
                <span>
                  {t('admin.product.cost')} {moneyMinor(cost.costPerThousandUnitsMinor, cost.currency)} · {t('admin.product.sale')} {moneyMinor(rate.pricePerThousandUnits.minorUnits, rate.currency)} · {t('admin.product.margin')}{' '}
                  <MarginText margin={unitMargin({ costPricePerUnitMinor: cost.costPerThousandUnitsMinor, salePricePerUnitMinor: rate.pricePerThousandUnits.minorUnits })} currency={rate.currency} />
                </span>
                <span className="admin-meta">{t('admin.billing.prices.perThousand')}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {drafts.length ? (
        <div className="admin-grid">
          {drafts.map((r) => (
            <Panel key={r.price.priceVersionId} id={`activate-${r.price.priceVersionId}`} title={t('admin.billing.prices.activate', { version: r.price.version })}>
              <p>
                <Subject row={r} />
              </p>
              <ActivationRequest ctx={ctx} command="billing.price.request_activation" target={{ priceVersionId: r.price.priceVersionId }} preview={r.preview} secondPerson="commerce.activate_price_version" canRequest={canDraft} />
              <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.price.cancel_draft', { 'f.priceVersionId': r.price.priceVersionId })} labels={formLabels({ submit: t('admin.billing.prices.cancelDraft') })} submitVariant="secondary" disabledReason={readOnlyReason(canDraft, ctx.offline)} />
            </Panel>
          ))}
        </div>
      ) : null}
      {subjects.length ? (
        <Panel id="price-draft" title={t('admin.billing.prices.draft')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.price.draft')} labels={formLabels({ submit: t('admin.billing.prices.draft') })} disabledReason={readOnlyReason(canDraft, ctx.offline)}>
            <div className="admin-form__grid">
              <SelectField name="subject" label={t('admin.billing.prices.subject')} options={subjects.map((r) => ({ value: subjectId(r), label: subjectId(r) }))} />
              <SelectField
                name="basis"
                label={t('admin.billing.prices.basis')}
                options={[
                  { value: 'flat', label: t('admin.billing.prices.flat') },
                  { value: 'markup', label: t('admin.billing.prices.markupLabel') },
                ]}
              />
              <TextInput name="sale" label={t('admin.billing.prices.sale')} description={t('admin.billing.prices.saleHelp')} />
              <TextInput name="percent" label={t('admin.billing.prices.percent')} description={t('admin.billing.prices.percentHelp')} />
              <TextInput name="effectiveFrom" label={t('admin.billing.prices.effectiveFrom')} description={t('admin.product.dateHelp')} isRequired />
            </div>
            <p className="admin-note">{t('admin.billing.prices.noOverlap')}</p>
          </ConsoleForm>
        </Panel>
      ) : null}
      <GuardRails only={['paymentNeutrality']} />
    </>
  );
}

/** HC-91 Prices: per module, capability or model; cost beside sale and margin; flat or markup fixed at drafting; activation by a second person. */
export const screen: Screen = { group: 'billing', id: 'prices', title: () => t('admin.billing.prices.title'), render: Prices };
