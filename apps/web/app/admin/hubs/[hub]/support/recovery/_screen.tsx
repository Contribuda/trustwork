import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { dateTime, list } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { submitSupportCommand } from '../_actions';
import { COOLING_OFF_HOURS, RECOVERY_APPROVER, recoveryBlocker } from '../_commands';
import { supportOf, type RecoveryRequest } from '../_fixtures';
import { fixturesOn, Lang, Pill, SectionForm, StaffName, staffNames, type StaffNames } from '../../participants/_kit';

const tone = (r: RecoveryRequest) => (r.state === 'cancelled' ? 'fail' : r.state === 'ready' ? 'pass' : 'warn');

function RecoveryCard({ ctx, request, names }: { ctx: HubContext; request: RecoveryRequest; names: StaffNames }) {
  const zone = ctx.record.hub.timeZone;
  const blocker = recoveryBlocker(request, ctx.viewer.person.id, ctx.access.permissions);
  const due = request.effectiveAt !== null && Date.parse(request.effectiveAt) <= ctx.now.getTime();
  const reason = (code: string | null) => (code ? tDynamic(`adminParticipants.errors.${code}`, tDynamic(`admin.errors.${code}`, code, { items: '' })) : null);
  return (
    <li className="admin-approval" data-testid={`recovery-${request.id}`} data-state={request.state}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">
          {tDynamic(`adminSupport.actions.${request.action}`, request.action)} · <Lang text={request.subject.name} />
        </h3>
        <Pill tone={tone(request)}>{tDynamic(`adminSupport.recovery.states.${request.state}`, request.state)}</Pill>
      </div>
      <KeyValues
        rows={[
          { label: t('adminSupport.recovery.evidence'), value: tDynamic(`adminSupport.recovery.evidenceStates.${request.evidence}`, request.evidence) },
          { label: t('adminSupport.grants.requestedBy'), value: <StaffName names={names} id={request.requestedBy} /> },
          { label: t('adminSupport.recovery.approver'), value: <StaffName names={names} id={request.approvedBy} /> },
          { label: t('adminSupport.recovery.coolingOff'), value: request.effectiveAt ? dateTime(request.effectiveAt, zone) : t('adminSupport.recovery.afterApproval', { hours: COOLING_OFF_HOURS }) },
          { label: t('adminSupport.recovery.notified'), value: list(request.notified.map((c) => tDynamic(`adminSupport.channels.${c}`, c))) },
          { label: t('adminSupport.cases.case'), value: <code className="admin-code">{request.caseId}</code> },
        ]}
      />
      {request.objection ? (
        <p className="admin-callout admin-callout--danger" data-testid="objection">
          {t('adminSupport.recovery.objection')}
        </p>
      ) : null}
      {request.state === 'awaiting_approval' ? (
        <SectionForm ctx={ctx} action={submitSupportCommand} command="recovery.approve" fields={{ requestId: request.id }} submit={t('adminSupport.recovery.approve')} can={[RECOVERY_APPROVER[request.action]]} blocked={reason(blocker)}>
          <p className="admin-note">{t('adminSupport.recovery.approveNote', { hours: COOLING_OFF_HOURS })}</p>
        </SectionForm>
      ) : null}
      {request.state === 'cooling_off' || request.state === 'ready' ? (
        <SectionForm
          ctx={ctx}
          action={submitSupportCommand}
          command="recovery.complete"
          fields={{ requestId: request.id }}
          submit={t('adminSupport.recovery.complete')}
          can={[RECOVERY_APPROVER[request.action]]}
          blocked={due ? null : t('adminParticipants.errors.cooling_off_active')}
          variant="secondary"
        />
      ) : null}
      {request.state === 'awaiting_approval' || request.state === 'cooling_off' ? (
        <SectionForm ctx={ctx} action={submitSupportCommand} command="recovery.cancel" fields={{ requestId: request.id }} submit={t('adminSupport.recovery.cancel')} can={['admin.support.diagnose']} variant="danger" />
      ) : null}
    </li>
  );
}

async function Recovery(ctx: HubContext) {
  const d = supportOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const names = await staffNames(ctx, d.recovery.flatMap((r) => [r.requestedBy, r.approvedBy]));
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminSupport.recovery.title')} lede={t('adminSupport.recovery.lede')} />
      <p className="admin-callout" role="note">
        {t('adminSupport.recovery.rule', { hours: COOLING_OFF_HOURS })}
      </p>
      <Panel id="requests" title={t('adminSupport.recovery.requests')}>
        {d.recovery.length ? (
          <ul className="admin-approvals">
            {d.recovery.map((r) => (
              <RecoveryCard key={r.id} ctx={ctx} request={r} names={names} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminSupport.recovery.empty')}</p>
        )}
      </Panel>
    </>
  );
}

/** HC-34 Recovery escalations: sign-in factor changes with evidence, a different approver, a 72-hour cooling-off and objections that cancel. */
export const screen: Screen = { group: 'support', id: 'recovery', title: () => t('adminSupport.recovery.title'), render: Recovery };
