import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, TextInput } from '../../../../_components/forms';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Empty, loadProduct, PreviewPanel, UniqueSelect } from '../../modules/_kit/parts';

const signal = (s: string) => tDynamic(`admin.agents.abuse.signals.${s}`, s);

async function Abuse(ctx: HubContext) {
  const { abuse } = (await loadProduct(ctx)).agents;
  const options = abuse.signals.map((s) => ({ value: s.kind, label: signal(s.kind) }));
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.agents.abuse.title')} lede={t('admin.agents.abuse.lede')} />
      <Panel id="abuse-signals" title={t('admin.agents.abuse.signalsTitle')}>
        {abuse.signals.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.agents.abuse.signal')}</th>
                <th scope="col">{t('admin.agents.abuse.last7Days')}</th>
                <th scope="col">{t('admin.agents.abuse.threshold')}</th>
                <th scope="col">{t('admin.agents.abuse.response')}</th>
                <th scope="col">{t('admin.agents.abuse.cases')}</th>
              </tr>
            </thead>
            <tbody>
              {abuse.signals.map((s) => (
                <tr key={s.kind}>
                  <td data-label={t('admin.agents.abuse.signal')}>{signal(s.kind)}</td>
                  <td data-label={t('admin.agents.abuse.last7Days')}>
                    {s.last7Days}
                    {s.last7Days >= s.threshold ? <span className="admin-warning"> · {t('admin.agents.abuse.overThreshold')}</span> : null}
                  </td>
                  <td data-label={t('admin.agents.abuse.threshold')}>{s.threshold}</td>
                  <td data-label={t('admin.agents.abuse.response')}>{tDynamic(`admin.agents.abuse.responses.${s.response}`, s.response)}</td>
                  <td data-label={t('admin.agents.abuse.cases')}>{s.casesOpened}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.agents.abuse.none')}</Empty>
        )}
        <KeyValues rows={[{ label: t('admin.agents.abuse.throttles'), value: abuse.throttlesActive }]} />
        <p className="admin-note">{t('admin.agents.abuse.noAutoSanctions')}</p>
      </Panel>
      {abuse.signals.length ? (
        <div className="admin-grid">
          <Panel id="abuse-case" title={t('admin.agents.abuse.openCase')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('abuse.open_case')} labels={formLabels({ submit: t('admin.agents.abuse.openCase') })} disabledReason={readOnlyReason(ctx.can('admin.moderation.case.open'), ctx.offline)}>
              <UniqueSelect id="case-signal" name="signal" label={t('admin.agents.abuse.signal')} options={options} />
              <p className="admin-note">{t('admin.agents.abuse.caseNote')}</p>
            </ConsoleForm>
          </Panel>
          <Panel id="abuse-thresholds" title={t('admin.agents.abuse.adjust')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('abuse.thresholds.draft')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.agents.policy.edit'), ctx.offline)}>
              <UniqueSelect id="threshold-signal" name="signal" label={t('admin.agents.abuse.signal')} options={options} />
              <TextInput name="threshold" label={t('admin.agents.abuse.threshold')} isRequired />
            </ConsoleForm>
          </Panel>
        </div>
      ) : null}
      {abuse.draft ? (
        <Panel id="abuse-draft" title={t('admin.agents.abuse.draftVersion', { version: abuse.draft.version })}>
          <PreviewPanel ctx={ctx} preview={abuse.draft.preview} id="abuse-preview" />
          <p className="admin-note">{t('admin.agents.abuse.activate')}</p>
        </Panel>
      ) : null}
    </>
  );
}

/** HC-84 Abuse: aggregate signals that open cases; nothing beyond rate throttling is applied automatically. */
export const screen: Screen = { group: 'agents', id: 'abuse', title: () => t('admin.agents.abuse.title'), render: Abuse };
