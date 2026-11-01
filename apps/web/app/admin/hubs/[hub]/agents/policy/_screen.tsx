import { disclosureLocalesMissing } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { languageName, list } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { ActivationRequest, Empty, GuardRails, loadProduct, PendingRequests, StatePill, versioned, yesNo } from '../../modules/_kit/parts';

const action = (a: string) => tDynamic(`admin.agents.modules.actions.${a}`, a);
const area = (a: string) => tDynamic(`admin.agents.policy.areas.${a}`, a);
const AREAS = ['agent_disclosure', 'liability_allocation', 'consent', 'record_keeping', 'action_limits', 'legal_texts'] as const;

async function AgentPolicy(ctx: HubContext) {
  const { policy } = (await loadProduct(ctx)).agents;
  const locales = ctx.record.hub.locales;
  const missingDisclosure = locales.filter((l) => !policy.disclosure.some((d) => d.lang === l));
  const limits = policy.protectionLimits;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.agents.policy.title')} lede={t('admin.agents.policy.lede')} />
      <PendingRequests ctx={ctx} actions={['jurisdiction.activate_settings']} />
      <div className="admin-grid">
        <Panel id="policy-rules" title={t('admin.agents.policy.rules')}>
          <KeyValues
            rows={[
              { label: t('admin.agents.policy.version'), value: t('admin.common.version', { version: policy.version }) },
              { label: t('admin.agents.policy.neverPreAuthorized'), value: list(policy.forbiddenPreAuthorization.map(action)) },
              { label: t('admin.agents.policy.commitmentsVerified'), value: t('admin.agents.policy.always') },
              { label: t('admin.agents.policy.outreach'), value: t('admin.agents.policy.perWeek', { count: policy.outreachPerPersonPerWeek }) },
              { label: t('admin.agents.policy.onlyParticipants'), value: yesNo(policy.outreachOnlyToParticipants) },
              { label: t('admin.agents.policy.channels'), value: list(policy.channels.map((c) => tDynamic(`admin.agents.policy.channelNames.${c}`, c))) },
            ]}
          />
          <p className="admin-note">{t('admin.agents.policy.competition')}</p>
        </Panel>
        <Panel id="plan-to-people" title={t('admin.agents.policy.planToPeople')}>
          <KeyValues
            rows={[
              { label: t('admin.agents.policy.draftRequests'), value: yesNo(policy.planToPeople.mayDraftRequests) },
              { label: t('admin.agents.policy.draftOffers'), value: yesNo(policy.planToPeople.mayDraftOffers) },
              { label: t('admin.agents.policy.acceptWithinMandate'), value: yesNo(policy.planToPeople.mayAcceptWithinMandate) },
              { label: t('admin.agents.policy.requestsPerWeek'), value: policy.planToPeople.requestsPerWeek },
            ]}
          />
        </Panel>
      </div>
      <Panel id="disclosure" title={t('admin.agents.policy.disclosure')}>
        {policy.disclosure.length ? (
          <ul className="admin-list">
            {policy.disclosure.map((d) => (
              <li key={d.lang} className="admin-list__row">
                <span>{languageName(d.lang)}</span>
                <span lang={d.lang}>{d.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.agents.policy.noDisclosure')}</Empty>
        )}
        {missingDisclosure.length ? <p className="admin-callout admin-callout--warning">{t('admin.agents.policy.disclosureMissing', { items: list(missingDisclosure.map(languageName)) })}</p> : null}
      </Panel>
      <Panel id="protection-limits" title={t('admin.agents.policy.protection')}>
        <KeyValues
          rows={[
            { label: t('admin.agents.policy.limits.openIntroductionsPerPerson'), value: limits.openIntroductionsPerPerson },
            { label: t('admin.agents.policy.limits.newCounterpartiesPerDay'), value: limits.newCounterpartiesPerDay },
            { label: t('admin.agents.policy.limits.maxNegotiationRounds'), value: limits.maxNegotiationRounds },
            { label: t('admin.agents.policy.limits.envelopesPerCounterpartyPerDay'), value: limits.envelopesPerCounterpartyPerDay },
            { label: t('admin.agents.policy.limits.connectionsPerPerson'), value: limits.connectionsPerPerson },
            { label: t('admin.agents.policy.limits.connectionIdleExpiryDays'), value: limits.connectionIdleExpiryDays },
          ]}
        />
        <p className="admin-note">{t('admin.agents.policy.samePlans')}</p>
      </Panel>
      <Panel id="jurisdictions" title={t('admin.agents.policy.jurisdictions')}>
        <p>{t('admin.agents.policy.jurisdictionsLede')}</p>
        {policy.jurisdictions.length ? (
          policy.jurisdictions.map(({ ref, rows }) => {
            const missing = disclosureLocalesMissing(ref, ctx.record.hub);
            return (
              <div key={ref.configVersionId} className="admin-subsection" data-testid={`jurisdiction-${ref.jurisdiction}`}>
                <div className="admin-panel__head">
                  <h3 className="admin-h3">
                    <code className="admin-code">{ref.jurisdiction}</code> · {t('admin.common.version', { version: ref.version })}
                  </h3>
                  <StatePill state={ref.status} />
                </div>
                <table className="plain-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('admin.agents.policy.area')}</th>
                      <th scope="col">{t('admin.agents.policy.packDefault')}</th>
                      <th scope="col">{t('admin.agents.policy.hubValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.area}>
                        <td data-label={t('admin.agents.policy.area')}>
                          {area(row.area)}
                          {row.packDefault.mandatory ? <span className="admin-meta"> · {t('admin.agents.policy.mandatory')}</span> : null}
                        </td>
                        <td data-label={t('admin.agents.policy.packDefault')}>
                          <span lang={row.packDefault.lang}>{row.packDefault.text}</span>
                          <span className="admin-meta">
                            {' · '}
                            <code className="admin-code">{`${row.packDefault.fact.packCode} ${row.packDefault.fact.packVersion} ${row.packDefault.fact.factKey}`}</code>
                          </span>
                        </td>
                        <td data-label={t('admin.agents.policy.hubValue')}>
                          <span lang={row.hubValue.lang}>{row.hubValue.text}</span>
                          <span className="admin-meta"> · {tDynamic(`admin.agents.policy.comparison.${row.comparison}`, row.comparison)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="admin-meta">{t('admin.agents.policy.disclosureIn', { items: list(ref.disclosureLocales.map(languageName)) })}</p>
                {ref.status === 'draft' ? (
                  <ActivationRequest
                    ctx={ctx}
                    command="jurisdiction.request_activation"
                    target={{ configVersionId: ref.configVersionId }}
                    preview={null}
                    secondPerson="jurisdiction.activate_settings"
                    canRequest={ctx.can('admin.hub.jurisdiction.edit')}
                    blocked={missing.length ? t('admin.agents.policy.disclosureMissing', { items: list(missing.map(languageName)) }) : null}
                  />
                ) : null}
              </div>
            );
          })
        ) : (
          <Empty>{t('admin.agents.policy.noJurisdictions')}</Empty>
        )}
        <p className="admin-note">{t('admin.agents.policy.notLegalAdvice')}</p>
      </Panel>
      <div className="admin-grid">
        <Panel id="policy-edit" title={t('admin.agents.policy.edit')}>
          <ConsoleForm action={submitConsoleCommand} hidden={versioned(ctx, 'agents.policy.draft', policy.version)} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.agents.policy.edit'), ctx.offline)}>
            <div className="admin-form__grid">
              <TextInput name="outreachPerPersonPerWeek" label={t('admin.agents.policy.outreach')} defaultValue={String(policy.outreachPerPersonPerWeek)} />
              <TextInput name="requestsPerWeek" label={t('admin.agents.policy.requestsPerWeek')} defaultValue={String(policy.planToPeople.requestsPerWeek)} />
              <SelectField name="disclosureLang" label={t('admin.agents.policy.disclosureLang')} options={locales.map((l) => ({ value: l, label: languageName(l) }))} />
            </div>
            <TextInput name="disclosureText" label={t('admin.agents.policy.disclosureText')} description={t('admin.agents.policy.disclosureHelp')} />
            <p className="admin-note">
              {t('admin.agents.policy.placeholder')} <code className="admin-code">{'{person}'}</code>
            </p>
          </ConsoleForm>
        </Panel>
        <Panel id="jurisdiction-edit" title={t('admin.agents.policy.jurisdictionEdit')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('jurisdiction.draft')} labels={formLabels({ submit: t('admin.agents.policy.draftJurisdiction') })} disabledReason={readOnlyReason(ctx.can('admin.hub.jurisdiction.edit'), ctx.offline)}>
            <div className="admin-form__grid">
              <TextInput name="jurisdiction" label={t('admin.agents.policy.jurisdiction')} description={t('admin.agents.policy.jurisdictionHelp')} isRequired />
              <SelectField name="area" label={t('admin.agents.policy.area')} options={AREAS.map((a) => ({ value: a, label: area(a) }))} />
              <SelectField
                name="comparison"
                label={t('admin.agents.policy.comparisonLabel')}
                options={[
                  { value: 'same', label: t('admin.agents.policy.comparison.same') },
                  { value: 'stricter', label: t('admin.agents.policy.comparison.stricter') },
                ]}
              />
            </div>
            <TextInput name="value" label={t('admin.agents.policy.hubValue')} isRequired />
            <p className="admin-note">{t('admin.agents.policy.neverWeaker')}</p>
          </ConsoleForm>
        </Panel>
      </div>
      {policy.draft ? (
        <Panel id="policy-draft" title={t('admin.agents.policy.draftVersion', { version: policy.draft.version })}>
          <ActivationRequest
            ctx={ctx}
            command="agents.policy.request_activation"
            target={{ policyVersion: String(policy.draft.version) }}
            preview={policy.draft.preview}
            secondPerson={null}
            canRequest={ctx.can('admin.agents.policy.edit')}
            blocked={missingDisclosure.length ? t('admin.agents.policy.disclosureMissing', { items: list(missingDisclosure.map(languageName)) }) : null}
          />
        </Panel>
      ) : null}
      <GuardRails />
    </>
  );
}

/** HC-81 Agent policy: hub-wide rules, disclosure in every hub language, plan-to-people limits and per-jurisdiction settings beside the country-pack defaults. */
export const screen: Screen = { group: 'agents', id: 'policy', title: () => t('admin.agents.policy.title'), render: AgentPolicy };
