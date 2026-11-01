import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { submitTrustCommand } from '../_actions';
import { trustOf } from '../_fixtures';
import { Count, fixturesOn, SectionForm, Table, Tiles } from '../../participants/_kit';

async function Confirmations(ctx: HubContext) {
  const d = trustOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const p = d.policy;
  const yes = (v: boolean) => t(v ? 'adminParticipants.common.yes' : 'adminParticipants.common.no');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminTrust.confirmations.title')} lede={t('adminTrust.confirmations.lede')} />
      <Panel id="policy" title={t('adminTrust.confirmations.policy')}>
        {p ? (
          <>
            <KeyValues
              rows={[
                { label: t('adminTrust.reputation.version'), value: t('adminParticipants.common.version', { version: p.version }) },
                { label: t('adminTrust.confirmations.fields.requireLink'), value: <>{yes(p.requireTransactionOrProjectLink)} <span className="admin-meta">· {t('adminTrust.confirmations.locked')}</span></> },
                { label: t('adminTrust.confirmations.fields.maxOpen'), value: p.maxOpenRequestsPerRequester },
                { label: t('adminTrust.confirmations.fields.perCounterparty'), value: p.maxRequestsPerCounterpartyPerMonth },
                { label: t('adminTrust.confirmations.fields.cooldown'), value: t('adminParticipants.verification.days', { days: p.declineCooldownDays }) },
                { label: t('adminTrust.confirmations.fields.reciprocal'), value: yes(p.reciprocalConfirmationsFlagged) },
                { label: t('adminTrust.confirmations.fields.agentsRequest'), value: yes(p.agentsMayRequest) },
                { label: t('adminTrust.confirmations.fields.agentsConfirm'), value: <>{yes(p.agentsMayConfirm)} <span className="admin-meta">· {t('adminTrust.confirmations.locked')}</span></> },
              ]}
            />
            <SectionForm ctx={ctx} action={submitTrustCommand} command="confirmations.policy" submit={t('adminTrust.confirmations.save')} can={['admin.claims.policy.edit']}>
              <TextInput name="maxOpenRequestsPerRequester" label={t('adminTrust.confirmations.fields.maxOpen')} isRequired defaultValue={String(p.maxOpenRequestsPerRequester)} description={t('adminTrust.reputation.range', { min: 1, max: 200 })} />
              <TextInput name="maxRequestsPerCounterpartyPerMonth" label={t('adminTrust.confirmations.fields.perCounterparty')} isRequired defaultValue={String(p.maxRequestsPerCounterpartyPerMonth)} description={t('adminTrust.reputation.range', { min: 1, max: 20 })} />
              <TextInput name="declineCooldownDays" label={t('adminTrust.confirmations.fields.cooldown')} isRequired defaultValue={String(p.declineCooldownDays)} description={t('adminTrust.reputation.range', { min: 0, max: 365 })} />
              <p className="admin-note">{t('adminTrust.confirmations.agentsNever')}</p>
            </SectionForm>
          </>
        ) : (
          <p className="admin-empty">{t('adminTrust.confirmations.noPolicy')}</p>
        )}
      </Panel>
      {d.confirmations ? (
        <Panel id="counts" title={t('adminTrust.confirmations.counts')}>
          <Tiles
            testid="confirmation-counts"
            items={(['requested', 'accepted', 'declined'] as const).map((k) => ({ key: k, label: tDynamic(`adminTrust.confirmations.countKinds.${k}`, k), value: <Count value={d.confirmations![k]} /> }))}
          />
          <p className="admin-note">{t('adminParticipants.common.cohortNote')}</p>
        </Panel>
      ) : null}
      <Panel id="patterns" title={t('adminTrust.confirmations.patterns')}>
        <p className="admin-note">{t('adminTrust.confirmations.patternsNote')}</p>
        <Table
          testid="patterns"
          rows={d.patterns}
          rowKey={(x) => x.id}
          empty={t('adminTrust.confirmations.noPatterns')}
          columns={[
            { label: t('adminTrust.common.id'), render: (x) => <code className="admin-code">{x.id}</code> },
            { label: t('adminTrust.confirmations.kind'), render: (x) => tDynamic(`adminTrust.confirmations.kinds.${x.kind}`, x.kind) },
            { label: t('adminTrust.confirmations.size'), render: (x) => t('adminTrust.confirmations.accounts', { count: x.size }) },
            { label: t('adminTrust.confirmations.window'), render: (x) => t('adminParticipants.verification.days', { days: x.window }) },
            { label: t('adminTrust.confirmations.detected'), render: (x) => longDate(x.detectedAt) },
          ]}
        />
        {d.patterns.length ? (
          <SectionForm ctx={ctx} action={submitTrustCommand} command="confirmations.open_case" submit={t('adminTrust.moderation.openCase')} can={['admin.claims.policy.edit', 'admin.moderation.case.open']} variant="secondary">
            <SelectField name="patternId" label={t('adminTrust.confirmations.pattern')} options={d.patterns.map((x) => ({ value: x.id, label: `${x.id} · ${tDynamic(`adminTrust.confirmations.kinds.${x.kind}`, x.kind)}` }))} />
          </SectionForm>
        ) : null}
      </Panel>
    </>
  );
}

/** HC-75 Confirmations: the confirmation policy (agents never confirm), flagged reciprocal patterns and cohort counts. */
export const screen: Screen = { group: 'trust', id: 'confirmations', title: () => t('adminTrust.confirmations.title'), render: Confirmations };
