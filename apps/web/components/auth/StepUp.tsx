'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Button, Form, FormAlert, PasswordField, Dialog, TextField } from '@trustwork/ui';
import { useAuthForm, type SubmitResult } from './useAuthForm';
import { RECOVERY_CODE, TOTP_CODE } from './second-factor-codes';
import { t } from '@/app/_lib/i18n';

type Mode = 'password' | 'elevate';

/** True for the 403 a staff route answers when the session is not elevated (BE-004). */
export function needsElevation(result: SubmitResult): boolean {
  return result.kind === 'error' && result.error.code === 'access.forbidden' && result.error.details?.required === 'elevation';
}

/**
 * Step-up (WEB-004) and elevation (BE-004). Sensitive actions answer `auth.step_up_required` when the sign-in is older
 * than the step-up window; staff routes answer 403 with `details.required = 'elevation'` without an elevated session.
 * `guard` runs the action; on either answer it asks in a modal dialog for the password (`POST /v1/auth/step-up`)
 * and, for elevation, for the code from the authenticator app or a recovery code (`POST /v1/admin/session/elevate`,
 * which itself needs a fresh step-up), and then runs the action once more. Secrets never leave this dialog and are
 * cleared after each attempt.
 */
export function useStepUp(): { guard: (run: () => Promise<SubmitResult>, onAsk?: () => void) => Promise<SubmitResult>; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const pending = useRef<{ run: () => Promise<SubmitResult>; done: (result: SubmitResult) => void; elevate: boolean } | null>(null);
  const form = useAuthForm();

  async function guard(run: () => Promise<SubmitResult>, onAsk?: () => void): Promise<SubmitResult> {
    const result = await run();
    const stepUp = result.kind === 'error' && result.error.code === 'auth.step_up_required';
    const elevate = needsElevation(result);
    if (!stepUp && !elevate) return result;
    onAsk?.();
    return new Promise<SubmitResult>((done) => {
      pending.current = { run, done, elevate };
      form.setAlert(null);
      setPassword('');
      setCode('');
      setCodeError(undefined);
      setRecovery(false);
      setMode(elevate ? 'elevate' : 'password');
      setOpen(true);
    });
  }

  function cancel() {
    setOpen(false);
    setPassword('');
    setCode('');
    pending.current?.done({ kind: 'invalid' });
    pending.current = null;
  }

  async function finish() {
    if (!pending.current) return;
    const { run, done } = pending.current;
    pending.current = null;
    setOpen(false);
    done(await run());
  }

  const formId = mode === 'password' ? 'step-up-form' : 'elevate-form';
  const dialog = (
    <Dialog
      title={mode === 'password' ? t('settings.stepUp.title') : t('settings.elevation.title')}
      description={mode === 'password' ? t('settings.stepUp.body') : recovery ? t('settings.elevation.recoveryBody') : t('settings.elevation.body')}
      isOpen={open}
      onOpenChange={(next) => (next ? setOpen(true) : cancel())}
      isLoading={form.busy}
      actions={
        <>
          <Button variant="ghost" onPress={cancel}>
            {t('settings.stepUp.cancel')}
          </Button>
          <Button type="submit" form={formId} isLoading={form.busy} pendingLabel={t('settings.stepUp.pending')}>
            {t('settings.stepUp.confirm')}
          </Button>
        </>
      }
    >
      {form.alert ? <FormAlert tone={form.alert.tone}>{form.alert.text}</FormAlert> : null}
      {mode === 'password' ? (
        <Form
          id="step-up-form"
          validationBehavior="aria"
          onSubmit={async (event) => {
            event.preventDefault();
            const response = await form.submit({ path: '/v1/auth/step-up', payload: { password } });
            setPassword('');
            if (response.kind !== 'ok' || !pending.current) return;
            if (pending.current.elevate) {
              form.setAlert(null);
              setMode('elevate');
              return;
            }
            await finish();
          }}
        >
          <PasswordField id="step-up-password" label={t('auth.password')} value={password} onChange={setPassword} autoComplete="current-password" isRequired isDisabled={form.busy} autoFocus />
        </Form>
      ) : (
        <Form
          id="elevate-form"
          validationBehavior="aria"
          onSubmit={async (event) => {
            event.preventDefault();
            const value = code.trim();
            if (!(recovery ? RECOVERY_CODE : TOTP_CODE).test(value)) {
              setCodeError(recovery ? t('settings.secondFactor.recoveryFormat') : t('settings.secondFactor.codeFormat'));
              return;
            }
            setCodeError(undefined);
            const response = await form.submit({ path: '/v1/admin/session/elevate', payload: { proof: { method: recovery ? 'recovery_code' : 'totp', code: value } } });
            setCode('');
            if (response.kind === 'error' && response.error.code === 'auth.step_up_required') {
              form.setAlert(null);
              setMode('password');
              return;
            }
            if (response.kind === 'error' && response.error.code === 'auth.invalid_credentials') form.setAlert({ tone: 'error', text: t('settings.secondFactor.invalidCode'), code: response.error.code });
            if (response.kind === 'error' && response.error.details?.required === 'second_factor') form.setAlert({ tone: 'warning', text: t('settings.elevation.enrolFirst'), code: response.error.code });
            if (response.kind === 'ok') await finish();
          }}
        >
          <TextField
            id="elevate-code"
            label={recovery ? t('settings.secondFactor.recoveryLabel') : t('settings.secondFactor.codeLabel')}
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            errorMessage={codeError}
            isRequired
            isDisabled={form.busy}
            autoFocus
          />
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              setRecovery(!recovery);
              setCode('');
              setCodeError(undefined);
            }}
          >
            {recovery ? t('settings.secondFactor.useApp') : t('settings.secondFactor.useRecovery')}
          </Button>
        </Form>
      )}
    </Dialog>
  );

  return { guard, dialog };
}
