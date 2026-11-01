import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, Empty, GuardRails, loadProduct, versioned, yesNo } from '../_kit/parts';

async function Commerce(ctx: HubContext) {
  const { commerce } = (await loadProduct(ctx)).modules;
  const zone = ctx.record.hub.timeZone;
  const { flows } = commerce;
  const firstRule = commerce.rules[0];
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.commerce.title')} lede={t('admin.modules.commerce.lede')} />
      <div className="admin-grid">
        <Panel id="commerce-flows" title={t('admin.modules.commerce.flows')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.commerce.rfqs'), value: <Cohort value={flows.rfqs} /> },
              { label: t('admin.modules.commerce.quotes'), value: <Cohort value={flows.quotes} /> },
              { label: t('admin.modules.commerce.agreements'), value: <Cohort value={flows.agreements} /> },
              { label: t('admin.modules.commerce.orders'), value: <Cohort value={flows.orders} /> },
              { label: t('admin.modules.commerce.toFirstQuote'), value: flows.medianHoursToFirstQuote === null ? t('admin.common.notRecorded') : t('admin.modules.commerce.hours', { count: flows.medianHoursToFirstQuote }) },
              { label: t('admin.modules.commerce.toOrder'), value: flows.medianDaysAcceptanceToOrder === null ? t('admin.common.notRecorded') : t('admin.modules.commerce.days', { count: flows.medianDaysAcceptanceToOrder }) },
            ]}
          />
        </Panel>
        <Panel id="commerce-rules" title={t('admin.modules.commerce.rules')}>
          {commerce.rules.length ? (
            <ul className="admin-list">
              {commerce.rules.map((r) => (
                <li key={r.categoryKey} className="admin-list__row">
                  <span>{tDynamic(`admin.modules.commerce.categories.${r.categoryKey}`, r.categoryKey)}</span>
                  <span className="admin-meta">
                    {t('admin.modules.commerce.licenceCheck', { value: yesNo(r.licenceCheck) })} · {t('admin.modules.commerce.taxIncluded', { value: yesNo(r.pricesIncludeTax) })} · {t('admin.common.version', { version: r.version })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('admin.modules.commerce.noRules')}</Empty>
          )}
        </Panel>
      </div>
      <Panel id="unknown-outcomes" title={t('admin.modules.commerce.unknown')}>
        {commerce.unknownOutcomes.length ? (
          <>
            <ul className="admin-list">
              {commerce.unknownOutcomes.map((u) => (
                <li key={u.id} className="admin-list__row">
                  <code className="admin-code">{u.id}</code>
                  <span>{tDynamic(`admin.modules.commerce.outcomeKinds.${u.kind}`, u.kind)}</span>
                  <span className="admin-meta">
                    {tDynamic(`admin.modules.commerce.outcomeStates.${u.state}`, u.state)} · {dateTime(u.since, zone)}
                  </span>
                </li>
              ))}
            </ul>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('commerce.reconcile')} labels={formLabels({ submit: t('admin.modules.commerce.reconcile') })} disabledReason={readOnlyReason(ctx.can('admin.assistant.reconcile'), ctx.offline)}>
              <div className="admin-form__grid">
                <SelectField name="outcomeId" label={t('admin.modules.commerce.outcome')} options={commerce.unknownOutcomes.map((u) => ({ value: u.id, label: u.id }))} />
                <TextInput name="evidence" label={t('admin.modules.commerce.evidence')} description={t('admin.modules.commerce.evidenceHelp')} isRequired />
              </div>
              <p className="admin-note">{t('admin.modules.commerce.noBlindRetry')}</p>
            </ConsoleForm>
          </>
        ) : (
          <Empty>{t('admin.modules.commerce.noUnknown')}</Empty>
        )}
        <p>
          <NextLink href={ctx.href('support/cases')}>{t('admin.modules.commerce.caseGrant')}</NextLink>
        </p>
      </Panel>
      {firstRule ? (
        <Panel id="commerce-edit" title={t('admin.modules.commerce.editRule')}>
          <ConsoleForm action={submitConsoleCommand} hidden={versioned(ctx, 'commerce.rule.save', firstRule.version)} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.commerce.category_rules.edit'), ctx.offline)}>
            <div className="admin-form__grid">
              <SelectField name="categoryKey" label={t('admin.modules.commerce.category')} options={commerce.rules.map((r) => ({ value: r.categoryKey, label: tDynamic(`admin.modules.commerce.categories.${r.categoryKey}`, r.categoryKey) }))} />
              <SelectField
                name="licenceRequired"
                label={t('admin.modules.commerce.licenceRequired')}
                options={[
                  { value: 'on', label: t('admin.common.yes') },
                  { value: 'off', label: t('admin.common.no') },
                ]}
              />
            </div>
          </ConsoleForm>
        </Panel>
      ) : null}
      <GuardRails only={['privateData', 'confirmations', 'sanctions']} />
    </>
  );
}

/** HC-67 Commerce: category rules and flow health without private data; unknown outcomes are reconciled with evidence. */
export const screen: Screen = { group: 'modules', id: 'commerce', title: () => t('admin.modules.commerce.title'), render: Commerce };
