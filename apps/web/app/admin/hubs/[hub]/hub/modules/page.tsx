import type { Metadata } from 'next';
import { HUB_MODULES, MODULE_DEPENDENCIES, type HubModule } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { submitConsoleCommand } from '../../../../_data/actions';
import type { SectionStatus } from '../../../../_data/sections';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext, HubParams, PageSearchParams } from '../../../../_components/context';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { list } from '../../../../_components/format';
import { ConsoleHeader, HubConsolePage, Panel, StatusLabel } from '../../../../_components/shell';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('admin.hub.modules.title') };
}

/**
 * How far each product module is built in the engine (docs/engine/status.md), shown beside its switch so an operator
 * never mistakes a designed module for a working one. Switching a module on in a hub does not build it.
 */
const ENGINE_STATUS: Record<HubModule, SectionStatus | 'live' | 'contract' | 'proposed'> = {
  publications: 'demo', magazine: 'demo', events: 'demo', learning: 'demo', matching: 'proposed', catalogue: 'contract', procurement: 'contract',
  sales: 'contract', execution_reputation: 'contract', agents: 'contract', external_agent_api: 'designed', search: 'demo', knowledge_answers: 'designed',
  communications: 'demo', billing: 'contract', federation: 'proposed', editorial_automation: 'proposed', data_mining: 'proposed', project_planner: 'proposed',
  expert_marketplace: 'proposed', shared_knowledge: 'proposed', reputation_passport: 'proposed', plan_recommendations: 'proposed',
};

const moduleName = (m: string) => tDynamic(`admin.hub.modules.names.${m}`, m);

function Modules(ctx: HubContext) {
  const enabled = new Set(ctx.record.modes.modules);
  const canEdit = ctx.can('admin.hub.modes.edit');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.hub.modules.title')} lede={t('admin.hub.modules.lede')} />
      <Panel id="module-list" title={t('admin.hub.modules.list')}>
        <ul className="admin-modules">
          {HUB_MODULES.map((m) => {
            const deps = MODULE_DEPENDENCIES[m] ?? [];
            const missing = deps.filter((d) => !enabled.has(d));
            const on = enabled.has(m);
            return (
              <li key={m} className="admin-module" data-testid={`module-${m}`}>
                <div className="admin-panel__head">
                  <h3 className="admin-h3">{moduleName(m)}</h3>
                  <span className={`admin-pill admin-pill--${on ? 'on' : 'off'}`}>{t(on ? 'admin.common.on' : 'admin.common.off')}</span>
                </div>
                <p className="admin-module__meta">
                  {t('admin.hub.modules.engine')} <StatusLabel status={ENGINE_STATUS[m]} />
                </p>
                {deps.length ? <p className="admin-meta">{t('admin.hub.modules.dependsOn', { items: list(deps.map(moduleName)) })}</p> : null}
                {!on && missing.length ? <p className="admin-note admin-note--disabled">{t('admin.hub.modules.needsFirst', { items: list(missing.map(moduleName)) })}</p> : null}
              </li>
            );
          })}
        </ul>
      </Panel>
      <Panel id="toggle-module" title={t('admin.hub.modules.change')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('modules.toggle')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
          <div className="admin-form__grid">
            <SelectField name="module" label={t('admin.hub.modules.module')} options={HUB_MODULES.map((m) => ({ value: m, label: moduleName(m) }))} />
            <SelectField
              name="enable"
              label={t('admin.hub.modules.action')}
              options={[
                { value: 'true', label: t('admin.hub.modules.enable') },
                { value: 'false', label: t('admin.hub.modules.disable') },
              ]}
            />
          </div>
          <p className="admin-note">{t('admin.hub.modules.disableNote')}</p>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-12 Modules: which product modules are on, what each depends on, and how far the engine has built it. */
export default async function ModulesPage({ params, searchParams }: { params: HubParams; searchParams: PageSearchParams }) {
  return (
    <HubConsolePage params={params} searchParams={searchParams} section={{ group: 'hub', id: 'modules' }}>
      {(ctx) => Modules(ctx)}
    </HubConsolePage>
  );
}
