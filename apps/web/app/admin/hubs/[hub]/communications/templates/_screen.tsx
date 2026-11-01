import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason } from '../../../../_components/forms';
import { languageName, list } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Empty, loadProduct, StatePill, UniqueSelect } from '../../modules/_kit/parts';

const templateName = (key: string) => tDynamic(`admin.communications.templates.names.${key}`, key);

async function Templates(ctx: HubContext) {
  const { communications } = await loadProduct(ctx);
  const locales = ctx.record.hub.locales;
  const canEdit = ctx.can('admin.notifications.template.edit');
  const options = communications.templates.map((x) => ({ value: x.key, label: templateName(x.key) }));
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.communications.templates.title')} lede={t('admin.communications.templates.lede')} />
      <Panel id="templates" title={t('admin.communications.templates.list')}>
        {communications.templates.length ? (
          <ul className="admin-approvals">
            {communications.templates.map((x) => {
              const missing = locales.filter((l) => !x.locales.includes(l));
              return (
                <li key={x.key} className="admin-approval" data-testid={`template-${x.key}`}>
                  <div className="admin-panel__head">
                    <h3 className="admin-h3">{templateName(x.key)}</h3>
                    <StatePill state={x.status} />
                  </div>
                  <p className="admin-meta">
                    {tDynamic(`admin.communications.templates.categories.${x.category}`, x.category)} · {tDynamic(`admin.communications.channels.${x.channel}`, x.channel)} · {t('admin.common.version', { version: x.version })} · {list(x.locales.map(languageName))}
                  </p>
                  <p>
                    {t('admin.communications.templates.preview')} <q lang={x.preview.lang}>{x.preview.text}</q>
                  </p>
                  {missing.length ? (
                    <p className="admin-callout admin-callout--warning" data-testid="template-language-missing">
                      {t('admin.communications.templates.missing', { items: list(missing.map(languageName)) })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{t('admin.communications.templates.none')}</Empty>
        )}
        <p className="admin-note">{t('admin.communications.templates.synthetic')}</p>
      </Panel>
      {options.length ? (
        <div className="admin-grid">
          <Panel id="template-edit" title={t('admin.communications.templates.edit')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('comms.template.save')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
              <UniqueSelect id="edit-template" name="templateKey" label={t('admin.communications.templates.template')} options={options} />
              <UniqueSelect id="edit-lang" name="lang" label={t('admin.communications.templates.language')} options={locales.map((l) => ({ value: l, label: languageName(l) }))} />
            </ConsoleForm>
          </Panel>
          <Panel id="template-activate" title={t('admin.communications.templates.activate')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('comms.template.activate')} labels={formLabels({ submit: t('admin.communications.templates.activate') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
              <UniqueSelect id="activate-template" name="templateKey" label={t('admin.communications.templates.template')} options={options} />
              <p className="admin-note">{t('admin.communications.templates.activateNote')}</p>
            </ConsoleForm>
          </Panel>
        </div>
      ) : null}
    </>
  );
}

/** HC-121 Templates: message templates by category with versions and languages; activation is blocked while a hub language is missing. */
export const screen: Screen = { group: 'communications', id: 'templates', title: () => t('admin.communications.templates.title'), render: Templates };
