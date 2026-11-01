import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen, ScreenRoute } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Table } from '../../participants/_kit';
import { Cohort } from '../../modules/_kit/parts';
import { loadOutreach, OutreachBanner, OutreachForm, SuppressionLookup } from '../_kit/parts';
import { SUPPRESSION_REASONS, SUPPRESSION_SCOPES } from '../_kit/schemas';

function Suppression(ctx: HubContext, route: ScreenRoute) {
  const view = loadOutreach(ctx);
  const zone = ctx.record.hub.timeZone;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.suppression.title')} lede={t('adminOutreach.suppression.lede')} />
      <OutreachBanner view={view} />
      <Panel id="counts" title={t('adminOutreach.suppression.counts')}>
        <Table
          testid="suppression-counts"
          rows={view.suppressionCounts}
          rowKey={(r) => `${r.reason}-${r.scope}`}
          empty={t('adminOutreach.suppression.noCounts')}
          columns={[
            { label: t('adminOutreach.suppression.reason'), render: (r) => tDynamic(`adminOutreach.suppression.reasons.${r.reason}`, r.reason) },
            { label: t('adminOutreach.suppression.scope'), render: (r) => tDynamic(`adminOutreach.suppression.scopes.${r.scope}`, r.scope) },
            { label: t('adminOutreach.suppression.count'), render: (r) => <Cohort value={r.count} /> },
          ]}
        />
        <KeyValues rows={[{ label: t('adminOutreach.suppression.doNotCollect'), value: <Cohort value={view.doNotCollect} /> }]} />
      </Panel>
      <SuppressionLookup ctx={ctx} view={view} query={route.query['f.identifier'] ?? ''} />
      <Panel id="add" title={t('adminOutreach.suppression.add')}>
        <OutreachForm ctx={ctx} command="outreach.suppression_add" submit={t('adminOutreach.suppression.add')} can={['admin.privacy.request.read']} variant="secondary">
          <TextInput name="identifier" label={t('adminOutreach.suppression.identifier')} isRequired />
          <SelectField name="reason" label={t('adminOutreach.suppression.reason')} options={SUPPRESSION_REASONS.map((r) => ({ value: r, label: tDynamic(`adminOutreach.suppression.reasons.${r}`, r) }))} />
          <SelectField name="scope" label={t('adminOutreach.suppression.scope')} options={SUPPRESSION_SCOPES.map((s) => ({ value: s, label: tDynamic(`adminOutreach.suppression.scopes.${s}`, s) }))} />
        </OutreachForm>
      </Panel>
      <Panel id="registries" title={t('adminOutreach.suppression.registries')}>
        <Table
          testid="registry-polls"
          rows={view.registryPolls}
          rowKey={(r) => r.registry.text}
          empty={t('adminOutreach.suppression.noRegistries')}
          columns={[
            { label: t('adminOutreach.suppression.registry'), render: (r) => <span lang={r.registry.lang}>{r.registry.text}</span> },
            { label: t('adminOutreach.campaigns.jurisdiction'), render: (r) => r.jurisdiction },
            { label: t('adminOutreach.suppression.lastPolled'), render: (r) => (r.lastPolledAt ? dateTime(r.lastPolledAt, zone) : t('adminOutreach.suppression.notPolled')) },
            { label: t('adminOutreach.suppression.cadence'), render: (r) => t('adminOutreach.suppression.cadenceValue', { days: r.cadenceDays }) },
          ]}
        />
        {view.registryPolls.length ? <OutreachForm ctx={ctx} command="outreach.registry_batch_record" submit={t('adminOutreach.suppression.recordBatch')} can={['admin.privacy.request.read']} variant="secondary" /> : null}
      </Panel>
    </>
  );
}

/** HC-175 Suppression and objections: counts by reason and scope, exact lookup only, registry polls; no list browsing. */
export const screen: Screen = { group: 'outreach', id: 'suppression', title: () => t('adminOutreach.suppression.title'), render: Suppression };
