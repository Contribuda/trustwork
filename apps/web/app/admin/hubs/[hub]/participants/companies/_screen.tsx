import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { list, longDate } from '../../../../_components/format';
import { ConsoleHeader, Panel, StatusLabel } from '../../../../_components/shell';
import { submitParticipantsCommand } from '../_actions';
import { participantsOf, VERIFICATION_REVOCATION_CATEGORIES, type CompanyRecord } from '../_fixtures';
import { fixturesOn, Lang, Pill, SectionForm, Table } from '../_kit';

const stateTone = (s: CompanyRecord['state']) => (s === 'verified' ? 'pass' : s === 'claimed' ? 'warn' : 'neutral');
const repTone = (s: CompanyRecord['representative']['state']) => (s === 'active' ? 'pass' : s === 'none' ? 'neutral' : 'warn');

async function Companies(ctx: HubContext) {
  const data = participantsOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const companies = data.companies.filter((c) => c.kind === 'contractor' || c.state !== 'sourced');
  const sourced = data.companies.filter((c) => c.state === 'sourced');
  const takedowns = data.companies.filter((c) => c.takedownPending);
  const options = (rows: readonly CompanyRecord[]) => rows.map((c) => ({ value: c.id, label: c.name.value }));
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminParticipants.companies.title')} lede={t('adminParticipants.companies.lede')} />
      {takedowns.map((c) => (
        <p key={c.id} className="admin-callout admin-callout--warning" role="note" data-testid="takedown-banner">
          {t('adminParticipants.companies.takedownBanner')} <Lang text={c.name} />
        </p>
      ))}
      <Panel id="directory" title={t('adminParticipants.companies.directory')}>
        <p className="admin-note">{t('adminParticipants.companies.badgeRule')}</p>
        <Table
          testid="companies"
          rows={companies}
          rowKey={(c) => c.id}
          empty={t('adminParticipants.companies.none')}
          columns={[
            {
              label: t('adminParticipants.common.name'),
              render: (c) => (
                <>
                  <Lang text={c.name} />
                  {c.identifiers.map((i) => (
                    <div key={i.value} className="admin-meta">
                      {tDynamic(`adminParticipants.identifiers.${i.kind}`, i.kind)} <code className="admin-code">{i.value}</code>
                    </div>
                  ))}
                </>
              ),
            },
            { label: t('adminParticipants.companies.state'), render: (c) => <Pill tone={stateTone(c.state)}>{tDynamic(`adminParticipants.companyStates.${c.state}`, c.state)}</Pill> },
            { label: t('adminParticipants.companies.categories'), render: (c) => list(c.categories.map((k) => tDynamic(`adminParticipants.categories.${k}`, k))) },
            {
              label: t('adminParticipants.companies.verification'),
              render: (c) => (
                <>
                  {c.verifiedAt ? t('adminParticipants.companies.verifiedOn', { date: longDate(c.verifiedAt) }) : t('admin.common.none')}
                  {c.recheckDue ? (
                    <div className="admin-meta">
                      {t('adminParticipants.companies.recheckOn', { date: longDate(c.recheckDue) })}
                      {Date.parse(c.recheckDue) <= ctx.now.getTime() ? <span className="admin-warning"> · {t('adminParticipants.companies.recheckOverdue')}</span> : null}
                    </div>
                  ) : null}
                </>
              ),
            },
            {
              label: t('adminParticipants.companies.representative'),
              render: (c) => (
                <>
                  <Pill tone={repTone(c.representative.state)}>{tDynamic(`adminParticipants.repStates.${c.representative.state}`, c.representative.state)}</Pill>
                  {c.representative.accountable ? (
                    <span className="admin-meta">
                      {' '}
                      · <Lang text={c.representative.accountable} />
                    </span>
                  ) : null}
                </>
              ),
            },
          ]}
        />
        <p>
          <NextLink href={ctx.href('participants/claims')}>{t('adminParticipants.companies.openClaims')}</NextLink>
        </p>
        <p className="admin-meta">
          {t('adminParticipants.companies.linkProposals')} <StatusLabel status="designed" />
        </p>
      </Panel>
      <Panel id="sourced" title={t('adminParticipants.companies.sourced')}>
        <p className="admin-note">{t('adminParticipants.companies.sourcedNote')}</p>
        <Table
          testid="sourced-pages"
          rows={sourced}
          rowKey={(c) => c.id}
          empty={t('adminParticipants.companies.noSourced')}
          columns={[
            { label: t('adminParticipants.common.name'), render: (c) => <Lang text={c.name} /> },
            { label: t('adminParticipants.companies.kind'), render: (c) => tDynamic(`adminParticipants.companyKinds.${c.kind}`, c.kind) },
            {
              label: t('adminParticipants.companies.source'),
              render: (c) =>
                c.source ? (
                  <>
                    <Lang text={c.source.name} /> <code className="admin-code">{c.source.url}</code>
                  </>
                ) : (
                  t('admin.common.none')
                ),
            },
            { label: t('adminParticipants.companies.takedown'), render: (c) => (c.takedownPending ? <Pill tone="warn">{t('adminParticipants.companies.takedownPending')}</Pill> : t('admin.common.none')) },
          ]}
        />
      </Panel>
      <div className="admin-grid">
        <Panel id="revoke" title={t('adminParticipants.companies.revoke')}>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="companies.revoke_verification" submit={t('adminParticipants.companies.revoke')} can={['admin.claims.revoke']} variant="danger">
            <SelectField name="companyId" label={t('adminParticipants.common.company')} options={options(data.companies.filter((c) => c.state === 'verified'))} />
            <SelectField name="category" label={t('adminParticipants.common.reasonCategory')} options={VERIFICATION_REVOCATION_CATEGORIES.map((c) => ({ value: c, label: tDynamic(`adminParticipants.companies.revocation.${c}`, c) }))} />
            <p className="admin-note">{t('adminParticipants.companies.revokeNote')}</p>
          </SectionForm>
        </Panel>
        <Panel id="recheck" title={t('adminParticipants.companies.triggerRecheck')}>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="companies.recheck" submit={t('adminParticipants.companies.triggerRecheck')} can={['admin.claims.decide']} variant="secondary">
            <SelectField name="companyId" label={t('adminParticipants.common.company')} options={options(data.companies.filter((c) => c.state !== 'sourced'))} />
          </SectionForm>
        </Panel>
        <Panel id="suspend-representative" title={t('adminParticipants.companies.suspendRep')}>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="companies.suspend_representative" submit={t('adminParticipants.companies.suspendRep')} can={['admin.claims.decide']} variant="danger">
            <SelectField name="companyId" label={t('adminParticipants.common.company')} options={options(data.companies.filter((c) => c.representative.state !== 'none'))} />
            <p className="admin-note">{t('adminParticipants.companies.suspendRepNote')}</p>
          </SectionForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-21 Companies: sourced, claimed and verified companies, identifiers, re-checks and representatives; no control sets a badge. */
export const screen: Screen = { group: 'participants', id: 'companies', title: () => t('adminParticipants.companies.title'), render: Companies };
