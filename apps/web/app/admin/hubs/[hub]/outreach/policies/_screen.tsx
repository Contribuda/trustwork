import { OUTREACH_CHANNELS, OUTREACH_MODES, RECIPIENT_CLASSES, resolveOutreach, type OutreachPolicy, type RecipientClass, type OutreachChannel } from '@trustwork/contracts/client';
import { getPack, outreachPackRules } from '@trustwork/country-packs';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen, ScreenRoute } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { dateTime, localized } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { GetForm, Pill, Table } from '../../participants/_kit';
import { channelName, className, EngineFloor, loadOutreach, OutreachBanner, OutreachForm } from '../_kit/parts';
import { activePolicy, type PolicyVersion } from '../_kit/schemas';

const modeName = (mode: string) => tDynamic(`adminOutreach.modes.${mode}`, mode);
const asPolicy = (v: PolicyVersion): OutreachPolicy => ({ mode: v.mode, packs: v.packs, counselApproval: v.counselApproval, secondPersonApprovalId: v.secondPersonApprovalId, jurisdictions: v.jurisdictions });

function Rules({ version }: { version: PolicyVersion }) {
  if (!version.jurisdictions.length) return <p className="admin-meta">{t('adminOutreach.policies.noRules')}</p>;
  return (
    <>
      {version.jurisdictions.map((j) => {
        const rows = RECIPIENT_CLASSES.flatMap((rc) => OUTREACH_CHANNELS.flatMap((ch) => {
          const rule = j.recipientClasses[rc]?.[ch];
          return rule ? [{ key: `${rc}-${ch}`, rc, ch, basis: rule.basis }] : [];
        }));
        return (
          <div key={j.scope} data-testid={`rules-${j.scope}`}>
            <h4>{t('adminOutreach.policies.rulesFor', { scope: j.scope })}</h4>
            <Table
              rows={rows}
              rowKey={(r) => r.key}
              empty={t('adminOutreach.policies.noRules')}
              columns={[
                { label: t('adminOutreach.common.recipientClass'), render: (r) => className(r.rc) },
                { label: t('adminOutreach.common.channel'), render: (r) => channelName(r.ch) },
                { label: t('adminOutreach.policies.basis'), render: (r) => <Pill tone={r.basis === 'prohibited' ? 'fail' : 'neutral'}>{tDynamic(`adminOutreach.bases.${r.basis}`, r.basis)}</Pill> },
              ]}
            />
            <KeyValues
              rows={[
                { label: t('adminOutreach.policies.notice'), value: tDynamic(`adminOutreach.noticeTimings.${j.notice.timing}`, j.notice.timing) },
                { label: t('adminOutreach.policies.volume'), value: t('adminOutreach.policies.volumeValue', { perDay: j.volume.perHubPerDay, perDomain: j.volume.perRecipientDomainPerWeek, touches: j.volume.touchesPerRecipientPerPurpose, days: j.volume.minDaysBetweenTouches }) },
                { label: t('adminOutreach.policies.optOut'), value: t('adminOutreach.policies.optOutValue', { hours: j.optOut.honourWithinHours }) },
                { label: t('adminOutreach.policies.quietHours'), value: <span lang="en">{j.quietHours.allowed}</span> },
              ]}
            />
          </div>
        );
      })}
    </>
  );
}

