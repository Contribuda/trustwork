import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { audienceName, Cohort, Empty, loadProduct, moduleName, moneyMinor, planName } from '../../modules/_kit/parts';

async function Usage(ctx: HubContext) {
  const { usage, cohorts } = (await loadProduct(ctx)).agents;
  const period = usage[0];
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.agents.usage.title')} lede={t('admin.agents.usage.lede')} />
      <Panel id="usage-modules" title={t('admin.agents.usage.byModule')}>
        {period ? <p className="admin-meta">{t('admin.agents.usage.period', { from: longDate(period.from), to: longDate(period.to) })}</p> : null}
        {usage.length ? (
          <table className="plain-table" data-testid="usage-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.agents.usage.module')}</th>
                <th scope="col">{t('admin.agents.usage.principals')}</th>
                <th scope="col">{t('admin.agents.usage.runs')}</th>
                <th scope="col">{t('admin.agents.usage.actions')}</th>
                <th scope="col">{t('admin.agents.usage.money')}</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.moduleKey}>
                  <td data-label={t('admin.agents.usage.module')}>{moduleName(u.moduleKey)}</td>
                  <td data-label={t('admin.agents.usage.principals')}>
                    <Cohort value={u.activePrincipals} />
                  </td>
                  <td data-label={t('admin.agents.usage.runs')}>
                    <Cohort value={u.runs} />
                  </td>
                  <td data-label={t('admin.agents.usage.actions')}>
                    {t('admin.agents.usage.succeeded')} <Cohort value={u.actionsSucceeded} /> · {t('admin.agents.usage.escalated')} <Cohort value={u.actionsEscalatedToHumans} /> · {t('admin.agents.usage.unknown', { count: u.outcomeUnknown })}
                  </td>
                  <td data-label={t('admin.agents.usage.money')}>
                    {t('admin.product.cost')} {moneyMinor(u.cost.minorUnits, u.cost.currency)} · {t('admin.agents.usage.revenue')} {moneyMinor(u.revenue.minorUnits, u.revenue.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.agents.usage.none')}</Empty>
        )}
      </Panel>
      <Panel id="usage-cohorts" title={t('admin.agents.usage.byCohort')}>
        {cohorts.length ? (
          <ul className="admin-list">
            {cohorts.map((c) => (
              <li key={`${c.segment}-${c.key}`} className="admin-list__row">
                <span>
                  {tDynamic(`admin.agents.usage.segments.${c.segment}`, c.segment)}: {c.segment === 'plan' ? planName(c.key) : audienceName(c.key)}
                </span>
                <span>
                  {t('admin.agents.usage.principals')} <Cohort value={c.activePrincipals} /> · {t('admin.agents.usage.runs')} <Cohort value={c.runs} />
                </span>
                <span className="admin-meta">
                  {t('admin.product.cost')} {moneyMinor(c.cost.minorUnits, c.cost.currency)} · {t('admin.agents.usage.revenue')} {moneyMinor(c.revenue.minorUnits, c.revenue.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.agents.usage.none')}</Empty>
        )}
        <p className="admin-note">{t('admin.agents.usage.noDrillDown')}</p>
      </Panel>
      <Panel id="usage-export" title={t('admin.agents.usage.export')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('usage.export')} labels={formLabels({ submit: t('admin.agents.usage.export') })} disabledReason={readOnlyReason(ctx.can('admin.agents.read'), ctx.offline)}>
          <SelectField
            name="period"
            label={t('admin.agents.usage.exportPeriod')}
            options={[
              { value: 'month', label: t('admin.agents.usage.month') },
              { value: 'quarter', label: t('admin.agents.usage.quarter') },
            ]}
          />
          <p className="admin-note">{t('admin.agents.usage.exportNote')}</p>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-83 Usage: is the agent product useful, safe and affordable; aggregates per module and cohort, counts under ten suppressed. */
export const screen: Screen = { group: 'agents', id: 'usage', title: () => t('admin.agents.usage.title'), render: Usage };
