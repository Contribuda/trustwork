'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ReasonField } from '@trustwork/ui';
import { TextField } from '@/components/ui';
import { withBase } from '@/app/_lib/base-path';

export type SecretEntryLabels = {
  value: string;
  valueHelp: string;
  grace: string;
  graceHelp: string;
  reason: string;
  reasonHelp: string;
  submit: string;
  saved: string;
  generic: string;
  /** Provider reason codes in the viewer's language. */
  reasons: Readonly<Record<string, string>>;
};

const CONTRACT_VERSION = '1.0.0';

/**
 * The only place a provider secret is typed (KEYS-001, write-only). The value goes from this form straight to
 * `POST .../connections/:id/secret`, the same-origin API route, so it never passes a server action or the console's form
 * fields, and React never holds it: the input is uncontrolled, read once from the form and cleared whatever the answer. The route
 * answers with a reference and a fingerprint, which the page reads again after a refresh. There is no way back to the value.
 */
export function SecretEntry({ path, connectionId, revision, graceDefault, labels, disabled }: {
  path: `/v1/${string}`; connectionId: string; revision: number; graceDefault: number; labels: SecretEntryLabels; disabled: string | null;
}) {
  const router = useRouter();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ tone: 'idle' | 'info' | 'error'; message: string }>({ tone: 'idle', message: '' });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const data = new FormData(element);
    const field = element.elements.namedItem('secret');
    if (field instanceof HTMLInputElement) field.value = '';
    setPending(true);
    try {
      const key = crypto.randomUUID();
      const response = await fetch(withBase(path), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'X-Trustwork-Request': '1' },
        body: JSON.stringify({
          contractVersion: CONTRACT_VERSION, idempotencyKey: key, reason: String(data.get('reason') ?? '').trim(), connectionId, value: String(data.get('secret') ?? ''), expectedRevision: revision,
          graceHours: Number.parseInt(String(data.get('grace') ?? ''), 10),
        }),
        cache: 'no-store',
      });
      if (response.ok) {
        setResult({ tone: 'info', message: labels.saved });
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { details?: { reason?: unknown } } | null;
      const reason = typeof body?.details?.reason === 'string' ? labels.reasons[body.details.reason] : undefined;
      setResult({ tone: 'error', message: reason ?? labels.generic });
    } catch {
      setResult({ tone: 'error', message: labels.generic });
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="admin-form" aria-busy={pending || undefined} autoComplete="off" data-testid={`secret-entry-${connectionId}`}>
      <fieldset className="admin-form__fields" disabled={pending || Boolean(disabled)}>
        {/* A native, uncontrolled input: a design-system field keeps what is typed in React state, and this value stays out of it. */}
        <div className="admin-field">
          <label htmlFor={id} className="admin-field__label">{labels.value}</label>
          <input id={id} name="secret" type="password" className="admin-select" autoComplete="new-password" spellCheck={false} required minLength={8} maxLength={16384} aria-describedby={`${id}-help`} />
          <p id={`${id}-help`} className="admin-field__help">{labels.valueHelp}</p>
        </div>
        <TextField name="grace" label={labels.grace} description={labels.graceHelp} defaultValue={String(graceDefault)} isRequired />
        <ReasonField showCounter={false} name="reason" label={labels.reason} description={labels.reasonHelp} isRequired rows={2} maxLength={500} isDisabled={pending || Boolean(disabled)} />
      </fieldset>
      {disabled ? <p className="admin-note admin-note--disabled">{disabled}</p> : null}
      <div className="admin-form__actions">
        <Button type="submit" variant="primary" isLoading={pending} isDisabled={Boolean(disabled)}>
          {labels.submit}
        </Button>
      </div>
      <p className={`admin-form__result admin-form__result--${result.tone}`} role={result.tone === 'error' ? 'alert' : 'status'}>
        {result.message}
      </p>
    </form>
  );
}
