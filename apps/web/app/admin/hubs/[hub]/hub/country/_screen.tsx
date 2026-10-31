import { getPack } from '@trustwork/country-packs';
import { currentLocale, t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { country, localized, number } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, StatusLabel } from '../../../../_components/shell';

const KINDS = ['identifier', 'register', 'licence_category', 'holiday', 'tax_fact', 'unit'] as const;

async function Country(ctx: HubContext) {
  const hub = ctx.record.hub;
  const binding = hub.countryPack;
  const pack = binding ? getPack(binding.code) : null;
  const additions = await ctx.port.localAdditions(hub.id);
  const identifierLabel = pack ? localized(pack.registrationIdentifier.label) : null;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.country.title')} lede={t('admin.hub.country.lede')} />
      <div className="admin-grid">
        <Panel id="binding" title={t('admin.hub.country.binding')}>
          {binding && pack ? (
            <KeyValues
              rows={[
                { label: t('admin.hub.country.pack'), value: t('admin.hub.country.packVersion', { country: country(binding.code), version: binding.version }) },
                { label: t('admin.hub.country.packStatus'), value: tDynamic(`admin.hub.country.packStatuses.${pack.status}`, pack.status) },
                { label: t('admin.hub.country.identifier'), value: identifierLabel ? <span lang={identifierLabel.lang}>{identifierLabel.text}</span> : null },
                { label: t('admin.hub.country.identifierKind'), value: <code className="admin-code">{pack.registrationIdentifier.kind}</code> },
                { label: t('admin.hub.country.currency'), value: <code className="admin-code">{pack.currency.code}</code> },
                { label: t('admin.hub.country.regions'), value: number(pack.regions.length) },
                { label: t('admin.hub.country.entityTypes'), value: number(pack.legalEntityTypes.length) },
                { label: t('admin.hub.country.residencyRequired'), value: t(pack.dataResidency.required ? 'admin.common.yes' : 'admin.common.no') },
              ]}
            />
          ) : (
            <p>{t('admin.hub.country.generic')}</p>
          )}
          <p className="admin-meta">{t('admin.hub.country.sourcesNote')}</p>
          {pack ? (
            <p className="admin-meta" lang={pack.dataResidency.note[currentLocale()] ? currentLocale() : 'en'}>
              {pack.dataResidency.note[currentLocale()] ?? pack.dataResidency.note.en}
            </p>
          ) : null}
        </Panel>

        <Panel id="additions" title={t('admin.hub.country.additions')} aside={<StatusLabel status="demo" />}>
          {additions.length ? (
            <table className="plain-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.hub.country.kind')}</th>
                  <th scope="col">{t('admin.hub.country.label')}</th>
                  <th scope="col">{t('admin.hub.country.verification')}</th>
                </tr>
              </thead>
              <tbody>
                {additions.map((a) => {
                  const name = localized(a.label, [hub.defaultLocale]);
                  return (
                    <tr key={a.key}>
                      <td data-label={t('admin.hub.country.kind')}>{tDynamic(`admin.hub.country.kinds.${a.kind}`, a.kind)}</td>
                      <td data-label={t('admin.hub.country.label')}>
                        {a.source ? (
                          <a href={a.source} rel="noopener noreferrer" target="_blank" lang={name.lang}>
                            {name.text}
                            <span className="admin-visually-hidden"> {t('admin.common.opensNewTab')}</span>
                          </a>
                        ) : (
                          <span lang={name.lang}>{name.text}</span>
                        )}{' '}
                        <code className="admin-code">{a.key}</code>
                      </td>
                      <td data-label={t('admin.hub.country.verification')}>{tDynamic(`admin.hub.country.levels.${a.verification}`, a.verification)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="admin-empty">{t('admin.hub.country.noAdditions')}</p>
          )}
          <p className="admin-meta">
            {t('admin.hub.country.export')} <StatusLabel status="designed" />
          </p>
        </Panel>
      </div>
      <Panel id="add-addition" title={t('admin.hub.country.add')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('country.add_addition')} labels={formLabels({ submit: t('admin.hub.country.add') })} disabledReason={readOnlyReason(ctx.can('admin.hub.country.edit'), ctx.offline)}>
          <div className="admin-form__grid">
            <SelectField name="kind" label={t('admin.hub.country.kind')} options={KINDS.map((k) => ({ value: k, label: tDynamic(`admin.hub.country.kinds.${k}`, k) }))} />
            <TextInput name="key" label={t('admin.hub.country.key')} description={t('admin.hub.country.keyHelp')} isRequired />
            <TextInput name="label" label={t('admin.hub.country.label')} isRequired />
          </div>
          <p className="admin-note">{t('admin.hub.country.candidateNote')}</p>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-15 Country base: the bound country pack (or generic profile) and the hub's local additions, each a candidate until confirmed. */
export const screen: Screen = { group: 'hub', id: 'country', title: () => t('admin.hub.country.title'), render: Country };
