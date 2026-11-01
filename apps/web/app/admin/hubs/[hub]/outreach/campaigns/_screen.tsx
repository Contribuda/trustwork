import { notFound } from 'next/navigation';
import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen, ScreenRoute } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Pill, Table } from '../../participants/_kit';
import { Cohort } from '../../modules/_kit/parts';
import { channelName, className, loadOutreach, MessagePreviewCard, OutreachBanner, OutreachForm, PolicyGateList, purposeName, stateName } from '../_kit/parts';
import { activePolicy, CAMPAIGN_CHANNELS, CAMPAIGN_CLASSES, PURPOSES, type Campaign, type OutreachView } from '../_kit/schemas';

const SLUG = /^[a-z0-9-]{3,60}$/;

function activationBlock(view: OutreachView): string | null {
  if (activePolicy(view).mode === 'strict') return t('adminOutreach.strictOn');
  const s = view.sender;
  if (s.spf !== 'pass' || s.dkim !== 'pass' || s.dmarc !== 'pass') return t('adminOutreach.errors.sender_checks');
  return null;
}

function List(ctx: HubContext, view: OutreachView) {
  const zone = ctx.record.hub.timeZone;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.campaigns.title')} lede={t('adminOutreach.campaigns.lede')} />
      <OutreachBanner view={view} />
      <Panel id="campaigns" title={t('adminOutreach.campaigns.list')}>
        <Table
          testid="campaigns"
          rows={view.campaigns}
          rowKey={(c) => c.id}
          empty={t('adminOutreach.campaigns.none')}
          columns={[
            { label: t('adminOutreach.common.name'), render: (c) => <NextLink href={ctx.href(`outreach/campaigns/${c.id}`)}><span lang={c.name.lang}>{c.name.text}</span></NextLink> },
            { label: t('adminOutreach.campaigns.purpose'), render: (c) => purposeName(c.purpose) },
            { label: t('adminOutreach.common.recipientClass'), render: (c) => className(c.recipientClass) },
            { label: t('adminOutreach.common.channel'), render: (c) => channelName(c.channel) },
            { label: t('adminOutreach.common.state'), render: (c) => <Pill tone={c.state === 'running' ? 'pass' : c.state === 'paused' || c.state === 'stopped' ? 'warn' : 'neutral'}>{stateName(c.state)}</Pill> },
            { label: t('adminOutreach.campaigns.audience'), render: (c) => <Cohort value={c.audience} /> },
            { label: t('adminOutreach.campaigns.lastDryRun'), render: (c) => (c.lastDryRun ? dateTime(c.lastDryRun, zone) : t('adminOutreach.campaigns.neverDryRun')) },
          ]}
        />
      </Panel>
      <Panel id="draft-campaign" title={t('adminOutreach.campaigns.draft')}>
        <OutreachForm ctx={ctx} command="outreach.campaign_draft" submit={t('adminOutreach.campaigns.saveDraft')} can={['admin.notifications.template.edit']} variant="secondary">
          <TextInput name="name" label={t('adminOutreach.common.name')} isRequired />
          <SelectField name="purpose" label={t('adminOutreach.campaigns.purpose')} options={PURPOSES.map((p) => ({ value: p, label: purposeName(p) }))} />
          <SelectField name="recipientClass" label={t('adminOutreach.common.recipientClass')} options={CAMPAIGN_CLASSES.map((c) => ({ value: c, label: className(c) }))} />
          <SelectField name="channel" label={t('adminOutreach.common.channel')} options={CAMPAIGN_CHANNELS.map((c) => ({ value: c, label: channelName(c) }))} description={t('adminOutreach.campaigns.channelHelp')} />
        </OutreachForm>
      </Panel>
    </>
  );
}

