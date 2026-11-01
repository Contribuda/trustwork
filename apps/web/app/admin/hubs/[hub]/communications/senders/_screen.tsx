import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Empty, loadProduct, StatePill } from '../../modules/_kit/parts';

async function Senders(ctx: HubContext) {
  const { communications } = await loadProduct(ctx);
  const zone = ctx.record.hub.timeZone;
  const canEdit = ctx.can('admin.providers.connection.edit');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.communications.senders.title')} lede={t('admin.communications.senders.lede')} />
      <Panel id="sending-domains" title={t('admin.communications.senders.domains')}>
        {communications.domains.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.communications.senders.domain')}</th>
                <th scope="col">{t('admin.communications.senders.spf')}</th>
                <th scope="col">{t('admin.communications.senders.dkim')}</th>
                <th scope="col">{t('admin.communications.senders.dmarc')}</th>
                <th scope="col">{t('admin.communications.senders.replyTo')}</th>
              </tr>
            </thead>
            <tbody>
              {communications.domains.map((d) => (
                <tr key={d.domain}>
                  <td data-label={t('admin.communications.senders.domain')}>
                    <code className="admin-code">{d.domain}</code>
                    <span className="admin-meta"> · {t('admin.communications.senders.checked', { time: dateTime(d.checkedAt, zone) })}</span>
                  </td>
                  <td data-label={t('admin.communications.senders.spf')}>
                    <StatePill state={d.spf} />
                  </td>
                  <td data-label={t('admin.communications.senders.dkim')}>
                    <StatePill state={d.dkim} />
                  </td>
                  <td data-label={t('admin.communications.senders.dmarc')}>
                    <StatePill state={d.dmarc} />
                  </td>
                  <td data-label={t('admin.communications.senders.replyTo')}>
                    <code className="admin-code">{d.replyTo}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.communications.senders.none')}</Empty>
        )}
      </Panel>
      <Panel id="sms-sender" title={t('admin.communications.senders.sms')}>
        <KeyValues
          rows={[
            { label: t('admin.communications.senders.registration'), value: tDynamic(`admin.communications.senders.registrations.${communications.sms.registration}`, communications.sms.registration) },
            { label: t('admin.communications.senders.mode'), value: tDynamic(`admin.providerMode.${communications.sms.mode}`, communications.sms.mode) },
          ]}
        />
      </Panel>
      <div className="admin-grid">
        <Panel id="add-domain" title={t('admin.communications.senders.add')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('comms.domain.add')} labels={formLabels({ submit: t('admin.communications.senders.add') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
            <TextInput name="domain" label={t('admin.communications.senders.domain')} description={t('admin.communications.senders.domainHelp')} isRequired />
          </ConsoleForm>
        </Panel>
        {communications.domains.length ? (
          <Panel id="recheck-domain" title={t('admin.communications.senders.recheck')}>
            <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('comms.domain.recheck')} labels={formLabels({ submit: t('admin.communications.senders.recheck') })} disabledReason={readOnlyReason(canEdit, ctx.offline)}>
              <SelectField name="domain" label={t('admin.communications.senders.domain')} options={communications.domains.map((d) => ({ value: d.domain, label: d.domain }))} />
            </ConsoleForm>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

/** HC-120 Senders: sending domains with SPF, DKIM and DMARC state, reply-to, SMS sender registration (US 10DLC). */
export const screen: Screen = { group: 'communications', id: 'senders', title: () => t('admin.communications.senders.title'), render: Senders };
