import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { list, longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { ActivationRequest, Empty, GuardRails, loadProduct, moduleName, moneyMinor, PendingRequests, planName, StatePill, yesNo } from '../../modules/_kit/parts';

async function Offers(ctx: HubContext) {
  const { billing } = await loadProduct(ctx);
  const planOffers = billing.offers.filter((o) => o.kind === 'plan');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.billing.offers.title')} lede={t('admin.billing.offers.lede')} />
      <PendingRequests ctx={ctx} actions={['commerce.activate_price_version']} />
      <Panel id="free-minimum" title={t('admin.billing.offers.freeMinimum')}>
        {billing.freeMinimum.length ? (
          <ul className="admin-list">
            {billing.freeMinimum.map((f) => (
              <li key={f.moduleKey} className="admin-list__row">
                <span>{moduleName(f.moduleKey)}</span>
                <span>{t('admin.billing.offers.unitsPerMonth', { count: f.unitsPerMonth, unit: tDynamic(`admin.product.units.${f.unit}`, f.unit) })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.billing.offers.noFreeMinimum')}</Empty>
        )}
        <p className="admin-note">{t('admin.billing.offers.freeStaysFree')}</p>
      </Panel>
      <Panel id="offers" title={t('admin.billing.offers.offers')}>
        {billing.offers.length ? (
          <ul className="admin-list">
            {billing.offers.map((o) => (
              <li key={o.id} className="admin-list__row">
                <span lang="en">{o.name}</span>
                <span className="admin-meta">
                  {tDynamic(`admin.billing.offers.kinds.${o.kind}`, o.kind)} · <code className="admin-code">{o.code}</code>
                </span>
                <StatePill state={o.status} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.billing.offers.noOffers')}</Empty>
        )}
      </Panel>
      <Panel id="plans" title={t('admin.billing.offers.plans')}>
        {billing.plans.length ? (
          <ul className="admin-approvals">
            {billing.plans.map(({ plan, key, trialDays, price, preview }) => (
              <li key={plan.id} className="admin-approval" data-testid={`plan-${key}`}>
                <div className="admin-panel__head">
                  <h3 className="admin-h3">
                    {planName(key)} · {t('admin.common.version', { version: plan.version })}
                  </h3>
                  <StatePill state={plan.status} />
                </div>
                <KeyValues
                  rows={[
                    { label: t('admin.billing.offers.price'), value: t('admin.billing.offers.perMonth', { amount: moneyMinor(price.amountMinorUnits, price.currency) }) },
                    { label: t('admin.billing.offers.payer'), value: tDynamic(`admin.billing.offers.payers.${plan.payerKind}`, plan.payerKind) },
                    { label: t('admin.billing.offers.modules'), value: list(plan.moduleKeys.map(moduleName)) },
                    { label: t('admin.billing.offers.quota'), value: plan.includedQuota.map((q) => t('admin.billing.offers.quotaValue', { module: moduleName(q.moduleKey), units: q.units, window: tDynamic(`admin.billing.offers.windows.${q.window}`, q.window) })).join(' · ') || t('admin.common.none') },
                    { label: t('admin.billing.offers.trial'), value: t('admin.billing.offers.trialDays', { count: trialDays }) },
                    { label: t('admin.billing.offers.representative'), value: yesNo(plan.representativeIncluded) },
                    { label: t('admin.billing.offers.effective'), value: longDate(price.effectiveFrom) },
                  ]}
                />
                {plan.status === 'draft' ? (
                  <ActivationRequest ctx={ctx} command="billing.plan.request_activation" target={{ planId: plan.id }} preview={preview} secondPerson="commerce.activate_price_version" canRequest={ctx.can('admin.commerce.offer.edit')} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.billing.offers.noPlans')}</Empty>
        )}
        <p className="admin-note" data-testid="plan-neutrality">
          {t('admin.billing.offers.neutral')}
        </p>
      </Panel>
      {planOffers.length ? (
        <Panel id="plan-draft" title={t('admin.billing.offers.draft')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.plan.draft')} labels={formLabels({ submit: t('admin.billing.offers.draft') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.offer.edit'), ctx.offline)}>
            <div className="admin-form__grid">
              <SelectField name="offerId" label={t('admin.billing.offers.offer')} options={planOffers.map((o) => ({ value: o.id, label: o.code }))} />
              <TextInput name="trialDays" label={t('admin.billing.offers.trial')} description={t('admin.billing.offers.trialHelp')} isRequired />
            </div>
          </ConsoleForm>
        </Panel>
      ) : null}
      <GuardRails only={['paymentNeutrality', 'sanctions']} />
    </>
  );
}

/** HC-90 Offers and plans: plan versions with modules, quotas and trials; activation by another person; plans never touch ranking. */
export const screen: Screen = { group: 'billing', id: 'offers', title: () => t('admin.billing.offers.title'), render: Offers };
