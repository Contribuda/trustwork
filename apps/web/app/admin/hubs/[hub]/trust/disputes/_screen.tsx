import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, StatusLabel } from '../../../../_components/shell';
import { submitTrustCommand } from '../_actions';
import { DISPUTE_DECISIONS, trustOf, type Dispute } from '../_fixtures';
import { EVIDENCE_CATEGORIES } from '../../participants/_fixtures';
import { fixturesOn, Lang, Pill, SectionForm } from '../../participants/_kit';

function DisputeCard({ ctx, dispute }: { ctx: HubContext; dispute: Dispute }) {
  const fields = { disputeId: dispute.id };
  return (
    <li className="admin-approval" data-testid={`dispute-${dispute.id}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">{tDynamic(`adminTrust.disputes.assertions.${dispute.assertion}`, dispute.assertion)}</h3>
        <Pill tone={dispute.state === 'open' ? 'warn' : 'neutral'}>{tDynamic(`adminTrust.disputes.states.${dispute.state}`, dispute.state)}</Pill>
      </div>
      <KeyValues
        rows={[
          { label: t('adminTrust.disputes.observation'), value: <code className="admin-code">{dispute.observation}</code> },
          { label: t('adminTrust.disputes.partyA'), value: <Lang text={dispute.parties[0]} /> },
          { label: t('adminTrust.disputes.partyB'), value: <Lang text={dispute.parties[1]} /> },
          { label: t('adminTrust.disputes.evidence'), value: t('adminTrust.common.items', { count: dispute.evidence }) },
          { label: t('adminTrust.common.received'), value: dateTime(dispute.openedAt, ctx.record.hub.timeZone) },
        ]}
      />
      <p className="admin-meta">
        {t('adminTrust.disputes.evidenceGrant')} <StatusLabel status="designed" />
      </p>
      <h4 className="admin-h4">{t('adminTrust.disputes.statements')}</h4>
      <ul className="admin-list">
        {dispute.statements.map((s, i) => (
          <li key={i} className="admin-list__row">
            <span className="admin-meta">{t(s.party === 0 ? 'adminTrust.disputes.partyA' : 'adminTrust.disputes.partyB')}:</span> <Lang text={s.text} />
          </li>
        ))}
      </ul>
      <div className="admin-grid">
        <SectionForm ctx={ctx} action={submitTrustCommand} command="disputes.observation" fields={fields} submit={t('adminTrust.disputes.record')} can={['admin.trust.evidence.decide']} variant="secondary">
          <SelectField name="stance" label={t('adminTrust.disputes.stance')} options={(['confirm', 'dispute'] as const).map((s) => ({ value: s, label: tDynamic(`adminTrust.disputes.stances.${s}`, s) }))} />
          <SelectField name="evidence" label={t('adminParticipants.claims.evidenceCategory')} options={EVIDENCE_CATEGORIES.map((e) => ({ value: e, label: tDynamic(`adminParticipants.evidence.${e}`, e) }))} />
        </SectionForm>
        {dispute.state === 'open' ? (
          <SectionForm ctx={ctx} action={submitTrustCommand} command="disputes.exclude" fields={fields} submit={t('adminTrust.disputes.exclude')} can={['admin.trust.exclude']} variant="secondary">
            <p className="admin-note">{t('adminTrust.disputes.excludeNote')}</p>
          </SectionForm>
        ) : null}
        <SectionForm ctx={ctx} action={submitTrustCommand} command="disputes.decide" fields={fields} submit={t('adminTrust.disputes.decide')} can={['admin.trust.evidence.decide']}>
          <SelectField name="decision" label={t('adminTrust.disputes.decision')} options={DISPUTE_DECISIONS.map((x) => ({ value: x, label: tDynamic(`adminTrust.disputes.decisions.${x}`, x) }))} />
        </SectionForm>
      </div>
    </li>
  );
}

async function Disputes(ctx: HubContext) {
  const d = trustOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminTrust.disputes.title')} lede={t('adminTrust.disputes.lede')} />
      <p className="admin-callout" role="note">
        {t('adminTrust.disputes.rule')}
      </p>
      <Panel id="disputes" title={t('adminTrust.disputes.queue')}>
        {d.disputes.length ? (
          <ul className="admin-approvals">
            {d.disputes.map((x) => (
              <DisputeCard key={x.id} ctx={ctx} dispute={x} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminTrust.disputes.empty')}</p>
        )}
      </Panel>
    </>
  );
}

/** HC-71 Disputes: execution and review disputes decided on evidence; an observation can be excluded while it is disputed. */
export const screen: Screen = { group: 'trust', id: 'disputes', title: () => t('adminTrust.disputes.title'), render: Disputes };
