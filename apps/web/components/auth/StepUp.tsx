'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Button, Form, FormAlert, PasswordField, Dialog } from '@trustwork/ui';
import { useAuthForm, type SubmitResult } from './useAuthForm';
import { t } from '@/app/_lib/i18n';

/**
 * Step-up (WEB-004): sensitive actions (ending other sessions, changing the password, inviting or changing members,
 * transfers) answer `auth.step_up_required` when the sign-in is older than the step-up window. `guard` runs the action;
 * on that answer it asks for the password in a modal dialog (`POST /v1/auth/step-up`) and then runs the action once
 * more. The password never leaves this dialog and is cleared after each attempt.
 */
export function useStepUp(): { guard: (run: () => Promise<SubmitResult>, onAsk?: () => void) => Promise<SubmitResult>; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const pending = useRef<{ run: () => Promise<SubmitResult>; done: (result: SubmitResult) => void } | null>(null);
  const form = useAuthForm();

  async function guard(run: () => Promise<SubmitResult>, onAsk?: () => void): Promise<SubmitResult> {
    const result = await run();
    if (result.kind !== 'error' || result.error.code !== 'auth.step_up_required') return result;
    onAsk?.();
    return new Promise<SubmitResult>((done) => {
      pending.current = { run, done };
      form.setAlert(null);
      setPassword('');
      setOpen(true);
    });
  }

  function cancel() {
    setOpen(false);
    setPassword('');
    pending.current?.done({ kind: 'invalid' });
    pending.current = null;
  }

  const dialog = (
    <Dialog
      title={t('settings.stepUp.title')}
      description={t('settings.stepUp.body')}
      isOpen={open}
      onOpenChange={(next) => (next ? setOpen(true) : cancel())}
      isLoading={form.busy}
      actions={
        <>
          <Button variant="ghost" onPress={cancel}>
            {t('settings.stepUp.cancel')}
          </Button>
          <Button type="submit" form="step-up-form" isLoading={form.busy} pendingLabel={t('settings.stepUp.pending')}>
            {t('settings.stepUp.confirm')}
          </Button>
        </>
      }
    >
      {form.alert ? <FormAlert tone={form.alert.tone}>{form.alert.text}</FormAlert> : null}
      <Form
        id="step-up-form"
        validationBehavior="aria"
        onSubmit={async (event) => {
          event.preventDefault();
          const response = await form.submit({ path: '/v1/auth/step-up', payload: { password } });
          setPassword('');
          if (response.kind !== 'ok' || !pending.current) return;
          const { run, done } = pending.current;
          pending.current = null;
          setOpen(false);
          done(await run());
        }}
      >
        <PasswordField id="step-up-password" label={t('auth.password')} value={password} onChange={setPassword} autoComplete="current-password" isRequired isDisabled={form.busy} autoFocus />
      </Form>
    </Dialog>
  );

  return { guard, dialog };
}
