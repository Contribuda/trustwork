import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ScreeningListAuthoritySchema, ScreeningListsOverviewSchema, ScreeningVersionsSchema, ScreeningGeolocationSchema, ScreeningMetricsSchema, type ScreeningSubjectRef } from '@trustwork/contracts/client';
import { primeLocale } from '@/app/_lib/locale';
import { tDynamic } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';
import { ApiFailure, createTransport } from '@/app/_lib/data/http/transport';
import { HeaderLocaleSwitcher } from '@/components/locale/LocaleControls';
import reference from '@/locales/en/screening.json';
import { CompliancePanel } from '../../participants/compliance/CompliancePanel';
import { ActionForm } from './ActionForm';
import { AccessSchema, HoldsSchema, HubsSchema, MatchDetailSchema, NodeSchema, QueueSchema, RunsSchema, SubjectSchema, type Copy, type MatchDetail } from './model';
import './screening.css';

type Query = { subject?: string | undefined; view?: string | undefined; participant?: ScreeningSubjectRef | undefined };

/** Only this screen uses these live endpoints; the general console adapter remains HUBC-007. */
export async function readScreening(hubSlug: string, query: Query, transport = createTransport()) {
  const node = NodeSchema.parse(await transport.get('/v1/admin/node'));
  const access = AccessSchema.parse(await transport.get(`/v1/admin/access?nodeId=${node.nodeId}`));
  // The accepted storage authority is node compliance/auditor, not a hub role or a broad claims permission.
  if (!access.roles.some((role) => role === 'compliance-officer' || role === 'auditor')) return null;
  const hubs = HubsSchema.parse(await transport.get('/v1/admin/hubs'));
  const hub = hubs.items.find((item) => item.hub.slug === hubSlug)?.hub;
  if (!hub || hub.nodeId !== node.nodeId) return null;
  const listAuthority = ScreeningListAuthoritySchema.parse(await transport.get(`/v1/admin/screening/list-authority?hubId=${hub.id}`));
  const lists = ScreeningListsOverviewSchema.parse(await transport.get('/v1/admin/screening/lists'));
  const versions = new Map<string, z.infer<typeof ScreeningVersionsSchema>['items']>();
  for (const list of lists.items) versions.set(list.id, ScreeningVersionsSchema.parse(await transport.get(`/v1/admin/screening/lists/${list.id}/versions`)).items);
  const geo = ScreeningGeolocationSchema.parse(await transport.get('/v1/admin/jurisdiction/geolocation'));
  const metrics = ScreeningMetricsSchema.parse(await transport.get(`/v1/admin/screening/metrics?hubId=${hub.id}`));
  const queue = QueueSchema.parse(await transport.get('/v1/admin/screening/queue'));
  const holds = HoldsSchema.parse(await transport.get('/v1/admin/jurisdiction/holds'));
  const runs = RunsSchema.parse(await transport.get('/v1/admin/screening/rescreen-runs'));
  const stateId = query.subject ? z.uuid().safeParse(query.subject) : null;
  if (stateId && !stateId.success) return null;
  const participant = query.participant;
  if (participant && !z.uuid().safeParse(participant.id).success) return null;
  const subjectBody = participant ? await transport.get(`/v1/admin/screening/subjects/lookup/${participant.kind}/${participant.id}`) : stateId?.success ? await transport.get(`/v1/admin/screening/subjects/${stateId.data}`) : null;
  if ((stateId?.success || participant) && subjectBody === null) return null;
  const subject = subjectBody ? SubjectSchema.parse(subjectBody) : null;
  const details: MatchDetail[] = [];
  if (subject) for (const match of subject.matches) details.push(MatchDetailSchema.parse(await transport.get(`/v1/admin/screening/matches/${match.id}`)));
  return { node, access, hub, listAuthority, lists, versions, geo, metrics, queue, holds: holds.items, runs: runs.items, subject, details };
}

export function localizedCopy(): Copy {
  function visit(value: unknown, path: string): unknown {
    if (typeof value === 'string') return tDynamic(path, value);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, visit(child, `${path}.${key}`)]));
  }
  return visit(reference.screening.console, 'screening.console') as Copy;
}

