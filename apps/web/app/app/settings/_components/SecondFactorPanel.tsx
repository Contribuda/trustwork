'use client';

import { useCallback, useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { Button, Checkbox, Form, FormActions, FormAlert, StatusChip, TextField } from '@trustwork/ui';
import { useAuthForm } from '@/components/auth/useAuthForm';
import { useStepUp } from '@/components/auth/StepUp';
import { RECOVERY_CODE, TOTP_CODE } from '@/components/auth/second-factor-codes';
import { longDate, t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';

type Factor = { id: string; kind: 'totp'; createdAt: string; activatedAt: string; lastUsedAt: string | null };
type Status = {
  enrolled: boolean;
  factors: Factor[];
  recoveryCodes: { remaining: number; total: number; generatedAt: string } | null;
  pendingReset: { id: string; state: 'pending' | 'cooling_off'; requestedAt: string; effectiveAt: string | null } | null;
};
type Enrolment = { factorId: string; secret: string; otpauthUri: string; expiresAt: string };
type Action = 'regenerate' | 'remove' | null;

async function loadStatus(): Promise<Status | null> {
  try {
    const response = await fetch(withBase('/v1/me/second-factor'), { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
    return response.ok ? ((await response.json()) as Status) : null;
  } catch {
    return null;
  }
}

/** Groups of four for reading the key aloud or typing it into an app. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

/**
 * Two-step verification in the security settings (BE-004, live API only): status from `GET /v1/me/second-factor`;
 * set-up with an authenticator app (step-up, the key shown once with an `otpauth:` link, confirmation with a code);
 * the ten recovery codes shown once with an "I have stored them" confirmation; new recovery codes and removal, each
 * confirmed with a current code; and a support reset in its waiting period, which the person can cancel. Every change
 * is also announced by e-mail to every confirmed address. Buttons that the next view replaces are disabled while busy
 * instead of showing a pending state, so no live announcement refers to a control that no longer exists.
 */
export function SecondFactorPanel() {
  const stepUp = useStepUp();
  const start = useAuthForm();
  const confirm = useAuthForm();
  const proof = useAuthForm();
  const cancelReset = useAuthForm();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [stored, setStored] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<Action>(null);
  const [recovery, setRecovery] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await loadStatus();
    setFailed(next === null);
    setStatus(next);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  function checkCode(value: string, allowRecovery: boolean): boolean {
    const ok = (allowRecovery ? RECOVERY_CODE : TOTP_CODE).test(value);
    setCodeError(ok ? undefined : allowRecovery ? t('settings.secondFactor.recoveryFormat') : t('settings.secondFactor.codeFormat'));
    return ok;
  }

  if (failed) return <FormAlert tone="error">{t('settings.secondFactor.loadFailed')}</FormAlert>;
  if (!status) return <p className="ws-muted" role="status">{t('settings.secondFactor.loading')}</p>;

  const codeField = (label: string, allowRecovery: boolean) => (
    <TextField
      id="second-factor-code"
      label={label}
      value={code}
      onChange={setCode}
      autoComplete="one-time-code"
      inputMode={allowRecovery ? 'text' : 'numeric'}
      errorMessage={codeError}
      isRequired
      autoFocus
    />
  );

  if (codes) {
    return (
      <div className="ws-section">
        <FormAlert tone="warning" autoFocus>
          {t('settings.secondFactor.codesOnce')}
        </FormAlert>
        <ol className="ws-list" aria-label={t('settings.secondFactor.codesCaption')} style={{ fontFamily: 'var(--font-mono, monospace)' }}>
          {codes.map((c) => (
            <li key={c} className="ws-row">
              <span className="ws-row__title">{c}</span>
            </li>
          ))}
        </ol>
        <Checkbox isSelected={stored} onChange={setStored}>
          {t('settings.secondFactor.codesStored')}
        </Checkbox>
        <div className="ws-actions">
          <Button
            isDisabled={!stored}
            onPress={() => {
              setCodes(null);
              setStored(false);
              void refresh();
            }}
          >
            {t('settings.secondFactor.done')}
          </Button>
        </div>
      </div>
    );
  }

  if (enrolment) {
    return (
      <div className="ws-section">
        <h3 className="ws-head__kicker" id="enrol-title">
          {t('settings.secondFactor.setupTitle')}
        </h3>
        <ol className="ws-steps">
          <li>
            <span className="ws-steps__n" aria-hidden="true">1</span>
            <span>{t('settings.secondFactor.step1')}</span>
          </li>
          <li>
            <span className="ws-steps__n" aria-hidden="true">2</span>
            <span>
              {t('settings.secondFactor.step2')}{' '}
              <a href={enrolment.otpauthUri} className="ws-more">
                {t('settings.secondFactor.openApp')}
              </a>
            </span>
          </li>
          <li>
            <span className="ws-steps__n" aria-hidden="true">3</span>
            <span>{t('settings.secondFactor.step3')}</span>
          </li>
        </ol>
        <dl className="ws-facts">
          <div>
            <dt>{t('settings.secondFactor.keyLabel')}</dt>
            <dd>
              <code data-testid="totp-key">{grouped(enrolment.secret)}</code>
            </dd>
          </div>
        </dl>
        {confirm.alert ? (
          <FormAlert tone={confirm.alert.tone} autoFocus>
            {confirm.alert.text}
          </FormAlert>
        ) : null}
        <Form
          validationBehavior="aria"
          aria-labelledby="enrol-title"
          isBusy={confirm.busy}
          onSubmit={async (event) => {
            event.preventDefault();
            const value = code.trim();
            if (!checkCode(value, false)) return;
            const response = await stepUp.guard(() => confirm.submit({ path: '/v1/me/second-factor/totp/confirm', payload: { factorId: enrolment.factorId, code: value } }), () => confirm.setAlert(null));
            setCode('');
            if (response.kind === 'ok') {
              setEnrolment(null);
              const issued = Array.isArray(response.body.recoveryCodes) ? (response.body.recoveryCodes as string[]) : null;
              setNotice(t('settings.secondFactor.enabled'));
              if (issued) setCodes(issued);
              else void refresh();
            } else if (response.kind === 'error' && response.error.code === 'auth.invalid_credentials') confirm.setAlert({ tone: 'error', text: t('settings.secondFactor.invalidCode'), code: response.error.code });
            else if (response.kind === 'error' && response.error.code === 'access.not_found') {
              setEnrolment(null);
              setNotice(t('settings.secondFactor.setupExpired'));
            }
          }}
        >
          <div className="au-form__fields" style={{ maxWidth: '28rem' }}>
            {codeField(t('settings.secondFactor.codeLabel'), false)}
            <FormActions>
              <Button type="submit" isDisabled={confirm.busy}>
                {t('settings.secondFactor.confirmSetup')}
              </Button>
              <Button variant="ghost" onPress={() => setEnrolment(null)}>
                {t('settings.stepUp.cancel')}
              </Button>
            </FormActions>
          </div>
        </Form>
        {stepUp.dialog}
      </div>
    );
  }

  const factor = status.factors[0];
  return (
    <div className="ws-section">
      {notice ? (
        <FormAlert tone="success" autoFocus>
          {notice}
        </FormAlert>
      ) : null}
      {status.pendingReset ? (
        <FormAlert tone="warning">
          {status.pendingReset.effectiveAt ? t('settings.secondFactor.resetCooling', { date: longDate(status.pendingReset.effectiveAt) }) : t('settings.secondFactor.resetPending')}{' '}
          <Button
            variant="secondary"
            size="sm"
            isDisabled={cancelReset.busy}
            onPress={async () => {
              const id = status.pendingReset?.id;
              if (!id) return;
              const response = await stepUp.guard(() => cancelReset.submit({ path: `/v1/me/second-factor/resets/${id}/cancel`, payload: null }));
              if (response.kind === 'ok') {
                setNotice(t('settings.secondFactor.resetCancelled'));
                void refresh();
              }
            }}
          >
            {t('settings.secondFactor.cancelReset')}
          </Button>
        </FormAlert>
      ) : null}
      <ul className="ws-list">
        <li className="ws-row">
          <span className="ws-row__main ws-row__main--icon">
            <span className="ws-mark ws-mark--file" aria-hidden="true">
              <Smartphone size={16} strokeWidth={2} />
            </span>
            <span>
              <span className="ws-row__title">{t('settings.secondFactor.app')}</span>
              <span className="ws-row__meta">
                <StatusChip size="sm" tone={status.enrolled ? 'success' : 'neutral'}>
                  {status.enrolled ? t('common.on') : t('settings.secondFactor.off')}
                </StatusChip>
                {factor ? <span>{t('settings.secondFactor.addedAt', { date: longDate(factor.activatedAt) })}</span> : null}
                {status.recoveryCodes ? <span>{t('settings.secondFactor.codesLeft', { count: status.recoveryCodes.remaining, total: status.recoveryCodes.total })}</span> : null}
              </span>
            </span>
          </span>
        </li>
      </ul>
      {!status.enrolled ? <p className="ws-muted">{t('settings.secondFactor.offHint')}</p> : null}
      {start.alert ? <FormAlert tone={start.alert.tone}>{start.alert.text}</FormAlert> : null}
      {proof.alert ? (
        <FormAlert tone={proof.alert.tone} autoFocus>
          {proof.alert.text}
        </FormAlert>
      ) : null}
      {action && factor ? (
        <Form
          validationBehavior="aria"
          aria-label={action === 'remove' ? t('settings.secondFactor.remove') : t('settings.secondFactor.regenerate')}
          isBusy={proof.busy}
          onSubmit={async (event) => {
            event.preventDefault();
            const value = code.trim();
            if (!checkCode(value, recovery)) return;
            const payload = { proof: { method: recovery ? 'recovery_code' : 'totp', code: value } };
            const response = await stepUp.guard(
              () => proof.submit(action === 'remove' ? { path: '/v1/me/second-factor/remove', payload: { factorId: factor.id, ...payload } } : { path: '/v1/me/second-factor/recovery-codes', payload }),
              () => proof.setAlert(null),
            );
            setCode('');
            if (response.kind === 'ok') {
              setAction(null);
              if (action === 'regenerate' && Array.isArray(response.body.recoveryCodes)) setCodes(response.body.recoveryCodes as string[]);
              else {
                setNotice(t('settings.secondFactor.removed'));
                void refresh();
              }
            } else if (response.kind === 'error' && response.error.code === 'auth.invalid_credentials') proof.setAlert({ tone: 'error', text: t('settings.secondFactor.invalidCode'), code: response.error.code });
          }}
        >
          <div className="au-form__fields" style={{ maxWidth: '28rem' }}>
            {codeField(recovery ? t('settings.secondFactor.recoveryLabel') : t('settings.secondFactor.codeLabel'), recovery)}
            <Button variant="ghost" size="sm" onPress={() => { setRecovery(!recovery); setCode(''); setCodeError(undefined); }}>
              {recovery ? t('settings.secondFactor.useApp') : t('settings.secondFactor.useRecovery')}
            </Button>
            <FormActions>
              <Button type="submit" variant={action === 'remove' ? 'danger' : 'primary'} isDisabled={proof.busy}>
                {action === 'remove' ? t('settings.secondFactor.remove') : t('settings.secondFactor.regenerate')}
              </Button>
              <Button variant="ghost" onPress={() => { setAction(null); setCode(''); proof.setAlert(null); }}>
                {t('settings.stepUp.cancel')}
              </Button>
            </FormActions>
          </div>
        </Form>
      ) : (
        <div className="ws-actions">
          {status.enrolled ? (
            <>
              <Button variant="secondary" onPress={() => { setNotice(null); setRecovery(false); setAction('regenerate'); }}>
                {t('settings.secondFactor.regenerate')}
              </Button>
              <Button variant="ghost" onPress={() => { setNotice(null); setRecovery(false); setAction('remove'); }}>
                {t('settings.secondFactor.remove')}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              isDisabled={start.busy}
              onPress={async () => {
                setNotice(null);
                const response = await stepUp.guard(() => start.submit({ path: '/v1/me/second-factor/totp', payload: null }), () => start.setAlert(null));
                if (response.kind === 'ok') {
                  setCode('');
                  setCodeError(undefined);
                  setEnrolment(response.body as unknown as Enrolment);
                }
              }}
            >
              {t('settings.secondFactor.setUp')}
            </Button>
          )}
        </div>
      )}
      {stepUp.dialog}
    </div>
  );
}
