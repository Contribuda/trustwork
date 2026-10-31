import { AUTOMATION_DOMAINS, blockingGates, HUB_LIFECYCLE, HUMAN_GATES, hubTransitionAllowed, modesViolations } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { list, violationLabel } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';

const onOff = (value: boolean) => t(value ? 'admin.common.on' : 'admin.common.off');

function Modes(ctx: HubContext) {
  const { record } = ctx;
  const { modes, hub } = record;
  const next = HUB_LIFECYCLE.filter((to) => hubTransitionAllowed(hub.lifecycle, to));
  const violations = modesViolations(hub.lifecycle, modes);
  const softOpen = next.includes('soft_launch') ? blockingGates('soft_launch', record.gates) : [];
  const canEdit = ctx.can('admin.hub.modes.edit');
  const canRequest = ctx.can('admin.hub.lifecycle.request');
  const levels = ['manual', 'assisted', 'supervised_autonomous'] as const;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.modes.title')} lede={t('admin.hub.modes.lede')} />
      {violations.length ? (
        <p className="admin-callout admin-callout--danger" role="alert">
          {t('admin.hub.modes.violationsFound', { items: list(violations.map(violationLabel)) })}
        </p>
      ) : null}
      <div className="admin-grid">
        <Panel id="lifecycle" title={t('admin.hub.modes.lifecycle')}>
          <KeyValues
            rows={[
              { label: t('admin.hub.modes.stage'), value: tDynamic(`admin.lifecycle.${hub.lifecycle}`, hub.lifecycle) },
              { label: t('admin.hub.modes.nextStages'), value: next.length ? list(next.map((s) => tDynamic(`admin.lifecycle.${s}`, s))) : t('admin.common.none') },
            ]}
          />
          {softOpen.length ? (
            <p className="admin-callout admin-callout--warning">
              {t('admin.hub.modes.blockedBy', { items: list(softOpen.map((g) => tDynamic(`admin.hub.launch.gates.${g}`, g))) })}{' '}
              <a href={ctx.href('hub/launch')}>{t('admin.hub.modes.openLaunch')}</a>
            </p>
          ) : null}
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('lifecycle.request')}
            labels={formLabels({ submit: t('admin.hub.modes.requestTransition'), secondPerson: true })}
            disabledReason={readOnlyReason(canRequest, ctx.offline)}
          >
            <SelectField name="to" label={t('admin.hub.modes.to')} options={next.map((s) => ({ value: s, label: tDynamic(`admin.lifecycle.${s}`, s) }))} />
          </ConsoleForm>
        </Panel>

        <Panel id="behaviour" title={t('admin.hub.modes.behaviour')}>
          <KeyValues
            rows={[
              { label: t('admin.hub.modes.data'), value: tDynamic(`admin.hub.modes.dataMode.${modes.dataMode}`, modes.dataMode) },
              { label: t('admin.hub.modes.registration'), value: tDynamic(`admin.hub.modes.registrationMode.${modes.registration}`, modes.registration) },
              { label: t('admin.hub.modes.moderation'), value: tDynamic(`admin.hub.modes.moderationMode.${modes.moderation}`, modes.moderation) },
              { label: t('admin.hub.modes.indexing'), value: onOff(modes.searchEngineIndexing) },
              { label: t('admin.hub.modes.maintenance'), value: onOff(modes.maintenance) },
            ]}
          />
          {modes.dataMode === 'demo' ? <p className="admin-note">{t('admin.hub.modes.demoRule')}</p> : null}
        </Panel>
      </div>

      <Panel id="automation" title={t('admin.hub.modes.automation')}>
        <table className="plain-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.hub.modes.domain')}</th>
              <th scope="col">{t('admin.hub.modes.level')}</th>
            </tr>
          </thead>
          <tbody>
            {AUTOMATION_DOMAINS.map((d) => (
              <tr key={d}>
                <td data-label={t('admin.hub.modes.domain')}>{tDynamic(`admin.hub.modes.domains.${d}`, d)}</td>
                <td data-label={t('admin.hub.modes.level')}>{tDynamic(`admin.values.automation.${modes.automation[d]}`, modes.automation[d])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="admin-h3">{t('admin.hub.modes.humanGates')}</h3>
        <p>{t('admin.hub.modes.humanGatesNote')}</p>
        <ul className="admin-tags">
          {HUMAN_GATES.map((g) => (
            <li key={g}>{tDynamic(`admin.hub.modes.gates.${g}`, g)}</li>
          ))}
        </ul>
      </Panel>

      <Panel id="change-modes" title={t('admin.hub.modes.change')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('modes.save')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
          <div className="admin-form__grid">
            <SelectField
              name="registration"
              label={t('admin.hub.modes.registration')}
              defaultValue={modes.registration}
              options={(['closed', 'invite_only', 'open'] as const).map((v) => ({ value: v, label: tDynamic(`admin.hub.modes.registrationMode.${v}`, v) }))}
            />
            <SelectField
              name="moderation"
              label={t('admin.hub.modes.moderation')}
              defaultValue={modes.moderation}
              options={(['pre_moderate_all', 'pre_moderate_new_authors', 'post_moderate'] as const).map((v) => ({ value: v, label: tDynamic(`admin.hub.modes.moderationMode.${v}`, v) }))}
            />
            <SelectField
              name="searchEngineIndexing"
              label={t('admin.hub.modes.indexing')}
              defaultValue={modes.searchEngineIndexing ? 'on' : 'off'}
              options={[
                { value: 'off', label: t('admin.common.off') },
                { value: 'on', label: t('admin.common.on') },
              ]}
            />
            {AUTOMATION_DOMAINS.map((d) => (
              <SelectField
                key={d}
                name={`automation.${d}`}
                label={tDynamic(`admin.hub.modes.domains.${d}`, d)}
                defaultValue={modes.automation[d]}
                options={levels.map((v) => ({ value: v, label: tDynamic(`admin.values.automation.${v}`, v) }))}
              />
            ))}
          </div>
          <p className="admin-note">{t('admin.hub.modes.supervisedNote')}</p>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-11 System modes: lifecycle, data mode, registration, moderation, automation with its human gates, indexing, maintenance. */
export const screen: Screen = { group: 'hub', id: 'modes', title: () => t('admin.hub.modes.title'), render: Modes };