function Policies(ctx: HubContext, route: ScreenRoute) {
  const view = loadOutreach(ctx);
  const active = activePolicy(view);
  const drafts = view.policyVersions.filter((p) => p.state === 'draft');
  const binding = ctx.record.hub.countryPack;
  const pack = binding ? getPack(binding.code) : null;
  const facts = pack?.facets?.outreachLaw ?? [];
  const zone = ctx.record.hub.timeZone;

  // Simulate one recipient against the active version and each draft (read only: nothing is sent or stored).
  const q = route.query;
  const recipientClass = (RECIPIENT_CLASSES as readonly string[]).includes(q['f.class'] ?? '') ? (q['f.class'] as RecipientClass) : null;
  const channel = (OUTREACH_CHANNELS as readonly string[]).includes(q['f.channel'] ?? '') ? (q['f.channel'] as OutreachChannel) : null;
  const jurisdiction = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test((q['f.jurisdiction'] ?? '').trim().toUpperCase()) ? (q['f.jurisdiction'] ?? '').trim().toUpperCase() : null;
  const hubJurisdiction = drafts[0]?.jurisdictions[0]?.scope ?? active.jurisdictions[0]?.scope ?? (binding ? binding.code.toUpperCase() : 'ZZ');
  const packRules = binding ? outreachPackRules(binding.code.toUpperCase(), facts) : [];
  const simulate = recipientClass && channel
    ? [active, ...drafts].map((v) => ({
        version: v,
        decision: resolveOutreach({ recipientClass, channel, recipientJurisdiction: jurisdiction, hubJurisdiction, policy: asPolicy(v), packRules, sourceAllowsOutreach: q['f.source'] === 'on', suppressed: false, recordedConsent: q['f.consent'] === 'on' }),
      }))
    : null;

  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminOutreach.policies.title')} lede={t('adminOutreach.policies.lede')} />
      <OutreachBanner view={view} />
      <Panel id="versions" title={t('adminOutreach.policies.versions')}>
        <Table
          testid="policy-versions"
          rows={view.policyVersions}
          rowKey={(v) => v.id}
          empty=""
          columns={[
            { label: t('adminOutreach.common.versionLabel'), render: (v) => t('adminOutreach.common.version', { version: v.version }) },
            { label: t('adminOutreach.policies.mode'), render: (v) => modeName(v.mode) },
            { label: t('adminOutreach.common.state'), render: (v) => <Pill tone={v.state === 'active' ? 'pass' : 'neutral'}>{tDynamic(`adminOutreach.states.${v.state}`, v.state)}</Pill> },
            { label: t('adminOutreach.policies.counsel'), render: (v) => (v.counselApproval ? <span lang="en">{v.counselApproval.reference}</span> : v.mode === 'strict' ? t('adminOutreach.policies.notNeeded') : <span className="admin-warning">{t('adminOutreach.policies.missing')}</span>) },
            { label: t('adminOutreach.policies.packs'), render: (v) => (v.packs.length ? v.packs.join(', ') : t('admin.common.none')) },
            { label: t('adminOutreach.policies.drafted'), render: (v) => dateTime(v.draftedAt, zone) },
          ]}
        />
      </Panel>
      {drafts.map((d) => (
        <Panel key={d.id} id={`draft-${d.version}`} title={t('adminOutreach.policies.draftTitle', { version: d.version })}>
          <p lang={d.reason.lang}>{d.reason.text}</p>
          <KeyValues
            rows={[
              { label: t('adminOutreach.policies.change'), value: <span data-testid="config-diff">{t('adminOutreach.policies.modeChange', { from: modeName(active.mode), to: modeName(d.mode) })}</span> },
              { label: t('adminOutreach.policies.counsel'), value: d.counselApproval ? <span lang="en">{d.counselApproval.reference}</span> : <span className="admin-warning">{t('adminOutreach.policies.missing')}</span> },
              { label: t('adminOutreach.policies.secondPerson'), value: t('adminOutreach.policies.secondPersonValue') },
            ]}
          />
          <Rules version={d} />
          {d.mode !== 'strict' && !d.counselApproval ? (
            <p className="admin-callout admin-callout--warning" data-testid="counsel-required">
              {t('adminOutreach.policies.counselRequired')}
            </p>
          ) : null}
          <OutreachForm
            ctx={ctx}
            command="outreach.policy_request_activation"
            fields={{ version: d.id }}
            submit={t('adminOutreach.policies.requestActivation')}
            can={['admin.hub.jurisdiction.activate']}
            secondPerson
            blocked={d.mode !== 'strict' && !d.counselApproval ? t('adminOutreach.policies.counselRequired') : null}
          />
        </Panel>
      ))}
      <Panel id="draft-version" title={t('adminOutreach.policies.draftVersion')}>
        <OutreachForm ctx={ctx} command="outreach.policy_draft" submit={t('adminOutreach.policies.saveDraft')} can={['admin.hub.jurisdiction.edit']} variant="secondary">
          <SelectField name="mode" label={t('adminOutreach.policies.mode')} options={OUTREACH_MODES.map((m) => ({ value: m, label: modeName(m) }))} description={t('adminOutreach.policies.modeHelp')} />
        </OutreachForm>
      </Panel>
      <Panel id="simulate" title={t('adminOutreach.policies.simulate')}>
        <p className="admin-note">{t('adminOutreach.policies.simulateHelp')}</p>
        <GetForm ctx={ctx} path="outreach/policies" submit={t('adminOutreach.policies.simulateRun')} id="simulate-form">
          <SelectField name="class" label={t('adminOutreach.common.recipientClass')} options={RECIPIENT_CLASSES.map((c) => ({ value: c, label: className(c) }))} defaultValue={recipientClass ?? undefined} />
          <SelectField name="channel" label={t('adminOutreach.common.channel')} options={OUTREACH_CHANNELS.map((c) => ({ value: c, label: channelName(c) }))} defaultValue={channel ?? undefined} />
          <TextInput name="jurisdiction" label={t('adminOutreach.policies.recipientJurisdiction')} description={t('adminOutreach.policies.recipientJurisdictionHelp')} defaultValue={jurisdiction ?? ''} />
          <label className="admin-check-input" htmlFor="sim-source">
            <input id="sim-source" type="checkbox" name="f.source" defaultChecked={q['f.source'] === 'on'} />
            <span>{t('adminOutreach.policies.sourceAllows')}</span>
          </label>
          <label className="admin-check-input" htmlFor="sim-consent">
            <input id="sim-consent" type="checkbox" name="f.consent" defaultChecked={q['f.consent'] === 'on'} />
            <span>{t('adminOutreach.policies.recordedConsent')}</span>
          </label>
        </GetForm>
        {simulate ? (
          <ul className="admin-list" data-testid="simulation">
            {simulate.map(({ version, decision }) => (
              <li key={version.id} data-contact={decision.contact ? 'true' : 'false'}>
                <strong>{t('adminOutreach.common.version', { version: version.version })}</strong> ({modeName(version.mode)}):{' '}
                {decision.contact ? t('adminOutreach.policies.wouldContact', { basis: tDynamic(`adminOutreach.bases.${decision.basis}`, decision.basis) }) : tDynamic(`adminOutreach.decisions.${decision.reason}`, decision.reason)}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      <Panel id="pack-facts" title={t('adminOutreach.policies.packFacts')}>
        {facts.length ? (
          <ul className="admin-list" data-testid="pack-facts">
            {facts.map((f) => {
              const summary = localized(f.summary);
              return (
                <li key={f.id} data-fact={f.id}>
                  <strong>{tDynamic(`adminOutreach.topics.${f.topic}`, f.topic)}</strong>{' '}
                  <Pill tone={f.counselReview === 'done' ? 'pass' : 'warn'}>{tDynamic(`adminOutreach.counselReview.${f.counselReview}`, f.counselReview)}</Pill>{' '}
                  <span className="admin-meta">· {tDynamic(`adminOutreach.verification.${f.verification}`, f.verification)}</span>
                  <p lang={summary.lang}>{summary.text}</p>
                  <p className="admin-meta">
                    {t('adminOutreach.policies.sources')}{' '}
                    {f.sources.map((s, i) => (
                      <span key={s.url}>
                        {i ? ', ' : ''}
                        <a href={s.url} rel="noreferrer noopener" target="_blank" lang="en">
                          {s.what}
                        </a>
                      </span>
                    ))}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminOutreach.policies.noPackFacts')}</p>
        )}
        <p className="admin-note">{t('adminOutreach.policies.packNote')}</p>
      </Panel>
      <Panel id="floor" title={t('adminOutreach.floor.title')}>
        <EngineFloor />
      </Panel>
    </>
  );
}

/** HC-171 Policies: versions, the draft's rules and change, pack facts with sources, a recipient simulation, the floor. */
export const screen: Screen = { group: 'outreach', id: 'policies', title: () => t('adminOutreach.policies.title'), render: Policies };
