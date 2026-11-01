import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, Empty, loadProduct, onOff } from '../_kit/parts';

const POLICIES = ['editorial_only', 'verified_and_editorial', 'anyone_reviewed', 'anyone_unreviewed'] as const;

async function Events(ctx: HubContext) {
  const { events } = (await loadProduct(ctx)).modules;
  const zone = ctx.record.hub.timeZone;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.events.title')} lede={t('admin.modules.events.lede')} />
      <div className="admin-grid">
        <Panel id="events-policy" title={t('admin.modules.events.policy')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.events.hosting'), value: tDynamic(`admin.modules.events.policies.${events.hostingPolicy}`, events.hostingPolicy) },
              { label: t('admin.modules.events.ticketing'), value: onOff(events.ticketing) },
              { label: t('admin.modules.events.feeVersion'), value: events.feeVersionLabel ? <span lang="en">{events.feeVersionLabel}</span> : t('admin.common.none') },
              { label: t('admin.modules.events.partnerMeetings'), value: onOff(events.partnerMeetings) },
            ]}
          />
        </Panel>
        <Panel id="events-counts" title={t('admin.modules.events.counts')}>
          <KeyValues
            rows={[
              { label: t('admin.modules.events.published'), value: <Cohort value={events.counts.published} /> },
              { label: t('admin.modules.events.registrations'), value: <Cohort value={events.counts.registrations} /> },
              { label: t('admin.modules.events.checkIns'), value: <Cohort value={events.counts.checkIns} /> },
              { label: t('admin.modules.events.refunds'), value: events.refunds },
              { label: t('admin.modules.events.screening'), value: events.organizerScreening },
              { label: t('admin.modules.events.payouts'), value: events.payoutBatchesWaiting },
            ]}
          />
          <p>
            <NextLink href={ctx.href('billing/payouts')}>{t('admin.modules.events.payoutsLink')}</NextLink>
          </p>
        </Panel>
      </div>
      <Panel id="events-review" title={t('admin.modules.events.review')}>
        {events.inReview.length ? (
          <>
            <ul className="admin-list">
              {events.inReview.map((e) => (
                <li key={e.id} className="admin-list__row">
                  <span lang={e.title.lang}>{e.title.text}</span>
                  <span className="admin-meta">
                    {tDynamic(`admin.modules.events.organizers.${e.organizerKind}`, e.organizerKind)} · {dateTime(e.startsAt, zone)} · <code className="admin-code">{e.id}</code>
                  </span>
                </li>
              ))}
            </ul>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('events.review')} labels={formLabels({ submit: t('admin.modules.events.decide') })} disabledReason={readOnlyReason(ctx.can('admin.events.review'), ctx.offline)}>
              <div className="admin-form__grid">
                <SelectField name="eventId" label={t('admin.modules.events.event')} options={events.inReview.map((e) => ({ value: e.id, label: e.id }))} />
                <SelectField
                  name="decision"
                  label={t('admin.modules.events.decision')}
                  options={[
                    { value: 'approve', label: t('admin.modules.events.approve') },
                    { value: 'return', label: t('admin.modules.events.return') },
                  ]}
                />
              </div>
            </ConsoleForm>
          </>
        ) : (
          <Empty>{t('admin.modules.events.noReview')}</Empty>
        )}
      </Panel>
      <Panel id="events-edit" title={t('admin.modules.events.edit')}>
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('events.policy.save')} labels={formLabels({ submit: t('admin.common.saveVersion') })} disabledReason={readOnlyReason(ctx.can('admin.events.policy.edit'), ctx.offline)}>
          <SelectField name="hostingPolicy" label={t('admin.modules.events.hosting')} defaultValue={events.hostingPolicy} options={POLICIES.map((p) => ({ value: p, label: tDynamic(`admin.modules.events.policies.${p}`, p) }))} />
          <p className="admin-note">{t('admin.modules.events.guard')}</p>
        </ConsoleForm>
      </Panel>
    </>
  );
}

/** HC-64 Events: hosting policy, review, counts; attendee lists stay private and payouts go through the second person. */
export const screen: Screen = { group: 'modules', id: 'events', title: () => t('admin.modules.events.title'), render: Events };
