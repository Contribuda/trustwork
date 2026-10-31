import NextLink from 'next/link';
import { blockingGates, LAUNCH_GATES, providerBudgetState, SOFT_LAUNCH_GATES, type ConsolePermission } from '@trustwork/contracts/client';
import { formatMoney, t, tDynamic } from '@/app/_lib/i18n';
import { approvalBlocker } from '../../_data/commands';
import { submitConsoleCommand } from '../../_data/actions';
import type { QueueId } from '../../_data/schemas';
import { ConsoleForm } from '../../_components/ConsoleForm';
import type { HubContext } from '../../_components/context';
import type { Screen } from '../../_components/screen';
import { dateTime, number } from '../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../_components/shell';
import { formLabels } from '../../_components/forms';

/** Each queue opens its section and counts only for viewers who may act on it (screens.md HC-01, "Navigation behaviour"). */
const QUEUES: Record<QueueId, { path: string; act: readonly ConsolePermission[] }> = {
  claims: { path: 'participants/claims', act: ['admin.claims.decide'] },
  review_items: { path: 'editorial/review', act: ['admin.editorial.items.review', 'admin.publications.review'] },
  link_proposals: { path: 'data/links', act: ['admin.links.decide'] },
  reports: { path: 'trust/moderation', act: ['admin.moderation.decide'] },
  support_cases: { path: 'support/cases', act: ['admin.support.case.close'] },
  grant_requests: { path: 'support/cases', act: ['admin.support.grant.approve'] },
  privacy_requests: { path: 'privacy/requests', act: ['admin.privacy.export', 'admin.privacy.erasure.execute'] },
  unknown_outcomes: { path: 'ops/jobs', act: ['admin.assistant.reconcile', 'admin.jobs.retry'] },
  alerts: { path: 'automation/alerts', act: ['admin.pipelines.run', 'admin.pipelines.pause'] },
};

const NEXT_FIVE = ['inviteStaff', 'legalDocuments', 'firstSource', 'verificationRecipe', 'backupDrill'] as const;

