import { createHash } from 'node:crypto';
import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../_components/context';
import type { Screen, ScreenRoute } from '../../../_components/screen';
import { ConsoleHeader, KeyValues, Panel } from '../../../_components/shell';
import { dateTime } from '../../../_components/format';
import { approvalBlocker, APPROVER_PERMISSIONS, holdsAny } from '../../../_data/commands';
import type { ChangeValue } from '../../../_data/schemas';
import { INBOX_VIEWS, inboxView } from '../../../_navigation/model';
import { deviceScope, navigationCopy } from '../../../_navigation/server';
import { SavedTabs } from '../../../_navigation/SavedTabs';
import { requestInHub } from './authority';
import { Decision } from './Decision';
import s from '../../../_navigation/navigation.module.css';

function Value({ value }: { value: ChangeValue }) {
  if (value.kind === 'none') return <>{t('admin.common.none')}</>;
  if (value.kind === 'key') return <>{tDynamic(`admin.${value.key}`, value.key)}</>;
  const fixtureLabel = { 'Privacy notice 1': 'privacyVersionOne', 'Privacy notice 2': 'privacyVersionTwo', 'Consultation fee 1': 'feeVersionOne' }[value.value];
  if (fixtureLabel) return <>{tDynamic(`consoleNav.${fixtureLabel}`, '')}</>;
  return <span lang={value.lang}>{value.value}</span>;
}

