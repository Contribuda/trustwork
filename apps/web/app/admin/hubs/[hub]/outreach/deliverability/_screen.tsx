import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Pill, Table } from '../../participants/_kit';
import { Cohort } from '../../modules/_kit/parts';
import { loadOutreach, OutreachBanner, OutreachForm } from '../_kit/parts';
import { THRESHOLDS } from '../_kit/schemas';

const percent = (value: string | null) => (value === null ? t('admin.common.notRecorded') : t('adminOutreach.deliverability.percent', { value }));
const CHECK_TONE = { pass: 'pass', fail: 'fail', pending: 'warn' } as const;

function Deliverability(ctx: HubContext) {
  const view = loadOutreach(ctx);
  const zone = ctx.record.hub.timeZone;
  const s = view.sender;
  const check = (state: 'pass' | 'fail' | 'pending') => <Pill tone={CHECK_TONE[state]}>{tDynamic(`adminOutreach.checks.${state}`, state)}</Pill>;
  const paused = view.campaigns.filter((c) => c.state === 'paused');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.deliverability.title')} lede={t('adminOutreach.deliverability.lede')} />
      <OutreachBanner view={view} />
      <Panel id="sender" title={t('adminOutreach.deliverability.sender')}>
        <KeyValues
          rows={[
            { label: t('adminOutreach.deliverability.domain'), value: <code className="admin-code">{s.domain}</code> },
            { label: 'SPF', value: check(s.spf) },
            { label: 'DKIM', value: check(s.dkim) },
            { label: 'DMARC', value: check(s.dmarc) },
            { label: t('adminOutreach.deliverability.ramp'), value: tDynamic(`adminOutreach.ramp.${s.rampStage}`, s.rampStage) },
            { label: t('adminOutreach.deliverability.dailyCap'), value: String(s.dailyCap) },
            { label: t('adminOutreach.deliverability.checked'), value: s.checkedAt ? dateTime(s.checkedAt, zone) : t('adminOutreach.deliverability.neverChecked') },
          ]}
        />
        <p className="admin-note">{t('adminOutreach.deliverability.separateIdentity')}</p>
        <OutreachForm ctx={ctx} command="outreach.dns_recheck" submit={t('adminOutreach.deliverability.recheck')} can={['admin.notifications.template.edit']} variant="secondary" />
      </Panel>
      <Panel id="rates" title={t('adminOutreach.deliverability.rates')}>
        <KeyValues
          rows={[
            { label: t('adminOutreach.deliverability.sent'), value: <Cohort value={view.rates.sent} /> },
            { label: t('adminOutreach.deliverability.bounces'), value: percent(view.rates.bouncePercent) },
            { label: t('adminOutreach.deliverability.complaints'), value: percent(view.rates.complaintPercent) },
            { label: t('adminOutreach.deliverability.thresholds'), value: t('adminOutreach.deliverability.thresholdsValue', { warn: THRESHOLDS.complaintWarnPercent, pause: THRESHOLDS.complaintPausePercent, bounce: THRESHOLDS.hardBouncePausePercent }) },
          ]}
        />
        <p className="admin-note">{t('adminOutreach.deliverability.noTracking')}</p>
      </Panel>
      <Panel id="auto-pauses" title={t('adminOutreach.deliverability.autoPauses')}>
        <Table
          rows={view.autoPauses}
          rowKey={(p) => `${p.campaignId}-${p.at}`}
          empty={t('adminOutreach.deliverability.noAutoPauses')}
          columns={[
            { label: t('adminOutreach.deliverability.campaign'), render: (p) => view.campaigns.find((c) => c.id === p.campaignId)?.name.text ?? p.campaignId },
            { label: t('adminOutreach.deliverability.rule'), render: (p) => tDynamic(`adminOutreach.pauseRules.${p.rule}`, p.rule) },
            { label: t('adminOutreach.deliverability.at'), render: (p) => dateTime(p.at, zone) },
          ]}
        />
        {paused.length ? (
          <OutreachForm ctx={ctx} command="outreach.campaign_resume" submit={t('adminOutreach.deliverability.resume')} can={['admin.notifications.broadcast']} variant="secondary">
            <SelectField name="campaign" label={t('adminOutreach.deliverability.campaign')} options={paused.map((c) => ({ value: c.id, label: c.name.text }))} />
          </OutreachForm>
        ) : null}
      </Panel>
    </>
  );
}

/** HC-176 Deliverability: the outreach sender identity, DNS checks, ramp, rates against thresholds and auto-pauses; cohorts only. */
export const screen: Screen = { group: 'outreach', id: 'deliverability', title: () => t('adminOutreach.deliverability.title'), render: Deliverability };
