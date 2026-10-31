import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { TAXONOMY_KINDS, type TaxonomyTree } from '../../../../_data/schemas';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { localized, longDate } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';

/** Terms as nested lists (the tree pattern of the screen contract, readable at 375 px). */
function Terms({ tree, parent, hubLocale }: { tree: TaxonomyTree; parent: string | null; hubLocale: string }) {
  const terms = tree.terms.filter((term) => term.parent === parent);
  if (!terms.length) return null;
  return (
    <ul className={parent ? 'admin-tree admin-tree--nested' : 'admin-tree'}>
      {terms.map((term) => {
        const name = localized(term.label, [hubLocale]);
        return (
          <li key={term.key}>
            <span lang={name.lang}>{name.text}</span> <code className="admin-code">{term.key}</code>
            <span className="admin-meta"> · {t('admin.hub.taxonomy.usage', { count: term.usage })}</span>
            {term.deprecated ? <span className="admin-warning"> · {t('admin.hub.taxonomy.deprecated')}</span> : null}
            <Terms tree={tree} parent={term.key} hubLocale={hubLocale} />
          </li>
        );
      })}
    </ul>
  );
}

async function Taxonomy(ctx: HubContext) {
  const trees = await ctx.port.taxonomy(ctx.record.hub.id);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.taxonomy.title')} lede={t('admin.hub.taxonomy.lede')} />
      {trees.length ? (
        <div className="admin-grid">
          {trees.map((tree) => (
            <Panel key={tree.kind} id={`tree-${tree.kind}`} title={tDynamic(`admin.hub.taxonomy.kinds.${tree.kind}`, tree.kind)}>
              <p className="admin-meta">
                {t('admin.common.version', { version: tree.version })} · {tree.releasedAt ? t('admin.hub.taxonomy.released', { date: longDate(tree.releasedAt) }) : t('admin.hub.taxonomy.unreleased')} · {t('admin.hub.taxonomy.terms', { count: tree.terms.length })}
              </p>
              <Terms tree={tree} parent={null} hubLocale={ctx.record.hub.defaultLocale} />
            </Panel>
          ))}
        </div>
      ) : (
        <p className="admin-empty" data-testid="taxonomy-empty">
          {t('admin.hub.taxonomy.empty')}
        </p>
      )}
      <p className="admin-meta">{t('admin.hub.taxonomy.deprecateNote')}</p>
      <Panel id="add-term" title={t('admin.hub.taxonomy.add')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('taxonomy.add_term')} labels={formLabels({ submit: t('admin.hub.taxonomy.add') })} disabledReason={readOnlyReason(ctx.can('admin.taxonomy.edit'), ctx.offline)}>
          <div className="admin-form__grid">
            <SelectField name="kind" label={t('admin.hub.taxonomy.kind')} options={TAXONOMY_KINDS.map((k) => ({ value: k, label: tDynamic(`admin.hub.taxonomy.kinds.${k}`, k) }))} />
            <TextInput name="key" label={t('admin.hub.taxonomy.key')} description={t('admin.hub.taxonomy.keyHelp')} isRequired />
            <TextInput name="label" label={t('admin.hub.taxonomy.label')} isRequired />
          </div>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-16 Taxonomy and units: versioned trees of topics, categories, plan steps and units. */
export const screen: Screen = { group: 'hub', id: 'taxonomy', title: () => t('admin.hub.taxonomy.title'), render: Taxonomy };