export async function Inbox(ctx: HubContext, route: ScreenRoute) {
  const copy = navigationCopy();
  const view = inboxView(route.query.view);
  const options = INBOX_VIEWS.map((id) => ({ id: `inbox:${id}` as const, label: copy[id], href: ctx.href('inbox', { view: id }) }));
  if (!ctx.request.demo || ctx.port.source !== 'fixtures') return <p>{copy.unavailable}</p>;
  const projection = await ctx.port.approvals(ctx.record.hub.id);
  const me = ctx.viewer.person.id;
  const requests = projection.requests.filter((request) => requestInHub(request, ctx.record.hub.id) && (request.requestedBy === me || holdsAny(ctx.access, APPROVER_PERMISSIONS[request.action])));
  const decisions = projection.decisions.filter((decision) => decision.hubId === ctx.record.hub.id && (decision.requestedBy === me || decision.decidedBy === me));
  const people = await ctx.port.people([...new Set([me, ...requests.map((request) => request.requestedBy), ...decisions.flatMap((decision) => [decision.decidedBy, decision.requestedBy])])]);
  const name = (id: string) => people.find((person) => person.id === id);
  const rows = requests.filter((request) => view === 'mine' ? request.requestedBy === me : view === 'waiting' && request.requestedBy !== me);
  const selected = route.query.item;
  // Deep-link filtering follows authorization. Missing and unauthorized IDs are indistinguishable.
  const shown = selected ? rows.filter((request) => request.id === selected) : rows;
  return <>
    <ConsoleHeader ctx={ctx} title={copy.inbox} lede={copy.inboxLede} />
    <p className="admin-callout" role="note">{copy.synthetic}</p>
    <nav className={s.tabs} aria-label={copy.filter}>
      {options.map((option) => <NextLink key={option.id} href={option.href} aria-current={option.id === `inbox:${view}` ? 'page' : undefined}>{option.label}</NextLink>)}
    </nav>
    <SavedTabs scope={deviceScope(ctx)} current={`inbox:${view}`} options={options} copy={copy} />
    <div className={s.row}><NextLink href={ctx.href('approvals')}>{copy.legacyApprovals}</NextLink><NextLink href={ctx.href('inbox', { view })}>{copy.refresh}</NextLink></div>
    {view === 'assigned' ? <Panel id="assigned" title={copy.assigned}><p>{copy.unavailable}</p></Panel> : view === 'done' ? <Panel id="decisions" title={copy.done}>
      <p>{copy.notActivation}</p>
      {decisions.length ? <ul className={s.records}>{decisions.map((decision) => <li key={decision.requestId} className={s.record}>
        <h3>{tDynamic(`admin.approvals.actions.${decision.action}`, decision.action)}</h3>
        <p>{t(decision.decision === 'approve' ? 'admin.approvals.approved' : 'admin.approvals.declined')}</p>
        <p>{t('admin.approvals.decidedAt')}: {dateTime(decision.decidedAt, ctx.record.hub.timeZone)}</p>
        <p>{t('admin.approvals.decidedBy')}: <span lang={name(decision.decidedBy)?.nameLang}>{name(decision.decidedBy)?.displayName ?? t('admin.common.unknownPerson')}</span></p>
      </li>)}</ul> : <p>{copy.empty}</p>}
    </Panel> : <section className={s.stack} aria-label={copy[view]}>
      {!shown.length ? <p>{copy.empty}</p> : shown.map((request) => {
        const blocker = approvalBlocker(request, me, ctx.access, ctx.now);
        const requester = name(request.requestedBy);
        const fixtureReason = { 'rq-legal-privacy-2': copy.reasonLegal, 'rq-provider-email-live': copy.reasonProvider, 'rq-automation-editorial': copy.reasonAutomation, 'rq-fee-consultation': copy.reasonFee, 'rq-role-compliance': copy.reasonRole }[request.id];
        const requestState = request.state !== 'pending' || request.currentDigest.value !== request.actionDigest.value ? 'void' : Date.parse(request.expiresAt) <= ctx.now.getTime() ? 'expired' : 'pending';
        const marker = createHash('sha256').update(JSON.stringify([deviceScope(ctx), request.id, request.actionDigest.value])).digest('hex');
        return <Decision key={request.id} copy={copy} title={tDynamic(`admin.approvals.actions.${request.action}`, request.action)}
          scope={ctx.hubName.text} requester={requester?.displayName ?? t('admin.common.unknownPerson')} requestReason={fixtureReason ?? copy.synthetic}
          digest={request.actionDigest.value} expiresAt={request.expiresAt} timeZone={ctx.record.hub.timeZone} marker={marker}
          hubId={ctx.record.hub.id} lostResponse={route.query.demoResult === 'unknown'}
          hidden={ctx.hidden('approvals.decide', { actor: me, 'f.requestId': request.id, 'f.digest': request.actionDigest.value })}
          disabledReason={ctx.offline ? t('admin.common.offlineDisabled') : blocker ? tDynamic(`admin.errors.${blocker}`, blocker) : undefined}>
          <p>{view === 'waiting' ? copy.whyMine : t('admin.approvals.ownRequest')}</p>
          <p>{t(`admin.approvals.state.${requestState}`)}</p>
          <KeyValues rows={[
            { label: t('admin.approvals.requestedBy'), value: requester?.displayName ?? t('admin.common.unknownPerson'), lang: requester?.nameLang },
            { label: copy.actor, value: ctx.viewer.person.displayName, lang: ctx.viewer.person.nameLang },
            { label: copy.scope, value: ctx.hubName.text, lang: ctx.hubName.lang },
            { label: copy.currentDigest, value: <code>{request.currentDigest.value}</code> },
            { label: t('admin.approvals.requestedAt'), value: dateTime(request.requestedAt, ctx.record.hub.timeZone) },
            { label: t('admin.approvals.expiresAt'), value: dateTime(request.expiresAt, ctx.record.hub.timeZone) },
          ]} />
          <h3>{t('admin.approvals.changes')}</h3>
          <ul className={s.fieldList} data-testid="inbox-field-diff">
            {request.changes.map((change) => <li key={change.field}><strong>{tDynamic(`admin.approvals.fields.${change.field}`, change.field)}</strong><dl>
              <dt>{t('admin.approvals.before')}</dt><dd><Value value={change.before} /></dd>
              <dt>{t('admin.approvals.after')}</dt><dd><Value value={change.after} /></dd>
            </dl></li>)}
          </ul>
          <NextLink href={ctx.href('inbox', { view, item: request.id })}>{t('admin.approvals.action')}</NextLink>
        </Decision>;
      })}
    </section>}
  </>;
}

export const screen: Screen = { group: 'home', id: 'inbox', title: () => t('consoleNav.inbox'), render: Inbox };
