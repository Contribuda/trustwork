import { t } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { ActivationRequest, Empty, loadProduct, moneyMinor, PendingRequests, StatePill } from '../../modules/_kit/parts';

async function Credits(ctx: HubContext) {
  const { billing } = await loadProduct(ctx);
  const { credits } = billing;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.billing.credits.title')} lede={t('admin.billing.credits.lede')} />
      <PendingRequests ctx={ctx} actions={['commerce.activate_price_version']} />
      <div className="admin-grid">
        <Panel id="credits-issued" title={t('admin.billing.credits.issued')}>
          <KeyValues
            rows={[
              { label: t('admin.billing.credits.thisMonth'), value: credits.issuedThisMonth },
              { label: t('admin.billing.credits.amount'), value: moneyMinor(credits.issuedAmount.minorUnits, credits.issuedAmount.currency) },
              { label: t('admin.billing.credits.roleCap'), value: moneyMinor(credits.roleCap.minorUnits, credits.roleCap.currency) },
            ]}
          />
          <p className="admin-note">{t('admin.billing.credits.notRefunds')}</p>
        </Panel>
        <Panel id="refund-policy" title={t('admin.billing.credits.refundPolicy')}>
          <KeyValues
            rows={[
              { label: t('admin.common.version', { version: credits.refundPolicy.version }), value: <span lang={credits.refundPolicy.summary.lang}>{credits.refundPolicy.summary.text}</span> },
              { label: t('admin.billing.credits.effective'), value: longDate(credits.refundPolicy.effectiveFrom) },
            ]}
          />
        </Panel>
      </div>
      <Panel id="credit-packs" title={t('admin.billing.credits.packs')}>
        {credits.packs.length ? (
          <ul className="admin-approvals">
            {credits.packs.map((p) => (
              <li key={p.id} className="admin-approval" data-testid={`pack-${p.id}`}>
                <div className="admin-panel__head">
                  <h3 className="admin-h3">
                    {t('admin.billing.credits.packTitle', { credits: p.credits })} · {t('admin.common.version', { version: p.version })}
                  </h3>
                  <StatePill state={p.status} />
                </div>
                <KeyValues
                  rows={[
                    { label: t('admin.billing.credits.price'), value: moneyMinor(p.price.minorUnits, p.price.currency) },
                    { label: t('admin.billing.credits.validity'), value: p.validityDays === null ? t('admin.billing.credits.noExpiry') : t('admin.billing.credits.validFor', { days: p.validityDays, reminder: p.reminderDaysBeforeExpiry ?? 0 }) },
                    { label: t('admin.billing.credits.refunds'), value: t('admin.common.version', { version: p.refundPolicyVersion }) },
                  ]}
                />
                {p.status === 'draft' ? (
                  <ActivationRequest ctx={ctx} command="billing.pack.request_activation" target={{ packId: p.id }} preview={p.preview} secondPerson="commerce.activate_price_version" canRequest={ctx.can('admin.commerce.offer.edit')} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.billing.credits.noPacks')}</Empty>
        )}
        <p className="admin-note">{t('admin.billing.credits.neverSilent')}</p>
      </Panel>
      <div className="admin-grid">
        <Panel id="issue-credit" title={t('admin.billing.credits.issue')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.credit.issue')} labels={formLabels({ submit: t('admin.billing.credits.issue') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.credit.issue'), ctx.offline)}>
            <TextInput name="billingAccount" label={t('admin.billing.credits.account')} description={t('admin.billing.credits.accountHelp')} isRequired />
            <TextInput name="amountMinor" label={t('admin.billing.credits.amountMinor')} description={t('admin.billing.credits.capHelp', { cap: moneyMinor(credits.roleCap.minorUnits, credits.roleCap.currency) })} isRequired />
          </ConsoleForm>
        </Panel>
        <Panel id="draft-pack" title={t('admin.billing.credits.draftPack')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.pack.draft')} labels={formLabels({ submit: t('admin.billing.credits.draftPack') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.offer.edit'), ctx.offline)}>
            <div className="admin-form__grid">
              <TextInput name="credits" label={t('admin.billing.credits.creditsLabel')} isRequired />
              <TextInput name="priceMinor" label={t('admin.billing.credits.priceMinor')} isRequired />
              <SelectField
                name="validity"
                label={t('admin.billing.credits.validity')}
                options={[
                  { value: 'none', label: t('admin.billing.credits.noExpiry') },
                  { value: 'days', label: t('admin.billing.credits.expiresAfter') },
                ]}
              />
              <TextInput name="validityDays" label={t('admin.billing.credits.validityDays')} />
              <TextInput name="reminderDays" label={t('admin.billing.credits.reminderDays')} />
            </div>
            <p className="admin-note">{t('admin.billing.credits.shownBeforePurchase')}</p>
          </ConsoleForm>
        </Panel>
        <Panel id="refund-edit" title={t('admin.billing.credits.editRefund')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.refund_policy.save')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.refund.policy'), ctx.offline)}>
            <TextInput name="refundWindowDays" label={t('admin.billing.credits.refundWindow')} isRequired />
          </ConsoleForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-94 Credits and refunds: credits within role caps, credit packs whose validity is shown before purchase and never expire silently, refund policy versions. */
export const screen: Screen = { group: 'billing', id: 'credits', title: () => t('admin.billing.credits.title'), render: Credits };
