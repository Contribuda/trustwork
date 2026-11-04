import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import type { ClaimDispute, ClaimProvider, ClaimsView, LiveClaim } from '../../../../_data/live-claims';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import { CheckboxField, formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { country as countryName, dateTime, longDate } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Pill, StaffName, staffNames, type StaffNames } from '../_kit';
import { CHECK_RESULTS, CLAIM_DECISIONS } from './_commands';

const L = 'adminParticipants.claims.live';
const checkName = (check: string) => tDynamic(`${L}.checks.${check}`, check);
const resultTone = (result: string) => (result === 'pass' ? 'pass' : result === 'fail' ? 'fail' : 'warn');
const STATE_TONE: Readonly<Record<string, 'pass' | 'warn' | 'fail' | 'neutral'>> = { open: 'warn', waiting: 'warn', disputed: 'fail', approved: 'pass', rejected: 'neutral', withdrawn: 'neutral' };

/** The country rule of CLM-001 as the reviewer needs it: what the company is, what this hub covers, what may be decided. */
function CountryRule({ claim }: { claim: LiveClaim }) {
  const place = claim.company?.country ? countryName(claim.company.country) : null;
  const region = claim.company?.region ? ` · ${claim.company.region}` : '';
  if (claim.territory === 'covered') {
    return <p className="admin-note" data-testid="claim-territory-covered"><Pill tone="pass">{t('adminParticipants.claims.live.territory.covered')}</Pill> {place}{region}</p>;
  }
  if (claim.territory === 'outside') {
    return <p className="admin-callout admin-callout--danger" role="note" data-testid="claim-territory-outside">{t('adminParticipants.claims.live.territory.outside', { country: place ?? '' })}</p>;
  }
  return <p className="admin-callout admin-callout--warning" role="note" data-testid="claim-territory-missing">{t('adminParticipants.claims.live.territory.missing')}</p>;
}

function CountryCorrection({ ctx, claim }: { ctx: HubContext; claim: LiveClaim }) {
  const fields = { 'f.companyId': claim.companyId, 'f.fromCountry': claim.company?.country ?? '', 'f.fromRegion': claim.company?.region ?? '' };
  return (
    <details data-testid="claim-country-correction">
      <summary>{t('adminParticipants.claims.live.correct.title')}</summary>
      <p className="admin-note">{t('adminParticipants.claims.live.correct.help')}</p>
      <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('claim.country_correct', fields)} labels={formLabels({ submit: t('adminParticipants.claims.live.correct.submit') })} disabledReason={readOnlyReason(ctx.can('admin.claims.authority.decide'), ctx.offline)}>
        <div className="admin-form__grid">
          <TextInput name="country" label={t('adminParticipants.claims.live.correct.country')} description={t('adminParticipants.claims.live.correct.countryHelp')} isRequired defaultValue={claim.company?.country ?? ''} />
          <TextInput name="region" label={t('adminParticipants.claims.live.correct.region')} description={t('adminParticipants.claims.live.correct.regionHelp')} defaultValue={claim.company?.region ?? ''} />
        </div>
      </ConsoleForm>
    </details>
  );
}

function Standing({ ctx, claim }: { ctx: HubContext; claim: LiveClaim }) {
  const { standing } = claim;
  if (!standing) return <p className="admin-empty">{t('adminParticipants.claims.live.standing.hidden')}</p>;
  return (
    <>
      <p>
        <Pill tone={standing.status === 'passed' ? 'pass' : standing.status === 'failed' ? 'fail' : 'warn'}>{tDynamic(`${L}.standing.${standing.status}`, standing.status)}</Pill>
        {standing.missing.length ? ` ${t('adminParticipants.claims.live.standing.missing', { checks: standing.missing.map(checkName).join(', ') })}` : ''}
        {standing.failed.length ? ` ${t('adminParticipants.claims.live.standing.failedChecks', { checks: standing.failed.map(checkName).join(', ') })}` : ''}
      </p>
      {standing.handoverBlocked ? <p className="admin-callout admin-callout--danger" data-testid="sanctions-block">{t('adminParticipants.claims.live.standing.blocked')} <a href={ctx.href('trust/screening')}>{t('adminParticipants.claims.openScreeningCase')}</a></p> : null}
    </>
  );
}

