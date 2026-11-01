import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { languageName, list, longDate, number } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { submitTrustCommand } from '../_actions';
import { METHOD_PARAMETERS, trustOf, type MethodParameter } from '../_fixtures';
import { fixturesOn, Pill, SectionForm, StaffName, staffNames, Table } from '../../participants/_kit';

const PARAMETERS = Object.keys(METHOD_PARAMETERS) as MethodParameter[];

async function Reputation(ctx: HubContext) {
  const d = trustOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const names = await staffNames(ctx, d.methods.map((m) => m.releasedBy));
  const reviewable = d.methods.filter((m) => m.state === 'draft' || m.state === 'in_review');
  const releasable = d.methods.filter((m) => m.state === 'in_review');
  const current = d.methods.find((m) => m.state === 'released') ?? null;
  const param = (p: MethodParameter) => tDynamic(`adminTrust.reputation.parameters.${p}`, p);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminTrust.reputation.title')} lede={t('adminTrust.reputation.lede')} />
      <p className="admin-callout" role="note" data-testid="no-score-control">
        {t('adminTrust.reputation.noScore')}
      </p>
      <Panel id="versions" title={t('adminTrust.reputation.versions')}>
        <Table
          testid="method-versions"
          rows={d.methods}
          rowKey={(m) => m.id}
          empty={t('adminTrust.reputation.noVersions')}
          columns={[
            { label: t('adminTrust.reputation.version'), render: (m) => t('adminParticipants.common.version', { version: m.version }) },
            { label: t('adminTrust.common.state'), render: (m) => <Pill tone={m.state === 'released' ? 'pass' : m.state === 'superseded' ? 'neutral' : 'warn'}>{tDynamic(`adminTrust.reputation.states.${m.state}`, m.state)}</Pill> },
            {
              label: t('adminTrust.reputation.localParameters'),
              render: (m) => (
                <>
                  {PARAMETERS.map((p) => (
                    <div key={p}>
                      {param(p)}: {number(m.parameters[p])}
                    </div>
                  ))}
                </>
              ),
            },
            { label: t('adminTrust.reputation.explanations'), render: (m) => list(m.explanations.map(languageName)) },
            { label: t('adminTrust.reputation.released'), render: (m) => (m.releasedAt ? <><StaffName names={names} id={m.releasedBy} /> · {longDate(m.releasedAt)}</> : t('admin.common.none')) },
          ]}
        />
        {current ? (
          <p className="admin-meta">
            {t('adminTrust.reputation.missingExplanations', { languages: list(ctx.record.hub.locales.filter((l) => !current.explanations.includes(l)).map(languageName)) || t('admin.common.none') })}
          </p>
        ) : null}
      </Panel>
      <Panel id="bounds" title={t('adminTrust.reputation.bounds')}>
        <ul className="admin-list">
          {PARAMETERS.map((p) => (
            <li key={p} className="admin-list__row">
              <span>{param(p)}</span>
              <span className="admin-meta">{t('adminTrust.reputation.range', { min: METHOD_PARAMETERS[p].min, max: METHOD_PARAMETERS[p].max })}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <div className="admin-grid">
        <Panel id="draft" title={t('adminTrust.reputation.draft')}>
          <SectionForm ctx={ctx} action={submitTrustCommand} command="reputation.draft" submit={t('adminTrust.reputation.draft')} can={['admin.trust.evidence.decide', 'admin.trust.method.release']}>
            {PARAMETERS.map((p) => (
              <TextInput key={p} name={p} label={param(p)} isRequired defaultValue={String(current?.parameters[p] ?? METHOD_PARAMETERS[p].min)} description={t('adminTrust.reputation.range', { min: METHOD_PARAMETERS[p].min, max: METHOD_PARAMETERS[p].max })} />
            ))}
          </SectionForm>
        </Panel>
        <Panel id="review" title={t('adminTrust.reputation.reviewAndRelease')}>
          {reviewable.length ? (
            <SectionForm ctx={ctx} action={submitTrustCommand} command="reputation.review" submit={t('adminTrust.reputation.review')} can={['admin.trust.evidence.decide']} variant="secondary">
              <SelectField name="methodId" label={t('adminTrust.reputation.version')} options={reviewable.map((m) => ({ value: m.id, label: t('adminParticipants.common.version', { version: m.version }) }))} />
            </SectionForm>
          ) : null}
          {releasable.length ? (
            <SectionForm ctx={ctx} action={submitTrustCommand} command="reputation.release" submit={t('adminTrust.reputation.release')} can={['admin.trust.method.release']}>
              <SelectField name="methodId" label={t('adminTrust.reputation.version')} options={releasable.map((m) => ({ value: m.id, label: t('adminParticipants.common.version', { version: m.version }) }))} description={t('adminTrust.reputation.releaseRule')} />
            </SectionForm>
          ) : (
            <p className="admin-empty">{t('adminTrust.reputation.nothingToRelease')}</p>
          )}
        </Panel>
        <Panel id="explain" title={t('adminTrust.reputation.publishExplanation')}>
          {d.methods.length ? (
            <SectionForm ctx={ctx} action={submitTrustCommand} command="reputation.explain" submit={t('adminTrust.reputation.publishExplanation')} can={['admin.trust.evidence.decide', 'admin.trust.method.release']} variant="secondary">
              <SelectField name="methodId" label={t('adminTrust.reputation.version')} options={d.methods.filter((m) => m.state !== 'superseded').map((m) => ({ value: m.id, label: t('adminParticipants.common.version', { version: m.version }) }))} />
              <SelectField name="locale" label={t('adminTrust.reputation.language')} options={ctx.record.hub.locales.map((l) => ({ value: l, label: languageName(l) }))} />
            </SectionForm>
          ) : (
            <p className="admin-empty">{t('adminTrust.reputation.noVersions')}</p>
          )}
        </Panel>
      </div>
      <Panel id="jobs" title={t('adminTrust.reputation.jobs')}>
        <Table
          rows={d.jobs}
          rowKey={(j) => j.id}
          empty={t('adminTrust.reputation.noJobs')}
          columns={[
            { label: t('adminTrust.reputation.version'), render: (j) => t('adminParticipants.common.version', { version: j.method }) },
            { label: t('adminTrust.common.state'), render: (j) => tDynamic(`adminTrust.common.runStates.${j.state}`, j.state) },
            { label: t('adminTrust.common.progress'), render: (j) => t('adminTrust.common.progressOf', { done: number(j.processed), total: number(j.total) }) },
            { label: t('adminTrust.common.started'), render: (j) => longDate(j.startedAt) },
          ]}
        />
      </Panel>
    </>
  );
}

/** HC-72 Reputation methods: explainable method versions with bounded local parameters; no control edits a score. */
export const screen: Screen = { group: 'trust', id: 'reputation', title: () => t('adminTrust.reputation.title'), render: Reputation };
