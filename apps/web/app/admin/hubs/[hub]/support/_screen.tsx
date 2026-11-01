import { notFound } from 'next/navigation';
import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../_components/context';
import type { Screen, ScreenRoute } from '../../../_components/screen';
import { SelectField, TextInput } from '../../../_components/forms';
import { dateTime, list, longDate, number } from '../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../_components/shell';
import { submitSupportCommand } from './_actions';
import { CASE_REASONS, COMMUNICATIONS, GUIDED_TASKS, MEMBERSHIPS, SERVICE_ACTIONS, USAGE, type SupportData } from './_fixtures';
import { lookup, LOOKUP_KINDS, lookupData, type LookupKind } from './_lookup';
import { CheckField, fixturesOn, GetForm, Lang, Pill, SectionForm, Table } from '../participants/_kit';

function dataOf(ctx: HubContext) {
  return lookupData(fixturesOn(ctx) ? ctx.record.hub.id : '');
}

function caseOptions(data: SupportData, subject?: string) {
  return data.cases.filter((c) => c.state !== 'closed' && (!subject || c.subject.id === subject)).map((c) => ({ value: c.id, label: `${c.id} · ${c.subject.name.value}` }));
}

/* ---------- HC-30 Lookup ---------- */

function Lookup(ctx: HubContext, route: ScreenRoute) {
  const data = dataOf(ctx);
  const by = (LOOKUP_KINDS as readonly string[]).includes(route.query.by ?? '') ? (route.query.by as LookupKind) : 'email';
  const q = route.query.q ?? '';
  const caseId = data.support.cases.find((c) => c.id === route.query.case && c.state !== 'closed')?.id ?? null;
  const results = q && caseId ? lookup(data, by, q) : [];
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminSupport.lookup.title')} lede={t('adminSupport.lookup.lede')} />
      <Panel id="lookup" title={t('adminSupport.lookup.search')}>
        <GetForm ctx={ctx} path="support" submit={t('adminSupport.lookup.find')} id="lookup-form">
          <SelectFieldGet name="by" label={t('adminSupport.lookup.by')} value={by} options={LOOKUP_KINDS.map((k) => ({ value: k, label: tDynamic(`adminSupport.lookup.kinds.${k}`, k) }))} />
          <TextFieldGet name="q" label={t('adminSupport.lookup.query')} value={by === 'email' ? '' : q} />
          <SelectFieldGet name="case" label={t('adminSupport.lookup.forCase')} value={caseId ?? ''} options={[{ value: '', label: t('adminSupport.lookup.chooseCase') }, ...caseOptions(data.support)]} />
        </GetForm>
        <p className="admin-note">{t('adminSupport.lookup.logged')}</p>
      </Panel>
      {q ? (
        <Panel id="results" title={t('adminSupport.lookup.results')}>
          {!caseId ? (
            <p className="admin-callout admin-callout--warning" data-testid="lookup-needs-case">
              {t('adminSupport.lookup.needsCase')}
            </p>
          ) : results.length ? (
            <>
              <p className="admin-meta" data-testid="lookup-logged">
                {t('adminSupport.lookup.loggedFor', { case: caseId })}
              </p>
              <Table
                testid="lookup-results"
                rows={results}
                rowKey={(r) => `${r.kind}-${r.id}`}
                empty=""
                columns={[
                  { label: t('adminParticipants.common.name'), render: (r) => <span lang="en">{r.name}</span> },
                  { label: t('adminSupport.account.email'), render: (r) => (r.kind === 'person' ? <code className="admin-code">{r.masked}</code> : t('admin.common.none')) },
                  { label: t('adminSupport.account.state'), render: (r) => (r.kind === 'person' ? tDynamic(`adminParticipants.accountStates.${r.state}`, r.state) : tDynamic(`adminParticipants.companyStates.${r.state}`, r.state)) },
                  {
                    label: t('adminSupport.lookup.open'),
                    render: (r) => (
                      <NextLink href={ctx.href(`support/${r.kind === 'person' ? 'accounts' : 'companies'}/${r.id}`, { case: caseId })}>
                        {t(r.kind === 'person' ? 'adminSupport.lookup.openAccount' : 'adminSupport.lookup.openCompany')}
                      </NextLink>
                    ),
                  },
                ]}
              />
            </>
          ) : (
            <p className="admin-empty" data-testid="lookup-nothing">
              {t('adminSupport.lookup.nothing')}
            </p>
          )}
        </Panel>
      ) : null}
      <Panel id="create-case" title={t('adminSupport.cases.create')}>
        <SectionForm ctx={ctx} action={submitSupportCommand} command="cases.create" submit={t('adminSupport.cases.create')} can={['admin.support.case.create']} variant="secondary">
          <SelectField name="subjectKind" label={t('adminSupport.cases.subjectKind')} options={(['person', 'company'] as const).map((k) => ({ value: k, label: tDynamic(`adminParticipants.subjects.${k}`, k) }))} />
          <TextInput name="subjectId" label={t('adminSupport.cases.subjectId')} isRequired description={t('adminSupport.cases.subjectIdHelp')} />
          <SelectField name="reason" label={t('adminSupport.cases.reason')} options={CASE_REASONS.map((r) => ({ value: r, label: tDynamic(`adminSupport.cases.reasons.${r}`, r) }))} />
        </SectionForm>
      </Panel>
    </>
  );
}

