import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { ActivationRequest, Cohort, Empty, loadProduct, moneyMinor, PendingRequests, StatePill, UniqueSelect } from '../../modules/_kit/parts';

async function Payouts(ctx: HubContext) {
  const { billing } = await loadProduct(ctx);
  const zone = ctx.record.hub.timeZone;
  const awaiting = billing.payoutBatches.filter((b) => b.state === 'awaiting_release');
  const unknown = billing.payoutBatches.filter((b) => b.state === 'outcome_unknown');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.billing.payouts.title')} lede={t('admin.billing.payouts.lede')} />
      <p className="admin-callout" role="note" data-testid="no-money-moves">
        {t('admin.billing.payouts.provider')}
      </p>
      <PendingRequests ctx={ctx} actions={['billing.release_payout_batch']} />
      <Panel id="payout-batches" title={t('admin.billing.payouts.batches')}>
        {billing.payoutBatches.length ? (
          <ul className="admin-list">
            {billing.payoutBatches.map((b) => (
              <li key={b.id} className="admin-list__row">
                <span>
                  {tDynamic(`admin.billing.payouts.recipients.${b.recipients}`, b.recipients)} · <code className="admin-code">{b.id}</code>
                </span>
                <span>
                  {t('admin.billing.payouts.payees')} <Cohort value={b.payees} /> · {moneyMinor(b.total.minorUnits, b.total.currency)}
                </span>
                <span className="admin-meta">{dateTime(b.createdAt, zone)}</span>
                <StatePill state={b.state} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.billing.payouts.none')}</Empty>
        )}
      </Panel>
      <div className="admin-grid">
        {awaiting.map((b) => (
          <Panel key={b.id} id={`release-${b.id}`} title={t('admin.billing.payouts.release')}>
            <p>
              <code className="admin-code">{b.id}</code> · {moneyMinor(b.total.minorUnits, b.total.currency)}
            </p>
            <ActivationRequest ctx={ctx} command="billing.payout.request_release" target={{ batchId: b.id }} preview={null} secondPerson="billing.release_payout_batch" canRequest={ctx.can('admin.billing.payouts.release')} submit={t('admin.billing.payouts.requestRelease')} />
          </Panel>
        ))}
        {unknown.length ? (
          <Panel id="payout-reconcile" title={t('admin.billing.payouts.reconcile')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('billing.payout.reconcile')} labels={formLabels({ submit: t('admin.billing.payouts.reconcile') })} disabledReason={readOnlyReason(ctx.can('admin.assistant.reconcile'), ctx.offline)}>
              <UniqueSelect id="reconcile-batch" name="batchId" label={t('admin.billing.payouts.batch')} options={unknown.map((b) => ({ value: b.id, label: b.id }))} />
              <TextInput name="evidence" label={t('admin.billing.payouts.evidence')} description={t('admin.billing.payouts.evidenceHelp')} isRequired />
              <p className="admin-note">{t('admin.billing.payouts.noBlindRetry')}</p>
            </ConsoleForm>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

/** HC-93 Payouts: batches to organizers, authors and experts through the licensed provider; release by a second person, unknown outcomes reconciled. */
export const screen: Screen = { group: 'billing', id: 'payouts', title: () => t('admin.billing.payouts.title'), render: Payouts };
