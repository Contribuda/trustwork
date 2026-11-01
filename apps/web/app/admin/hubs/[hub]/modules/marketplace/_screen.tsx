import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { ActivationRequest, Cohort, Empty, GuardRails, loadProduct, moneyMinor, PendingRequests, StatePill, versioned, yesNo } from '../_kit/parts';

const category = (key: string) => tDynamic(`admin.modules.marketplace.categories.${key}`, key);

async function Marketplace(ctx: HubContext) {
  const { marketplace } = (await loadProduct(ctx)).modules;
  const drafts = marketplace.fees.filter((f) => f.fee.status === 'draft');
  const firstRule = marketplace.rules[0];
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.marketplace.title')} lede={t('admin.modules.marketplace.lede')} />
      <PendingRequests ctx={ctx} actions={['billing.activate_fee_version']} />
      <Panel id="category-rules" title={t('admin.modules.marketplace.rules')}>
        {marketplace.rules.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.modules.marketplace.category')}</th>
                <th scope="col">{t('admin.modules.marketplace.whoMayOffer')}</th>
                <th scope="col">{t('admin.modules.marketplace.pricing')}</th>
                <th scope="col">{t('admin.modules.marketplace.agents')}</th>
                <th scope="col">{t('admin.modules.marketplace.activity')}</th>
              </tr>
            </thead>
            <tbody>
              {marketplace.rules.map((r) => {
                const counts = marketplace.counts.find((c) => c.categoryKey === r.categoryKey);
                return (
                  <tr key={r.id}>
                    <td data-label={t('admin.modules.marketplace.category')}>
                      {category(r.categoryKey)}
                      <span className="admin-meta">
                        {' · '}
                        {tDynamic(`admin.modules.marketplace.kinds.${r.kind}`, r.kind)} · {t('admin.common.version', { version: r.version })}
                      </span>
                    </td>
                    <td data-label={t('admin.modules.marketplace.whoMayOffer')}>
                      {tDynamic(`admin.modules.marketplace.who.${r.whoMayOffer}`, r.whoMayOffer)}
                      {r.licenceCategory ? (
                        <span className="admin-meta">
                          {' · '}
                          {t('admin.modules.marketplace.licence')} <span lang="en">{r.licenceCategory}</span>
                        </span>
                      ) : null}
                    </td>
                    <td data-label={t('admin.modules.marketplace.pricing')}>
                      {tDynamic(`admin.modules.marketplace.pricingModels.${r.pricing}`, r.pricing)}
                      <span className="admin-meta"> · {t('admin.modules.marketplace.windows', { hours: r.refunds.cancellationWindowHours, days: r.refunds.disputeWindowDays })}</span>
                    </td>
                    <td data-label={t('admin.modules.marketplace.agents')}>
                      {t('admin.modules.marketplace.automation', {
                        drafts: yesNo(r.agentAutomation.mayDraftRequests),
                        accepts: yesNo(r.agentAutomation.mayAcceptWithinMandate),
                        perWeek: r.agentAutomation.requestsPerWeek,
                      })}
                    </td>
                    <td data-label={t('admin.modules.marketplace.activity')}>
                      {counts ? (
                        <>
                          {t('admin.modules.marketplace.open')} <Cohort value={counts.openRequests} /> · {t('admin.modules.marketplace.engagements')} <Cohort value={counts.engagements} />
                        </>
                      ) : (
                        t('admin.common.none')
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.modules.marketplace.noRules')}</Empty>
        )}
        <KeyValues
          rows={[
            { label: t('admin.modules.marketplace.disputes'), value: marketplace.disputes },
            { label: t('admin.modules.marketplace.refunds'), value: marketplace.refundsOutsidePolicy },
            { label: t('admin.modules.marketplace.paused'), value: <Cohort value={marketplace.pausedForExpiredLicence} /> },
          ]}
        />
      </Panel>
      {firstRule ? (
        <Panel id="edit-rule" title={t('admin.modules.marketplace.editRule')}>
          <ConsoleForm action={submitConsoleCommand} hidden={versioned(ctx, 'marketplace.rule.save', firstRule.version)} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.marketplace.rules.edit'), ctx.offline)}>
            <div className="admin-form__grid">
              <SelectField name="categoryKey" label={t('admin.modules.marketplace.category')} options={marketplace.rules.map((r) => ({ value: r.categoryKey, label: category(r.categoryKey) }))} />
              <SelectField
                name="whoMayOffer"
                label={t('admin.modules.marketplace.whoMayOffer')}
                options={(['verified_company', 'verified_professional', 'verified_company_or_professional', 'claimed_company_or_professional'] as const).map((w) => ({ value: w, label: tDynamic(`admin.modules.marketplace.who.${w}`, w) }))}
              />
              <TextInput name="requestsPerWeek" label={t('admin.modules.marketplace.requestsPerWeek')} defaultValue={String(firstRule.agentAutomation.requestsPerWeek)} />
            </div>
            <p className="admin-note">{t('admin.modules.marketplace.licensedNote')}</p>
          </ConsoleForm>
        </Panel>
      ) : null}
      <Panel id="fee-versions" title={t('admin.modules.marketplace.fees')}>
        {marketplace.fees.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.modules.marketplace.fee')}</th>
                <th scope="col">{t('admin.modules.marketplace.amount')}</th>
                <th scope="col">{t('admin.modules.marketplace.effective')}</th>
                <th scope="col">{t('admin.modules.marketplace.status')}</th>
              </tr>
            </thead>
            <tbody>
              {marketplace.fees.map(({ fee }) => (
                <tr key={fee.id}>
                  <td data-label={t('admin.modules.marketplace.fee')}>
                    {tDynamic(`admin.modules.marketplace.feeKinds.${fee.kind}`, fee.kind)}
                    {fee.categoryKey ? ` · ${category(fee.categoryKey)}` : ''}
                    <span className="admin-meta"> · {t('admin.common.version', { version: fee.version })}</span>
                  </td>
                  <td data-label={t('admin.modules.marketplace.amount')}>
                    {fee.basisPoints !== null ? t('admin.modules.marketplace.percent', { percent: fee.basisPoints / 100 }) : ''}
                    {fee.basisPoints !== null && fee.fixed ? ' + ' : ''}
                    {fee.fixed ? moneyMinor(fee.fixed.minorUnits, fee.fixed.currency) : ''}
                    <span className="admin-meta"> · {tDynamic(`admin.modules.marketplace.payer.${fee.payer}`, fee.payer)}</span>
                  </td>
                  <td data-label={t('admin.modules.marketplace.effective')}>{longDate(fee.effectiveFrom)}</td>
                  <td data-label={t('admin.modules.marketplace.status')}>
                    <StatePill state={fee.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.modules.marketplace.noFees')}</Empty>
        )}
        <p className="admin-note">{t('admin.modules.marketplace.feesDisclosed')}</p>
      </Panel>
      <div className="admin-grid">
        {drafts.map(({ fee, preview }) => (
          <Panel key={fee.id} id={`activate-${fee.id}`} title={t('admin.modules.marketplace.activateFee', { version: fee.version })}>
            <ActivationRequest ctx={ctx} command="marketplace.fee.request_activation" target={{ feeId: fee.id }} preview={preview} secondPerson="billing.activate_fee_version" canRequest={ctx.can('admin.billing.fees.draft')} />
          </Panel>
        ))}
        <Panel id="draft-fee" title={t('admin.modules.marketplace.draftFee')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('marketplace.fee.draft')} labels={formLabels({ submit: t('admin.modules.marketplace.draftFee') })} disabledReason={readOnlyReason(ctx.can('admin.billing.fees.draft'), ctx.offline)}>
            <div className="admin-form__grid">
              <SelectField name="kind" label={t('admin.modules.marketplace.fee')} options={(['consultation', 'task'] as const).map((k) => ({ value: k, label: tDynamic(`admin.modules.marketplace.feeKinds.${k}`, k) }))} />
              <TextInput name="basisPoints" label={t('admin.modules.marketplace.basisPoints')} description={t('admin.modules.marketplace.basisPointsHelp')} isRequired />
              <TextInput name="effectiveFrom" label={t('admin.modules.marketplace.effectiveFrom')} description={t('admin.product.dateHelp')} isRequired />
            </div>
          </ConsoleForm>
        </Panel>
      </div>
      <GuardRails only={['paymentNeutrality', 'sanctions', 'privateData']} />
    </>
  );
}

/** HC-62 Marketplace: consultation and task categories, commissions as fee versions activated by a second person. */
export const screen: Screen = { group: 'modules', id: 'marketplace', title: () => t('admin.modules.marketplace.title'), render: Marketplace };
