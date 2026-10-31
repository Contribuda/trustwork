import { blockingGates, SOFT_LAUNCH_GATES } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { dateTime, list } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';

const gateName = (g: string) => tDynamic(`admin.hub.launch.gates.${g}`, g);

async function Launch(ctx: HubContext) {
  const { record } = ctx;
  const gates = record.gates;
  const people = await ctx.port.people([...new Set(gates.flatMap((g) => (g.checkedBy ? [g.checkedBy] : [])))]);
  const passed = gates.filter((g) => g.state === 'passed').length;
  const softOpen = blockingGates('soft_launch', gates);
  const publicOpen = blockingGates('public', gates);
  const markable = gates.filter((g) => g.state !== 'passed');
  const zone = record.hub.timeZone;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.launch.title')} lede={t('admin.hub.launch.lede')} />
      <p className="admin-progress" data-testid="launch-progress">
        {t('admin.hub.launch.progress', { passed, total: gates.length })}
        <progress max={gates.length} value={passed} aria-label={t('admin.hub.launch.progressLabel')} />
      </p>
      <Panel id="gates" title={t('admin.hub.launch.gatesTitle')}>
        <table className="plain-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.hub.launch.gate')}</th>
              <th scope="col">{t('admin.hub.launch.state')}</th>
              <th scope="col">{t('admin.hub.launch.evidence')}</th>
              <th scope="col">{t('admin.hub.launch.checked')}</th>
            </tr>
          </thead>
          <tbody>
            {gates.map((g) => {
              const checker = people.find((p) => p.id === g.checkedBy);
              return (
                <tr key={g.gate} data-testid={`gate-${g.gate}`}>
                  <td data-label={t('admin.hub.launch.gate')}>
                    {gateName(g.gate)}
                    {SOFT_LAUNCH_GATES.includes(g.gate) ? <span className="admin-meta"> · {t('admin.hub.launch.softLaunchGate')}</span> : null}
                  </td>
                  <td data-label={t('admin.hub.launch.state')}>
                    <span className={`admin-pill admin-pill--${g.state}`}>{t(`admin.hub.launch.states.${g.state}`)}</span>
                    {g.invalidationReason ? (
                      <span className="admin-meta" lang="en">
                        {' '}
                        · {g.invalidationReason}
                      </span>
                    ) : null}
                  </td>
                  <td data-label={t('admin.hub.launch.evidence')}>{g.evidenceRef ? <code className="admin-code">{g.evidenceRef}</code> : t('admin.common.none')}</td>
                  <td data-label={t('admin.hub.launch.checked')}>
                    {checker && g.checkedAt ? (
                      <>
                        <span lang={checker.nameLang}>{checker.displayName}</span>
                        <span className="admin-meta"> · {dateTime(g.checkedAt, zone)}</span>
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
        <p className="admin-note">{t('admin.hub.launch.noWaiver')}</p>
      </Panel>
      <div className="admin-grid">
        <Panel id="mark" title={t('admin.hub.launch.mark')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('launch.mark_passed')} labels={formLabels({ submit: t('admin.hub.launch.mark') })} disabledReason={readOnlyReason(ctx.can('admin.hub.launch.check') && markable.length > 0, ctx.offline)}>
            <SelectField name="gate" label={t('admin.hub.launch.gate')} options={markable.map((g) => ({ value: g.gate, label: gateName(g.gate) }))} />
            <TextInput name="evidence" label={t('admin.hub.launch.evidenceRef')} description={t('admin.hub.launch.evidenceHelp')} isRequired />
          </ConsoleForm>
        </Panel>
        <Panel id="request-launch" title={t('admin.hub.launch.request')}>
          <p>{softOpen.length ? t('admin.hub.launch.softBlocked', { items: list(softOpen.map(gateName)) }) : t('admin.hub.launch.softReady')}</p>
          <p>{publicOpen.length ? t('admin.hub.launch.publicBlocked', { count: publicOpen.length }) : t('admin.hub.launch.publicReady')}</p>
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('lifecycle.request')}
            labels={formLabels({ submit: t('admin.hub.launch.request'), secondPerson: true })}
            disabledReason={readOnlyReason(ctx.can('admin.hub.lifecycle.request'), ctx.offline)}
          >
            <SelectField
              name="to"
              label={t('admin.hub.modes.to')}
              options={(['soft_launch', 'public'] as const).map((s) => ({ value: s, label: tDynamic(`admin.lifecycle.${s}`, s) }))}
            />
          </ConsoleForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-17 Launch checklist: every gate with evidence; soft launch or public is requested only when gates pass, and needs a second person. */
export const screen: Screen = { group: 'hub', id: 'launch', title: () => t('admin.hub.launch.title'), render: Launch };