function Evidence({ ctx, claim, providers }: { ctx: HubContext; claim: LiveClaim; providers: readonly ClaimProvider[] }) {
  const unbound = claim.checks.filter((c) => !c.bound);
  const readOnly = readOnlyReason(ctx.can('admin.claims.decide'), ctx.offline);
  const usable = providers.filter((p) => p.mode !== 'live');
  return (
    <details data-testid="claim-evidence">
      <summary>{t('adminParticipants.claims.live.evidence.title')}</summary>
      <p className="admin-note">{t('adminParticipants.claims.live.evidence.help')}</p>
      {claim.checks.length ? (
        <ul className="admin-list">
          {claim.checks.map((c) => (
            <li key={c.id} className="admin-list__row">
              <span>{checkName(c.checkType)}</span>
              <Pill tone={resultTone(c.result)}>{tDynamic(`${L}.results.${c.result}`, c.result)}</Pill>
              <span className="admin-meta">{dateTime(c.recordedAt, ctx.record.hub.timeZone)} · {t(c.bound ? 'adminParticipants.claims.live.evidence.bound' : 'adminParticipants.claims.live.evidence.unbound')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="admin-empty">{t('adminParticipants.claims.live.evidence.none')}</p>
      )}
      {unbound.length ? (
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('claim.bind_evidence', { 'f.claimId': claim.id })} labels={formLabels({ submit: t('adminParticipants.claims.live.evidence.bind') })} disabledReason={readOnly} submitVariant="secondary">
          {unbound.map((c) => (
            <CheckboxField key={c.id} name={`check.${c.id}`} label={`${checkName(c.checkType)} · ${tDynamic(`${L}.results.${c.result}`, c.result)}`} />
          ))}
        </ConsoleForm>
      ) : null}
      {usable.length ? (
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('claim.check_record', { 'f.companyId': claim.companyId, 'f.recipeId': claim.recipeId })} labels={formLabels({ submit: t('adminParticipants.claims.recordCheck') })} disabledReason={readOnly} submitVariant="secondary">
          <div className="admin-form__grid">
            <SelectField name="providerId" label={t('adminParticipants.claims.live.evidence.provider')} options={usable.map((p) => ({ value: p.id, label: `${checkName(p.checkType)} · ${p.adapter}` }))} />
            <SelectField name="result" label={t('adminParticipants.claims.result')} options={CHECK_RESULTS.map((r) => ({ value: r, label: tDynamic(`${L}.results.${r}`, r) }))} />
            <TextInput name="evidenceRef" label={t('adminParticipants.claims.live.evidence.ref')} description={t('adminParticipants.claims.live.evidence.refHelp')} />
          </div>
        </ConsoleForm>
      ) : (
        <p className="admin-note">{t('adminParticipants.claims.live.evidence.noProvider')}</p>
      )}
      <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('claim.screening_record', { 'f.companyId': claim.companyId, 'f.recipeId': claim.recipeId })} labels={formLabels({ submit: t('adminParticipants.claims.live.evidence.screening') })} disabledReason={readOnly} submitVariant="secondary" />
    </details>
  );
}

function Decision({ ctx, claim }: { ctx: HubContext; claim: LiveClaim }) {
  const readOnly = readOnlyReason(ctx.can('admin.claims.decide'), ctx.offline);
  // A rejection is a decision too, so a hub that may not decide offers neither; the correction above is the way forward.
  const blocked = claim.territory !== 'covered' ? t('adminParticipants.claims.live.territory.noDecision') : null;
  return (
    <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('claim.decide', { 'f.claimId': claim.id, 'f.revision': String(claim.revision) })} labels={formLabels({ submit: t('adminParticipants.claims.decide') })} disabledReason={readOnly ?? blocked}>
      <SelectField name="decision" label={t('adminParticipants.claims.decision')} options={CLAIM_DECISIONS.map((d) => ({ value: d, label: tDynamic(`${L}.decisions.${d}`, d) }))} />
      <CheckboxField name="officerMatch" label={t('adminParticipants.claims.live.officerMatch')} />
      <TextInput name="note" label={t('adminParticipants.claims.live.note')} />
    </ConsoleForm>
  );
}

