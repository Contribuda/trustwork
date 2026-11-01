import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { dateTime, list } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, Empty, loadProduct, onOff, versioned } from '../_kit/parts';
import { PROJECT_PUBLIC_FIELDS } from '../_kit/schemas';

const field = (f: string) => tDynamic(`admin.modules.projects.fields.${f}`, f);

async function Projects(ctx: HubContext) {
  const { projects } = (await loadProduct(ctx)).modules;
  const zone = ctx.record.hub.timeZone;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.projects.title')} lede={t('admin.modules.projects.lede')} />
      <div className="admin-grid">
        <Panel id="projects-policy" title={t('admin.modules.projects.policy')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.projects.publishing'), value: onOff(projects.publishingAllowed) },
              { label: t('admin.modules.projects.publicFields'), value: list(projects.publicFields.map(field)) },
              { label: t('admin.modules.projects.version'), value: t('admin.common.version', { version: projects.version }) },
            ]}
          />
          <p className="admin-note">{t('admin.modules.projects.privateByDefault')}</p>
        </Panel>
        <Panel id="projects-counts" title={t('admin.modules.projects.counts')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.projects.created'), value: <Cohort value={projects.counts.created} /> },
              { label: t('admin.modules.projects.published'), value: <Cohort value={projects.counts.published} /> },
              { label: t('admin.modules.projects.completed'), value: <Cohort value={projects.counts.completed} /> },
              { label: t('admin.modules.projects.transferDisputes'), value: projects.transferDisputes },
            ]}
          />
          <p>
            <NextLink href={ctx.href('support/cases')}>{t('admin.modules.projects.disputesLink')}</NextLink>
          </p>
        </Panel>
      </div>
      <Panel id="projects-reports" title={t('admin.modules.projects.reports')}>
        {projects.reports.length ? (
          <ul className="admin-list">
            {projects.reports.map((r) => (
              <li key={r.id} className="admin-list__row">
                <span lang={r.title.lang}>{r.title.text}</span>
                <span className="admin-meta">
                  {tDynamic(`admin.modules.projects.reasons.${r.reason}`, r.reason)} · {dateTime(r.at, zone)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.modules.projects.noReports')}</Empty>
        )}
        {projects.reports.length ? (
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('projects.hold')} labels={formLabels({ submit: t('admin.modules.projects.hold') })} disabledReason={readOnlyReason(ctx.can('admin.publications.hold'), ctx.offline)}>
            <SelectField name="reportId" label={t('admin.modules.projects.report')} options={projects.reports.map((r) => ({ value: r.id, label: r.id }))} />
            <p className="admin-note">{t('admin.modules.projects.holdNote')}</p>
          </ConsoleForm>
        ) : null}
      </Panel>
      <Panel id="projects-edit" title={t('admin.modules.projects.edit')}>
        <ConsoleForm action={submitConsoleCommand} hidden={versioned(ctx, 'projects.policy.save', projects.version)} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.hub.modes.edit'), ctx.offline)}>
          <div className="admin-form__grid">
            <SelectField
              name="publishingAllowed"
              label={t('admin.modules.projects.publishing')}
              defaultValue={projects.publishingAllowed ? 'on' : 'off'}
              options={[
                { value: 'on', label: t('admin.common.on') },
                { value: 'off', label: t('admin.common.off') },
              ]}
            />
            <SelectField name="field" label={t('admin.modules.projects.field')} options={PROJECT_PUBLIC_FIELDS.map((f) => ({ value: f, label: field(f) }))} />
            <SelectField
              name="include"
              label={t('admin.modules.projects.fieldAction')}
              options={[
                { value: 'false', label: t('admin.modules.projects.exclude') },
                { value: 'true', label: t('admin.modules.projects.include') },
              ]}
            />
          </div>
          <p className="admin-note">{t('admin.modules.projects.narrowerOnly')}</p>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-60 Projects: project publishing policy (narrower than the engine only), counts and reports, never private projects. */
export const screen: Screen = { group: 'modules', id: 'projects', title: () => t('admin.modules.projects.title'), render: Projects };
