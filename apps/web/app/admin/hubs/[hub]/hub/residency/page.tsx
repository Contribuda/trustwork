import type { Metadata } from 'next';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext, HubParams, PageSearchParams } from '../../../../_components/context';
import { formLabels, readOnlyReason, TextInput } from '../../../../_components/forms';
import { country } from '../../../../_components/format';
import { ConsoleHeader, HubConsolePage, KeyValues, Panel } from '../../../../_components/shell';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('admin.hub.residency.title') };
}

async function Residency(ctx: HubContext) {
  const residency = await ctx.port.residency(ctx.record.hub.id);
  const contradictions = residency ? residency.services.filter((s) => s.country !== residency.country) : [];
  const privateOutside = residency ? residency.subProcessors.filter((p) => p.privateData && p.country !== residency.country) : [];
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.residency.title')} lede={t('admin.hub.residency.lede')} />
      {!residency ? (
        <p className="admin-empty">{t('admin.hub.residency.none')}</p>
      ) : (
        <>
          {contradictions.length ? (
            <p className="admin-callout admin-callout--warning" role="note" data-testid="residency-contradiction">
              {t('admin.hub.residency.contradiction', { services: contradictions.map((s) => tDynamic(`admin.hub.residency.services.${s.service}`, s.service)).join(', '), country: country(residency.country) })}
            </p>
          ) : null}
          {privateOutside.length ? (
            <p className="admin-callout admin-callout--danger" role="alert">
              {t('admin.hub.residency.privateOutside')}
            </p>
          ) : null}
          <div className="admin-grid">
            <Panel id="decision" title={t('admin.hub.residency.decision')}>
              <KeyValues
                rows={[
                  { label: t('admin.hub.residency.country'), value: country(residency.country) },
                  { label: t('admin.hub.residency.regime'), value: tDynamic(`admin.hub.residency.regimes.${residency.regime}`, residency.regime) },
                  { label: t('admin.hub.residency.version'), value: t('admin.common.version', { version: residency.version }) },
                ]}
              />
            </Panel>
            <Panel id="services" title={t('admin.hub.residency.servicesTitle')}>
              <table className="plain-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.hub.residency.service')}</th>
                    <th scope="col">{t('admin.hub.residency.region')}</th>
                    <th scope="col">{t('admin.hub.residency.country')}</th>
                  </tr>
                </thead>
                <tbody>
                  {residency.services.map((s) => (
                    <tr key={s.service}>
                      <td data-label={t('admin.hub.residency.service')}>{tDynamic(`admin.hub.residency.services.${s.service}`, s.service)}</td>
                      <td data-label={t('admin.hub.residency.region')}>
                        <code className="admin-code">{s.region}</code>
                      </td>
                      <td data-label={t('admin.hub.residency.country')}>
                        {country(s.country)}
                        {s.country !== residency.country ? <span className="admin-warning"> · {t('admin.hub.residency.outside')}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
          <Panel id="subprocessors" title={t('admin.hub.residency.subProcessors')}>
            <p className="admin-meta">{t('admin.hub.residency.subProcessorsNote')}</p>
            <table className="plain-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.hub.residency.processor')}</th>
                  <th scope="col">{t('admin.hub.residency.capability')}</th>
                  <th scope="col">{t('admin.hub.residency.mode')}</th>
                  <th scope="col">{t('admin.hub.residency.country')}</th>
                  <th scope="col">{t('admin.hub.residency.privateData')}</th>
                </tr>
              </thead>
              <tbody>
                {residency.subProcessors.map((p) => (
                  <tr key={p.name}>
                    <td data-label={t('admin.hub.residency.processor')} lang="en">
                      {p.name}
                    </td>
                    <td data-label={t('admin.hub.residency.capability')}>{tDynamic(`admin.capabilities.${p.capability}`, p.capability)}</td>
                    <td data-label={t('admin.hub.residency.mode')}>{t(`admin.providerMode.${p.mode}`)}</td>
                    <td data-label={t('admin.hub.residency.country')}>{country(p.country)}</td>
                    <td data-label={t('admin.hub.residency.privateData')}>{t(p.privateData ? 'admin.common.yes' : 'admin.common.no')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
      <Panel id="change-residency" title={t('admin.hub.residency.change')}>
        <ConsoleForm
          action={submitConsoleCommand}
          hidden={ctx.hidden('residency.request_change')}
          labels={formLabels({ submit: t('admin.hub.residency.requestChange'), secondPerson: true })}
          disabledReason={readOnlyReason(ctx.can('admin.hub.residency.edit'), ctx.offline)}
        >
          <TextInput name="country" label={t('admin.hub.residency.newCountry')} description={t('admin.hub.residency.newCountryHelp')} isRequired />
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-14 Residency and sub-processors: where personal data lives and who processes it; changes need a second person. */
export default async function ResidencyPage({ params, searchParams }: { params: HubParams; searchParams: PageSearchParams }) {
  return (
    <HubConsolePage params={params} searchParams={searchParams} section={{ group: 'hub', id: 'residency' }}>
      {(ctx) => Residency(ctx)}
    </HubConsolePage>
  );
}
