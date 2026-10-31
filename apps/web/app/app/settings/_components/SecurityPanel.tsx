'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Laptop } from 'lucide-react';
import { passwordSchema } from '@trustwork/contracts/client';
import { z } from 'zod';
import { Button, Form, FormActions, FormAlert, PasswordField, StatusChip } from '@trustwork/ui';
import { mapFieldErrors, useAuthForm } from '@/components/auth/useAuthForm';
import { useStepUp } from '@/components/auth/StepUp';
import { longDate, t } from '@/app/_lib/i18n';

export type LiveSession = { id: string; device: string; location: string; lastSeen: string; isCurrent: boolean };

const ChangePasswordSchema = z.strictObject({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema() });
const FIELD_MAP = {
  currentPassword: { required: 'auth.error.passwordRequired', invalid: 'auth.error.passwordRequired' },
  newPassword: { required: 'auth.error.passwordRequired', too_short: 'settings.security.passwordTooShort', too_long: 'settings.security.passwordTooLong', invalid: 'settings.security.passwordTooShort' },
} as const;

/**
 * Live sessions and password (WEB-004): the person's own sessions from `GET /v1/me/sessions` (device family and a
 * coarse network prefix only), ending one session, ending every other session (step-up) and changing the password
 * (step-up; the API ends the other sessions). The current session cannot be ended here: signing out does that.
 */
export function SecurityPanel({ sessions, minPassword }: { sessions: LiveSession[]; minPassword: number }) {
  const router = useRouter();
  const revoke = useAuthForm();
  const others = useAuthForm();
  const password = useAuthForm();
  const stepUp = useStepUp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const hasOthers = sessions.some((s) => !s.isCurrent);

  return (
    <>
      {revoke.alert ? <FormAlert tone={revoke.alert.tone}>{revoke.alert.text}</FormAlert> : null}
      <ul className="ws-list" aria-label={t('settings.security.sessionsCaption')}>
        {sessions.map((session) => (
          <li key={session.id} className="ws-row">
            <span className="ws-row__main ws-row__main--icon">
              <span className="ws-mark ws-mark--file" aria-hidden="true">
                <Laptop size={16} strokeWidth={2} />
              </span>
              <span>
                <span className="ws-row__title">{session.device || t('settings.security.unknownDevice')}</span>
                <span className="ws-row__meta">
                  {session.isCurrent ? (
                    <StatusChip size="sm" tone="info">
                      {t('settings.security.currentSession')}
                    </StatusChip>
                  ) : null}
                  {session.location ? <span>{session.location}</span> : null}
                  <span>{t('settings.security.lastSeenAt', { date: longDate(session.lastSeen) })}</span>
                </span>
              </span>
            </span>
            {!session.isCurrent ? (
              <span className="ws-row__side">
                <Button
                  variant="ghost"
                  size="sm"
                  isLoading={revoke.busy}
                  pendingLabel={t('settings.security.endPending')}
                  aria-label={`${t('settings.security.endSession')}: ${session.device || t('settings.security.unknownDevice')}`}
                  onPress={async () => {
                    const response = await revoke.submit({ path: '/v1/me/sessions/revoke', payload: { sessionId: session.id }, idempotent: true });
                    if (response.kind === 'ok') {
                      revoke.setAlert({ tone: 'success', text: t('settings.security.ended') });
                      router.refresh();
                    }
                  }}
                >
                  {t('settings.security.endSession')}
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {others.alert ? <FormAlert tone={others.alert.tone}>{others.alert.text}</FormAlert> : null}
      <div className="ws-actions">
        <Button
          variant="secondary"
          isDisabled={!hasOthers}
          isLoading={others.busy}
          pendingLabel={t('settings.security.endPending')}
          onPress={async () => {
            const response = await stepUp.guard(() => others.submit({ path: '/v1/me/sessions/revoke-others', payload: null, idempotent: true }), () => others.setAlert(null));
            if (response.kind === 'ok') {
              const count = typeof response.body.revoked === 'number' ? response.body.revoked : 0;
              others.setAlert({ tone: 'success', text: t('settings.security.othersEnded', { count }) });
              router.refresh();
            }
          }}
        >
          {t('settings.security.endOthers')}
        </Button>
      </div>

      <h3 className="ws-head__kicker" id="password-title">
        {t('settings.security.changePassword')}
      </h3>
      {password.alert ? (
        <FormAlert tone={password.alert.tone} autoFocus>
          {password.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(password.hydrated ? { 'data-hydrated': '' } : {})}
        aria-labelledby="password-title"
        isBusy={password.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const payload = { currentPassword: current, newPassword: next };
          const response = await stepUp.guard(
            () => password.submit({ path: '/v1/me/password', payload, schema: ChangePasswordSchema, idempotent: true, onError: (error) => mapFieldErrors(password.fieldIssues(error), FIELD_MAP, { min: minPassword }) }),
            () => password.setAlert(null),
          );
          if (response.kind === 'ok') {
            setCurrent('');
            setNext('');
            password.setAlert({ tone: 'success', text: t('settings.security.passwordChanged') });
            router.refresh();
          }
        }}
      >
        <div className="au-form__fields" style={{ maxWidth: '28rem' }}>
          <PasswordField id="password-currentPassword" label={t('settings.security.currentPassword')} value={current} onChange={setCurrent} autoComplete="current-password" errorMessage={password.fields.currentPassword} isDisabled={password.busy} />
          <PasswordField id="password-newPassword" label={t('settings.security.newPassword')} description={t('settings.security.passwordHint', { min: minPassword })} value={next} onChange={setNext} autoComplete="new-password" errorMessage={password.fields.newPassword} isDisabled={password.busy} />
          <FormActions>
            <Button type="submit" variant="secondary" isLoading={password.busy} pendingLabel={t('settings.security.saving')}>
              {t('settings.security.changePassword')}
            </Button>
          </FormActions>
        </div>
      </Form>
      {stepUp.dialog}
    </>
  );
}
