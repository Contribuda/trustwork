import { HOLD_CLEAR_EVIDENCE } from '@trustwork/contracts/client';
import { intlTag } from '@trustwork/ui/i18n';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { country, dateTime, longDate, number } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { submitTrustCommand } from '../_actions';
import { PACK_LIST_FACTS, trustOf, type ScreeningMatch } from '../_fixtures';
import { Count, fixturesOn, Lang, Pill, SectionForm, StaffName, staffNames, Table, Tiles, type StaffNames } from '../../participants/_kit';

function percent(share: number): string {
  try {
    return new Intl.NumberFormat(intlTag(), { style: 'percent', maximumFractionDigits: 0 }).format(share);
  } catch {
    return `${Math.round(share * 100)}%`;
  }
}

function MatchCard({ ctx, match, names }: { ctx: HubContext; match: ScreeningMatch; names: StaffNames }) {
  const own = match.originalDecider === ctx.viewer.person.id;
  return (
    <li className="admin-approval" data-testid={`match-${match.id}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">
          {tDynamic(`adminParticipants.subjects.${match.subject.kind}`, match.subject.kind)} · <code className="admin-code">{match.list}</code>
        </h3>
        <Pill tone={match.state === 'open' ? 'warn' : 'neutral'}>{tDynamic(`adminTrust.screening.matchStates.${match.state}`, match.state)}</Pill>
        {match.late ? <Pill tone="fail">{t('adminTrust.screening.late')}</Pill> : null}
      </div>
      <details className="admin-disclosure">
        <summary>{t('adminTrust.screening.underCase', { case: match.caseId })}</summary>
        <KeyValues
          rows={[
            { label: t('adminTrust.screening.screenedName'), value: <Lang text={match.subject.name} /> },
            { label: t('adminTrust.screening.listEntry'), value: <><Lang text={match.entry.name} /> <code className="admin-code">{match.entry.uid}</code></> },
            { label: t('adminTrust.screening.strength'), value: tDynamic(`adminTrust.screening.strengths.${match.strength}`, match.strength) },
          ]}
        />
      </details>
      {match.state === 'open' ? (
        <div className="admin-grid">
          <SectionForm ctx={ctx} action={submitTrustCommand} command="screening.confirm_match" fields={{ matchId: match.id }} submit={t('adminTrust.screening.confirm')} can={['admin.claims.policy.edit']} variant="danger" />
          <SectionForm ctx={ctx} action={submitTrustCommand} command="screening.not_same_person" fields={{ matchId: match.id }} submit={t('adminTrust.screening.notSamePerson')} can={['admin.claims.policy.edit']} secondPerson variant="secondary" />
        </div>
      ) : (
        <>
          <p className="admin-meta">
            {t('adminTrust.appeals.originalDecider')}: <StaffName names={names} id={match.originalDecider} />
          </p>
          <SectionForm ctx={ctx} action={submitTrustCommand} command="screening.decide_appeal" fields={{ matchId: match.id }} submit={t('adminTrust.screening.decideAppeal')} can={['admin.claims.policy.edit']} blocked={own ? t('adminParticipants.errors.original_decider') : null}>
            <SelectField name="decision" label={t('adminTrust.appeals.decision')} options={(['uphold', 'reverse'] as const).map((x) => ({ value: x, label: tDynamic(`adminTrust.screening.appealDecisions.${x}`, x) }))} />
          </SectionForm>
        </>
      )}
    </li>
  );
}

async function Screening(ctx: HubContext) {
  const d = trustOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const zone = ctx.record.hub.timeZone;
  const names = await staffNames(ctx, d.matches.map((m) => m.originalDecider));
  const staleBaseline = d.lists.some((l) => l.baseline && l.freshness === 'stale');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminTrust.screening.title')} lede={t('adminTrust.screening.lede')} />
      {staleBaseline ? (
        <p className="admin-callout admin-callout--danger" role="alert" data-testid="screening-stale">
          {t('adminTrust.screening.stale')}
        </p>
      ) : null}
      <p className="admin-callout" role="note">
        {t('adminTrust.screening.rule')}
      </p>
      <Panel id="lists" title={t('adminTrust.screening.lists')}>
        <Table
          testid="lists"
          rows={d.lists}
          rowKey={(l) => l.code}
          empty={t('adminParticipants.verification.noLists')}
          columns={[
            { label: t('adminParticipants.verification.list'), render: (l) => <code className="admin-code">{l.code}</code> },
            {
              label: t('adminParticipants.verification.kind'),
              render: (l) => (
                <>
                  {l.baseline ? <strong>{t('adminParticipants.verification.baselineAlwaysOn')}</strong> : t('adminParticipants.verification.additional')}
                  <div className="admin-meta">{tDynamic(`adminParticipants.modes.${l.mode}`, l.mode)}</div>
                </>
              ),
            },
            {
              label: t('adminTrust.screening.version'),
              render: (l) => (
                <>
                  <code className="admin-code">{l.version}</code>
                  <div className="admin-meta">{t('adminTrust.screening.publishedOn', { date: longDate(l.publishedAt) })}</div>
                </>
              ),
            },
            { label: t('adminTrust.screening.entries'), render: (l) => number(l.entries) },
            { label: t('adminTrust.screening.freshness'), render: (l) => <Pill tone={l.freshness === 'fresh' ? 'pass' : l.freshness === 'warning' ? 'warn' : 'fail'}>{tDynamic(`adminTrust.screening.freshnessStates.${l.freshness}`, l.freshness)}</Pill> },
          ]}
        />
        <SectionForm ctx={ctx} action={submitTrustCommand} command="screening.add_list" submit={t('adminParticipants.verification.addList')} can={['admin.claims.policy.edit']} secondPerson variant="secondary">
          <SelectField name="list" label={t('adminParticipants.verification.packList')} options={PACK_LIST_FACTS.filter((code) => !d.lists.some((l) => l.code === code)).map((code) => ({ value: code, label: code }))} />
          <SelectField name="mode" label={t('adminParticipants.verification.mode')} options={(['fake', 'file', 'live'] as const).map((m) => ({ value: m, label: tDynamic(`adminParticipants.modes.${m}`, m) }))} description={t('adminParticipants.verification.liveNote')} />
        </SectionForm>
      </Panel>
      {d.geo ? (
        <Panel id="geo" title={t('adminTrust.screening.geo')}>
          <KeyValues
            rows={[
              { label: t('adminTrust.screening.dataset'), value: <code className="admin-code">{d.geo.dataset}</code> },
              { label: t('adminParticipants.verification.mode'), value: tDynamic(`adminTrust.screening.geoModes.${d.geo.mode}`, d.geo.mode) },
              { label: t('adminTrust.screening.age'), value: t('adminTrust.screening.ageDays', { days: d.geo.ageDays }) },
            ]}
          />
        </Panel>
      ) : null}
      <Panel id="matches" title={t('adminTrust.screening.matches')}>
        {d.matches.length ? (
          <ul className="admin-approvals">
            {d.matches.map((m) => (
              <MatchCard key={m.id} ctx={ctx} match={m} names={names} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminTrust.screening.noMatches')}</p>
        )}
      </Panel>
      <Panel id="holds" title={t('adminTrust.screening.holds')}>
        <Table
          testid="holds"
          rows={d.holds}
          rowKey={(h) => h.id}
          empty={t('adminTrust.screening.noHolds')}
          columns={[
            { label: t('adminTrust.screening.place'), render: (h) => `${country(h.place)} (${h.place})` },
            { label: t('adminTrust.screening.source'), render: (h) => tDynamic(`adminTrust.screening.sources.${h.source}`, h.source) },
            { label: t('adminTrust.screening.dataset'), render: (h) => <code className="admin-code">{h.dataset}</code> },
            { label: t('adminTrust.common.received'), render: (h) => dateTime(h.at, zone) },
          ]}
        />
        {d.holds.length ? (
          <SectionForm ctx={ctx} action={submitTrustCommand} command="screening.clear_hold" submit={t('adminTrust.screening.clearHold')} can={['admin.claims.policy.edit']} variant="secondary">
            <SelectField name="holdId" label={t('adminTrust.screening.hold')} options={d.holds.map((h) => ({ value: h.id, label: `${h.id} · ${h.place}` }))} />
            <SelectField name="evidence" label={t('adminParticipants.claims.evidenceCategory')} options={HOLD_CLEAR_EVIDENCE.map((e) => ({ value: e, label: tDynamic(`adminTrust.screening.holdEvidence.${e}`, e) }))} />
          </SectionForm>
        ) : null}
      </Panel>
      <Panel id="runs" title={t('adminTrust.screening.runs')}>
        <Table
          rows={d.runs}
          rowKey={(r) => r.id}
          empty={t('adminTrust.screening.noRuns')}
          columns={[
            { label: t('adminTrust.screening.trigger'), render: (r) => tDynamic(`adminTrust.screening.triggers.${r.trigger}`, r.trigger) },
            { label: t('adminTrust.common.state'), render: (r) => tDynamic(`adminTrust.common.runStates.${r.state}`, r.state) },
            { label: t('adminTrust.common.progress'), render: (r) => t('adminTrust.common.progressOf', { done: number(r.processed), total: number(r.total) }) },
          ]}
        />
        <SectionForm ctx={ctx} action={submitTrustCommand} command="screening.rescreen" submit={t('adminTrust.screening.rescreen')} can={['admin.claims.policy.edit']} variant="secondary" />
      </Panel>
      {d.metrics ? (
        <Panel id="metrics" title={t('adminTrust.screening.metrics')}>
          <Tiles
            testid="screening-metrics"
            items={[
              { key: 'refusals', label: t('adminTrust.screening.refusals'), value: <Count value={d.metrics.refusals} /> },
              { key: 'holds', label: t('adminTrust.screening.holdCount'), value: <Count value={d.metrics.holds} /> },
              { key: 'matches', label: t('adminTrust.screening.matchCount'), value: <Count value={d.metrics.matches} /> },
              { key: 'share', label: t('adminTrust.screening.notSameShare'), value: d.metrics.cohort >= 10 ? percent(d.metrics.notSamePersonShare) : <Count value={d.metrics.cohort} /> },
            ]}
          />
          <p className="admin-note">{t('adminParticipants.common.cohortNote')}</p>
        </Panel>
      ) : null}
    </>
  );
}

/** HC-74 Screening: baseline lists always on, matches decided by people (not-same-person completed by a second person), holds and cohort metrics. */
export const screen: Screen = { group: 'trust', id: 'screening', title: () => t('adminTrust.screening.title'), render: Screening };
