import { t } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { TextInput } from '../../../../_components/forms';
import { languageName, list } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Pill, Table } from '../../participants/_kit';
import { loadOutreach, MessagePreviewCard, OutreachBanner, OutreachForm, purposeName, stateName } from '../_kit/parts';

function Templates(ctx: HubContext) {
  const view = loadOutreach(ctx);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.templates.title')} lede={t('adminOutreach.templates.lede')} />
      <OutreachBanner view={view} />
      <Panel id="templates" title={t('adminOutreach.templates.list')}>
        <Table
          testid="templates"
          rows={view.templates}
          rowKey={(x) => x.key}
          empty={t('adminOutreach.templates.none')}
          columns={[
            { label: t('adminOutreach.campaigns.purpose'), render: (x) => purposeName(x.purpose) },
            { label: t('adminOutreach.common.versionLabel'), render: (x) => t('adminOutreach.common.version', { version: x.version }) },
            { label: t('adminOutreach.common.state'), render: (x) => <Pill tone={x.state === 'active' ? 'pass' : 'neutral'}>{stateName(x.state)}</Pill> },
            { label: t('adminOutreach.templates.languages'), render: (x) => list(x.locales.map(languageName)) },
            { label: t('adminOutreach.templates.missing'), render: (x) => (x.missingLocales.length ? <span className="admin-warning">{list(x.missingLocales.map(languageName))}</span> : t('admin.common.none')) },
          ]}
        />
      </Panel>
      {view.templates.map((x) => (
        <Panel key={x.key} id={`template-${x.key}`} title={purposeName(x.purpose)}>
          <p className="admin-note">{t('adminOutreach.templates.syntheticPreview')}</p>
          <MessagePreviewCard preview={x.preview} />
          <OutreachForm ctx={ctx} command="outreach.template_edit" fields={{ template: x.key }} submit={t('adminOutreach.templates.saveBody')} can={['admin.notifications.template.edit']} variant="secondary">
            <TextInput name="body" label={t('adminOutreach.templates.body')} description={t('adminOutreach.templates.bodyHelp')} defaultValue={x.preview.blocks.find((b) => b.kind === 'body')?.text ?? ''} />
          </OutreachForm>
          <OutreachForm
            ctx={ctx}
            command="outreach.template_request_activation"
            fields={{ template: x.key }}
            submit={t('adminOutreach.templates.requestActivation')}
            can={['admin.notifications.template.edit']}
            secondPerson
            blocked={x.missingLocales.length ? t('adminOutreach.errors.locale_missing') : null}
          />
        </Panel>
      ))}
    </>
  );
}

/** HC-173 Templates: outreach templates per purpose and language; locked blocks; a missing hub language blocks activation. */
export const screen: Screen = { group: 'outreach', id: 'templates', title: () => t('adminOutreach.templates.title'), render: Templates };
