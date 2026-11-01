import { t } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, TextInput } from '../../../../_components/forms';
import { list, number } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, GuardRails, loadProduct, moduleName, onOff, yesNo } from '../../modules/_kit/parts';

async function ExternalAgents(ctx: HubContext) {
  const { external } = (await loadProduct(ctx)).agents;
  const mcp = external.mcp;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.agents.external.title')} lede={t('admin.agents.external.lede')} />
      <p className="admin-callout" role="note" data-testid="no-client-list">
        {t('admin.agents.external.noList')}
      </p>
      <div className="admin-grid">
        <Panel id="external-protocols" title={t('admin.agents.external.protocols')}>
          <KeyValues
            rows={[
              { label: t('admin.agents.external.mcp'), value: onOff(external.protocols.mcp) },
              { label: t('admin.agents.external.a2a'), value: onOff(external.protocols.a2a) },
              { label: t('admin.agents.external.clientsMcp'), value: <Cohort value={external.registeredClients.mcp} /> },
              { label: t('admin.agents.external.clientsA2a'), value: <Cohort value={external.registeredClients.a2a} /> },
              { label: t('admin.agents.external.modules'), value: external.modulesForExternalClients.length ? list(external.modulesForExternalClients.map(moduleName)) : t('admin.common.none') },
              { label: t('admin.agents.external.representatives'), value: yesNo(external.representativesMayUseExternalClients) },
            ]}
          />
        </Panel>
        <Panel id="external-limits" title={t('admin.agents.external.limits')}>
          <KeyValues
            rows={[
              { label: t('admin.agents.external.perMinute'), value: t('admin.agents.external.defaultMax', { value: external.rateLimits.defaultPerMinute, maximum: external.rateLimits.maximumPerMinute }) },
              { label: t('admin.agents.external.actionsPerDay'), value: t('admin.agents.external.defaultMax', { value: external.rateLimits.defaultActionsPerDay, maximum: external.rateLimits.maximumActionsPerDay }) },
            ]}
          />
          <p className="admin-note">{t('admin.agents.external.mandatesApply')}</p>
        </Panel>
      </div>
      <Panel id="mcp-policy" title={t('admin.agents.external.mcpPolicy')}>
        <KeyValues
          rows={[
            { label: t('admin.agents.external.endpointParticipant'), value: onOff(mcp.endpoints.participant) },
            { label: t('admin.agents.external.endpointPublic'), value: onOff(mcp.endpoints.public) },
            { label: t('admin.agents.external.endpointAdmin'), value: <>{onOff(mcp.endpoints.admin)} · {t('admin.agents.external.adminSecondPerson')}</> },
            { label: t('admin.agents.external.disabledTools'), value: mcp.disabledTools.length ? <code className="admin-code">{mcp.disabledTools.join(', ')}</code> : t('admin.common.none') },
            { label: t('admin.agents.external.trust'), value: t(mcp.clientTrust === 'any_https_client' ? 'admin.agents.external.anyHttps' : 'admin.agents.external.listedOnly') },
            { label: t('admin.agents.external.listedClients'), value: number(mcp.listedClients.length) },
            { label: t('admin.agents.external.dynamicRegistration'), value: onOff(mcp.dynamicRegistration) },
            { label: t('admin.agents.external.citedAnswers'), value: onOff(mcp.publicCitedAnswers) },
            { label: t('admin.agents.external.tokenLifetime'), value: t('admin.agents.external.seconds', { count: mcp.accessTokenTtlSeconds }) },
            { label: t('admin.agents.external.refreshLifetime'), value: t('admin.agents.external.days', { count: mcp.refreshAbsoluteDays }) },
            { label: t('admin.agents.external.rates'), value: t('admin.agents.external.ratesValue', { read: mcp.ratePerMinute.read, draft: mcp.ratePerMinute.draft, public: mcp.ratePerMinute.public, commits: mcp.commitsPerHour }) },
            { label: t('admin.agents.external.upload'), value: t('admin.agents.external.megabytes', { count: Math.round(mcp.maxUploadBytes / (1024 * 1024)) }) },
          ]}
        />
        <p className="admin-note">{t('admin.agents.external.tightenOnly')}</p>
      </Panel>
      <div className="admin-grid">
        <Panel id="external-edit" title={t('admin.agents.external.edit')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('external.save')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.agents.policy.edit') || ctx.can('admin.agents.clients.manage'), ctx.offline)}>
            <div className="admin-form__grid">
              <TextInput name="defaultPerMinute" label={t('admin.agents.external.defaultPerMinute')} defaultValue={String(external.rateLimits.defaultPerMinute)} isRequired />
              <TextInput name="maximumPerMinute" label={t('admin.agents.external.maximumPerMinute')} defaultValue={String(external.rateLimits.maximumPerMinute)} isRequired />
              <TextInput name="accessTokenTtlSeconds" label={t('admin.agents.external.tokenLifetime')} defaultValue={String(mcp.accessTokenTtlSeconds)} />
            </div>
          </ConsoleForm>
        </Panel>
        <Panel id="external-kill" title={t('admin.agents.external.kill')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('killswitch.engage', { 'f.scope': 'external_agent_api' })} labels={formLabels({ submit: t('admin.killSwitch.engageSubmit') })} submitVariant="danger" disabledReason={readOnlyReason(ctx.can('admin.agents.kill'), ctx.offline)}>
            <p className="admin-note">{t('admin.killSwitch.releaseNote')}</p>
          </ConsoleForm>
        </Panel>
      </div>
      <GuardRails only={['mandates', 'confirmations', 'noPerPersonAgents', 'privateData']} />
    </>
  );
}

/** HC-82 External agents: MCP and A2A access policy and client counts by protocol; no list of individual clients. */
export const screen: Screen = { group: 'agents', id: 'external', title: () => t('admin.agents.external.title'), render: ExternalAgents };
