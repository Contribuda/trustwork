import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../_data/actions';
import { approvalBlocker, APPROVER_PERMISSIONS, holdsAny } from '../../../_data/commands';
import type { ApprovalRequest, ChangeValue, ConsolePerson } from '../../../_data/schemas';
import { ConsoleForm } from '../../../_components/ConsoleForm';
import type { HubContext } from '../../../_components/context';
import type { Screen } from '../../../_components/screen';
import { formLabels, SelectField } from '../../../_components/forms';
import { dateTime } from '../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, StatusLabel } from '../../../_components/shell';

function Value({ value }: { value: ChangeValue }) {
  if (value.kind === 'none') return <span className="admin-meta">{t('admin.common.none')}</span>;
  if (value.kind === 'text') return <span lang={value.lang}>{value.value}</span>;
  return <span>{tDynamic(`admin.${value.key}`, value.key)}</span>;
}

function Person({ people, id }: { people: ConsolePerson[]; id: string }) {
  const person = people.find((p) => p.id === id);
  return person ? <span lang={person.nameLang}>{person.displayName}</span> : <span>{t('admin.common.unknownPerson')}</span>;
}

function RequestCard({ ctx, request, people, mine }: { ctx: HubContext; request: ApprovalRequest; people: ConsolePerson[]; mine: boolean }) {
  const zone = ctx.record.hub.timeZone;
  const blocker = approvalBlocker(request, ctx.viewer.person.id, ctx.access, ctx.now);
  const state = request.state === 'withdrawn' || request.currentDigest.value !== request.actionDigest.value ? 'void' : Date.parse(request.expiresAt) <= ctx.now.getTime() ? 'expired' : 'pending';
  return (
    <li className="admin-approval" data-testid={`approval-${request.id}`} data-state={state}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">{tDynamic(`admin.approvals.actions.${request.action}`, request.action)}</h3>
        <span className={`admin-pill admin-pill--${state}`}>{t(`admin.approvals.state.${state}`)}</span>
      </div>
      <KeyValues
        rows={[
          { label: t('admin.approvals.requestedBy'), value: <Person people={people} id={request.requestedBy} /> },
          { label: t('admin.approvals.reason'), value: request.reason.value, lang: request.reason.lang },
          { label: t('admin.approvals.requestedAt'), value: dateTime(request.requestedAt, zone) },
          { label: t('admin.approvals.expiresAt'), value: dateTime(request.expiresAt, zone) },
          { label: t('admin.approvals.digest'), value: <code className="admin-code">{request.actionDigest.value.slice(0, 12)}</code> },
        ]}
      />
      <h4 className="admin-h4">{t('admin.approvals.changes')}</h4>
      <ul className="admin-diff">
        {request.changes.map((change) => (
          <li key={change.field}>
            <span className="admin-diff__field">{tDynamic(`admin.approvals.fields.${change.field}`, change.field)}</span>
            <span className="admin-diff__before">
              <span className="admin-visually-hidden">{t('admin.approvals.before')} </span>
              <Value value={change.before} />
            </span>
            <span aria-hidden="true">→</span>
            <span className="admin-diff__after">
              <span className="admin-visually-hidden">{t('admin.approvals.after')} </span>
              <Value value={change.after} />
            </span>
          </li>
        ))}
      </ul>
      {state === 'void' ? <p className="admin-callout admin-callout--warning">{t('admin.approvals.actionChanged')}</p> : null}
      {state === 'expired' ? <p className="admin-callout">{t('admin.approvals.expired')}</p> : null}
      {mine ? (
        state === 'pending' ? (
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={ctx.hidden('approvals.withdraw', { 'f.requestId': request.id })}
            labels={formLabels({ submit: t('admin.approvals.withdraw') })}
            submitVariant="secondary"
            disabledReason={ctx.offline ? t('admin.common.offlineDisabled') : null}
          >
            <p className="admin-note">{t('admin.approvals.ownRequest')}</p>
          </ConsoleForm>
        ) : null
      ) : state === 'pending' ? (
        <ConsoleForm
          action={submitConsoleCommand}
          hidden={ctx.hidden('approvals.decide', { 'f.requestId': request.id, 'f.digest': request.actionDigest.value })}
          labels={formLabels({ submit: t('admin.approvals.decide') })}
          disabledReason={ctx.offline ? t('admin.common.offlineDisabled') : blocker ? tDynamic(`admin.errors.${blocker}`, blocker) : null}
        >
          <SelectField
            name="decision"
            label={t('admin.approvals.decision')}
            options={[
              { value: 'approve', label: t('admin.approvals.approve') },
              { value: 'decline', label: t('admin.approvals.decline') },
            ]}
            description={t('admin.approvals.bindsDigest')}
          />
        </ConsoleForm>
      ) : null}
      {state === 'pending' ? (
        <p className="admin-meta">
          {t('admin.approvals.askQuestion')} <StatusLabel status="designed" />
        </p>
      ) : null}
    </li>
  );
}