function SelectFieldGet({ name, label, value, options }: { name: string; label: string; value: string; options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <div className="admin-field">
      <label htmlFor={`get-${name}`} className="admin-field__label">
        {label}
      </label>
      <select id={`get-${name}`} name={name} className="admin-select" defaultValue={value}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextFieldGet({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <div className="admin-field">
      <label htmlFor={`get-${name}`} className="admin-field__label">
        {label}
      </label>
      <input id={`get-${name}`} name={name} className="admin-select" defaultValue={value} maxLength={200} autoComplete="off" />
    </div>
  );
}

/* ---------- HC-31 Account card ---------- */

function NoImpersonation() {
  return (
    <p className="admin-callout" role="note" data-testid="no-impersonation">
      {t('adminSupport.account.noImpersonation')}
    </p>
  );
}

function Account(ctx: HubContext, route: ScreenRoute, personId: string) {
  const data = dataOf(ctx);
  const account = data.support.accounts.find((a) => a.summary.personId === personId);
  if (!account) notFound();
  const s = account.summary;
  const zone = ctx.record.hub.timeZone;
  const own = personId === ctx.viewer.person.id;
  if (s.accountState === 'erased') {
    return (
      <>
        <ConsoleHeader ctx={ctx} title={t('adminSupport.account.title')} />
        <p className="admin-callout" data-testid="erased-tombstone">
          {t('adminSupport.account.erased')}
        </p>
      </>
    );
  }
  const profile = account.publicProfileId ? data.participants.profiles.find((p) => p.id === account.publicProfileId) : null;
  const cases = caseOptions(data.support, personId);
  const recovery = data.support.recovery.filter((r) => r.subject.personId === personId);
  const blocked = own ? t('adminSupport.account.ownAccount') : cases.length === 0 ? t('adminSupport.account.needsCase') : null;
  const caseField = route.query.case && cases.some((c) => c.value === route.query.case) ? route.query.case : cases[0]?.value;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminSupport.account.title')} lede={t('adminSupport.account.lede')} />
      {own ? (
        <p className="admin-callout admin-callout--warning" role="note" data-testid="own-account">
          {t('adminSupport.account.ownAccount')}
        </p>
      ) : null}
      <NoImpersonation />
      <Panel id="summary" title={s.displayName} titleLang="en">
        <KeyValues
          rows={[
            { label: t('adminSupport.account.email'), value: <><code className="admin-code">{s.maskedEmail}</code> · {t(s.emailVerified ? 'adminSupport.account.verified' : 'adminSupport.account.unverified')}</> },
            { label: t('adminSupport.account.state'), value: tDynamic(`adminParticipants.accountStates.${s.accountState}`, s.accountState) },
            { label: t('adminSupport.account.secondFactor'), value: s.secondFactor.enrolled ? t('adminSupport.account.factorMethods', { count: s.secondFactor.methods }) : t('adminSupport.account.noFactor') },
            { label: t('adminSupport.account.sessions'), value: number(s.activeSessions) },
            { label: t('adminSupport.account.recovery'), value: tDynamic(`adminSupport.account.recoveryStates.${s.recovery}`, s.recovery) },
            { label: t('adminSupport.account.employer'), value: s.employer ? <span lang="en">{`${s.employer.companyName} · ${s.employer.role}`}</span> : t('admin.common.none') },
            { label: t('adminSupport.account.openCases'), value: number(s.openCases) },
          ]}
        />
        <p className="admin-note">{t('adminSupport.account.allowlist')}</p>
      </Panel>
      <div className="admin-grid">
        <Panel id="entitlements" title={t('adminSupport.account.entitlements')}>
          <Table
            rows={s.entitlements}
            rowKey={(e) => e.offerCode}
            empty={t('adminSupport.account.noEntitlements')}
            columns={[
              { label: t('adminSupport.account.offer'), render: (e) => <code className="admin-code">{e.offerCode}</code> },
              { label: t('adminSupport.account.validUntil'), render: (e) => (e.validUntil ? longDate(e.validUntil) : t('adminSupport.account.noEnd')) },
            ]}
          />
          <Table
            testid="usage"
            rows={USAGE.filter((u) => u.personId === personId)}
            rowKey={(u) => `${u.offerCode}-${u.meter}`}
            empty={t('adminSupport.account.noUsage')}
            columns={[
              { label: t('adminSupport.account.meter'), render: (u) => tDynamic(`adminSupport.account.meters.${u.meter}`, u.meter) },
              { label: t('adminSupport.account.usage'), render: (u) => t('adminSupport.account.usageOf', { used: number(u.used), included: number(u.included) }) },
              { label: t('adminSupport.account.period'), render: (u) => u.period },
            ]}
          />
        </Panel>
        <Panel id="consents" title={t('adminSupport.account.consents')}>
          <Table
            rows={s.consents}
            rowKey={(c) => `${c.kind}-${c.version}`}
            empty={t('adminSupport.account.noConsents')}
            columns={[
              { label: t('adminParticipants.consents.kind'), render: (c) => tDynamic(`adminParticipants.consents.kinds.${c.kind}`, c.kind) },
              { label: t('adminParticipants.consents.version'), render: (c) => c.version },
              { label: t('adminSupport.account.state'), render: (c) => tDynamic(`adminSupport.account.consentStates.${c.state}`, c.state) },
              { label: t('adminSupport.account.date'), render: (c) => longDate(c.at) },
            ]}
          />
        </Panel>
      </div>
      <Panel id="memberships" title={t('adminSupport.account.memberships')}>
        <Table
          rows={MEMBERSHIPS.filter((m) => m.personId === personId)}
          rowKey={(m) => `${m.company.value}-${m.from}`}
          empty={t('adminSupport.account.noMemberships')}
          columns={[
            { label: t('adminParticipants.common.company'), render: (m) => <Lang text={m.company} /> },
            { label: t('adminSupport.account.role'), render: (m) => <Lang text={m.role} /> },
            { label: t('adminSupport.account.period'), render: (m) => `${longDate(m.from)} – ${m.to ? longDate(m.to) : t('adminSupport.account.now')}` },
          ]}
        />
      </Panel>
      <Panel id="communications" title={t('adminSupport.account.communications')}>
        <p className="admin-note">{t('adminSupport.account.metadataOnly')}</p>
        <Table
          testid="communications"
          rows={COMMUNICATIONS.filter((c) => c.personId === personId)}
          rowKey={(c) => `${c.template}-${c.at}`}
          empty={t('adminSupport.account.noCommunications')}
          columns={[
            { label: t('adminSupport.account.template'), render: (c) => `${tDynamic(`adminSupport.account.templates.${c.template}`, c.template)} v${c.version}` },
            { label: t('adminSupport.account.channel'), render: (c) => tDynamic(`adminSupport.channels.${c.channel}`, c.channel) },
            { label: t('adminSupport.account.delivery'), render: (c) => <Pill tone={c.state === 'delivered' ? 'pass' : c.state === 'bounced' ? 'fail' : 'warn'}>{tDynamic(`adminSupport.account.deliveryStates.${c.state}`, c.state)}</Pill> },
            { label: t('adminSupport.account.date'), render: (c) => dateTime(c.at, zone) },
          ]}
        />
      </Panel>
      {recovery.length ? (
        <Panel id="in-progress" title={t('adminSupport.account.inProgress')}>
          <ul className="admin-list">
            {recovery.map((r) => (
              <li key={r.id} className="admin-list__row">
                <span>{tDynamic(`adminSupport.actions.${r.action}`, r.action)}</span>
                <Pill tone={r.state === 'cancelled' ? 'fail' : r.state === 'ready' ? 'pass' : 'warn'}>{tDynamic(`adminSupport.recovery.states.${r.state}`, r.state)}</Pill>
                {r.effectiveAt && r.state === 'cooling_off' ? <span className="admin-meta">{t('adminSupport.recovery.coolingOffEnds', { date: dateTime(r.effectiveAt, zone) })}</span> : null}
              </li>
            ))}
          </ul>
          <NextLink href={ctx.href('support/recovery')}>{t('adminSupport.account.openRecovery')}</NextLink>
        </Panel>
      ) : null}
      <Panel id="service" title={t('adminSupport.account.service')}>
        <SectionForm ctx={ctx} action={submitSupportCommand} command="accounts.service" fields={{ personId }} submit={t('adminSupport.account.serviceSubmit')} can={['admin.support.diagnose', 'admin.support.sessions.revoke', 'admin.support.case.create']} blocked={blocked}>
          <SelectField name="action" label={t('adminSupport.account.action')} options={SERVICE_ACTIONS.map((a) => ({ value: a, label: tDynamic(`adminSupport.actions.${a}`, a) }))} />
          <SelectField name="caseId" label={t('adminSupport.account.case')} options={cases.length ? cases : [{ value: '', label: t('admin.common.none') }]} defaultValue={caseField} />
          <SelectField name="task" label={t('adminSupport.account.guidedTask')} options={GUIDED_TASKS.map((g) => ({ value: g, label: tDynamic(`adminSupport.account.tasks.${g}`, g) }))} description={t('adminSupport.account.guidedTaskHelp')} />
          <CheckField name="evidence" label={t('adminSupport.account.evidenceRecorded')} />
          <p className="admin-note">{t('adminSupport.account.coolingOffRule')}</p>
        </SectionForm>
      </Panel>
      <Panel id="alternatives" title={t('adminSupport.account.alternatives')}>
        <ul className="admin-list">
          <li className="admin-list__row">
            {profile ? <NextLink href={ctx.href(`support/accounts/${personId}`, { ...(caseField ? { case: caseField } : {}), view: 'public' })}>{t('adminSupport.account.viewPublic')}</NextLink> : <span className="admin-meta">{t('adminSupport.account.noPublic')}</span>}
          </li>
          <li className="admin-list__row">
            <NextLink href={ctx.href('support/explain', { principal: personId })}>{t('adminSupport.account.openExplainer')}</NextLink>
          </li>
          <li className="admin-list__row">
            <span>{t('adminSupport.account.ownAgent')}</span>
          </li>
        </ul>
        {route.query.view === 'public' && profile ? (
          <section className="admin-subsection" aria-labelledby="public-projection-title" data-testid="public-projection">
            <h3 id="public-projection-title" className="admin-h3">
              {t('adminSupport.account.publicProjection')}
            </h3>
            <KeyValues
              rows={[
                { label: t('adminParticipants.common.name'), value: profile.name.value, lang: profile.name.lang },
                { label: t('adminParticipants.people.trade'), value: tDynamic(`adminParticipants.trades.${profile.trade}`, profile.trade) },
                { label: t('adminParticipants.people.place'), value: profile.place.value, lang: profile.place.lang },
                { label: t('adminParticipants.people.employer'), value: profile.employer ? profile.employer.value : t('admin.common.none'), ...(profile.employer ? { lang: profile.employer.lang } : {}) },
              ]}
            />
          </section>
        ) : null}
      </Panel>
    </>
  );
}

/* ---------- HC-32 Company card ---------- */

function Company(ctx: HubContext, companyId: string) {
  const data = dataOf(ctx);
  const company = data.participants.companies.find((c) => c.id === companyId && c.state !== 'sourced');
  const entry = data.support.companies.find((c) => c.companyId === companyId);
  if (!company || !entry) notFound();
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminSupport.company.title')} lede={t('adminSupport.company.lede')} />
      <NoImpersonation />
      <Panel id="company" title={company.name.value} titleLang={company.name.lang}>
        <KeyValues
          rows={[
            { label: t('adminParticipants.companies.state'), value: tDynamic(`adminParticipants.companyStates.${company.state}`, company.state) },
            { label: t('adminParticipants.companies.categories'), value: list(company.categories.map((k) => tDynamic(`adminParticipants.categories.${k}`, k))) },
            { label: t('adminParticipants.companies.verifiedAt'), value: company.verifiedAt ? longDate(company.verifiedAt) : t('admin.common.none') },
            {
              label: t('adminParticipants.companies.representative'),
              value: (
                <>
                  {tDynamic(`adminParticipants.repStates.${company.representative.state}`, company.representative.state)}
                  {company.representative.accountable ? (
                    <>
                      {' · '}
                      <Lang text={company.representative.accountable} />
                    </>
                  ) : null}
                </>
              ),
            },
            { label: t('adminSupport.account.openCases'), value: number(entry.openCases) },
          ]}
        />
        <p className="admin-note">{t('adminSupport.company.publicOnly')}</p>
      </Panel>
      <Panel id="members" title={t('adminSupport.company.members')}>
        <Table
          rows={company.publicMembers}
          rowKey={(m) => m.name.value}
          empty={t('adminSupport.company.noMembers')}
          columns={[
            { label: t('adminParticipants.common.name'), render: (m) => <Lang text={m.name} /> },
            { label: t('adminSupport.account.role'), render: (m) => <Lang text={m.role} /> },
          ]}
        />
      </Panel>
      <Panel id="company-actions" title={t('adminSupport.company.actions')}>
        <ul className="admin-list">
          <li className="admin-list__row">
            <NextLink href={ctx.href('support/cases')}>{t('adminSupport.company.requestGrant')}</NextLink>
          </li>
          <li className="admin-list__row">
            <NextLink href={ctx.href('support/explain')}>{t('adminSupport.account.openExplainer')}</NextLink>
          </li>
        </ul>
        <SectionForm ctx={ctx} action={submitSupportCommand} command="cases.create" fields={{ subjectKind: 'company', subjectId: company.id }} submit={t('adminSupport.cases.create')} can={['admin.support.case.create']} variant="secondary">
          <SelectField name="reason" label={t('adminSupport.cases.reason')} options={CASE_REASONS.map((r) => ({ value: r, label: tDynamic(`adminSupport.cases.reasons.${r}`, r) }))} />
        </SectionForm>
      </Panel>
    </>
  );
}

function Support(ctx: HubContext, route: ScreenRoute) {
  const [kind, id] = route.rest;
  if (kind === 'accounts' && id) return Account(ctx, route, id);
  if (kind === 'companies' && id) return Company(ctx, id);
  return Lookup(ctx, route);
}

/** HC-30 Lookup, with HC-31 Account card (`support/accounts/[person]`) and HC-32 Company card (`support/companies/[company]`). */
export const screen: Screen = {
  group: 'support',
  id: 'lookup',
  title: () => t('adminSupport.lookup.title'),
  accepts: (rest) => rest.length === 2 && (rest[0] === 'accounts' || rest[0] === 'companies') && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rest[1] ?? ''),
  render: Support,
};

