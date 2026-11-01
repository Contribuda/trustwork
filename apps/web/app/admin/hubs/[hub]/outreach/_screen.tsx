import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../_components/context';
import type { Screen } from '../../../_components/screen';
import { ConsoleHeader, KeyValues, Panel } from '../../../_components/shell';
import { Pill, Tiles } from '../participants/_kit';
import { Cohort } from '../modules/_kit/parts';
import { EngineFloor, loadOutreach, OutreachBanner, OutreachForm } from './_kit/parts';
import { activePolicy, GATE_IDS } from './_kit/schemas';

function Overview(ctx: HubContext) {
  const view = loadOutreach(ctx);
  const policy = activePolicy(view);
  const draft = view.policyVersions.find((p) => p.state === 'draft') ?? null;
  const running = view.campaigns.filter((c) => c.state === 'running').length;
  const waiting = view.replies.filter((r) => r.handled === 'waiting').length;
  const failing = GATE_IDS.map((id) => ({ id, count: view.campaigns.filter((c) => c.gates.some((g) => g.id === id && g.state === 'fail')).length })).filter((g) => g.count > 0).sort((a, b) => b.count - a.count);
  const checks = [view.sender.spf, view.sender.dkim, view.sender.dmarc];
  const sender = checks.every((s) => s === 'pass') ? 'pass' : checks.some((s) => s === 'fail') ? 'fail' : 'pending';
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.overview.title')} lede={t('adminOutreach.overview.lede')} />
      <OutreachBanner view={view} />
      <Panel id="mode" title={t('adminOutreach.overview.mode')}>
        <KeyValues
          rows={[
            { label: t('adminOutreach.overview.activeMode'), value: <span data-testid="active-mode">{tDynamic(`adminOutreach.modes.${policy.mode}`, policy.mode)}</span> },
            { label: t('adminOutreach.overview.activeVersion'), value: t('adminOutreach.common.version', { version: policy.version }) },
            { label: t('adminOutreach.overview.jurisdictions'), value: policy.jurisdictions.length ? policy.jurisdictions.map((j) => j.scope).join(', ') : t('adminOutreach.overview.noJurisdictions') },
            { label: t('adminOutreach.overview.draft'), value: draft ? t('adminOutreach.overview.draftValue', { version: draft.version, mode: tDynamic(`adminOutreach.modes.${draft.mode}`, draft.mode) }) : t('admin.common.none') },
          ]}
        />
      </Panel>
      <Panel id="state" title={t('adminOutreach.overview.state')}>
        <Tiles
          testid="outreach-tiles"
          items={[
            { key: 'running', label: t('adminOutreach.overview.running'), value: String(running) },
            { key: 'drafts', label: t('adminOutreach.overview.campaigns'), value: String(view.campaigns.length) },
            { key: 'replies', label: t('adminOutreach.overview.repliesWaiting'), value: String(waiting) },
            { key: 'suppressed', label: t('adminOutreach.overview.registrySuppressed'), value: <Cohort value={view.suppressionCounts.find((s) => s.reason === 'registry')?.count ?? null} /> },
            { key: 'sender', label: t('adminOutreach.overview.sender'), value: <Pill tone={sender === 'pass' ? 'pass' : sender === 'fail' ? 'fail' : 'warn'}>{tDynamic(`adminOutreach.checks.${sender}`, sender)}</Pill> },
          ]}
        />
        <h3>{t('adminOutreach.overview.failingGates')}</h3>
        {failing.length ? (
          <ul className="admin-list" data-testid="failing-gates">
            {failing.map((g) => (
              <li key={g.id}>
                {tDynamic(`adminOutreach.gates.${g.id}.name`, g.id)} <span className="admin-meta">· {t('adminOutreach.overview.campaignCount', { count: g.count })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminOutreach.overview.noFailingGates')}</p>
        )}
      </Panel>
      <Panel id="floor" title={t('adminOutreach.floor.title')}>
        <EngineFloor />
      </Panel>
      <Panel id="kill-switch" title={t('adminOutreach.overview.killSwitch')}>
        <p className="admin-note">{t('adminOutreach.overview.killSwitchHelp')}</p>
        <OutreachForm ctx={ctx} command="outreach.kill_switch_engage" submit={t('adminOutreach.overview.engage')} can={['admin.pipelines.pause']} variant="danger" blocked={view.killSwitch === 'engaged' ? t('adminOutreach.killSwitchEngaged') : null} />
      </Panel>
    </>
  );
}

/** HC-170 Outreach overview: mode per jurisdiction, campaigns, failing gates, sender state, replies; the kill switch. */
export const screen: Screen = { group: 'outreach', id: 'overview', title: () => t('adminOutreach.overview.title'), render: Overview };