/** Private server-rendered page. No fixture, query persona or fallback identity is ever used. */
export async function LiveScreening({ hub, query = {} }: { hub: string; query?: Query }) {
  const active = await primeLocale();
  const c = localizedCopy();
  let data;
  try { data = await readScreening(hub, query); }
  catch (error) {
    if (error instanceof ApiFailure && [401, 403, 404].includes(error.status)) notFound();
    throw error;
  }
  if (!data) notFound();
  const { access, subject } = data;
  const participantPage = !!query.participant;
  const mayAct = access.roles.includes('compliance-officer');
  const base = withBase(`/admin/hubs/${encodeURIComponent(hub)}/trust/screening`);
  const fmtDate = (s: string | null) => s ? new Intl.DateTimeFormat(active.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: data.hub.timeZone }).format(new Date(s)) : c.unknown;
  const number = (n: number) => new Intl.NumberFormat(active.locale).format(n);
  const approvalView = query.view === 'approvals';
  const queue = data.queue.items.filter((item) => !approvalView || item.states.some((state) => state === 'pending_second' || state === 'pending_reversal'));
  const visibleHolds = data.holds.filter((hold) => !subject || subject.subject.kind === 'person' && hold.personId === subject.subject.id);
  return <main className="screening-console" id="screening-main">
    <header>
      <HeaderLocaleSwitcher active={active} />
      <h1 tabIndex={-1}>{participantPage ? c.participantTitle : c.title}</h1>
      <p>{data.hub.name[active.locale] ?? data.hub.name[data.hub.defaultLocale]}</p>
      <p>{c.api} · {c.nodeScope}</p>
      <nav aria-label={c.title}>
        <a href={base}>{c.queue}</a><a href={`${base}?view=approvals`}>{c.approvals}</a><a href={`${base}#holds`}>{c.holds}</a><a href={`${base}#runs`}>{c.runs}</a>
      </nav>
    </header>
    {participantPage ? <p>{c.participantScope}</p> : <aside className="screening-warning"><strong>{c.incomplete}</strong><p>{c.unavailable}</p></aside>}
    <p>{c.rule}</p>{!mayAct ? <p>{c.readOnly}</p> : null}
    {!participantPage ? <>
    {!data.lists.available ? <p className="screening-warning" role="status">{c.stale}</p> : null}
    <section aria-labelledby="baseline-heading"><h2 id="baseline-heading">{c.lists}</h2>
      <p>{c.listControls.boundary}</p>
      {data.lists.items.map((list) => <article className="screening-card" key={list.id}>
        <h3><code>{list.code}</code></h3><p>{list.baseline ? c.baseline : c.additional}</p>
        <dl><dt>{c.mode}</dt><dd>{c.modes[list.mode]}</dd><dt>{c.freshness}</dt><dd>{c.freshnessStates[list.freshness.state]}</dd>
          <dt>{c.ageSeconds}</dt><dd>{list.freshness.ageSeconds === null ? c.unknown : number(list.freshness.ageSeconds)}</dd>
          <dt>{c.checkedAt}</dt><dd>{fmtDate(list.freshness.lastCheckedAt)}</dd>
          <dt>{c.version}</dt><dd>{list.activeVersion ? number(list.activeVersion.version) : c.unknown}</dd>
          <dt>{c.entryCount}</dt><dd>{list.activeVersion ? number(list.activeVersion.entryCount) : c.unknown}</dd>
          <dt>{c.publishedOn}</dt><dd>{list.activeVersion?.publishedOn ? new Intl.DateTimeFormat(active.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(list.activeVersion.publishedOn)) : c.unknown}</dd>
        </dl>
        {!list.baseline ? <ActionForm path={`/v1/admin/screening/lists/${list.id}/status`} label={list.status === 'active' ? c.listControls.pause : c.listControls.resume} fixed={{ status: list.status === 'active' ? 'paused' : 'active' }} copy={c} disabled={!mayAct} /> : null}
        <details><summary>{c.versionHistory}</summary><p>{c.historyLimit}</p><ul>{data.versions.get(list.id)?.map((version) => <li key={version.id}>
          {number(version.version)} · {c.versionStates[version.state]} · {c.modes[version.mode]} · {fmtDate(version.fetchedAt)}
          <p>{c.entryCount}: {number(version.entryCount)}</p><p>{c.digest}: <code>{version.digest}</code></p>
          {version.state === 'staged' ? <ActionForm path={`/v1/admin/screening/list-versions/${version.id}/confirm`} label={c.listControls.confirmVersion} copy={c} disabled={!mayAct} /> : null}
        </li>)}</ul></details>
      </article>)}
    </section>
    <section aria-labelledby="list-authority-heading"><h2 id="list-authority-heading">{c.listControls.title}</h2>
      <p>{c.listControls.boundary}</p>
      {data.listAuthority.sources.length ? <ActionForm path="/v1/admin/screening/list-proposals" label={c.listControls.propose} copy={c} fixed={{hubId:data.hub.id}}
        choices={{sourceId:{label:c.listControls.source,options:Object.fromEntries(data.listAuthority.sources.map((source)=>[source.id,`${source.packCode} / ${source.factId} / ${source.adapter}`]))}}}
        numbers={{cadenceSeconds:{label:c.listControls.cadence,value:86400,min:60,max:604800},warnAfterSeconds:{label:c.listControls.warning,value:259200,min:120,max:1209599},staleAfterSeconds:{label:c.listControls.stale,value:604800,min:180,max:1209600}}}
        evidence={{official_export:c.listControls.exportEvidence,source_review:c.listControls.reviewEvidence}} disabled={!mayAct} /> : <p>{c.listControls.noSources}</p>}
      <h3>{c.listControls.history}</h3><p>{c.historyLimit}</p>
      {data.listAuthority.proposals.map((proposal)=><article className="screening-card" key={proposal.id}>
        <h4>{c.listControls.proposalStates[proposal.state]}</h4>
        <p>{c.listControls.source}: <code>{proposal.source.packCode} / {proposal.source.factId} / {proposal.source.adapter}</code></p>
        <p><code>{proposal.source.sourceUrl}</code></p><p>{c.digest}: <code>{proposal.source.sourceDigest}</code></p>
        <p>{c.evidence}: {proposal.evidence === 'official_export' ? c.listControls.exportEvidence : c.listControls.reviewEvidence}</p><p>{proposal.reason}</p><p>{fmtDate(proposal.createdAt)}</p>
        <dl><dt>{c.listControls.cadence}</dt><dd>{number(proposal.cadenceSeconds)}</dd><dt>{c.listControls.warning}</dt><dd>{number(proposal.warnAfterSeconds)}</dd><dt>{c.listControls.stale}</dt><dd>{number(proposal.staleAfterSeconds)}</dd></dl>
        <p>{c.digest}: <code>{proposal.actionDigest}</code></p>
        {proposal.state === 'pending' ? <><p>{c.secondRequired}</p>
          <ActionForm path={`/v1/admin/screening/list-proposals/${proposal.id}/decision`} label={c.listControls.approve} fixed={{decision:'approve',actionDigest:proposal.actionDigest}} copy={c} disabled={!mayAct || proposal.requestedBy === access.personId || new Date(proposal.expiresAt) <= new Date()} />
          <ActionForm path={`/v1/admin/screening/list-proposals/${proposal.id}/decision`} label={c.reject} fixed={{decision:'reject',actionDigest:proposal.actionDigest}} copy={c} disabled={!mayAct || proposal.requestedBy === access.personId} />
        </> : null}
      </article>)}
    </section>
    <section aria-labelledby="geo-heading"><h2 id="geo-heading">{c.geolocation}</h2>
      <dl><dt>{c.mode}</dt><dd>{c.modes[data.geo.gate.mode]}</dd><dt>{c.dataset}</dt><dd>{data.geo.gate.dataset ?? c.unknown}</dd>
        <dt>{c.ageMonths}</dt><dd>{data.geo.ageMonths === null ? c.unknown : number(data.geo.ageMonths)}</dd>
        <dt>{c.freshness}</dt><dd>{c.freshnessStates[data.geo.freshness]}</dd></dl>
      {data.geo.gate.attribution ? <p>{data.geo.gate.attribution}</p> : null}
    </section>
    <section aria-labelledby="metrics-heading"><h2 id="metrics-heading">{c.metrics}</h2><p>{c.cohortRule}</p>
      <dl>{data.metrics.metrics.map((metric) => <div key={metric.key}><dt>{c.metricNames[metric.key]}</dt><dd>{c.metricReasons[metric.reason]}</dd></div>)}</dl>
      <h3>{c.runDuration}</h3><p>{c.nodeScope}</p>
      {data.metrics.rescreenDurations.length ? <ul>{data.metrics.rescreenDurations.map((run) => <li key={run.runId}><code>{run.runId}</code> · {number(run.seconds)}</li>)}</ul> : <p>{c.noEligibleDurations}</p>}
    </section>
    <section aria-labelledby="queue-heading"><h2 id="queue-heading">{approvalView ? c.approvals : c.queue}</h2>
      <p>{c.notifications}</p>
      {!queue.length ? <p>{c.noMatches}</p> : <ul>{queue.map((item) => <li key={item.subjectStateId} className="screening-card">
        <a href={`${base}?subject=${item.subjectStateId}${approvalView ? '&view=approvals' : ''}`}>{c.subjectKinds[item.subject.kind]} · <code>{item.subject.id}</code></a>
        <p>{fmtDate(item.dueAt)} {item.late ? <strong>{c.late}</strong> : null}</p>
        <p>{item.states.map((s) => c.states[s]).join(' · ')}</p>
      </li>)}</ul>}
    </section>
    </> : null}
    {subject ? <CompliancePanel subject={subject} details={data.details} access={access} mayAct={mayAct} c={c} hub={hub} fmtDate={fmtDate} /> : null}
    <section id="holds" aria-labelledby="holds-heading"><h2 id="holds-heading">{c.holds}</h2>
      {!visibleHolds.length ? <p>{c.noHolds}</p> : visibleHolds.map((hold) => <article className="screening-card" key={hold.id}>
        <h3><code>{hold.personId}</code></h3>
        <dl><dt>{c.place}</dt><dd>{hold.place}</dd><dt>{c.source}</dt><dd>{c.sources[hold.source]}</dd><dt>{c.dataset}</dt><dd>{hold.dataset}</dd><dt>{c.received}</dt><dd>{fmtDate(hold.placedAt)}</dd></dl>
        {hold.clearedAt ? <><h4>{c.history}</h4><p>{fmtDate(hold.clearedAt)} · {hold.clearEvidence ? c.holdEvidence[hold.clearEvidence] : c.unknown}</p><p>{hold.clearReason}</p></> : <ActionForm path={`/v1/admin/jurisdiction/holds/${hold.id}/clear`} label={c.clearHold} copy={c} evidence={c.holdEvidence} disabled={!mayAct || hold.personId === access.personId} />}
      </article>)}
    </section>
    {!participantPage ? <section id="runs" aria-labelledby="runs-heading"><h2 id="runs-heading">{c.runs}</h2>
      {!data.runs.length ? <p>{c.noRuns}</p> : data.runs.map((run) => <article className="screening-card" key={run.id}>
        <h3>{c.runStates[run.state]}</h3><p>{fmtDate(run.queuedAt)}</p><p>{c.progress}: {run.progress ? `${number(run.progress.subjectsDone)} / ${number(run.progress.subjectsTotal)}` : c.unknown}</p>
        {run.blockedReason ? <p role="status">{c.stale}</p> : null}{run.overdue ? <p>{c.late}</p> : null}
      </article>)}
      <ActionForm path="/v1/admin/screening/rescreen-runs" label={c.requestRun} copy={c} disabled={!mayAct} />
    </section> : null}
  </main>;
}
