import { notFound } from 'next/navigation';
import { caseGrantActive, CASE_GRANT_MAX_HOURS, ProjectionClassSchema } from '@trustwork/contracts/client';
import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen, ScreenRoute } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { submitSupportCommand } from '../_actions';
import { grantBlocker } from '../_commands';
import { GRANT_OBJECT_TYPES, supportOf, type GrantRequest, type SupportCase, type SupportData } from '../_fixtures';
import { fixturesOn, Lang, Pill, SectionForm, StaffName, staffNames, Table, type StaffNames } from '../../participants/_kit';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function data(ctx: HubContext): SupportData {
  return supportOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
}

function List(ctx: HubContext) {
  const { cases } = data(ctx);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminSupport.cases.title')} lede={t('adminSupport.cases.lede')} />
      <Panel id="cases" title={t('adminSupport.cases.list')}>
        <Table
          testid="cases"
          rows={cases}
          rowKey={(c) => c.id}
          empty={t('adminSupport.cases.empty')}
          columns={[
            { label: t('adminSupport.cases.case'), render: (c) => <NextLink href={ctx.href(`support/cases/${c.id}`)}>{c.id}</NextLink> },
            { label: t('adminSupport.cases.subject'), render: (c) => <Lang text={c.subject.name} /> },
            { label: t('adminSupport.cases.reason'), render: (c) => tDynamic(`adminSupport.cases.reasons.${c.reason}`, c.reason) },
            { label: t('adminSupport.account.state'), render: (c) => tDynamic(`adminSupport.cases.states.${c.state}`, c.state) },
            { label: t('adminSupport.cases.opened'), render: (c) => dateTime(c.openedAt, ctx.record.hub.timeZone) },
          ]}
        />
      </Panel>
    </>
  );
}

function RequestCard({ ctx, request, names }: { ctx: HubContext; request: GrantRequest; names: StaffNames }) {
  const blocker = grantBlocker(request, ctx.viewer.person.id, ctx.access.permissions, ctx.now);
  const mine = request.requestedBy === ctx.viewer.person.id;
  return (
    <li className="admin-approval" data-testid={`grant-request-${request.id}`}>
      <div className="admin-panel__head">
        <h4 className="admin-h4">{t('adminSupport.grants.request', { id: request.id })}</h4>
        <Pill tone="warn">{t('adminSupport.grants.awaiting')}</Pill>
      </div>
      <KeyValues
        rows={[
          { label: t('adminSupport.grants.requestedBy'), value: <StaffName names={names} id={request.requestedBy} /> },
          { label: t('adminSupport.grants.objects'), value: <code className="admin-code">{`${request.objectType}: ${request.ids.join(', ')}`}</code> },
          { label: t('adminSupport.grants.projection'), value: tDynamic(`adminSupport.grants.projections.${request.projectionClass}`, request.projectionClass) },
          { label: t('adminSupport.grants.purpose'), value: request.purpose.value, lang: request.purpose.lang },
          { label: t('adminSupport.grants.duration'), value: t('adminSupport.grants.hours', { hours: request.hours }) },
          { label: t('adminSupport.grants.digest'), value: <code className="admin-code">{request.digest.value.slice(0, 12)}</code> },
        ]}
      />
      <p className="admin-note">{t('adminSupport.grants.excluded')}</p>
      {mine ? <p className="admin-note" data-testid="own-grant-request">{t('admin.approvals.ownRequest')}</p> : null}
      <SectionForm
        ctx={ctx}
        action={submitSupportCommand}
        command="grants.approve"
        fields={{ requestId: request.id, digest: request.digest.value }}
        submit={t('adminSupport.grants.decide')}
        can={['admin.support.grant.approve']}
        blocked={blocker ? tDynamic(`adminParticipants.errors.${blocker}`, tDynamic(`admin.errors.${blocker}`, blocker, { items: '' })) : null}
      >
        <SelectField
          name="decision"
          label={t('admin.approvals.decision')}
          options={[
            { value: 'approve', label: t('admin.approvals.approve') },
            { value: 'decline', label: t('admin.approvals.decline') },
          ]}
          description={t('adminSupport.grants.bindsDigest')}
        />
      </SectionForm>
    </li>
  );
}

