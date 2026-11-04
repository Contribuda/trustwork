import NextLink from '@/components/locale/LocalLink';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui';
import { longDate, t, tDynamic } from '@/app/_lib/i18n';
import type { MyStaffInvitation } from '../../../../../../packages/contracts/src/staff-lifecycle.js';
import { respondToStaffInvitation } from './actions';

const RESULTS = ['accepted', 'declined', 'second_factor', 'gone', 'failed'] as const;
type Result = (typeof RESULTS)[number];
/** The result word of the last answer, from the redirect; anything else shows nothing. */
export const invitationResult = (value: unknown): Result | null => ((RESULTS as readonly unknown[]).includes(value) ? (value as Result) : null);

function validity(seconds: number | null): string {
  if (seconds === null) return t('admin.staff.invitation.noEnd');
  const days = Math.round(seconds / 86_400);
  return days >= 1 ? t('admin.overview.days', { count: days }) : t('admin.staff.invitation.forHours', { count: Math.max(1, Math.round(seconds / 3600)) });
}

function Invitation({ invitation, demo }: { invitation: MyStaffInvitation; demo: boolean }) {
  // A name and a reason are data in their author's language, which the API does not record.
  const lang = demo ? 'en' : 'und';
  return (
    <div className="ws-section" data-testid={`my-invitation-${invitation.id}`}>
      <h3 className="ws-head__kicker">{tDynamic(`admin.roles.${invitation.role}`, invitation.role)}</h3>
      <dl className="ws-facts">
        <div>
          <dt>{t('admin.staff.invitation.scope')}</dt>
          <dd>{invitation.scope.kind === 'hub' ? t('settings.staffInvitations.scopeHub') : t(`admin.staff.scope.${invitation.scope.kind}`)}</dd>
        </div>
        <div>
          <dt>{t('admin.staff.invitation.invitedBy')}</dt>
          <dd lang={lang}>{invitation.inviterName}</dd>
        </div>
        <div>
          <dt>{t('admin.approvals.reason')}</dt>
          <dd lang={lang}>{invitation.reason}</dd>
        </div>
        <div>
          <dt>{t('admin.staff.invitation.length')}</dt>
          <dd>{validity(invitation.validForSeconds)}</dd>
        </div>
        <div>
          <dt>{t('settings.staffInvitations.answerBy')}</dt>
          <dd>{longDate(invitation.expiresAt)}</dd>
        </div>
      </dl>
      <div className="ws-actions">
        <form action={respondToStaffInvitation}>
          <input type="hidden" name="invitationId" value={invitation.id} />
          <input type="hidden" name="accept" value="yes" />
          <Button type="submit" isDisabled={demo}>
            {t('settings.staffInvitations.accept')}
          </Button>
        </form>
        <form action={respondToStaffInvitation}>
          <input type="hidden" name="invitationId" value={invitation.id} />
          <input type="hidden" name="accept" value="no" />
          <Button type="submit" variant="secondary" isDisabled={demo}>
            {t('settings.staffInvitations.decline')}
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * Staff invitations (ADM-004 part 2) in the workspace settings: the invited person sees what is offered and by whom, and
 * accepts or declines; it says when a second factor is needed first. Any signed-in person gets only invitations to their
 * own verified addresses, and nothing is shown without one.
 *
 * It is a section of the settings page, not a route of its own, for two reasons: a route adds a page chunk of about 250
 * gzip bytes to a client bundle that is at its budget, and the second factor is set up right here. That set-up happens
 * in place, so "Accept" stays enabled: a page rendered before it would otherwise keep refusing, and the API has the last
 * word anyway, its refusal coming back as the result line.
 */
export function StaffInvitations({ invitations, secondFactor, result, demo }: { invitations: readonly MyStaffInvitation[]; secondFactor: boolean; result: Result | null; demo: boolean }) {
  if (!invitations.length && !result) return null;
  const good = result === 'accepted' || result === 'declined';
  return (
    <section id="staff-invitations" aria-labelledby="s-staff-invitations" className="ws-card">
      <h2 id="s-staff-invitations" className="ws-h2">
        <ShieldCheck size={18} strokeWidth={2} aria-hidden="true" />
        {t('settings.staffInvitations.title')}
      </h2>
      <p className="ws-note">{t('settings.staffInvitations.lede')}</p>
      {result ? (
        <p className={good ? 'ws-note ws-note--accent' : 'ws-note ws-note--warn'} role={good ? 'status' : 'alert'} data-testid="invitation-result">
          {t(`settings.staffInvitations.result.${result}`)}
        </p>
      ) : null}
      {demo ? <p className="ws-note">{t('settings.staffInvitations.demoNote')}</p> : null}
      {invitations.length ? (
        <>
          <p className={secondFactor ? 'ws-note' : 'ws-note ws-note--warn'} data-testid="invitation-second-factor">
            {secondFactor ? t('settings.staffInvitations.secondFactorReady') : t('settings.staffInvitations.secondFactorNeeded')}
            {secondFactor ? null : (
              <>
                {' '}
                <NextLink href="#security">{t('settings.staffInvitations.secondFactorLink')}</NextLink>
              </>
            )}
          </p>
          {invitations.map((i) => (
            <Invitation key={i.id} invitation={i} demo={demo} />
          ))}
          <p className="ws-note">{t('settings.staffInvitations.after')}</p>
        </>
      ) : (
        <p className="ws-note" data-testid="invitations-none">{t('settings.staffInvitations.empty')}</p>
      )}
    </section>
  );
}
