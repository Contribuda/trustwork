import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { submitTrustCommand } from '../_actions';
import { APPEAL_DECISIONS, trustOf, type Appeal } from '../_fixtures';
import { fixturesOn, Pill, SectionForm, StaffName, staffNames, type StaffNames } from '../../participants/_kit';

function AppealCard({ ctx, appeal, names }: { ctx: HubContext; appeal: Appeal; names: StaffNames }) {
  const own = appeal.originalDecider === ctx.viewer.person.id;
  const blocked = own ? t('adminParticipants.errors.original_decider') : null;
  const late = Date.parse(appeal.deadline) - ctx.now.getTime() < 3 * 86_400_000;
  return (
    <li className="admin-approval" data-testid={`appeal-${appeal.id}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">{t('adminTrust.appeals.against', { kind: tDynamic(`adminTrust.appeals.kinds.${appeal.against}`, appeal.against) })}</h3>
        <Pill tone={appeal.state === 'open' ? 'warn' : 'neutral'}>{tDynamic(`adminTrust.appeals.states.${appeal.state}`, appeal.state)}</Pill>
      </div>
      <KeyValues
        rows={[
          { label: t('adminTrust.appeals.ref'), value: <code className="admin-code">{appeal.ref}</code> },
          { label: t('adminTrust.appeals.originalDecider'), value: <StaffName names={names} id={appeal.originalDecider} /> },
          { label: t('adminTrust.appeals.filed'), value: longDate(appeal.filedAt) },
          { label: t('adminTrust.appeals.deadline'), value: <>{longDate(appeal.deadline)}{late ? <span className="admin-warning"> · {t('adminTrust.appeals.soon')}</span> : null}</> },
        ]}
      />
      {own ? (
        <p className="admin-callout admin-callout--warning" data-testid="original-decider">
          {t('adminParticipants.errors.original_decider')}
        </p>
      ) : null}
      <div className="admin-grid">
        <SectionForm ctx={ctx} action={submitTrustCommand} command="appeals.decide" fields={{ appealId: appeal.id }} submit={t('adminTrust.appeals.decide')} can={['admin.trust.appeals.decide', 'admin.moderation.appeal.decide']} blocked={blocked}>
          <SelectField name="decision" label={t('adminTrust.appeals.decision')} options={APPEAL_DECISIONS.map((x) => ({ value: x, label: tDynamic(`adminTrust.appeals.decisions.${x}`, x) }))} />
        </SectionForm>
        <SectionForm ctx={ctx} action={submitTrustCommand} command="appeals.request_info" fields={{ appealId: appeal.id }} submit={t('adminTrust.appeals.requestInfo')} can={['admin.trust.appeals.decide', 'admin.moderation.appeal.decide']} blocked={blocked} variant="secondary" />
      </div>
    </li>
  );
}

async function Appeals(ctx: HubContext) {
  const d = trustOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const names = await staffNames(ctx, d.appeals.map((a) => a.originalDecider));
  const queue = [...d.appeals].sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminTrust.appeals.title')} lede={t('adminTrust.appeals.lede')} />
      <Panel id="appeals" title={t('adminTrust.appeals.queue')}>
        {queue.length ? (
          <ul className="admin-approvals">
            {queue.map((a) => (
              <AppealCard key={a.id} ctx={ctx} appeal={a} names={names} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminTrust.appeals.empty')}</p>
        )}
      </Panel>
    </>
  );
}

/** HC-73 Appeals: one queue against claims, credentials, moderation and observations; never decided by the original decider. */
export const screen: Screen = { group: 'trust', id: 'appeals', title: () => t('adminTrust.appeals.title'), render: Appeals };