async function Overview(ctx: HubContext) {
  const { record, port, viewer, access } = ctx;
  const hubId = record.hub.id;
  const [overview, approvals] = await Promise.all([port.overview(hubId), port.approvals(hubId)]);
  const zone = record.hub.timeZone;
  const queues = (overview?.queues ?? []).filter((q) => q.count > 0 && QUEUES[q.id].act.some((p) => ctx.can(p)));
  const forMe = approvals.requests.filter((r) => approvalBlocker(r, viewer.person.id, access, ctx.now) === null);
  const canHub = ctx.can('admin.hub.read');
  const passed = record.gates.filter((g) => g.state === 'passed').length;
  const softOpen = blockingGates('soft_launch', record.gates);
  const engageable = ctx.can('admin.providers.kill') || ctx.can('admin.agents.kill');
  const killOptions = [...(ctx.can('admin.providers.kill') ? ['outbound_messages'] : []), ...(ctx.can('admin.agents.kill') ? ['hub_agent_dispatch', 'external_agent_api'] : [])];

  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.overview.title')} lede={t('admin.overview.lede')} />
      {record.sodMode === 'reduced' ? (
        <p className="admin-callout admin-callout--warning" role="note" data-testid="reduced-sod">
          {t('admin.overview.reducedSod')}
        </p>
      ) : null}
      <div className="admin-grid">
        <Panel id="queues" title={t('admin.overview.queues')}>
          {queues.length === 0 && forMe.length === 0 ? (
            <p className="admin-empty" data-testid="nothing-waiting">
              {t('admin.overview.nothingWaiting')}
            </p>
          ) : queues.length === 0 ? (
            <p className="admin-empty">{t('admin.overview.noQueues')}</p>
          ) : (
            <ul className="admin-list">
              {queues.map((q) => (
                <li key={q.id} className="admin-list__row">
                  <NextLink href={ctx.href(QUEUES[q.id].path)}>{tDynamic(`admin.overview.queue.${q.id}`, q.id)}</NextLink>
                  <span className="admin-count">{number(q.count)}</span>
                  {q.nearestDeadline ? <span className="admin-meta">{t('admin.overview.nearestDeadline', { date: dateTime(q.nearestDeadline, zone) })}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel id="approvals-waiting" title={t('admin.overview.approvals')}>
          <p>{forMe.length ? t('admin.overview.approvalsWaiting', { count: forMe.length }) : t('admin.overview.approvalsNone')}</p>
          <p>
            <NextLink href={ctx.href('approvals')} className="admin-link-strong">
              {t('admin.overview.openApprovals')}
            </NextLink>
          </p>
        </Panel>

        {canHub ? (
          <Panel id="launch-progress" title={t('admin.overview.launch')}>
            <KeyValues
              rows={[
                { label: t('admin.overview.gatesPassed'), value: t('admin.overview.gatesOf', { passed, total: LAUNCH_GATES.length }) },
                { label: t('admin.overview.softLaunchOpen'), value: t('admin.overview.gatesOf', { passed: SOFT_LAUNCH_GATES.length - softOpen.length, total: SOFT_LAUNCH_GATES.length }) },
              ]}
            />
            <p>
              <NextLink href={ctx.href('hub/launch')}>{t('admin.overview.openLaunch')}</NextLink>
            </p>
          </Panel>
        ) : null}

        {canHub && overview ? (
          <Panel id="compliance" title={t('admin.overview.compliance')}>
            <KeyValues
              rows={[
                { label: t('admin.overview.legalDue'), value: number(overview.compliance.legalDocumentsDue) },
                {
                  label: t('admin.overview.screeningAge'),
                  value: overview.compliance.screeningListAgeDays === null ? t('admin.common.notRecorded') : t('admin.overview.days', { count: overview.compliance.screeningListAgeDays }),
                },
                { label: t('admin.overview.licencesExpiring'), value: number(overview.compliance.expiringSourceLicences) },
                {
                  label: t('admin.overview.fakeProviders'),
                  value: overview.compliance.fakeProviders.length ? overview.compliance.fakeProviders.map((c) => tDynamic(`admin.capabilities.${c}`, c)).join(', ') : t('admin.common.none'),
                },
              ]}
            />
          </Panel>
        ) : null}

        {overview ? (
          <Panel id="health" title={t('admin.overview.health')}>
            <ul className="admin-tiles">
              {overview.health.map((h) => (
                <li key={h.id} className={`admin-tile admin-tile--${h.state}`}>
                  <span className="admin-tile__label">{tDynamic(`admin.overview.healthCheck.${h.id}`, h.id)}</span>
                  <span className="admin-tile__state">{tDynamic(`admin.overview.healthState.${h.state}`, h.state)}</span>
                  {h.value !== null ? <span className="admin-meta">{h.id.endsWith('_age') ? t('admin.overview.minutes', { count: h.value }) : number(h.value)}</span> : null}
                </li>
              ))}
            </ul>
            {engageable ? (
              <details className="admin-disclosure">
                <summary>{t('admin.killSwitch.engage')}</summary>
                <ConsoleForm
                  action={submitConsoleCommand}
                  hidden={ctx.hidden('killswitch.engage')}
                  labels={formLabels({ submit: t('admin.killSwitch.engageSubmit') })}
                  submitVariant="danger"
                  disabledReason={ctx.offline ? t('admin.common.offlineDisabled') : null}
                >
                  <label className="admin-field">
                    <span className="admin-field__label">{t('admin.killSwitch.scope')}</span>
                    <select name="f.scope" className="admin-select" defaultValue={killOptions[0]}>
                      {killOptions.map((k) => (
                        <option key={k} value={k}>
                          {tDynamic(`admin.killSwitch.scopes.${k}`, k)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="admin-note">{t('admin.killSwitch.releaseNote')}</p>
                </ConsoleForm>
              </details>
            ) : null}
          </Panel>
        ) : null}

        {(ctx.can('admin.providers.read') || ctx.can('admin.usage.read')) && record.budgets.length ? (
          <Panel id="spend" title={t('admin.overview.spend')}>
            <ul className="admin-list">
              {record.budgets.map(({ budget, spentMinorUnits }) => {
                const state = providerBudgetState(budget, spentMinorUnits);
                const percent = Math.min(100, Math.round((Number(spentMinorUnits) / Math.max(1, Number(budget.limit.minorUnits))) * 100));
                return (
                  <li key={budget.id} className="admin-budget">
                    <span className="admin-budget__label">
                      {budget.scope.kind === 'job' ? tDynamic(`admin.overview.budgetJob.${budget.scope.job}`, budget.scope.job) : tDynamic(`admin.overview.budgetScope.${budget.scope.kind}`, budget.scope.kind)}
                      {' · '}
                      {tDynamic(`admin.overview.period.${budget.period}`, budget.period)}
                    </span>
                    <span>
                      {t('admin.overview.spentOf', { spent: formatMoney(spentMinorUnits, budget.limit.currency), limit: formatMoney(budget.limit.minorUnits, budget.limit.currency) })}
                    </span>
                    <span className={`admin-budget__state admin-budget__state--${state}`}>{tDynamic(`admin.overview.budgetState.${state}`, state)}</span>
                    <span className="admin-meter" aria-hidden="true">
                      <span style={{ width: `${percent}%` }} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : null}

        {canHub && (record.hub.lifecycle === 'draft' || record.hub.lifecycle === 'preparing') ? (
          <Panel id="next-five" title={t('admin.overview.nextFive')}>
            <ol className="admin-ordered">
              {NEXT_FIVE.map((key) => (
                <li key={key}>{t(`admin.overview.next.${key}`)}</li>
              ))}
            </ol>
          </Panel>
        ) : null}
      </div>
      {overview ? <p className="admin-meta admin-updated">{t('admin.common.updated', { time: dateTime(overview.updatedAt, zone) })}</p> : null}
    </>
  );
}

/** HC-01 Overview: what needs a person today, and whether the hub is healthy and lawful. */
export const screen: Screen = { group: 'home', id: 'overview', title: () => t('admin.overview.title'), render: Overview };
