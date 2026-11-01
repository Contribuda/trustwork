import { t } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, Empty, GuardRails, loadProduct, onOff, StatePill } from '../_kit/parts';

async function Matching(ctx: HubContext) {
  const { matching } = (await loadProduct(ctx)).modules;
  const drafts = matching.methods.filter((m) => m.status === 'draft');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.matching.title')} lede={t('admin.modules.matching.lede')} />
      <div className="admin-grid">
        <Panel id="matching-counts" title={t('admin.modules.matching.counts')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.matching.needsPublished'), value: <Cohort value={matching.counts.needsPublished} /> },
              { label: t('admin.modules.matching.needsFilled'), value: <Cohort value={matching.counts.needsFilled} /> },
              { label: t('admin.modules.matching.introductionsRequested'), value: <Cohort value={matching.counts.introductionsRequested} /> },
              { label: t('admin.modules.matching.introductionsAccepted'), value: <Cohort value={matching.counts.introductionsAccepted} /> },
              { label: t('admin.modules.matching.reports'), value: matching.reports },
            ]}
          />
        </Panel>
        <Panel id="matching-settings" title={t('admin.modules.matching.settings')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.matching.quota'), value: t('admin.modules.matching.perWeek', { count: matching.introductionsPerPersonPerWeek }) },
              { label: t('admin.modules.matching.needsBoard'), value: onOff(matching.needsBoard) },
              { label: t('admin.modules.matching.crossBorder'), value: onOff(matching.crossBorderInterest) },
            ]}
          />
          <p className="admin-note">{t('admin.modules.matching.quotaShared')}</p>
        </Panel>
      </div>
      <Panel id="matching-methods" title={t('admin.modules.matching.methods')}>
        {matching.methods.length ? (
          <ul className="admin-list">
            {matching.methods.map((m) => (
              <li key={m.version} className="admin-list__row">
                <span>
                  {t('admin.common.version', { version: m.version })} · <span lang={m.explanation.lang}>{m.explanation.text}</span>
                </span>
                <span className="admin-meta">{m.releasedAt ? longDate(m.releasedAt) : ''}</span>
                <StatePill state={m.status} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.modules.matching.noMethods')}</Empty>
        )}
        {drafts.length ? (
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('matching.method.release')} labels={formLabels({ submit: t('admin.modules.matching.release') })} disabledReason={readOnlyReason(ctx.can('admin.matching.method.release'), ctx.offline)}>
            <SelectField name="version" label={t('admin.modules.matching.method')} options={drafts.map((m) => ({ value: String(m.version), label: t('admin.common.version', { version: m.version }) }))} />
          </ConsoleForm>
        ) : (
          <p className="admin-note">{t('admin.modules.matching.noDraftMethod')}</p>
        )}
      </Panel>
      <Panel id="matching-quota" title={t('admin.modules.matching.setQuota')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('matching.quota.save')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.matching.policy.edit'), ctx.offline)}>
          <TextInput name="introductionsPerPersonPerWeek" label={t('admin.modules.matching.quota')} defaultValue={String(matching.introductionsPerPersonPerWeek)} isRequired />
          <p className="admin-note">{t('admin.modules.matching.samePlans')}</p>
        </ConsoleForm>
      </Panel>
      <GuardRails only={['paymentNeutrality', 'privateData']} />
    </>
  );
}

/** HC-66 Matching: needs board, introduction quotas shared by people and their agents, released method versions; payment never changes the order. */
export const screen: Screen = { group: 'modules', id: 'matching', title: () => t('admin.modules.matching.title'), render: Matching };
