import { withBase } from '@/app/_lib/base-path';
import { ActionForm } from '../../trust/screening/ActionForm';
import type { Copy, MatchDetail, SubjectSchema } from '../../trust/screening/model';
import type { z } from 'zod';

/** The same staff-only compliance projection on the screening case and both participant routes. */
export function CompliancePanel({ subject, details, access, mayAct, c, hub, fmtDate }: {
  subject: z.infer<typeof SubjectSchema>; details: MatchDetail[]; access: { personId: string }; mayAct: boolean;
  c: Copy; hub: string; fmtDate: (value: string | null) => string;
}) {
  const decisionLabel = (kind: string) => c.decisionKinds[kind as keyof Copy['decisionKinds']] ?? c.unknown;
  return (
    <section aria-labelledby="subject-heading" data-testid="compliance-panel"><h2 id="subject-heading">{c.subjectKinds[subject.subject.kind]} · <code>{subject.subject.id}</code></h2>
      <p>{c.outcome}: {subject.lastOutcome ? c.outcomes[subject.lastOutcome] : c.unknown}</p>
      <p>{c.lastScreened}: {fmtDate(subject.lastScreenedAt)}</p>
      <p>{subject.moneyHeld ? c.moneyHeld : c.moneyClear}</p>
      <a href={withBase(`/admin/hubs/${encodeURIComponent(hub)}/participants/${subject.subject.kind === 'person' ? 'people' : 'companies'}/${subject.subject.id}`)}>{c.openParticipant}</a>
      {details.map(({ match, decisions }) => {
        const proposal = match.pendingApproval;
        const own = proposal?.requestedBy === access.personId;
        const expired = !!proposal && Date.parse(proposal.requestExpiresAt) <= Date.now();
        const original = decisions.find((decision) => decision.kind === 'confirm')?.decidedBy;
        return <article className="screening-card" key={match.id} data-testid={`match-${match.id}`}>
          <h3>{c.states[match.state]}</h3>
          <div className="screening-grid"><div><h4>{c.screenedName}</h4><p>{match.screenedName}</p></div><div><h4>{c.listEntry}</h4><p>{match.entryName}</p><code>{match.listCode} / {match.entryUid}</code></div></div>
          <p>{fmtDate(match.openedAt)}</p>
          <div className="screening-grid">
            {match.state === 'open' ? <>
              <ActionForm path={`/v1/admin/screening/matches/${match.id}/confirm`} label={c.confirm} copy={c} evidence={c.evidenceTypes} disabled={!mayAct} />
              <ActionForm path={`/v1/admin/screening/matches/${match.id}/propose-not-same-person`} label={c.propose} copy={c} evidence={c.evidenceTypes} disabled={!mayAct} />
            </> : null}
            {match.state === 'appeal' ? <>
              <ActionForm path={`/v1/admin/screening/matches/${match.id}/appeal-decision`} label={c.uphold} copy={c} evidence={c.evidenceTypes} fixed={{ decision: 'uphold' }} disabled={!mayAct || original === access.personId} />
              <ActionForm path={`/v1/admin/screening/matches/${match.id}/appeal-decision`} label={c.reverse} copy={c} evidence={c.evidenceTypes} fixed={{ decision: 'propose_reversal' }} disabled={!mayAct || original === access.personId} />
            </> : null}
          </div>
          {proposal ? <section aria-label={c.approvals}>
            <h4>{c.pending}</h4><p>{c.proposalNote}</p>
            <dl><dt>{c.requestedBy}</dt><dd><code>{proposal.requestedBy}</code></dd><dt>{c.digest}</dt><dd><code>{proposal.actionDigest}</code></dd><dt>{c.expiry}</dt><dd>{fmtDate(proposal.requestExpiresAt)}</dd></dl>
            {own ? <p>{c.secondRequired}</p> : null}
            <div className="screening-grid">{(['approve', 'reject'] as const).map((decision) => <ActionForm key={decision} path={`/v1/admin/screening/matches/${match.id}/proposal-decision`} label={c[decision]} copy={c} fixed={{ decision, actionDigest: proposal.actionDigest }} disabled={!mayAct || own || expired} />)}</div>
          </section> : null}
          <section aria-label={c.history}><h4>{c.history}</h4><ul>{decisions.map((decision) => <li key={decision.id}>
            <p>{decisionLabel(decision.kind)} · {fmtDate(decision.decidedAt)}</p><p>{decision.reason}</p>
            <p>{decision.evidence ? c.evidenceTypes[decision.evidence as keyof Copy['evidenceTypes']] ?? c.unknown : c.unknown}</p><code>{decision.decidedBy}</code>
          </li>)}</ul></section>
        </article>;
      })}
    </section>
  );
}