function ClaimCard({ ctx, claim, providers }: { ctx: HubContext; claim: LiveClaim; providers: readonly ClaimProvider[] }) {
  return (
    <li className="admin-approval" data-testid={`live-claim-${claim.id}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3" lang="und">{claim.companyName ?? claim.companyId}</h3>
        <Pill tone={STATE_TONE[claim.state] ?? 'neutral'}>{tDynamic(`${L}.states.${claim.state}`, claim.state)}</Pill>
      </div>
      <KeyValues
        rows={[
          { label: t('adminParticipants.claims.target'), value: tDynamic(`${L}.levels.${claim.level}`, claim.level) },
          { label: t('adminParticipants.claims.recipe'), value: claim.recipe ? <code className="admin-code">{`${claim.recipe.key} v${claim.recipe.version}`}</code> : <code className="admin-code">{claim.recipeId}</code> },
          { label: t('adminParticipants.claims.submitted'), value: dateTime(claim.createdAt, ctx.record.hub.timeZone) },
          { label: t('adminParticipants.claims.live.tie'), value: claim.domainTie ? `${tDynamic(`${L}.ties.${claim.domainTie}`, claim.domainTie)}${claim.domainTieDomain ? ` · ${claim.domainTieDomain}` : ''}` : t('adminParticipants.claims.live.noTie') },
          ...(claim.waitingUntil ? [{ label: t('adminParticipants.claims.live.waitingUntil'), value: longDate(claim.waitingUntil) }] : []),
        ]}
      />
      {claim.own ? (
        <p className="admin-callout admin-callout--warning" data-testid="own-claim">{t('adminParticipants.claims.live.own')}</p>
      ) : (
        <>
          <CountryRule claim={claim} />
          <Standing ctx={ctx} claim={claim} />
          <Evidence ctx={ctx} claim={claim} providers={providers} />
          <CountryCorrection ctx={ctx} claim={claim} />
          {claim.state === 'disputed' ? <p className="admin-note">{t('adminParticipants.claims.live.disputed')}</p> : <Decision ctx={ctx} claim={claim} />}
        </>
      )}
    </li>
  );
}

function Dispute({ ctx, dispute, claims, names }: { ctx: HubContext; dispute: ClaimDispute; claims: readonly LiveClaim[]; names: StaffNames }) {
  const inDispute = claims.filter((c) => c.disputeId === dispute.id);
  const readOnly = readOnlyReason(ctx.can('admin.claims.decide'), ctx.offline);
  const proposed = dispute.proposedBy !== null;
  const own = dispute.proposedBy === ctx.viewer.person.id;
  return (
    <li className="admin-approval" data-testid={`dispute-${dispute.id}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3" lang="und">{inDispute[0]?.companyName ?? dispute.companyId}</h3>
        <Pill tone="warn">{t('adminParticipants.claims.live.states.disputed')}</Pill>
      </div>
      {proposed ? (
        <>
          <p>{dispute.proposedClaimId ? t('adminParticipants.claims.live.dispute.proposedWinner') : t('adminParticipants.claims.live.dispute.proposedNone')} · <StaffName names={names} id={dispute.proposedBy} /></p>
          {dispute.proposedNote ? <p className="admin-meta" lang="und">{dispute.proposedNote}</p> : null}
          <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('claim.dispute_confirm', { 'f.disputeId': dispute.id, 'f.revision': String(dispute.revision) })} labels={formLabels({ submit: t('adminParticipants.claims.live.dispute.confirm'), secondPerson: true })} disabledReason={readOnly ?? (own ? t('adminParticipants.claims.live.reasons.second_person_required') : null)} />
        </>
      ) : (
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('claim.dispute_propose', { 'f.disputeId': dispute.id, 'f.revision': String(dispute.revision) })} labels={formLabels({ submit: t('adminParticipants.claims.live.dispute.propose') })} disabledReason={readOnly}>
          <SelectField name="winner" label={t('adminParticipants.claims.live.dispute.winner')} options={[{ value: 'none', label: t('adminParticipants.claims.live.dispute.none') }, ...inDispute.map((c, i) => ({ value: c.id, label: t('adminParticipants.claims.live.dispute.claim', { number: i + 1 }) }))]} />
          <TextInput name="note" label={t('adminParticipants.claims.live.dispute.note')} description={t('adminParticipants.claims.live.dispute.noteHelp')} isRequired />
        </ConsoleForm>
      )}
    </li>
  );
}

/** HC-22 on the API (HUBC-007): the queue with the country rule in view, evidence bound to the claim, decisions and disputes. */
export async function LiveClaims(ctx: HubContext) {
  const view: ClaimsView | null = await ctx.port.claims(ctx.record.hub.id);
  const header = <ConsoleHeader ctx={ctx} title={t('adminParticipants.claims.title')} lede={t('adminParticipants.claims.lede')} />;
  if (!view) {
    return (
      <>
        {header}
        <p className="admin-empty">{t('adminParticipants.claims.live.hidden')}</p>
      </>
    );
  }
  const names = await staffNames(ctx, view.disputes.map((d) => d.proposedBy));
  const openDisputes = view.disputes.filter((d) => d.state === 'open');
  return (
    <>
      {header}
      <Panel id="queue" title={t('adminParticipants.claims.queue')}>
        <p className="admin-note">{t('adminParticipants.claims.live.rule')}</p>
        {view.claims.length ? (
          <ul className="admin-approvals">
            {view.claims.map((c) => (
              <ClaimCard key={c.id} ctx={ctx} claim={c} providers={view.providers} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminParticipants.claims.empty')}</p>
        )}
      </Panel>
      {openDisputes.length ? (
        <Panel id="disputes" title={t('adminParticipants.claims.live.dispute.title')}>
          <p className="admin-note">{t('adminParticipants.claims.live.dispute.help')}</p>
          <ul className="admin-approvals">
            {openDisputes.map((d) => (
              <Dispute key={d.id} ctx={ctx} dispute={d} claims={view.claims} names={names} />
            ))}
          </ul>
        </Panel>
      ) : null}
      {view.decided.length ? (
        <Panel id="decided" title={t('adminParticipants.claims.live.decided')}>
          <ul className="admin-list">
            {view.decided.map((c) => (
              <li key={c.id} className="admin-list__row">
                <span lang="und">{c.companyName ?? c.companyId}</span>
                <Pill tone={STATE_TONE[c.state] ?? 'neutral'}>{tDynamic(`${L}.states.${c.state}`, c.state)}</Pill>
                {c.decidedAt ? <span className="admin-meta">{longDate(c.decidedAt)}</span> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}
