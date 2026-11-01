import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Cohort, Empty, loadProduct, StatePill, UniqueSelect } from '../../modules/_kit/parts';

async function Announcements(ctx: HubContext) {
  const { communications } = await loadProduct(ctx);
  const zone = ctx.record.hub.timeZone;
  const canSend = ctx.can('admin.notifications.broadcast');
  const unsent = communications.announcements.filter((a) => a.state !== 'sent');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.communications.announcements.title')} lede={t('admin.communications.announcements.lede')} />
      <Panel id="announcements" title={t('admin.communications.announcements.list')}>
        {communications.announcements.length ? (
          <ul className="admin-list">
            {communications.announcements.map((a) => (
              <li key={a.id} className="admin-list__row" data-testid={`announcement-${a.id}`}>
                <span>
                  {tDynamic(`admin.communications.announcements.kinds.${a.kind}`, a.kind)}: <span lang={a.title.lang}>{a.title.text}</span>
                </span>
                <span>
                  {tDynamic(`admin.communications.announcements.audiences.${a.audience}`, a.audience)} · <Cohort value={a.audienceSize} />
                </span>
                <span className="admin-meta">
                  {t('admin.communications.announcements.basis', { basis: tDynamic(`admin.communications.announcements.bases.${a.lawfulBasis}`, a.lawfulBasis) })} · {dateTime(a.at, zone)}
                </span>
                <StatePill state={a.state} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('admin.communications.announcements.none')}</Empty>
        )}
        <p className="admin-note">{t('admin.communications.announcements.optedIn')}</p>
      </Panel>
      <div className="admin-grid">
        {unsent.length ? (
          <Panel id="announcement-send" title={t('admin.communications.announcements.send')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('comms.announcement.send')} labels={formLabels({ submit: t('admin.communications.announcements.send') })} disabledReason={readOnlyReason(canSend, ctx.offline)}>
              <UniqueSelect id="send-announcement" name="announcementId" label={t('admin.communications.announcements.item')} options={unsent.map((a) => ({ value: a.id, label: a.id }))} />
              <p className="admin-note">{t('admin.communications.announcements.basisShown')}</p>
            </ConsoleForm>
          </Panel>
        ) : null}
        <Panel id="announcement-draft" title={t('admin.communications.announcements.draft')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('comms.announcement.draft')} labels={formLabels({ submit: t('admin.communications.announcements.draft') })} disabledReason={readOnlyReason(canSend, ctx.offline)}>
            <SelectField
              name="kind"
              label={t('admin.communications.announcements.kind')}
              options={[
                { value: 'announcement', label: t('admin.communications.announcements.kinds.announcement') },
                { value: 'legal_notice', label: t('admin.communications.announcements.kinds.legal_notice') },
              ]}
            />
            <TextInput name="title" label={t('admin.communications.announcements.titleLabel')} isRequired />
          </ConsoleForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-123 Announcements: announcements only to people who opted in and legal notices, each with its lawful basis. */
export const screen: Screen = { group: 'communications', id: 'announcements', title: () => t('admin.communications.announcements.title'), render: Announcements };
