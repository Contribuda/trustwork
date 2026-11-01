import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { country, dateTime, list } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { ActivationRequest, Empty, GuardRails, loadProduct, moneyMinor, PendingRequests, StatePill } from '../../modules/_kit/parts';
import type { ExtensionView } from '../../modules/_kit/schemas';

const GUARDS = ['mandates', 'budgets', 'approvals', 'killSwitches', 'egress', 'privacyRules', 'restrictedPlaces', 'untrustedTextNeverCommands'] as const;
const dataClass = (d: string) => tDynamic(`admin.agents.modules.dataClasses.${d}`, d);
const MANDATE_KINDS = ['prepare', 'research', 'communicate', 'send_quote', 'negotiate', 'maintain_records', 'schedule', 'publish'] as const;

async function ExtensionCard({ ctx, ext }: { ctx: HubContext; ext: ExtensionView }) {
  const zone = ctx.record.hub.timeZone;
  const { ref } = ext;
  const people = await ctx.port.people([...new Set(ext.history.map((h) => h.by))]);
  const who = (id: string) => {
    const person = people.find((p) => p.id === id);
    return person ? <span lang={person.nameLang}>{person.displayName}</span> : t('admin.common.unknownPerson');
  };
  const suite = ref.safetySuite;
  const failing = suite !== null && !suite.passed;
  return (
    <li className="admin-approval" data-testid={`extension-${ref.key}`} data-status={ref.status}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">
          <span lang={ext.title.lang}>{ext.title.text}</span> <code className="admin-code">{`${ref.key} v${ref.version}`}</code>
        </h3>
        <StatePill state={ref.status} />
      </div>
      {failing ? (
        <p className="admin-callout admin-callout--danger" data-testid="safety-failed">
          {t('admin.agents.extensions.safetyFailed')}
        </p>
      ) : null}
      <KeyValues
        rows={[
          {
            label: t('admin.agents.extensions.actions'),
            value: ext.actions.map((a) => (
              <span key={a.capabilityId} className="admin-dl__line">
                <code className="admin-code">{a.capabilityId}</code> · {t('admin.agents.extensions.mandateKind', { kind: a.mandateKind ? tDynamic(`admin.agents.modules.actions.${a.mandateKind}`, a.mandateKind) : t('admin.common.none') })} ·{' '}
                {tDynamic(`admin.agents.extensions.sideEffects.${a.sideEffect}`, a.sideEffect)}{' '}
              </span>
            )),
          },
          { label: t('admin.agents.extensions.inputs'), value: <code className="admin-code">{ext.inputs.join(', ')}</code> },
          { label: t('admin.agents.extensions.reads'), value: list(ref.dataClassesRead.map(dataClass)) },
          { label: t('admin.agents.extensions.sends'), value: ref.dataClassesSent.length ? list(ref.dataClassesSent.map(dataClass)) : t('admin.common.none') },
          {
            label: t('admin.agents.extensions.endpoints'),
            value: ref.endpoints.length
              ? ref.endpoints.map((e) => (
                  <span key={e.host}>
                    <code className="admin-code">{e.host}</code> ({country(e.country)}){' '}
                  </span>
                ))
              : t('admin.common.none'),
          },
          { label: t('admin.agents.extensions.cost'), value: t('admin.agents.extensions.costValue', { amount: moneyMinor(ext.costModel.costPerUnitMinor, ext.costModel.currency), unit: tDynamic(`admin.product.units.${ext.costModel.unit}`, ext.costModel.unit) }) },
          { label: t('admin.agents.extensions.adapter'), value: <>{t('admin.agents.extensions.withFake')} <code className="admin-code">{ref.adapterId}</code></> },
          { label: t('admin.agents.extensions.route'), value: ext.routeKey ? <code className="admin-code">{ext.routeKey}</code> : t('admin.common.none') },
          {
            label: t('admin.agents.extensions.safety'),
            value: suite ? (
              <span data-testid={`safety-${ref.key}`}>
                <StatePill state={suite.passed ? 'pass' : 'fail'} /> {t('admin.agents.extensions.safetyOn', { version: suite.engineVersion, date: dateTime(suite.at, zone) })}
              </span>
            ) : (
              t('admin.agents.extensions.safetyNotRun')
            ),
          },
        ]}
      />
      <details className="admin-disclosure">
        <summary>{t('admin.agents.extensions.guards')}</summary>
        <ul className="admin-list">
          {GUARDS.map((g) => (
            <li key={g} className="admin-list__row" data-guard-rail={g}>
              <span>{t(`admin.agents.extensions.guardNames.${g}`)}</span>
              <span className="admin-pill admin-pill--fail">{t('admin.product.guardRails.locked')}</span>
            </li>
          ))}
        </ul>
      </details>
      <details className="admin-disclosure">
        <summary>{t('admin.agents.extensions.history')}</summary>
        <ol className="admin-ordered">
          {ext.history.map((h) => (
            <li key={`${h.at}-${h.event}`}>
              {dateTime(h.at, zone)} · {tDynamic(`admin.agents.extensions.events.${h.event}`, h.event)} · {who(h.by)}
            </li>
          ))}
        </ol>
      </details>
      {ref.status === 'tested' || ref.status === 'draft' ? (
        <ActivationRequest
          ctx={ctx}
          command="extensions.request_activation"
          target={{ extensionVersionId: ref.id }}
          preview={ext.preview}
          secondPerson="agents.activate_extension"
          canRequest={ctx.can('admin.agents.extensions.edit')}
          blocked={suite?.passed !== true ? t('admin.agents.extensions.activationBlocked') : null}
        />
      ) : null}
    </li>
  );
}

