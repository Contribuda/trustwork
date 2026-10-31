import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { LEGAL_DOCUMENT_KINDS } from '../../../../_data/schemas';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { languageName, list, longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';

async function Legal(ctx: HubContext) {
  const { operator, documents } = await ctx.port.legal(ctx.record.hub.id);
  const locales = ctx.record.hub.locales;
  const activatable = documents.filter((d) => d.status === 'counsel_approved');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.legal.title')} lede={t('admin.hub.legal.lede')} />
      <Panel id="operator" title={t('admin.hub.legal.operator')}>
        {operator ? (
          <KeyValues
            rows={[
              { label: t('admin.hub.legal.legalName'), value: operator.legalName, lang: 'en' },
              { label: t('admin.hub.legal.form'), value: tDynamic(`admin.hub.legal.forms.${operator.form}`, operator.form) },
              { label: t('admin.hub.legal.identifier'), value: <code className="admin-code">{`${operator.identifier.kind} ${operator.identifier.value}`}</code> },
              { label: t('admin.hub.legal.address'), value: operator.address, lang: 'en' },
              { label: t('admin.hub.legal.legalContact'), value: <code className="admin-code">{operator.legalContact}</code> },
              { label: t('admin.hub.legal.abuseContact'), value: <code className="admin-code">{operator.abuseContact}</code> },
              {
                label: t('admin.hub.legal.screening'),
                value: `${tDynamic(`admin.hub.legal.screeningResult.${operator.screening.result}`, operator.screening.result)} · ${t(operator.screening.mode === 'fake' ? 'admin.hub.legal.fakeScreening' : 'admin.common.none')}`,
              },
            ]}
          />
        ) : (
          <p className="admin-empty">{t('admin.hub.legal.noOperator')}</p>
        )}
      </Panel>
      <Panel id="documents" title={t('admin.hub.legal.documents')}>
        {documents.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.hub.legal.kind')}</th>
                <th scope="col">{t('admin.hub.legal.version')}</th>
                <th scope="col">{t('admin.hub.legal.status')}</th>
                <th scope="col">{t('admin.hub.legal.languages')}</th>
                <th scope="col">{t('admin.hub.legal.counsel')}</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => {
                const missing = locales.filter((l) => !d.locales.includes(l));
                return (
                  <tr key={d.id}>
                    <td data-label={t('admin.hub.legal.kind')}>{tDynamic(`admin.hub.legal.kinds.${d.kind}`, d.kind)}</td>
                    <td data-label={t('admin.hub.legal.version')}>{d.version}</td>
                    <td data-label={t('admin.hub.legal.status')}>
                      {tDynamic(`admin.hub.legal.statuses.${d.status}`, d.status)}
                      {d.effectiveFrom ? <span className="admin-meta"> · {t('admin.hub.legal.effective', { date: longDate(d.effectiveFrom) })}</span> : null}
                    </td>
                    <td data-label={t('admin.hub.legal.languages')}>
                      {list(d.locales.map(languageName))}
                      {missing.length && d.status !== 'superseded' ? <span className="admin-warning"> · {t('admin.hub.legal.missing', { items: list(missing.map(languageName)) })}</span> : null}
                    </td>
                    <td data-label={t('admin.hub.legal.counsel')}>
                      {d.counselApproval ? (
                        <>
                          <span lang="en">{`${d.counselApproval.by}, ${d.counselApproval.firm}`}</span>
                          <span className="admin-meta"> · {longDate(d.counselApproval.at)}</span>
                        </>
                      ) : (
                        t('admin.hub.legal.noCounsel')
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="admin-empty">{t('admin.hub.legal.noDocuments')}</p>
        )}
      </Panel>
      <div className="admin-grid">
        <Panel id="activate" title={t('admin.hub.legal.requestActivation')}>
          {activatable.length ? (
            <ConsoleForm
              action={submitConsoleCommand}
              hidden={ctx.hidden('legal.request_activation')}
              labels={formLabels({ submit: t('admin.hub.legal.requestActivation'), secondPerson: true })}
              disabledReason={readOnlyReason(ctx.can('admin.hub.legal.activate'), ctx.offline)}
            >
              <SelectField
                name="documentId"
                label={t('admin.hub.legal.document')}
                options={activatable.map((d) => ({ value: d.id, label: `${tDynamic(`admin.hub.legal.kinds.${d.kind}`, d.kind)} ${d.version}` }))}
              />
            </ConsoleForm>
          ) : (
            <p className="admin-empty">{t('admin.hub.legal.nothingToActivate')}</p>
          )}
        </Panel>
        <Panel id="draft" title={t('admin.hub.legal.draft')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('legal.draft')} labels={formLabels({ submit: t('admin.hub.legal.draft') })} disabledReason={readOnlyReason(ctx.can('admin.hub.legal.edit'), ctx.offline)}>
            <SelectField name="kind" label={t('admin.hub.legal.kind')} options={LEGAL_DOCUMENT_KINDS.map((k) => ({ value: k, label: tDynamic(`admin.hub.legal.kinds.${k}`, k) }))} />
            <p className="admin-note">{t('admin.hub.legal.templatesNote')}</p>
          </ConsoleForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-13 Legal and operator: the operator record and the documents participants accept, activated only with counsel approval and every language. */
export const screen: Screen = { group: 'hub', id: 'legal', title: () => t('admin.hub.legal.title'), render: Legal };
