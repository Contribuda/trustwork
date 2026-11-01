import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Pill, Table } from '../../participants/_kit';
import { Cohort } from '../../modules/_kit/parts';
import { loadOutreach, OutreachForm, stateName } from '../_kit/parts';

function Lifecycle(ctx: HubContext) {
  const view = loadOutreach(ctx);
  const drafts = view.journeys.filter((j) => j.state === 'draft');
  const active = view.journeys.filter((j) => j.state === 'active');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.lifecycle.title')} lede={t('adminOutreach.lifecycle.lede')} />
      <Panel id="journeys" title={t('adminOutreach.lifecycle.journeys')}>
        <Table
          testid="journeys"
          rows={view.journeys}
          rowKey={(j) => j.id}
          empty={t('adminOutreach.lifecycle.none')}
          columns={[
            { label: t('adminOutreach.common.name'), render: (j) => <span lang={j.name.lang}>{j.name.text}</span> },
            { label: t('adminOutreach.lifecycle.audience'), render: (j) => tDynamic(`adminOutreach.lifecycle.audiences.${j.audience}`, j.audience) },
            { label: t('adminOutreach.lifecycle.steps'), render: (j) => String(j.steps) },
            { label: t('adminOutreach.lifecycle.cap'), render: (j) => t('adminOutreach.lifecycle.capValue', { count: j.capPerMonth }) },
            { label: t('adminOutreach.common.versionLabel'), render: (j) => t('adminOutreach.common.version', { version: j.version }) },
            { label: t('adminOutreach.lifecycle.enrolled'), render: (j) => <Cohort value={j.enrolled} /> },
            { label: t('adminOutreach.common.state'), render: (j) => <Pill tone={j.state === 'active' ? 'pass' : 'neutral'}>{stateName(j.state)}</Pill> },
          ]}
        />
        <p className="admin-note">{t('adminOutreach.lifecycle.noPeople')}</p>
      </Panel>
      {drafts.length ? (
        <Panel id="activate" title={t('adminOutreach.lifecycle.activate')}>
          <OutreachForm ctx={ctx} command="outreach.journey_activate" submit={t('adminOutreach.lifecycle.activate')} can={['admin.notifications.broadcast']} secondPerson>
            <SelectField name="journey" label={t('adminOutreach.lifecycle.journey')} options={drafts.map((j) => ({ value: j.id, label: j.name.text }))} />
          </OutreachForm>
        </Panel>
      ) : null}
      {active.length ? (
        <Panel id="pause" title={t('adminOutreach.lifecycle.pause')}>
          <OutreachForm ctx={ctx} command="outreach.journey_pause" submit={t('adminOutreach.lifecycle.pause')} can={['admin.notifications.broadcast']} variant="danger">
            <SelectField name="journey" label={t('adminOutreach.lifecycle.journey')} options={active.map((j) => ({ value: j.id, label: j.name.text }))} />
          </OutreachForm>
        </Panel>
      ) : null}
    </>
  );
}

/** HC-177 Lifecycle journeys: journeys for participants and partners with steps, caps and enrolment cohorts; no per-person rows. */
export const screen: Screen = { group: 'outreach', id: 'lifecycle', title: () => t('adminOutreach.lifecycle.title'), render: Lifecycle };