async function Extensions(ctx: HubContext) {
  const { extensions } = (await loadProduct(ctx)).agents;
  const live = extensions.filter((e) => e.ref.status !== 'retired');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.agents.extensions.title')} lede={t('admin.agents.extensions.lede')} />
      <PendingRequests ctx={ctx} actions={['agents.activate_extension']} />
      <Panel id="extension-registry" title={t('admin.agents.extensions.registry')}>
        {extensions.length ? (
          <ul className="admin-approvals">
            {extensions.map((ext) => (
              <ExtensionCard key={ext.ref.id} ctx={ctx} ext={ext} />
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.agents.extensions.none')}</Empty>
        )}
        <p className="admin-note">{t('admin.agents.extensions.oneAgent')}</p>
      </Panel>
      {live.length ? (
        <div className="admin-grid">
          <Panel id="run-safety" title={t('admin.agents.extensions.runSafety')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('extensions.run_safety')} labels={formLabels({ submit: t('admin.agents.extensions.runSafety') })} disabledReason={readOnlyReason(ctx.can('admin.agents.extensions.edit'), ctx.offline)}>
              <SelectField name="extensionVersionId" label={t('admin.agents.extensions.extension')} options={live.map((e) => ({ value: e.ref.id, label: `${e.ref.key} v${e.ref.version}` }))} />
              <p className="admin-note">{t('admin.agents.extensions.fakeOnly')}</p>
            </ConsoleForm>
          </Panel>
          <Panel id="suspend-extension" title={t('admin.agents.extensions.suspend')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('agents.kill', { 'f.scope': 'agent_extension' })} labels={formLabels({ submit: t('admin.agents.extensions.suspend') })} submitVariant="danger" disabledReason={readOnlyReason(ctx.can('admin.agents.kill'), ctx.offline)}>
              <SelectField name="target" label={t('admin.agents.extensions.extension')} options={live.map((e) => ({ value: e.ref.extensionId, label: `${e.ref.key} v${e.ref.version}` }))} />
              <p className="admin-note">{t('admin.agents.extensions.suspendNote')}</p>
            </ConsoleForm>
          </Panel>
        </div>
      ) : null}
      <Panel id="draft-extension" title={t('admin.agents.extensions.draft')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('extensions.draft')} labels={formLabels({ submit: t('admin.agents.extensions.draft') })} disabledReason={readOnlyReason(ctx.can('admin.agents.extensions.edit'), ctx.offline)}>
          <div className="admin-form__grid">
            <TextInput name="key" label={t('admin.agents.extensions.key')} description={t('admin.agents.extensions.keyHelp')} isRequired />
            <SelectField name="actionKind" label={t('admin.agents.extensions.mandateKindLabel')} options={MANDATE_KINDS.map((k) => ({ value: k, label: tDynamic(`admin.agents.modules.actions.${k}`, k) }))} />
            <TextInput name="endpointHost" label={t('admin.agents.extensions.endpointHost')} description={t('admin.agents.extensions.endpointHelp')} />
            <TextInput name="endpointCountry" label={t('admin.agents.extensions.endpointCountry')} description={t('admin.agents.extensions.countryHelp')} />
          </div>
          <p className="admin-note">{t('admin.agents.extensions.cannotBypass')}</p>
        </ConsoleForm>
      </Panel>
      <GuardRails />
    </>
  );
}

/** HC-85 Extensions: the governed extension registry; activation after a passing safety suite on the fake adapter and a second person. */
export const screen: Screen = { group: 'agents', id: 'extensions', title: () => t('admin.agents.extensions.title'), render: Extensions };
