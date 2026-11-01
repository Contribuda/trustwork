import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { dateTime, longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, StatusLabel } from '../../../../_components/shell';
import { submitParticipantsCommand } from '../_actions';
import { CLAIM_DECISIONS, EVIDENCE_CATEGORIES, participantsOf, type Claim, type StepResult } from '../_fixtures';
import { fixturesOn, Lang, Pill, SectionForm, StaffName, staffNames, type StaffNames } from '../_kit';

const tone = (r: StepResult) => (r === 'pass' ? 'pass' : r === 'pending' ? 'warn' : 'fail');
const REVIEWERS = ['p-trust', 'p-compliance', 'p-hub-owner'] as const;

function ClaimCard({ ctx, claim, company, names }: { ctx: HubContext; claim: Claim; company: { value: string; lang: string } | null; names: StaffNames }) {
  const me = ctx.viewer.person.id;
  const match = claim.steps.some((s) => s.result === 'potential_match');
  const conflict = claim.conflicts.includes(me);
  const ownAppeal = claim.appeal?.originalDecider === me;
  const blocked = conflict ? t('adminParticipants.errors.conflict_of_interest') : ownAppeal ? t('adminParticipants.errors.original_decider') : null;
  return (
    <li className="admin-approval" data-testid={`claim-${claim.id}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">{company ? <Lang text={company} /> : claim.companyId}</h3>
        <Pill tone={claim.state === 'appeal' ? 'warn' : 'neutral'}>{tDynamic(`adminParticipants.claims.states.${claim.state}`, claim.state)}</Pill>
      </div>
      <KeyValues
        rows={[
          { label: t('adminParticipants.claims.target'), value: tDynamic(`adminParticipants.companyStates.${claim.target}`, claim.target) },
          { label: t('adminParticipants.claims.recipe'), value: <code className="admin-code">{`${claim.recipe.key} v${claim.recipe.version}`}</code> },
          { label: t('adminParticipants.claims.submitted'), value: dateTime(claim.submittedAt, ctx.record.hub.timeZone) },
        ]}
      />
      <h4 className="admin-h4">{t('adminParticipants.claims.steps')}</h4>
      <ul className="admin-list">
        {claim.steps.map((s) => (
          <li key={s.step} className="admin-list__row">
            <span>{tDynamic(`adminParticipants.steps.${s.step}`, s.step)}</span>
            <Pill tone={tone(s.result)}>{tDynamic(`adminParticipants.stepResults.${s.result}`, s.result)}</Pill>
            {s.required ? null : <span className="admin-meta">{t('adminParticipants.claims.optional')}</span>}
          </li>
        ))}
      </ul>
      <h4 className="admin-h4">{t('adminParticipants.claims.evidence')}</h4>
      <ul className="admin-tags">
        {claim.evidence.map((e) => (
          <li key={e.category}>{t('adminParticipants.claims.evidenceItem', { category: tDynamic(`adminParticipants.evidence.${e.category}`, e.category), count: e.count })}</li>
        ))}
      </ul>
      <p className="admin-meta">
        {t('adminParticipants.claims.evidenceViewer')} <StatusLabel status="designed" />
      </p>
      {match ? (
        <p className="admin-callout admin-callout--danger" data-testid="sanctions-block">
          {t('adminParticipants.claims.sanctionsBlock')} {claim.screeningCase ? <NextLink href={ctx.href('trust/screening')}>{t('adminParticipants.claims.openScreeningCase')}</NextLink> : null}
        </p>
      ) : null}
      {claim.conflicts.length ? (
        <p className="admin-callout admin-callout--warning" data-testid="conflict-note">
          {t('adminParticipants.claims.conflicts')} {claim.conflicts.map((id) => <StaffName key={id} names={names} id={id} />)}
        </p>
      ) : null}
      {claim.appeal ? (
        <>
          <p className="admin-callout">
            {t('adminParticipants.claims.appealNote', { deadline: longDate(claim.appeal.deadline) })} <StaffName names={names} id={claim.appeal.originalDecider} />
          </p>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="claims.route_appeal" fields={{ claimId: claim.id }} submit={t('adminParticipants.claims.routeAppeal')} can={['admin.claims.decide', 'admin.trust.appeals.decide']} variant="secondary">
            <SelectField name="reviewer" label={t('adminParticipants.claims.reviewer')} options={REVIEWERS.filter((id) => id !== claim.appeal!.originalDecider).map((id) => ({ value: id, label: names.get(id)?.text ?? id }))} />
          </SectionForm>
        </>
      ) : null}
      <div className="admin-grid">
        <SectionForm ctx={ctx} action={submitParticipantsCommand} command="claims.decide" fields={{ claimId: claim.id }} submit={t('adminParticipants.claims.decide')} can={['admin.claims.decide']} blocked={blocked}>
          <SelectField
            name="decision"
            label={t('adminParticipants.claims.decision')}
            options={CLAIM_DECISIONS.filter((d) => !(match && (d === 'claimed' || d === 'verified'))).map((d) => ({ value: d, label: tDynamic(`adminParticipants.claims.decisions.${d}`, d) }))}
          />
        </SectionForm>
        <SectionForm ctx={ctx} action={submitParticipantsCommand} command="claims.record_check" fields={{ claimId: claim.id }} submit={t('adminParticipants.claims.recordCheck')} can={['admin.claims.decide']} blocked={blocked} variant="secondary">
          <SelectField name="step" label={t('adminParticipants.claims.step')} options={claim.steps.filter((s) => s.step !== 'screening').map((s) => ({ value: s.step, label: tDynamic(`adminParticipants.steps.${s.step}`, s.step) }))} />
          <SelectField name="result" label={t('adminParticipants.claims.result')} options={(['pass', 'fail'] as const).map((r) => ({ value: r, label: tDynamic(`adminParticipants.stepResults.${r}`, r) }))} />
          <SelectField name="evidence" label={t('adminParticipants.claims.evidenceCategory')} options={EVIDENCE_CATEGORIES.map((e) => ({ value: e, label: tDynamic(`adminParticipants.evidence.${e}`, e) }))} />
        </SectionForm>
      </div>
    </li>
  );
}

async function Claims(ctx: HubContext) {
  const data = participantsOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const names = await staffNames(ctx, [...data.claims.flatMap((c) => c.conflicts), ...data.claims.map((c) => c.appeal?.originalDecider), ...REVIEWERS]);
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminParticipants.claims.title')} lede={t('adminParticipants.claims.lede')} />
      <Panel id="queue" title={t('adminParticipants.claims.queue')}>
        <p className="admin-note">{t('adminParticipants.claims.recipeRule')}</p>
        {data.claims.length ? (
          <ul className="admin-approvals">
            {data.claims.map((c) => (
              <ClaimCard key={c.id} ctx={ctx} claim={c} company={data.companies.find((x) => x.id === c.companyId)?.name ?? null} names={names} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminParticipants.claims.empty')}</p>
        )}
      </Panel>
    </>
  );
}

/** HC-22 Claims: decide claims with the recipe; a potential sanctions match or a declared conflict blocks the decision. */
export const screen: Screen = { group: 'participants', id: 'claims', title: () => t('adminParticipants.claims.title'), render: Claims };
