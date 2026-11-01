import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { submitTrustCommand } from '../_actions';
import { CLAUSES, SANCTION_LEVELS, trustOf } from '../_fixtures';
import { fixturesOn, Lang, Pill, SectionForm, Table } from '../../participants/_kit';

async function Moderation(ctx: HubContext) {
  const d = trustOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const zone = ctx.record.hub.timeZone;
  const clause = (key: string) => tDynamic(`adminTrust.clauses.${key}`, key);
  const pending = d.cases.filter((c) => c.decision === 'pending');
  const fresh = d.reports.filter((r) => r.state === 'new');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminTrust.moderation.title')} lede={t('adminTrust.moderation.lede')} />
      <Panel id="reports" title={t('adminTrust.moderation.reports')}>
        <Table
          testid="reports"
          rows={d.reports}
          rowKey={(r) => r.id}
          empty={t('adminTrust.moderation.noReports')}
          columns={[
            { label: t('adminTrust.common.id'), render: (r) => <code className="admin-code">{r.id}</code> },
            { label: t('adminTrust.moderation.target'), render: (r) => tDynamic(`adminTrust.moderation.targets.${r.target}`, r.target) },
            { label: t('adminTrust.moderation.clause'), render: (r) => clause(r.clause) },
            { label: t('adminTrust.moderation.source'), render: (r) => tDynamic(`adminTrust.moderation.sources.${r.source}`, r.source) },
            { label: t('adminTrust.common.received'), render: (r) => dateTime(r.receivedAt, zone) },
            { label: t('adminTrust.common.state'), render: (r) => <Pill tone={r.state === 'new' ? 'warn' : 'neutral'}>{tDynamic(`adminTrust.moderation.reportStates.${r.state}`, r.state)}</Pill> },
          ]}
        />
        {fresh.length ? (
          <SectionForm ctx={ctx} action={submitTrustCommand} command="moderation.open_case" submit={t('adminTrust.moderation.openCase')} can={['admin.moderation.case.open']} variant="secondary">
            <SelectField name="reportId" label={t('adminTrust.moderation.report')} options={fresh.map((r) => ({ value: r.id, label: `${r.id} · ${clause(r.clause)}` }))} />
          </SectionForm>
        ) : null}
      </Panel>
      <Panel id="cases" title={t('adminTrust.moderation.cases')}>
        <Table
          testid="moderation-cases"
          rows={d.cases}
          rowKey={(c) => c.id}
          empty={t('adminTrust.moderation.noCases')}
          columns={[
            { label: t('adminTrust.common.id'), render: (c) => <code className="admin-code">{c.id}</code> },
            { label: t('adminTrust.moderation.clause'), render: (c) => clause(c.clause) },
            { label: t('adminTrust.moderation.evidence'), render: (c) => t('adminTrust.common.items', { count: c.evidence }) },
            { label: t('adminTrust.moderation.decision'), render: (c) => `${tDynamic(`adminTrust.moderation.decisions.${c.decision}`, c.decision)}${c.level ? ` · ${t('adminTrust.moderation.level', { level: c.level })}` : ''}` },
            { label: t('adminTrust.moderation.appeal'), render: (c) => tDynamic(`adminTrust.moderation.appealStates.${c.appeal}`, c.appeal) },
          ]}
        />
      </Panel>
      <div className="admin-grid">
        <Panel id="decide" title={t('adminTrust.moderation.decide')}>
          {pending.length ? (
            <SectionForm ctx={ctx} action={submitTrustCommand} command="moderation.decide" submit={t('adminTrust.moderation.decide')} can={['admin.moderation.decide']}>
              <SelectField name="caseId" label={t('adminTrust.moderation.case')} options={pending.map((c) => ({ value: c.id, label: `${c.id} · ${clause(c.clause)}` }))} />
              <SelectField
                name="outcome"
                label={t('adminTrust.moderation.decision')}
                options={(['no_action', 'sanction'] as const).map((o) => ({ value: o, label: tDynamic(`adminTrust.moderation.decisions.${o}`, o) }))}
              />
              <SelectField name="level" label={t('adminTrust.moderation.sanctionLevel')} options={SANCTION_LEVELS.map((l) => ({ value: String(l), label: `${t('adminTrust.moderation.level', { level: l })}: ${tDynamic(`adminTrust.moderation.levels.${l}`, String(l))}` }))} description={t('adminTrust.moderation.levelRule')} />
            </SectionForm>
          ) : (
            <p className="admin-empty">{t('adminTrust.moderation.nothingToDecide')}</p>
          )}
        </Panel>
        <Panel id="emergency" title={t('adminTrust.moderation.emergency')}>
          <SectionForm ctx={ctx} action={submitTrustCommand} command="moderation.emergency" submit={t('adminTrust.moderation.emergencySubmit')} can={['admin.moderation.emergency.hold', 'admin.moderation.emergency.freeze']} variant="danger">
            <SelectField name="kind" label={t('adminTrust.moderation.emergencyKind')} options={(['hold', 'freeze'] as const).map((k) => ({ value: k, label: tDynamic(`adminTrust.moderation.emergencyKinds.${k}`, k) }))} />
            <SelectField name="target" label={t('adminTrust.moderation.target')} options={[...d.reports.map((r) => ({ value: r.id, label: r.id })), ...d.cases.map((c) => ({ value: c.id, label: c.id }))]} />
          </SectionForm>
        </Panel>
      </div>
      <Panel id="clauses" title={t('adminTrust.moderation.clauseLibrary')}>
        <Table
          rows={CLAUSES}
          rowKey={(c) => c.key}
          empty=""
          columns={[
            { label: t('adminTrust.moderation.clause'), render: (c) => clause(c.key) },
            { label: t('adminTrust.moderation.law'), render: (c) => <Lang text={c.law} /> },
          ]}
        />
        <h3 className="admin-h3">{t('adminTrust.moderation.ladder')}</h3>
        <ol className="admin-ordered" data-testid="sanction-ladder">
          {SANCTION_LEVELS.map((l) => (
            <li key={l}>
              {tDynamic(`adminTrust.moderation.levels.${l}`, String(l))}
              {l === 4 ? <span className="admin-meta"> · {t('adminTrust.moderation.secondPerson')}</span> : null}
            </li>
          ))}
        </ol>
      </Panel>
    </>
  );
}

/** HC-70 Moderation: reports, cases with clause and evidence, the clause library mapped to law and the sanction ladder (level 4 needs a second person). */
export const screen: Screen = { group: 'trust', id: 'moderation', title: () => t('adminTrust.moderation.title'), render: Moderation };
