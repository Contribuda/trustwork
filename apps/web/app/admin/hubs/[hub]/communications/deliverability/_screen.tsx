import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason, SelectField } from '../../../../_components/forms';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Cohort, Empty, loadProduct } from '../../modules/_kit/parts';

const templateName = (key: string) => tDynamic(`admin.communications.templates.names.${key}`, key);
const percent = (value: string | null) => (value === null ? t('admin.common.notRecorded') : t('admin.communications.deliverability.percent', { value }));

async function Deliverability(ctx: HubContext) {
  const { communications } = await loadProduct(ctx);
  const threshold = Number(communications.bounceThresholdPercent);
  const active = communications.templates.filter((x) => x.status === 'active');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.communications.deliverability.title')} lede={t('admin.communications.deliverability.lede')} />
      <Panel id="deliverability" title={t('admin.communications.deliverability.rates')}>
        {communications.deliverability.length ? (
          <table className="plain-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.communications.deliverability.template')}</th>
                <th scope="col">{t('admin.communications.deliverability.sent')}</th>
                <th scope="col">{t('admin.communications.deliverability.delivered')}</th>
                <th scope="col">{t('admin.communications.deliverability.bounced')}</th>
                <th scope="col">{t('admin.communications.deliverability.complaints')}</th>
              </tr>
            </thead>
            <tbody>
              {communications.deliverability.map((d) => {
                const high = d.bouncePercent !== null && Number(d.bouncePercent) > threshold;
                return (
                  <tr key={`${d.templateKey}-${d.channel}`}>
                    <td data-label={t('admin.communications.deliverability.template')}>
                      {templateName(d.templateKey)} <span className="admin-meta">· {tDynamic(`admin.communications.channels.${d.channel}`, d.channel)}</span>
                    </td>
                    <td data-label={t('admin.communications.deliverability.sent')}>
                      <Cohort value={d.sent} />
                    </td>
                    <td data-label={t('admin.communications.deliverability.delivered')}>{percent(d.deliveredPercent)}</td>
                    <td data-label={t('admin.communications.deliverability.bounced')}>
                      {percent(d.bouncePercent)}
                      {high ? <span className="admin-warning"> · {t('admin.communications.deliverability.aboveThreshold')}</span> : null}
                    </td>
                    <td data-label={t('admin.communications.deliverability.complaints')}>{percent(d.complaintPercent)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>{t('admin.communications.deliverability.none')}</Empty>
        )}
        <KeyValues
          rows={[
            { label: t('admin.communications.deliverability.threshold'), value: percent(communications.bounceThresholdPercent) },
            { label: t('admin.communications.deliverability.quietHours'), value: t('admin.communications.deliverability.quietValue', { from: communications.quietHours.from, to: communications.quietHours.to }) },
          ]}
        />
        <p className="admin-note">{t('admin.communications.deliverability.noTracking')}</p>
      </Panel>
      {active.length ? (
        <Panel id="pause-template" title={t('admin.communications.deliverability.pause')}>
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('comms.template.pause')} labels={formLabels({ submit: t('admin.communications.deliverability.pause') })} submitVariant="danger" disabledReason={readOnlyReason(ctx.can('admin.notifications.template.edit'), ctx.offline)}>
            <SelectField name="templateKey" label={t('admin.communications.deliverability.template')} options={active.map((x) => ({ value: x.key, label: templateName(x.key) }))} />
            <p className="admin-note">{t('admin.communications.deliverability.transactional')}</p>
          </ConsoleForm>
        </Panel>
      ) : null}
    </>
  );
}

/** HC-122 Deliverability: delivery, bounce and complaint rates per template and channel; never per person. */
export const screen: Screen = { group: 'communications', id: 'deliverability', title: () => t('admin.communications.deliverability.title'), render: Deliverability };
