import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { localized } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, Empty, loadProduct, StatePill, WideScreenNote, yesNo } from '../_kit/parts';

async function Planner(ctx: HubContext) {
  const { planner } = (await loadProduct(ctx)).modules;
  const people = await ctx.port.people([...new Set(planner.templates.flatMap(({ template }) => [...template.authors, ...(template.reviewedBy ? [template.reviewedBy] : [])]))]);
  const names = (ids: readonly string[]) =>
    ids.map((id, i) => {
      const person = people.find((p) => p.id === id);
      return (
        <span key={id}>
          {i ? ', ' : ''}
          {person ? <span lang={person.nameLang}>{person.displayName}</span> : t('admin.common.unknownPerson')}
        </span>
      );
    });
  const inReview = planner.templates.filter(({ template }) => template.status === 'in_review');
  const published = planner.templates.filter(({ template }) => template.status === 'published');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.planner.title')} lede={t('admin.modules.planner.lede')} />
      {planner.blocked.map((b) => (
        <p key={`${b.templateKey}-${b.version}`} className="admin-callout admin-callout--warning" role="note" data-testid="template-blocked">
          {t(b.problem === 'cycle' ? 'admin.modules.planner.blockedCycle' : 'admin.modules.planner.blockedMissing', { template: b.templateKey, item: b.itemKey })}
        </p>
      ))}
      <Panel id="templates" title={t('admin.modules.planner.templates')}>
        {planner.templates.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.modules.planner.template')}</th>
                <th scope="col">{t('admin.modules.planner.countryType')}</th>
                <th scope="col">{t('admin.modules.planner.status')}</th>
                <th scope="col">{t('admin.modules.planner.people')}</th>
                <th scope="col">{t('admin.modules.planner.usage')}</th>
              </tr>
            </thead>
            <tbody>
              {planner.templates.map(({ template, plansCreated, itemsTurnedIntoRequestsPercent }) => {
                const title = localized(template.title, [ctx.record.hub.defaultLocale]);
                return (
                  <tr key={template.id}>
                    <td data-label={t('admin.modules.planner.template')}>
                      <span lang={title.lang}>{title.text}</span>
                      <span className="admin-meta"> · {t('admin.common.version', { version: template.version })}</span>
                    </td>
                    <td data-label={t('admin.modules.planner.countryType')}>
                      {template.countryCode ?? t('admin.common.none')} · <code className="admin-code">{template.projectType}</code>
                    </td>
                    <td data-label={t('admin.modules.planner.status')}>
                      <StatePill state={template.status} />
                    </td>
                    <td data-label={t('admin.modules.planner.people')}>
                      {t('admin.modules.planner.authors')} {names(template.authors)}
                      {template.reviewedBy ? (
                        <span className="admin-meta">
                          {' · '}
                          {t('admin.modules.planner.reviewer')} {names([template.reviewedBy])}
                        </span>
                      ) : null}
                    </td>
                    <td data-label={t('admin.modules.planner.usage')}>
                      <Cohort value={plansCreated} /> {t('admin.modules.planner.plans')}
                      {itemsTurnedIntoRequestsPercent !== null ? <span className="admin-meta"> · {t('admin.modules.planner.requestsShare', { percent: itemsTurnedIntoRequestsPercent })}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.modules.planner.noTemplates')}</Empty>
        )}
      </Panel>
      {published.concat(inReview).map(({ template }) => {
        const title = localized(template.title, [ctx.record.hub.defaultLocale]);
        return (
          <Panel key={template.id} id={`tree-${template.key}`} title={title.text} titleLang={title.lang} level={2}>
            <WideScreenNote />
            <ol className="admin-tree" aria-label={t('admin.modules.planner.phases')}>
              {template.phases.map((phase) => {
                const phaseTitle = localized(phase.title, [ctx.record.hub.defaultLocale]);
                return (
                  <li key={phase.key}>
                    <span lang={phaseTitle.lang}>{phaseTitle.text}</span>
                    <ul className="admin-tree admin-tree--nested">
                      {phase.items.map((item) => {
                        const itemTitle = localized(item.title, [ctx.record.hub.defaultLocale]);
                        return (
                          <li key={item.key}>
                            <span lang={itemTitle.lang}>{itemTitle.text}</span>
                            <span className="admin-meta">
                              {' · '}
                              {tDynamic(`admin.modules.planner.kinds.${item.kind}`, item.kind)}
                              {item.licenceCategory ? <> · <span lang="en">{item.licenceCategory}</span></> : null}
                              {item.typicalDurationDays !== null ? ` · ${t('admin.modules.planner.days', { count: item.typicalDurationDays })}` : null}
                              {item.dependsOn.length ? (
                                <>
                                  {' · '}
                                  {t('admin.modules.planner.after')} <code className="admin-code">{item.dependsOn.join(', ')}</code>
                                </>
                              ) : null}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ol>
            {template.references.length ? (
              <ul className="admin-list">
                {template.references.map((r) => (
                  <li key={r.url}>
                    <a href={r.url} rel="noopener noreferrer" target="_blank" lang="en">
                      {r.label}
                    </a>
                    <span className="admin-visually-hidden"> {t('admin.common.opensNewTab')}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="admin-note">{t('admin.modules.planner.notLegalAdvice')}</p>
          </Panel>
        );
      })}
      <div className="admin-grid">
        <Panel id="planner-review" title={t('admin.modules.planner.review')}>
          {inReview.length || published.length ? (
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('planner.publish')} labels={formLabels({ submit: t('admin.modules.planner.publish') })} disabledReason={readOnlyReason(ctx.can('admin.planner.templates.publish'), ctx.offline)}>
              <SelectField name="templateId" label={t('admin.modules.planner.template')} options={[...inReview, ...published].map(({ template }) => ({ value: template.id, label: `${template.key} ${template.version}` }))} />
              <p className="admin-note">{t('admin.modules.planner.notByAuthor')}</p>
            </ConsoleForm>
          ) : (
            <Empty>{t('admin.modules.planner.nothingInReview')}</Empty>
          )}
        </Panel>
        <Panel id="planner-draft" title={t('admin.modules.planner.draft')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('planner.draft')} labels={formLabels({ submit: t('admin.modules.planner.draft') })} disabledReason={readOnlyReason(ctx.can('admin.planner.templates.edit'), ctx.offline)}>
            <TextInput name="templateKey" label={t('admin.modules.planner.templateKey')} description={t('admin.modules.planner.keyHelp')} isRequired />
            <TextInput name="projectType" label={t('admin.modules.planner.projectType')} description={t('admin.modules.planner.keyHelp')} isRequired />
          </ConsoleForm>
        </Panel>
      </div>
      <Panel id="planner-settings" title={t('admin.modules.planner.settings')}>
        <KeyValues
          rows={[
            { label: t('admin.modules.planner.addItems'), value: yesNo(planner.adaptation.addItems) },
            { label: t('admin.modules.planner.removeItems'), value: yesNo(planner.adaptation.removeItems) },
            { label: t('admin.modules.planner.reorder'), value: yesNo(planner.adaptation.reorder) },
            { label: t('admin.modules.planner.feedback'), value: planner.feedback },
          ]}
        />
        <p className="admin-note">{t('admin.modules.planner.ownerConfirms')}</p>
      </Panel>
    </>
  );
}

/** HC-61 Planner: plan templates per country and project type, reviewed and published by someone who is not an author. */
export const screen: Screen = { group: 'modules', id: 'planner', title: () => t('admin.modules.planner.title'), render: Planner };
