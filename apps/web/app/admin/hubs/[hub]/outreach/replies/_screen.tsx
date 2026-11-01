import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { Pill, Table } from '../../participants/_kit';
import { loadOutreach, OutreachBanner, OutreachForm } from '../_kit/parts';
import { REPLY_CLASSES } from '../_kit/schemas';

function Replies(ctx: HubContext) {
  const view = loadOutreach(ctx);
  const zone = ctx.record.hub.timeZone;
  const open = view.replies.filter((r) => r.handled === 'waiting');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.replies.title')} lede={t('adminOutreach.replies.lede')} />
      <OutreachBanner view={view} />
      <p className="admin-callout admin-callout--warning" data-testid="replies-untrusted">
        {t('adminOutreach.replies.untrusted')}
      </p>
      {view.rehearsal ? (
        <p className="admin-callout" data-testid="replies-rehearsal">
          {t('adminOutreach.replies.rehearsal')}
        </p>
      ) : null}
      <Panel id="replies" title={t('adminOutreach.replies.list')}>
        <Table
          testid="replies"
          rows={view.replies}
          rowKey={(r) => r.id}
          empty={t('adminOutreach.replies.none')}
          columns={[
            { label: t('adminOutreach.replies.class'), render: (r) => tDynamic(`adminOutreach.replyClasses.${r.class}`, r.class) },
            { label: t('adminOutreach.replies.text'), render: (r) => <q lang={r.text.lang} data-untrusted="true">{r.text.text}</q> },
            { label: t('adminOutreach.replies.received'), render: (r) => dateTime(r.receivedAt, zone) },
            { label: t('adminOutreach.replies.handled'), render: (r) => <Pill tone={r.handled === 'waiting' ? 'warn' : 'neutral'}>{tDynamic(`adminOutreach.handled.${r.handled}`, r.handled)}</Pill> },
          ]}
        />
        <p className="admin-note">{t('adminOutreach.replies.handoff')}</p>
      </Panel>
      {view.replies.length ? (
        <Panel id="reclassify" title={t('adminOutreach.replies.reclassify')}>
          <OutreachForm ctx={ctx} command="outreach.reply_reclassify" submit={t('adminOutreach.replies.reclassify')} can={['admin.notifications.template.edit']} variant="secondary">
            <SelectField name="reply" label={t('adminOutreach.replies.reply')} options={view.replies.map((r) => ({ value: r.id, label: `${r.id} · ${tDynamic(`adminOutreach.replyClasses.${r.class}`, r.class)}` }))} />
            <SelectField name="class" label={t('adminOutreach.replies.class')} options={REPLY_CLASSES.map((c) => ({ value: c, label: tDynamic(`adminOutreach.replyClasses.${c}`, c) }))} />
          </OutreachForm>
          <OutreachForm ctx={ctx} command="outreach.reply_wrong_recipient" submit={t('adminOutreach.replies.wrongRecipient')} can={['admin.notifications.template.edit']} variant="secondary">
            <SelectField name="reply" label={t('adminOutreach.replies.reply')} options={view.replies.map((r) => ({ value: r.id, label: r.id }))} />
          </OutreachForm>
          {open.length ? <p className="admin-meta">{t('adminOutreach.replies.waitingCount', { count: open.length })}</p> : null}
        </Panel>
      ) : null}
    </>
  );
}

/** HC-174 Replies and hand-off: replies by class, untrusted; staff answer in the entity's thread; no button acts on reply text. */
export const screen: Screen = { group: 'outreach', id: 'replies', title: () => t('adminOutreach.replies.title'), render: Replies };