function Detail(ctx: HubContext, c: SupportCase, d: SupportData, names: StaffNames) {
  const zone = ctx.record.hub.timeZone;
  const closed = c.state === 'closed' ? t('adminParticipants.errors.case_closed') : null;
  const requests = d.grantRequests.filter((g) => g.caseId === c.id);
  const grants = d.grants.filter((g) => g.supportCaseId === c.id);
  const log = d.accessLog.filter((a) => a.caseRef.id === c.id);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminSupport.cases.detailTitle', { id: c.id })} lede={t('adminSupport.cases.detailLede')} />
      <p>
        <NextLink href={ctx.href('support/cases')}>{t('adminSupport.cases.back')}</NextLink>
      </p>
      <Panel id="case" title={c.subject.name.value} titleLang={c.subject.name.lang}>
        <KeyValues
          rows={[
            { label: t('adminSupport.cases.reason'), value: tDynamic(`adminSupport.cases.reasons.${c.reason}`, c.reason) },
            { label: t('adminSupport.account.state'), value: tDynamic(`adminSupport.cases.states.${c.state}`, c.state) },
            { label: t('adminSupport.cases.assignee'), value: <StaffName names={names} id={c.assignee} /> },
            { label: t('adminSupport.cases.opened'), value: dateTime(c.openedAt, zone) },
          ]}
        />
        {c.subject.kind === 'person' ? <NextLink href={ctx.href(`support/accounts/${c.subject.id}`, { case: c.id })}>{t('adminSupport.lookup.openAccount')}</NextLink> : <NextLink href={ctx.href(`support/companies/${c.subject.id}`, { case: c.id })}>{t('adminSupport.lookup.openCompany')}</NextLink>}
      </Panel>
      <Panel id="thread" title={t('adminSupport.cases.thread')}>
        <p className="admin-note">{t('adminSupport.cases.threadNote')}</p>
        <ol className="admin-list" data-testid="case-thread">
          {c.thread.map((m) => (
            <li key={m.at} className="admin-approval">
              <p className="admin-meta">
                {m.from === 'person' ? t('adminSupport.cases.fromPerson') : <StaffName names={names} id={m.staffId} />} · {dateTime(m.at, zone)}
              </p>
              <p lang={m.text.lang}>{m.text.value}</p>
            </li>
          ))}
        </ol>
        <SectionForm ctx={ctx} action={submitSupportCommand} command="cases.reply" fields={{ caseId: c.id }} submit={t('adminSupport.cases.reply')} can={['admin.support.case.create']} blocked={closed}>
          <TextInput name="text" label={t('adminSupport.cases.message')} isRequired />
        </SectionForm>
      </Panel>
      <Panel id="snapshots" title={t('adminSupport.cases.snapshots')}>
        <p className="admin-note">{t('adminSupport.cases.snapshotNote')}</p>
        <Table
          rows={c.snapshots}
          rowKey={(s) => s.id}
          empty={t('adminSupport.cases.noSnapshots')}
          columns={[
            { label: t('adminSupport.cases.page'), render: (s) => <code className="admin-code">{s.page}</code> },
            { label: t('adminSupport.cases.versions'), render: (s) => <code className="admin-code">{s.versions}</code> },
            { label: t('adminSupport.cases.errors'), render: (s) => <code className="admin-code">{[...s.errorCodes, ...s.requestIds].join(' ')}</code> },
            { label: t('adminSupport.cases.selected'), render: (s) => <code className="admin-code">{s.objects.join(' ')}</code> },
          ]}
        />
      </Panel>
      <Panel id="grants" title={t('adminSupport.grants.title')}>
        <p className="admin-note">{t('adminSupport.grants.rule', { hours: CASE_GRANT_MAX_HOURS })}</p>
        {requests.length ? (
          <ul className="admin-approvals">
            {requests.map((r) => (
              <RequestCard key={r.id} ctx={ctx} request={r} names={names} />
            ))}
          </ul>
        ) : null}
        <Table
          testid="grants"
          rows={grants}
          rowKey={(g) => g.id}
          empty={t('adminSupport.grants.none')}
          columns={[
            { label: t('adminSupport.grants.objects'), render: (g) => <code className="admin-code">{`${g.objectSelector.type}: ${g.objectSelector.ids.join(', ')}`}</code> },
            { label: t('adminSupport.grants.projection'), render: (g) => tDynamic(`adminSupport.grants.projections.${g.projectionClass}`, g.projectionClass) },
            { label: t('adminSupport.grants.approvedBy'), render: (g) => <StaffName names={names} id={g.approvedBy} /> },
            { label: t('adminSupport.grants.expires'), render: (g) => dateTime(g.expiresAt, zone) },
            {
              label: t('adminSupport.account.state'),
              render: (g) =>
                g.revokedAt ? (
                  <Pill tone="fail">{t('adminSupport.grants.revoked')}</Pill>
                ) : caseGrantActive(g, ctx.now) ? (
                  <Pill tone="pass">{t('adminSupport.grants.active')}</Pill>
                ) : (
                  <span data-testid={`grant-expired-${g.id}`}>
                    <Pill tone="warn">{t('adminSupport.grants.expired')}</Pill> <span className="admin-meta">{t('adminSupport.grants.notFoundAgain')}</span>
                  </span>
                ),
            },
          ]}
        />
        {grants.some((g) => caseGrantActive(g, ctx.now)) ? (
          <SectionForm ctx={ctx} action={submitSupportCommand} command="grants.revoke" submit={t('adminSupport.grants.revoke')} can={['admin.support.grant.request', 'admin.support.grant.approve']} variant="secondary">
            <SelectField name="grantId" label={t('adminSupport.grants.grant')} options={grants.filter((g) => caseGrantActive(g, ctx.now)).map((g) => ({ value: g.id, label: `${g.id} · ${g.objectSelector.type}` }))} />
          </SectionForm>
        ) : null}
      </Panel>
      <Panel id="request-grant" title={t('adminSupport.grants.requestTitle')}>
        <SectionForm ctx={ctx} action={submitSupportCommand} command="grants.request" fields={{ caseId: c.id }} submit={t('adminSupport.grants.requestSubmit')} can={['admin.support.grant.request']} blocked={closed} secondPerson>
          <SelectField name="objectType" label={t('adminSupport.grants.objectType')} options={GRANT_OBJECT_TYPES.map((o) => ({ value: o, label: tDynamic(`adminSupport.grants.objectTypes.${o}`, o) }))} />
          <TextInput name="ids" label={t('adminSupport.grants.ids')} isRequired description={t('adminSupport.grants.idsHelp')} />
          <SelectField name="projectionClass" label={t('adminSupport.grants.projection')} options={ProjectionClassSchema.options.map((p) => ({ value: p, label: tDynamic(`adminSupport.grants.projections.${p}`, p) }))} />
          <TextInput name="purpose" label={t('adminSupport.grants.purpose')} isRequired />
          <TextInput name="hours" label={t('adminSupport.grants.duration')} isRequired defaultValue="24" description={t('adminSupport.grants.durationHelp', { hours: CASE_GRANT_MAX_HOURS })} />
        </SectionForm>
      </Panel>
      <Panel id="access-log" title={t('adminSupport.cases.accessLog')}>
        <Table
          testid="access-log"
          rows={log}
          rowKey={(a) => a.id}
          empty={t('adminSupport.cases.noReads')}
          columns={[
            { label: t('adminSupport.cases.readAt'), render: (a) => dateTime(a.readAt, zone) },
            { label: t('adminSupport.cases.reader'), render: (a) => <StaffName names={names} id={a.actorPersonId} /> },
            { label: t('adminSupport.grants.grant'), render: (a) => <code className="admin-code">{a.grantId}</code> },
            { label: t('adminSupport.grants.objects'), render: (a) => <code className="admin-code">{`${a.objectType}: ${a.objectId}`}</code> },
          ]}
        />
      </Panel>
      <div className="admin-grid">
        <Panel id="assign" title={t('adminSupport.cases.assign')}>
          <SectionForm ctx={ctx} action={submitSupportCommand} command="cases.assign" fields={{ caseId: c.id }} submit={t('adminSupport.cases.assign')} can={['admin.support.grant.approve']} blocked={closed} variant="secondary">
            <SelectField name="assignee" label={t('adminSupport.cases.assignee')} options={['p-support', 'p-support-agent'].map((id) => ({ value: id, label: names.get(id)?.text ?? id }))} />
          </SectionForm>
        </Panel>
        <Panel id="close" title={t('adminSupport.cases.close')}>
          <SectionForm ctx={ctx} action={submitSupportCommand} command="cases.close" fields={{ caseId: c.id }} submit={t('adminSupport.cases.close')} can={['admin.support.case.close']} blocked={closed} variant="secondary" />
        </Panel>
      </div>
    </>
  );
}

async function Cases(ctx: HubContext, route: ScreenRoute) {
  if (route.rest.length === 0) return List(ctx);
  const d = data(ctx);
  const c = d.cases.find((x) => x.id === route.rest[0]);
  if (!c) notFound();
  const names = await staffNames(ctx, [c.assignee, 'p-support', 'p-support-agent', ...c.thread.map((m) => m.staffId), ...d.grants.flatMap((g) => [g.approvedBy, g.requestedBy]), ...d.grantRequests.map((g) => g.requestedBy), ...d.accessLog.map((a) => a.actorPersonId)]);
  return Detail(ctx, c, d, names);
}

/** HC-33 Cases (`support/cases`, `support/cases/[case]`): the case thread, shared diagnostics, case grants approved by a different person, and the access log. */
export const screen: Screen = {
  group: 'support',
  id: 'cases',
  title: () => t('adminSupport.cases.title'),
  accepts: (rest) => rest.length === 1 && ID.test(rest[0] ?? ''),
  render: Cases,
};
