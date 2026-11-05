import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import { CheckboxField, formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import type { Screen } from '../../../../_components/screen';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Pill, Table } from '../../participants/_kit';
import { DATA_CLASSES, EGRESS_DECISIONS } from '../providers/_commands';

const className = (dataClass: string) => tDynamic(`providers.dataClasses.${dataClass}`, dataClass);

async function LiveEgress(ctx: HubContext) {
  const view = await ctx.port.providers(ctx.record.hub.id);
  const header = <ConsoleHeader ctx={ctx} title={t('providers.console.egress.title')} lede={t('providers.console.egress.lede')} />;
  if (!view?.egress) {
    return (
      <>
        {header}
        <p className="admin-empty">{t('providers.console.hidden')}</p>
      </>
    );
  }
  const { cells } = view.egress;
  const canEdit = ctx.can('admin.providers.egress.edit');
  const cell = (connectionId: string, dataClass: string) => cells.find((c) => c.connectionId === connectionId && c.dataClass === dataClass);
  const nonPublic = cells.filter((c) => c.decision === 'allow' && c.dataClass !== 'public');
  const reaches = nonPublic.map((c) => `${view.connections.find((x) => x.id === c.connectionId)?.label ?? c.connectionId}: ${className(c.dataClass)}`);
  return (
    <>
      {header}
      <Panel id="egress-matrix" title={t('providers.console.egress.matrix')}>
        <p className="admin-note">{t('providers.console.egress.defaultDeny')}</p>
        <Table
          testid="egress-matrix-table"
          rows={view.connections}
          rowKey={(c) => c.id}
          empty={t('providers.console.none')}
          columns={[
            { label: t('providers.console.egress.connection'), lang: () => 'und', render: (c) => c.label },
            ...DATA_CLASSES.map((dataClass) => ({
              label: className(dataClass),
              render: (c: (typeof view.connections)[number]) => {
                const rule = cell(c.id, dataClass);
                return <Pill tone={rule?.decision === 'allow' ? 'pass' : 'neutral'}>{t(rule?.decision === 'allow' ? 'providers.console.egress.allow' : 'providers.console.egress.deny')}</Pill>;
              },
            })),
          ]}
        />
      </Panel>
      {view.connections.length ? (
        <Panel id="egress-cell" title={t('providers.console.egress.change')}>
          <p className="admin-note">{t('providers.console.egress.changeHelp')}</p>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.egress_set')} labels={formLabels({ submit: t('providers.console.egress.change') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
            <div className="admin-form__grid">
              <SelectField name="egressConnection" label={t('providers.console.egress.connection')} options={view.connections.map((c) => ({ value: c.id, label: c.label, lang: 'und' }))} />
              <SelectField name="egressClass" label={t('providers.console.egress.dataClass')} options={DATA_CLASSES.map((c) => ({ value: c, label: className(c) }))} />
              <SelectField name="egressDecision" label={t('providers.console.egress.decision')} options={EGRESS_DECISIONS.map((d) => ({ value: d, label: t(d === 'allow' ? 'providers.console.egress.allow' : 'providers.console.egress.deny') }))} />
            </div>
            <CheckboxField name="egressResidency" label={t('providers.console.egress.requireResidency')} />
            <CheckboxField name="egressZeroRetention" label={t('providers.console.egress.requireZero')} />
          </ConsoleForm>
        </Panel>
      ) : null}
      <Panel id="egress-review" title={t('providers.console.egress.review')}>
        <p data-testid="egress-sentence">{reaches.length ? t('providers.console.egress.reaches', { items: reaches.join('; ') }) : t('providers.console.egress.reachesNothing')}</p>
        <p className="admin-note" data-testid="egress-review-state">{view.egressReview ? t('providers.console.egress.reviewed', { version: view.egressReview.version }) : t('providers.console.egress.notReviewed')}</p>
        <p className="admin-note">{t('providers.console.egress.reviewHelp')}</p>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.egress_signoff')} labels={formLabels({ submit: t('providers.console.egress.signOff'), secondPerson: true })} disabledReason={readOnlyReason(canEdit || ctx.can('admin.config.edit'), ctx.offline)} />
      </Panel>
    </>
  );
}

/** HC-102 Egress, live only: data classes by connection, default deny, and the review the launch checklist reads. */
export const screen: Screen = { group: 'integrations', id: 'egress', title: () => t('providers.console.egress.title'), render: LiveEgress };