async function Approvals(ctx: HubContext) {
  const { requests, decisions } = await ctx.port.approvals(ctx.record.hub.id);
  const people = await ctx.port.people([...new Set([...requests.map((r) => r.requestedBy), ...decisions.flatMap((d) => [d.requestedBy, d.decidedBy])])]);
  const me = ctx.viewer.person.id;
  const forMe = requests.filter((r) => r.requestedBy !== me && holdsAny(ctx.access, APPROVER_PERMISSIONS[r.action]));
  const mine = requests.filter((r) => r.requestedBy === me);
  const zone = ctx.record.hub.timeZone;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.approvals.title')} lede={t('admin.approvals.lede')} />
      {ctx.record.sodMode === 'reduced' ? <p className="admin-callout admin-callout--warning" role="note">{t('admin.approvals.reducedSod')}</p> : null}
      <Panel id="for-me" title={t('admin.approvals.forMe')}>
        {forMe.length ? (
          <ul className="admin-approvals">
            {forMe.map((r) => (
              <RequestCard key={r.id} ctx={ctx} request={r} people={people} mine={false} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty" data-testid="approvals-empty">{t('admin.approvals.forMeEmpty')}</p>
        )}
      </Panel>
      <Panel id="mine" title={t('admin.approvals.mine')}>
        {mine.length ? (
          <ul className="admin-approvals">
            {mine.map((r) => (
              <RequestCard key={r.id} ctx={ctx} request={r} people={people} mine />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('admin.approvals.mineEmpty')}</p>
        )}
      </Panel>
      <Panel id="decisions" title={t('admin.approvals.decisions')}>
        {decisions.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.approvals.action')}</th>
                <th scope="col">{t('admin.approvals.decision')}</th>
                <th scope="col">{t('admin.approvals.requestedBy')}</th>
                <th scope="col">{t('admin.approvals.decidedBy')}</th>
                <th scope="col">{t('admin.approvals.decidedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.requestId}>
                  <td data-label={t('admin.approvals.action')}>{tDynamic(`admin.approvals.actions.${d.action}`, d.action)}</td>
                  <td data-label={t('admin.approvals.decision')}>{t(d.decision === 'approve' ? 'admin.approvals.approved' : 'admin.approvals.declined')}</td>
                  <td data-label={t('admin.approvals.requestedBy')}>
                    <Person people={people} id={d.requestedBy} />
                  </td>
                  <td data-label={t('admin.approvals.decidedBy')}>
                    <Person people={people} id={d.decidedBy} />
                  </td>
                  <td data-label={t('admin.approvals.decidedAt')}>{dateTime(d.decidedAt, zone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="admin-empty">{t('admin.approvals.decisionsEmpty')}</p>
        )}
      </Panel>
    </>
  );
}

/** HC-02 Approvals: second-person decisions bound to one action, one scope and one digest; never one's own. */
export const screen: Screen = { group: 'home', id: 'approvals', title: () => t('admin.approvals.title'), render: Approvals };
