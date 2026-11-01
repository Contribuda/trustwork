import './capabilities.css';
import NextLink from '@/components/locale/LocalLink';
import { COMMITMENT_MANDATE_KINDS, unitMargin } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { list, number } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, StatusLabel } from '../../../../_components/shell';
import { ActivationRequest, audienceName, Empty, GuardRails, loadProduct, MarginText, moduleName, moneyMinor, PendingRequests, planName, StatePill, UniqueSelect, versioned, yesNo } from '../../modules/_kit/parts';
import { AUDIENCES, negativeMargin, type AgentModuleConfig } from '../../modules/_kit/schemas';

const action = (a: string) => tDynamic(`admin.agents.modules.actions.${a}`, a);
const commits = (m: AgentModuleConfig) => m.actions.some((a) => (COMMITMENT_MANDATE_KINDS as readonly string[]).includes(a));

function ModulePanel({ ctx, module, scopes }: { ctx: HubContext; module: AgentModuleConfig; scopes: ReadonlyArray<{ value: string; label: string }> }) {
  const price = module.price;
  const blocked = commits(module) && !module.verifiedCompanyRequired;
  const canEdit = ctx.can('admin.agents.modules.edit');
  return (
    <Panel id={`module-${module.key}`} title={moduleName(module.key)} aside={<StatePill state={module.lifecycle} />}>
      <p className="admin-module__meta">
        {t('admin.agents.modules.engine')} <StatusLabel status={module.engineStatus} /> · {t('admin.common.version', { version: module.version })}
      </p>
      {price && negativeMargin(price) ? (
        <p className="admin-callout admin-callout--warning" data-testid="negative-margin">
          {t('admin.agents.modules.negativeMargin')}
        </p>
      ) : null}
      {blocked ? (
        <p className="admin-callout admin-callout--danger" data-testid="commitment-blocked">
          {t('admin.agents.modules.commitmentBlocked')}
        </p>
      ) : null}
      <KeyValues
        rows={[
          { label: t('admin.agents.modules.actionsLabel'), value: list(module.actions.map(action)) },
          { label: t('admin.agents.modules.eligibility'), value: list(module.eligibility.map(audienceName)) },
          { label: t('admin.agents.modules.verifiedOnly'), value: yesNo(module.verifiedCompanyRequired) },
          {
            label: t('admin.agents.modules.routes'),
            value: (
              <>
                {module.routes.map((r) => (
                  <span key={`${r.job}-${r.routeKey}`}>
                    {tDynamic(`admin.agents.modules.jobs.${r.job}`, r.job)}: <code className="admin-code">{r.routeKey}</code> ({list(r.dataClasses.map((d) => tDynamic(`admin.agents.modules.dataClasses.${d}`, d)))}){' '}
                  </span>
                ))}
                <NextLink href={ctx.href('integrations/routing')}>{t('admin.agents.modules.routesLink')}</NextLink>
              </>
            ),
          },
          {
            label: t('admin.agents.modules.limits'),
            value: t('admin.agents.modules.limitsValue', {
              runs: module.limits.runsPerDay,
              actions: module.limits.actionsPerDay,
              concurrent: module.limits.concurrentRuns,
              tokens: number(module.limits.tokensPerMonth),
            }) + (module.limits.outreachPerWeek !== null ? ` · ${t('admin.agents.modules.outreach', { count: module.limits.outreachPerWeek })}` : ''),
          },
          { label: t('admin.agents.modules.metering'), value: t('admin.agents.modules.meteringValue', { unit: tDynamic(`admin.product.units.${module.metering.unit}`, module.metering.unit), free: module.metering.freeUnitsPerMonth }) },
          {
            label: t('admin.agents.modules.price'),
            value: price ? (
              <span data-testid={`price-${module.key}`}>
                {t('admin.product.cost')} {moneyMinor(price.costPerUnitMinor, price.currency)} · {t('admin.product.sale')} {moneyMinor(price.salePerUnitMinor, price.currency)} · {t('admin.product.margin')}{' '}
                <MarginText margin={unitMargin({ costPricePerUnitMinor: price.costPerUnitMinor, salePricePerUnitMinor: price.salePerUnitMinor })} currency={price.currency} />
                <span className="admin-meta">
                  {' · '}
                  {tDynamic(`admin.product.costBasis.${price.costBasis}`, price.costBasis)} · {t('admin.common.version', { version: price.version })}
                </span>
              </span>
            ) : (
              t('admin.agents.modules.noPrice')
            ),
          },
        ]}
      />
      <details className="admin-disclosure">
        <summary>{t('admin.agents.modules.capabilities', { count: module.capabilities.length })}</summary>
        <table className="plain-table agent-capabilities">
          <thead>
            <tr>
              <th scope="col">{t('admin.agents.modules.capability')}</th>
              <th scope="col">{t('admin.agents.modules.hub')}</th>
              <th scope="col">{t('admin.agents.modules.offFor')}</th>
              <th scope="col">{t('admin.agents.modules.offForPlans')}</th>
            </tr>
          </thead>
          <tbody>
            {module.capabilities.map((cap) => (
              <tr key={cap.id} data-testid={`capability-${cap.id}`}>
                <td data-label={t('admin.agents.modules.capability')}>
                  <code className="admin-code">{cap.id}</code> <span className="admin-meta">{tDynamic(`admin.agents.modules.kinds.${cap.kind}`, cap.kind)}</span>
                </td>
                <td data-label={t('admin.agents.modules.hub')}>{t(cap.hubOn ? 'admin.common.on' : 'admin.common.off')}</td>
                <td data-label={t('admin.agents.modules.offFor')}>{cap.offFor.length ? list(cap.offFor.map(audienceName)) : t('admin.common.none')}</td>
                <td data-label={t('admin.agents.modules.offForPlans')}>{cap.offForPlans.length ? list(cap.offForPlans.map(planName)) : t('admin.common.none')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="admin-note">{t('admin.agents.modules.parity')}</p>
        <ConsoleForm action={submitConsoleCommand} hidden={versioned(ctx, 'agents.module.draft', module.version, { moduleKey: module.key })} labels={formLabels({ submit: t('admin.agents.modules.draftChange') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
          <div className="admin-form__grid">
            <UniqueSelect id={`${module.key}-capability`} name="capability" label={t('admin.agents.modules.capability')} options={module.capabilities.map((c) => ({ value: c.id, label: c.id }))} />
            <UniqueSelect id={`${module.key}-scope`} name="scope" label={t('admin.agents.modules.scope')} options={scopes} />
            <UniqueSelect
              id={`${module.key}-state`}
              name="state"
              label={t('admin.agents.modules.state')}
              options={[
                { value: 'off', label: t('admin.common.off') },
                { value: 'on', label: t('admin.common.on') },
              ]}
            />
          </div>
          <p className="admin-note">{t('admin.agents.modules.toggleNote')}</p>
        </ConsoleForm>
      </details>
      <details className="admin-disclosure">
        <summary>{t('admin.agents.modules.defaults', { count: module.defaults.length })}</summary>
        {module.defaults.length ? (
          <ul className="admin-list">
            {module.defaults.map((d) => (
              <li key={d.key} className="admin-list__row">
                <span>{tDynamic(`admin.agents.modules.settings.${d.key}`, d.key)}</span>
                <span>{t('admin.agents.modules.defaultValue', { value: d.value, maximum: d.maximum })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.common.none')}</Empty>
        )}
        <p className="admin-note">{t('admin.agents.modules.tightenOnly')}</p>
        {module.defaults.length ? (
          <ConsoleForm action={submitConsoleCommand} hidden={versioned(ctx, 'agents.module.draft', module.version, { moduleKey: module.key })} labels={formLabels({ submit: t('admin.agents.modules.draftChange') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
            <div className="admin-form__grid">
              <UniqueSelect id={`${module.key}-default`} name="defaultKey" label={t('admin.agents.modules.setting')} options={module.defaults.map((d) => ({ value: d.key, label: tDynamic(`admin.agents.modules.settings.${d.key}`, d.key) }))} />
              <TextInput name="value" label={t('admin.agents.modules.defaultLabel')} isRequired />
              <TextInput name="maximum" label={t('admin.agents.modules.maximumLabel')} />
            </div>
          </ConsoleForm>
        ) : null}
      </details>
      <details className="admin-disclosure">
        <summary>{t('admin.agents.modules.jobsOffered', { count: module.jobs.length })}</summary>
        {module.jobs.length ? (
          <ul className="admin-list">
            {module.jobs.map((j) => (
              <li key={j.key} className="admin-list__row">
                <span>{tDynamic(`admin.agents.modules.jobTemplates.${j.key}`, j.key)}</span>
                <span className="admin-meta">
                  {list(j.triggers.map((tr) => tDynamic(`admin.agents.modules.triggers.${tr}`, tr)))} · {t('admin.agents.modules.minInterval', { hours: j.minIntervalHours })}
                </span>
                <span>{t(j.offered ? 'admin.common.on' : 'admin.common.off')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.agents.modules.noJobs')}</Empty>
        )}
        <p className="admin-note">{t('admin.agents.modules.jobsNote')}</p>
      </details>
      {module.draft ? (
        <div className="admin-subsection">
          <h3 className="admin-h3">{t('admin.agents.modules.draftVersion', { version: module.draft.version })}</h3>
          <ActivationRequest
            ctx={ctx}
            command="agents.module.request_activation"
            target={{ moduleKey: module.key }}
            preview={module.draft.preview}
            secondPerson={commits(module) ? 'agents.enable_commitment_module' : null}
            canRequest={ctx.can('admin.agents.modules.edit')}
            blocked={blocked ? t('admin.agents.modules.commitmentBlocked') : null}
          />
        </div>
      ) : null}
    </Panel>
  );
}

async function AgentModules(ctx: HubContext) {
  const product = await loadProduct(ctx);
  const { modules, plans } = product.agents;
  const first = modules[0];
  const scopes = [
    { value: 'hub', label: t('admin.agents.modules.scopeHub') },
    ...AUDIENCES.map((a) => ({ value: `audience:${a}`, label: t('admin.agents.modules.scopeAudience', { audience: audienceName(a) }) })),
    ...plans.map((p) => ({ value: `plan:${p}`, label: t('admin.agents.modules.scopePlan', { plan: planName(p) }) })),
  ];
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.agents.modules.title')} lede={t('admin.agents.modules.lede')} />
      <p className="admin-callout" role="note" data-testid="no-agent-list">
        {t('admin.agents.modules.noAgentList')}
      </p>
      <PendingRequests ctx={ctx} actions={['agents.enable_commitment_module']} />
      {modules.length ? modules.map((m) => <ModulePanel key={m.key} ctx={ctx} module={m} scopes={scopes} />) : <Empty>{t('admin.agents.modules.noModules')}</Empty>}
      {first ? (
        <div className="admin-grid">
          <Panel id="kill-module" title={t('admin.agents.modules.kill')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('agents.kill', { 'f.scope': 'agent_module' })} labels={formLabels({ submit: t('admin.killSwitch.engageSubmit') })} submitVariant="danger" disabledReason={readOnlyReason(ctx.can('admin.agents.kill'), ctx.offline)}>
              <SelectField name="target" label={t('admin.agents.modules.module')} options={modules.map((m) => ({ value: m.key, label: moduleName(m.key) }))} />
              <p className="admin-note">{t('admin.killSwitch.releaseNote')}</p>
              <p className="admin-note">{t('admin.agents.modules.capabilitySwitchProposed')}</p>
            </ConsoleForm>
          </Panel>
        </div>
      ) : null}
      <p>
        <NextLink href={ctx.href('billing/prices')}>{t('admin.agents.modules.pricesLink')}</NextLink>
      </p>
      <GuardRails />
    </>
  );
}

/** HC-80 Agent modules: the agent product catalogue of this hub; capabilities per participant type and plan, defaults and maximums, jobs, routes, prices. */
export const screen: Screen = { group: 'agents', id: 'modules', title: () => t('admin.agents.modules.title'), render: AgentModules };
