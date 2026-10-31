import type { Metadata } from 'next';
import { getPack, regionName } from '@trustwork/country-packs';
import type { HubTerritory } from '@trustwork/contracts/client';
import { currentLocale, t } from '@/app/_lib/i18n';
import { appLocales, coverage } from '@/app/_lib/locale-data';
import { primeLocale } from '@/app/_lib/locale';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext, HubParams, PageSearchParams } from '../../../../_components/context';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { country, languageName } from '../../../../_components/format';
import { ConsoleHeader, HubConsolePage, KeyValues, Panel } from '../../../../_components/shell';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('admin.hub.identity.title') };
}

/** A territory's display name: the country from `Intl`, a region from its pack (with the pack's language), a place by its key. */
function territoryName(territory: HubTerritory): { text: string; lang?: string; code?: boolean } {
  const code = territory.code;
  if (territory.level === 'country') return { text: country(code) };
  const region = code.split(':')[0]!;
  const pack = getPack(code.slice(0, 2));
  if (territory.level === 'region') {
    if (!pack) return { text: region };
    const name = regionName(pack, region, currentLocale());
    const own = pack.regions.find((r) => r.code === region)?.name;
    return { text: name, lang: own && own[currentLocale()] ? currentLocale() : 'en' };
  }
  return { text: code.split(':')[1] ?? code, code: true };
}

async function Identity(ctx: HubContext) {
  const { record } = ctx;
  const hub = record.hub;
  const brand = await ctx.port.brandChecks(hub.id);
  const engine = appLocales();
  const canEdit = ctx.can('admin.hub.identity.edit');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.identity.title')} lede={t('admin.hub.identity.lede')} />
      <div className="admin-grid">
        <Panel id="names" title={t('admin.hub.identity.names')}>
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.hub.identity.language')}</th>
                <th scope="col">{t('admin.hub.identity.name')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(hub.name).map(([tag, name]) => (
                <tr key={tag}>
                  <td data-label={t('admin.hub.identity.language')}>{languageName(tag)}</td>
                  <td data-label={t('admin.hub.identity.name')} lang={tag}>
                    {name}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel id="territories" title={t('admin.hub.identity.territories')}>
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.hub.identity.level')}</th>
                <th scope="col">{t('admin.hub.identity.code')}</th>
                <th scope="col">{t('admin.hub.identity.territoryName')}</th>
              </tr>
            </thead>
            <tbody>
              {hub.territories.map((territory) => {
                const name = territoryName(territory);
                return (
                  <tr key={territory.code}>
                    <td data-label={t('admin.hub.identity.level')}>{t(`admin.hub.identity.levels.${territory.level}`)}</td>
                    <td data-label={t('admin.hub.identity.code')}>
                      <code className="admin-code">{territory.code}</code>
                    </td>
                    <td data-label={t('admin.hub.identity.territoryName')} {...(name.lang ? { lang: name.lang } : {})}>
                      {name.code ? <code className="admin-code">{name.text}</code> : name.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="admin-meta">{t('admin.hub.identity.territoriesNote')}</p>
        </Panel>

        <Panel id="languages" title={t('admin.hub.identity.languages')}>
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.hub.identity.language')}</th>
                <th scope="col">{t('admin.hub.identity.completeness')}</th>
              </tr>
            </thead>
            <tbody>
              {hub.locales.map((tag) => {
                const known = engine.includes(tag);
                const c = known ? coverage(tag) : null;
                return (
                  <tr key={tag}>
                    <td data-label={t('admin.hub.identity.language')}>
                      {languageName(tag)}
                      {tag === hub.defaultLocale ? <span className="admin-meta"> · {t('admin.hub.identity.default')}</span> : null}
                    </td>
                    <td data-label={t('admin.hub.identity.completeness')}>
                      {c ? t('admin.hub.identity.percent', { percent: Math.floor((c.translated / Math.max(1, c.total)) * 100) }) : t('admin.hub.identity.notEngineLanguage')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel id="basics" title={t('admin.hub.identity.basics')}>
          <KeyValues
            rows={[
              { label: t('admin.hub.identity.currency'), value: <code className="admin-code">{hub.currency}</code> },
              { label: t('admin.hub.identity.timeZone'), value: <code className="admin-code">{hub.timeZone}</code> },
              { label: t('admin.hub.identity.domain'), value: <code className="admin-code">{record.domain}</code> },
              { label: t('admin.hub.identity.brand'), value: hub.brandOverlay ?? t('admin.hub.identity.noBrand') },
              { label: t('admin.hub.identity.revision'), value: t('admin.common.version', { version: hub.revision }) },
            ]}
          />
          {brand.length ? (
            <>
              <h3 className="admin-h3">{t('admin.hub.identity.contrast')}</h3>
              <ul className="admin-list">
                {brand.map((b) => (
                  <li key={b.locale}>
                    {languageName(b.locale)}: {t('admin.hub.identity.ratio', { ratio: b.ratio })} · {t(b.passes ? 'admin.hub.identity.contrastPass' : 'admin.hub.identity.contrastFail')}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Panel>
      </div>

      <Panel id="change" title={t('admin.hub.identity.change')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('identity.save')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
          <TextInput name="addTerritory" label={t('admin.hub.identity.addTerritory')} description={t('admin.hub.identity.addTerritoryHelp')} />
          <SelectField
            name="defaultLocale"
            label={t('admin.hub.identity.defaultLanguage')}
            defaultValue={hub.defaultLocale}
            options={hub.locales.map((tag) => ({ value: tag, label: languageName(tag) }))}
          />
        </ConsoleForm>
      </Panel>
      <p className="admin-meta">{t('admin.hub.identity.versionsNote')}</p>
    </>
  );
}

/** HC-10 Identity and territory: who and where the hub is; changes become a new configuration version. */
export default async function IdentityPage({ params, searchParams }: { params: HubParams; searchParams: PageSearchParams }) {
  return (
    <HubConsolePage params={params} searchParams={searchParams} section={{ group: 'hub', id: 'identity' }}>
      {(ctx) => Identity(ctx)}
    </HubConsolePage>
  );
}
