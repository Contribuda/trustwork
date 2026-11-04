import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import type { ProviderConnection, ProviderCredential, ProvidersView } from '../../../../_data/live-providers';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import { CheckboxField, FieldGroup, formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { country, longDate, shortDateTime } from '../../../../_components/format';
import type { Screen } from '../../../../_components/screen';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Pill, StaffName, staffNames, Table, type StaffNames } from '../../participants/_kit';
import { CAPABILITIES, CONNECTION_MODES, HOSTING_KINDS, PRICING_BASES, SECRET_GRACE_DEFAULT_HOURS, SECRET_GRACE_MAX_HOURS, SECRET_STORES } from './_commands';
import { SecretEntry, type SecretEntryLabels } from './SecretEntry';

/** Every string of the live section is under one namespace of the providers locale file. */
const L = 'providers.console';
const capabilityName = (capability: string) => tDynamic(`admin.capabilities.${capability}`, capability);
const modeName = (mode: string) => tDynamic(`${L}.modes.${mode}`, mode);
const STATUS_TONE: Readonly<Record<string, 'pass' | 'warn' | 'fail' | 'neutral'>> = { enabled: 'pass', active: 'pass', draft: 'warn', registered: 'warn', killed: 'fail', disabled: 'neutral', retired: 'neutral' };
const statusPill = (status: string) => <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{tDynamic(`${L}.status.${status}`, status)}</Pill>;
const yesNo = (value: boolean | undefined) => t(value ? 'admin.common.yes' : 'admin.common.no');

function secretLabels(): SecretEntryLabels {
  const reasons = ['secret_store_unconfigured', 'fake_holds_no_secret', 'revision_conflict', 'connection_killed', 'invalid_transition'] as const;
  return {
    value: t('providers.console.secret.value'), valueHelp: t('providers.console.secret.valueHelp'), grace: t('providers.console.secret.grace'),
    graceHelp: t('providers.console.secret.graceHelp', { max: SECRET_GRACE_MAX_HOURS }), reason: t('admin.common.reason'), reasonHelp: t('admin.common.reasonHelp'), submit: t('providers.console.secret.submit'),
    saved: t('providers.console.secret.saved'), generic: t('providers.console.secret.failed'), reasons: Object.fromEntries(reasons.map((r) => [r, tDynamic(`providers.reasons.${r}`, r)])),
  };
}

