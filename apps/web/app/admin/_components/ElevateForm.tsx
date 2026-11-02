'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@trustwork/ui';
import { PasswordField, TextField } from '@/components/ui';
import { withBase } from '@/app/_lib/base-path';
import { TOTP_CODE } from '@/components/auth/second-factor-codes';

export type ElevateLabels = {
  password: string;
  code: string;
  codeHelp: string;
  submit: string;
  /** The password was not accepted (step-up refused). */
  wrongPassword: string;
  /** The authenticator or recovery code was not accepted. */
  wrongCode: string;
  /** Any other failure, including the network. */
  generic: string;
};

type Outcome = { tone: 'idle' | 'error'; message: string };

async function post(path: string, body: unknown): Promise<boolean> {
  const response = await fetch(withBase(path), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Trustwork-Request': '1' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  return response.ok;
}

/**
 * Opens an elevated staff session from the console (BE-004, live mode): the password again (`POST /v1/auth/step-up`),
 * then the code from the authenticator app or a recovery code (`POST /v1/admin/session/elevate`). On success the page
 * renders again with the elevated session. Secrets never stay in the form after an attempt; strings arrive as props.
 */
export function ElevateForm({ labels }: { labels: ElevateLabels }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ tone: 'idle', message: '' });

  const run = async (form: FormData): Promise<Outcome> => {
    if (!(await post('/v1/auth/step-up', { password: String(form.get('f.password') ?? '') }))) return { tone: 'error', message: labels.wrongPassword };
    const code = String(form.get('f.code') ?? '').trim();
    const proof = TOTP_CODE.test(code.replace(/\s+/g, '')) ? { method: 'totp', code: code.replace(/\s+/g, '') } : { method: 'recovery_code', code };
    if (!(await post('/v1/admin/session/elevate', { proof }))) return { tone: 'error', message: labels.wrongCode };
    router.refresh();
    return { tone: 'idle', message: '' };
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    setPending(true);
    try {
      setOutcome(await run(new FormData(element)));
    } catch {
      setOutcome({ tone: 'error', message: labels.generic });
    } finally {
      setPending(false);
      for (const name of ['f.password', 'f.code']) {
        const field = element.elements.namedItem(name);
        if (field instanceof HTMLInputElement) field.value = '';
      }
    }
  };

  return (
    <form onSubmit={onSubmit} className="admin-form" aria-busy={pending || undefined} data-testid="admin-elevate-form">
      <fieldset className="admin-form__fields" disabled={pending}>
        <PasswordField name="f.password" label={labels.password} autoComplete="current-password" isRequired />
        <TextField name="f.code" label={labels.code} description={labels.codeHelp} autoComplete="one-time-code" isRequired />
      </fieldset>
      <div className="admin-form__actions">
        <Button type="submit" variant="primary" isLoading={pending}>
          {labels.submit}
        </Button>
      </div>
      <p className={`admin-form__result admin-form__result--${outcome.tone === 'error' ? 'error' : 'idle'}`} role={outcome.tone === 'error' ? 'alert' : 'status'}>
        {outcome.message}
      </p>
    </form>
  );
}