function Detail(ctx: HubContext, view: OutreachView, c: Campaign) {
  const zone = ctx.record.hub.timeZone;
  const blocked = activationBlock(view);
  const paused = view.autoPauses.filter((p) => p.campaignId === c.id);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={c.name.text} lede={t('adminOutreach.campaigns.detailLede')} />
      <OutreachBanner view={view} />
      <p>
        <NextLink href={ctx.href('outreach/campaigns')}>{t('adminOutreach.campaigns.back')}</NextLink>
      </p>
      <Panel id="summary" title={t('adminOutreach.campaigns.summary')}>
        <KeyValues
          rows={[
            { label: t('adminOutreach.campaigns.purpose'), value: purposeName(c.purpose) },
            { label: t('adminOutreach.common.recipientClass'), value: className(c.recipientClass) },
            { label: t('adminOutreach.common.channel'), value: channelName(c.channel) },
            { label: t('adminOutreach.campaigns.jurisdiction'), value: c.jurisdiction },
            { label: t('adminOutreach.common.state'), value: stateName(c.state) },
            { label: t('adminOutreach.campaigns.audience'), value: <Cohort value={c.audience} /> },
            { label: t('adminOutreach.campaigns.sequence'), value: c.sequence.map((s) => t('adminOutreach.campaigns.step', { step: s.step, days: s.afterDays })).join(' · ') },
            { label: t('adminOutreach.campaigns.dailyCap'), value: String(c.dailyCap) },
            { label: t('adminOutreach.campaigns.autonomy'), value: tDynamic(`adminOutreach.autonomy.${c.autonomy}`, c.autonomy) },
          ]}
        />
        {!c.activatedBefore ? <p className="admin-note">{t('adminOutreach.campaigns.firstVersion')}</p> : null}
        {paused.map((p) => (
          <p key={p.at} className="admin-callout admin-callout--warning">
            {t('adminOutreach.campaigns.autoPaused', { rule: tDynamic(`adminOutreach.pauseRules.${p.rule}`, p.rule), date: dateTime(p.at, zone) })}
          </p>
        ))}
      </Panel>
      <Panel id="gates" title={t('adminOutreach.campaigns.gates')}>
        <p className="admin-note">{c.lastDryRun ? t('adminOutreach.campaigns.dryRun', { date: dateTime(c.lastDryRun, zone) }) : t('adminOutreach.campaigns.neverDryRun')}</p>
        <PolicyGateList gates={c.gates} />
        <OutreachForm ctx={ctx} command="outreach.campaign_dry_run" fields={{ campaign: c.id }} submit={t('adminOutreach.campaigns.runDryRun')} can={['admin.notifications.template.edit']} variant="secondary" />
      </Panel>
      <Panel id="previews" title={t('adminOutreach.campaigns.previews')}>
        <p className="admin-note">{t('adminOutreach.campaigns.previewsHelp')}</p>
        <div className="admin-cards" data-testid="campaign-previews">
          {c.previews.map((p) => (
            <MessagePreviewCard key={`${p.lang}-${p.jurisdiction}`} preview={p} />
          ))}
        </div>
      </Panel>
      <Panel id="activation" title={t('adminOutreach.campaigns.activation')}>
        <OutreachForm ctx={ctx} command="outreach.campaign_request_activation" fields={{ campaign: c.id }} submit={t('adminOutreach.campaigns.requestActivation')} can={['admin.notifications.broadcast']} secondPerson blocked={blocked} />
      </Panel>
      <Panel id="pause-stop" title={t('adminOutreach.campaigns.pauseStop')}>
        <OutreachForm ctx={ctx} command="outreach.campaign_pause" fields={{ campaign: c.id }} submit={t('adminOutreach.campaigns.pause')} can={['admin.notifications.broadcast', 'admin.pipelines.pause']} variant="secondary" />
        <OutreachForm ctx={ctx} command="outreach.campaign_stop" fields={{ campaign: c.id }} submit={t('adminOutreach.campaigns.stop')} can={['admin.notifications.broadcast', 'admin.pipelines.pause']} variant="danger" />
      </Panel>
    </>
  );
}

function Campaigns(ctx: HubContext, route: ScreenRoute) {
  const view = loadOutreach(ctx);
  if (!route.rest.length) return List(ctx, view);
  const found = view.campaigns.find((c) => c.id === route.rest[0]);
  if (!found) notFound();
  return Detail(ctx, view, found);
}

/** HC-172 Campaigns: list, draft, and each campaign with its gates, exact previews and activation by a second person. */
export const screen: Screen = { group: 'outreach', id: 'campaigns', title: () => t('adminOutreach.campaigns.title'), accepts: (rest) => rest.length === 1 && SLUG.test(rest[0]!), render: Campaigns };