function Secrets({ ctx, connection }: { ctx: HubContext; connection: ProviderConnection }) {
  const { secret } = connection;
  if (connection.mode === 'fake') return <p className="admin-note">{t('providers.console.secret.fake')}</p>;
  const canWrite = readOnlyReason(ctx.can('admin.providers.secret.write'), ctx.offline);
  const hasLive = secret.versions.some((v) => v.status !== 'destroyed');
  if (secret.credentialRefId) return <p className="admin-note" data-testid="secret-by-reference">{t('providers.console.secret.byCredential')}</p>;
  return (
    <div className="admin-subsection">
      <h4 className="admin-h4">{t('providers.console.secret.title')}</h4>
      {secret.versions.length ? (
        <ul className="admin-list" data-testid={`secret-versions-${connection.id}`}>
          {secret.versions.map((v) => (
            <li key={v.ref.id} className="admin-list__row">
              <span>{t('admin.common.version', { version: v.ref.version })} · <code className="admin-code">{v.ref.keyedFingerprint}</code></span>
              <span className="admin-meta">
                {tDynamic(`providers.secretStatus.${v.status}`, v.status)}
                {v.graceUntil ? ` · ${shortDateTime(v.graceUntil)}` : ''}
                {v.ref.lastUsedAt ? ` · ${t('providers.console.secret.lastUsed', { date: shortDateTime(v.ref.lastUsedAt) })}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">{t('providers.console.secret.none')}</p>
      )}
      <p className="admin-note">{t('providers.console.secret.noReveal')}</p>
      <details data-testid="connection-key">
        <summary>{t(hasLive ? 'providers.console.secret.change' : 'providers.console.secret.enter')}</summary>
        <SecretEntry path={`/v1/admin/hubs/${ctx.record.hub.id}/providers/connections/${connection.id}/secret`} connectionId={connection.id} revision={connection.revision} graceDefault={SECRET_GRACE_DEFAULT_HOURS} labels={secretLabels()} disabled={canWrite} />
        {hasLive ? (
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.secret_revoke', { 'f.connectionId': connection.id })} labels={formLabels({ submit: t('providers.console.secret.revoke') })} disabledReason={canWrite} submitVariant="danger" />
        ) : null}
      </details>
    </div>
  );
}

function EnableStep({ ctx, connection, names }: { ctx: HubContext; connection: ProviderConnection; names: StaffNames }) {
  const hidden = ctx.hidden('providers.connection_enable', { 'f.connectionId': connection.id });
  const readOnly = readOnlyReason(ctx.can('admin.providers.toggle'), ctx.offline);
  if (connection.status === 'enabled' || connection.status === 'killed') return null;
  if (connection.mode === 'fake') return <ConsoleForm action={submitConsoleCommand} hidden={hidden} labels={formLabels({ submit: t('providers.console.enable') })} disabledReason={readOnly} />;
  const stage = connection.enableStage;
  if (stage.stage === 'requested') {
    return (
      <p className="admin-note">
        {t(stage.approved ? 'providers.console.approvedForOther' : 'providers.console.waiting')} <StaffName names={names} id={stage.requestedBy} /> · <a href={ctx.href('approvals')}>{t('providers.console.openApprovals')}</a>
      </p>
    );
  }
  if (stage.stage === 'approved') return <ConsoleForm action={submitConsoleCommand} hidden={hidden} labels={formLabels({ submit: t('providers.console.enable') })} disabledReason={readOnly} />;
  if (!connection.enable) return <p className="admin-note">{t('providers.reasons.test_required')}</p>;
  return <ConsoleForm action={submitConsoleCommand} hidden={hidden} labels={formLabels({ submit: t('providers.console.ask'), secondPerson: true })} disabledReason={readOnly} submitVariant="secondary" />;
}

function ConnectionCard({ ctx, connection, names }: { ctx: HubContext; connection: ProviderConnection; names: StaffNames }) {
  const fields = { 'f.connectionId': connection.id };
  const { hosting, lastTest } = connection;
  return (
    <li className="admin-approval" data-testid={`connection-${connection.adapterId}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3" lang="und">{connection.label}</h3>
        <span className="admin-pill">{modeName(connection.mode)}</span>
        {statusPill(connection.status)}
      </div>
      <KeyValues
        rows={[
          { label: t('providers.console.adapter'), value: <code className="admin-code">{connection.adapterId}</code> },
          { label: t('providers.console.capabilities'), value: connection.capabilities.map(capabilityName).join(', ') },
          { label: t('providers.console.hosting'), value: `${tDynamic(`${L}.hostingKinds.${hosting.kind}`, hosting.kind)} · ${country(hosting.country)}${connection.storageCountry ? ` · ${t('providers.console.storesIn', { country: country(connection.storageCountry) })}` : ''}` },
          ...(hosting.kind === 'vendor' ? [{ label: t('providers.console.vendorTerms'), value: t('providers.console.vendorTermsValue', { zero: yesNo(hosting.zeroRetention), trains: yesNo(hosting.trainsOnInputs), broker: yesNo(hosting.broker) }) }] : []),
          { label: t('providers.console.residency'), value: yesNo(connection.inHubResidency) },
          { label: t('providers.console.lastTest'), value: lastTest ? `${tDynamic(`providers.testOutcomes.${lastTest.outcome}`, lastTest.outcome)} · ${shortDateTime(lastTest.at)}` : t('providers.console.neverTested') },
        ]}
      />
      <Secrets ctx={ctx} connection={connection} />
      {/* Every action asks for its own reason, so they stay folded: a list of connections has to stay readable on a phone. */}
      <details className="admin-subsection" data-testid="connection-actions">
        <summary>{t('providers.console.actions')}</summary>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.connection_test', fields)} labels={formLabels({ submit: t('providers.console.test') })} disabledReason={readOnlyReason(ctx.can('admin.providers.test'), ctx.offline)} submitVariant="secondary" />
        <EnableStep ctx={ctx} connection={connection} names={names} />
        {connection.status === 'enabled' ? (
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.connection_disable', fields)} labels={formLabels({ submit: t('providers.console.disable') })} disabledReason={readOnlyReason(ctx.can('admin.providers.toggle'), ctx.offline)} submitVariant="secondary" />
        ) : null}
        {connection.killSwitchId ? (
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.kill_release', { 'f.killSwitchId': connection.killSwitchId })} labels={formLabels({ submit: t('providers.console.killRelease'), secondPerson: true })} disabledReason={readOnlyReason(ctx.can('admin.providers.kill'), ctx.offline)}>
            <TextInput name="incidentNote" label={t('providers.console.incidentNote')} description={t('providers.console.incidentHelp')} isRequired />
          </ConsoleForm>
        ) : (
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.kill_engage', fields)} labels={formLabels({ submit: t('providers.console.killEngage') })} disabledReason={readOnlyReason(ctx.can('admin.providers.kill'), ctx.offline)} submitVariant="danger" />
        )}
      </details>
    </li>
  );
}

function ConnectionDraft({ ctx, view }: { ctx: HubContext; view: ProvidersView }) {
  const usable = (view.credentials ?? []).filter((c) => c.status === 'active' && c.mode !== 'fake');
  return (
    <Panel id="connection-draft" title={t('providers.console.add')}>
      <p className="admin-note">{t('providers.console.addHelp')}</p>
      <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.connection_create')} labels={formLabels({ submit: t('providers.console.add') })} disabledReason={readOnlyReason(ctx.can('admin.providers.connection.edit'), ctx.offline)}>
        <div className="admin-form__grid">
          <TextInput name="label" label={t('providers.console.label')} isRequired />
          <TextInput name="adapterId" label={t('providers.console.adapter')} description={t('providers.console.adapterHelp')} isRequired />
          <SelectField name="mode" label={t('providers.console.mode')} options={CONNECTION_MODES.map((m) => ({ value: m, label: modeName(m) }))} description={t('providers.console.modeHelp')} />
          <SelectField name="hostingKind" label={t('providers.console.hostingKind')} options={HOSTING_KINDS.map((k) => ({ value: k, label: tDynamic(`${L}.hostingKinds.${k}`, k) }))} />
          <TextInput name="hostingCountry" label={t('providers.console.country')} description={t('providers.console.countryHelp')} isRequired />
          <TextInput name="storageCountry" label={t('providers.console.storageCountry')} description={t('providers.console.storageHelp')} />
          <TextInput name="region" label={t('providers.console.region')} />
          <TextInput name="endpoint" label={t('providers.console.endpoint')} description={t('providers.console.endpointHelp')} />
          <SelectField name="credentialRefId" label={t('providers.console.credential')} description={t('providers.console.credentialHelp')} options={[{ value: '', label: t('admin.common.none') }, ...usable.map((c) => ({ value: c.id, label: `${c.provider} · ${c.adapter}` }))]} />
        </div>
        <FieldGroup legend={t('providers.console.vendorTerms')}>
          <CheckboxField name="zeroRetention" label={t('providers.console.zeroRetention')} />
          <CheckboxField name="trainsOnInputs" label={t('providers.console.trainsOnInputs')} />
          <CheckboxField name="broker" label={t('providers.console.broker')} />
        </FieldGroup>
        <FieldGroup legend={t('providers.console.capabilities')}>
          <div className="admin-form__grid">
            {CAPABILITIES.map((c) => (
              <CheckboxField key={c} name={`cap.${c}`} label={capabilityName(c)} />
            ))}
          </div>
        </FieldGroup>
      </ConsoleForm>
    </Panel>
  );
}

function CredentialStep({ ctx, credential, names }: { ctx: HubContext; credential: ProviderCredential; names: StaffNames }) {
  const fields = { 'f.credentialId': credential.id };
  const readOnly = readOnlyReason(ctx.can('admin.providers.toggle'), ctx.offline);
  if (credential.status === 'retired') return null;
  if (credential.status === 'active') return <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.credential_retire', fields)} labels={formLabels({ submit: t('providers.console.credentials.retire') })} disabledReason={readOnly} submitVariant="secondary" />;
  const stage = credential.activationStage;
  if (stage.stage === 'requested') {
    return <p className="admin-note">{t(stage.approved ? 'providers.console.approvedForOther' : 'providers.console.waiting')} <StaffName names={names} id={stage.requestedBy} /> · <a href={ctx.href('approvals')}>{t('providers.console.openApprovals')}</a></p>;
  }
  const direct = credential.mode === 'fake' || stage.stage === 'approved';
  return <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.credential_activate', fields)} labels={formLabels({ submit: t(direct ? 'providers.console.credentials.activate' : 'providers.console.ask'), secondPerson: !direct })} disabledReason={readOnly} submitVariant={direct ? 'primary' : 'secondary'} />;
}

function Credentials({ ctx, credentials, names }: { ctx: HubContext; credentials: ProviderCredential[] | null; names: StaffNames }) {
  if (credentials === null) return <p className="admin-empty" data-testid="credentials-hidden">{t('providers.console.credentials.hidden')}</p>;
  return (
    <>
      <Panel id="credentials" title={t('providers.console.credentials.title')}>
        <p className="admin-note">{t('providers.console.credentials.help')}</p>
        {credentials.length ? (
          <ul className="admin-approvals">
            {credentials.map((c) => (
              <li key={c.id} className="admin-approval" data-testid={`credential-${c.provider}`}>
                <div className="admin-panel__head">
                  <h3 className="admin-h3"><code className="admin-code">{c.provider}</code></h3>
                  <span className="admin-pill">{modeName(c.mode)}</span>
                  {statusPill(c.status)}
                </div>
                <p className="admin-meta">
                  <code className="admin-code">{c.adapter}</code> · {tDynamic(`${L}.stores.${c.secret.store}`, c.secret.store)} · <code className="admin-code">{c.secret.ref}</code>
                </p>
                <CredentialStep ctx={ctx} credential={c} names={names} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('providers.console.credentials.none')}</p>
        )}
      </Panel>
      <Panel id="credential-register" title={t('providers.console.credentials.register')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.credential_register')} labels={formLabels({ submit: t('providers.console.credentials.register') })} disabledReason={readOnlyReason(ctx.can('admin.providers.secret.write'), ctx.offline)}>
          <div className="admin-form__grid">
            <TextInput name="credProvider" label={t('providers.console.credentials.provider')} description={t('providers.console.adapterHelp')} isRequired />
            <TextInput name="credAdapter" label={t('providers.console.adapter')} description={t('providers.console.adapterHelp')} isRequired />
            <SelectField name="credMode" label={t('providers.console.mode')} options={CONNECTION_MODES.map((m) => ({ value: m, label: modeName(m) }))} />
            <SelectField name="credStore" label={t('providers.console.credentials.store')} options={SECRET_STORES.map((s) => ({ value: s, label: tDynamic(`${L}.stores.${s}`, s) }))} />
            <TextInput name="credRef" label={t('providers.console.credentials.ref')} description={t('providers.console.credentials.refHelp')} isRequired />
          </div>
        </ConsoleForm>
      </Panel>
    </>
  );
}

function ModelCosts({ ctx, view }: { ctx: HubContext; view: ProvidersView }) {
  if (view.costs === null) return <p className="admin-empty" data-testid="costs-hidden">{t('providers.console.costs.hidden')}</p>;
  const labels = new Map(view.connections.map((c) => [c.id, c.label]));
  const canEdit = ctx.can('admin.providers.connection.edit') || ctx.can('admin.providers.budget.edit');
  return (
    <>
      <Panel id="model-costs" title={t('providers.console.costs.title')}>
        <p className="admin-note">{t('providers.console.costs.help')}</p>
        <Table
          testid="model-costs-table"
          rows={view.costs}
          rowKey={(c) => c.id}
          empty={t('providers.console.costs.none')}
          columns={[
            { label: t('providers.console.costs.model'), render: (c) => <><code className="admin-code">{c.modelId}</code><div className="admin-meta">{labels.get(c.connectionId) ?? c.connectionId} · {t('admin.common.version', { version: c.version })}</div></> },
            { label: t('providers.console.costs.input'), render: (c) => (c.inputPerMillionTokens === null ? t('admin.common.none') : `${c.inputPerMillionTokens} ${c.currency}`) },
            { label: t('providers.console.costs.output'), render: (c) => (c.outputPerMillionTokens === null ? t('admin.common.none') : `${c.outputPerMillionTokens} ${c.currency}`) },
            { label: t('providers.console.costs.observed'), render: (c) => <>{longDate(c.observedAt)}<div className="admin-meta">{tDynamic(`${L}.costs.bases.${c.basis}`, c.basis)}</div></> },
          ]}
        />
      </Panel>
      {view.connections.length ? (
        <Panel id="cost-record" title={t('providers.console.costs.record')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('providers.pricing_record')} labels={formLabels({ submit: t('providers.console.costs.record') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
            <div className="admin-form__grid">
              <SelectField name="priceConnection" label={t('providers.console.costs.connection')} options={view.connections.map((c) => ({ value: c.id, label: c.label, lang: 'und' }))} />
              <TextInput name="priceModel" label={t('providers.console.costs.model')} isRequired />
              <TextInput name="priceInput" label={t('providers.console.costs.input')} description={t('providers.console.costs.amountHelp', { currency: ctx.record.hub.currency })} />
              <TextInput name="priceOutput" label={t('providers.console.costs.output')} description={t('providers.console.costs.amountHelp', { currency: ctx.record.hub.currency })} />
              <SelectField name="priceBasis" label={t('providers.console.costs.basis')} options={PRICING_BASES.map((b) => ({ value: b, label: tDynamic(`${L}.costs.bases.${b}`, b) }))} />
              <TextInput name="priceNote" label={t('providers.console.costs.note')} />
            </div>
          </ConsoleForm>
        </Panel>
      ) : null}
    </>
  );
}

async function LiveProviders(ctx: HubContext) {
  const view = await ctx.port.providers(ctx.record.hub.id);
  const header = <ConsoleHeader ctx={ctx} title={t('providers.console.title')} lede={t('providers.console.lede')} />;
  if (!view) {
    return (
      <>
        {header}
        <p className="admin-empty">{t('providers.console.hidden')}</p>
      </>
    );
  }
  const stages = [...view.connections.map((c) => c.enableStage), ...(view.credentials ?? []).map((c) => c.activationStage)];
  const names = await staffNames(ctx, stages.flatMap((s) => (s.stage === 'requested' ? [s.requestedBy] : [])));
  return (
    <>
      {header}
      <Panel id="connections" title={t('providers.console.connections')}>
        {view.connections.length ? (
          <ul className="admin-approvals">
            {view.connections.map((c) => (
              <ConnectionCard key={c.id} ctx={ctx} connection={c} names={names} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('providers.console.none')}</p>
        )}
      </Panel>
      <ConnectionDraft ctx={ctx} view={view} />
      <Credentials ctx={ctx} credentials={view.credentials} names={names} />
      <ModelCosts ctx={ctx} view={view} />
    </>
  );
}

/** HC-100 Providers, live only (no demo data: demo mode keeps the "designed" page): connections, secrets by reference, credentials and model cost records. */
export const screen: Screen = { group: 'integrations', id: 'providers', title: () => t('providers.console.title'), render: LiveProviders };
