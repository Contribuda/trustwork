'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@trustwork/ui';
import { withBase } from '@/app/_lib/base-path';
import { answerFor } from './answers';

export type LiveFormKind = 'step' | 'account' | 'first_admin' | 'finish';
export type LiveFormLabels = {
  submit: string;
  /** Fallback for any refusal without a specific explanation. */
  generic: string;
  /** Explanations per `details.reason` of the API's refusal (`restricted_place`, `step_out_of_order`, ...). */
  reasons: Readonly<Record<string, string>>;
  /** Shown after a success that stays on the page (the account step, finishing). */
  success?: string | undefined;
  /** Prefix of the refused items list ("Refused: ..."). */
  items?: string | undefined;
};

type Outcome = { tone: 'idle' | 'error' | 'success'; message: string };
type Envelope = { code?: string; details?: { reason?: unknown; required?: unknown; items?: unknown } };

async function post(path: string, body: unknown, token: string | null): Promise<{ ok: boolean; status: number; body: Envelope }> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'X-Trustwork-Request': '1' };
  if (token) headers['X-Trustwork-Setup-Token'] = token;
  const response = await fetch(withBase(path), { method: 'POST', headers, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(body) });
  const parsed = (await response.json().catch(() => ({}))) as Envelope;
  return { ok: response.ok, status: response.status, body: parsed };
}

/**
 * The live setup wizard's forms (HUB-004). Each submission goes from the browser to the same-origin `/v1/setup/*`
 * route with the one-time token in its header and the CSRF header; the API validates, refuses restricted places and
 * keeps the order of the steps. Finishing first proves the founding administrator again (password step-up, then the
 * authenticator code for an elevated session, BE-004) and then finishes. Strings arrive as props: the console's
 * locale namespaces stay on the server. The result is announced in a live region; a refusal is an alert.
 */
export function LiveSetupForm({ kind, step, token, labels, nextHref, doneHref, children }: {
  kind: LiveFormKind;
  step: string;
  token: string;
  labels: LiveFormLabels;
  nextHref?: string | undefined;
  doneHref?: string | undefined;
  children?: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ tone: 'idle', message: '' });

  const explain = (result: { status: number; body: Envelope }): string => {
    const reason = typeof result.body.details?.reason === 'string' ? result.body.details.reason : typeof result.body.details?.required === 'string' ? result.body.details.required : result.body.code ?? '';
    const base = labels.reasons[reason] ?? (result.body.code ? labels.reasons[result.body.code] : undefined) ?? labels.generic;
    const items = Array.isArray(result.body.details?.items) ? (result.body.details.items as unknown[]).filter((i): i is string => typeof i === 'string') : [];
    return items.length && labels.items ? `${base} ${labels.items} ${items.join(', ')}` : base;
  };

  const run = async (form: FormData): Promise<Outcome> => {
    if (kind === 'step') {
      const result = await post(`/v1/setup/steps/${step}`, answerFor(step, form), token);
      if (!result.ok) return { tone: 'error', message: explain(result) };
      if (nextHref) router.push(nextHref);
      router.refresh();
      return { tone: 'success', message: labels.success ?? '' };
    }
    if (kind === 'account') {
      const value = (n: string) => String(form.get(`f.${n}`) ?? '').trim();
      const result = await post('/v1/setup/first-admin/account', { name: value('name'), email: value('email'), password: String(form.get('f.password') ?? '') }, token);
      if (!result.ok) return { tone: 'error', message: explain(result) };
      router.refresh();
      return { tone: 'success', message: labels.success ?? '' };
    }
    if (kind === 'first_admin') {
      const result = await post('/v1/setup/first-admin', { secondFactor: String(form.get('f.secondFactor') ?? 'totp'), recoveryCodesStored: form.get('f.recoveryStored') === 'on' }, token);
      if (!result.ok) return { tone: 'error', message: explain(result) };
      if (nextHref) router.push(nextHref);
      router.refresh();
      return { tone: 'success', message: labels.success ?? '' };
    }
    const stepUp = await post('/v1/auth/step-up', { password: String(form.get('f.password') ?? '') }, null);
    if (!stepUp.ok) return { tone: 'error', message: explain(stepUp) };
    const code = String(form.get('f.code') ?? '').replace(/\s+/g, '');
    const elevated = await post('/v1/admin/session/elevate', { proof: { method: 'totp', code } }, null);
    if (!elevated.ok) return { tone: 'error', message: explain(elevated) };
    const finished = await post('/v1/setup/finish', { confirm: true }, token);
    if (!finished.ok) return { tone: 'error', message: explain(finished) };
    if (doneHref) router.push(doneHref);
    return { tone: 'success', message: labels.success ?? '' };
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setPending(true);
    try {
      setOutcome(await run(form));
    } catch {
      setOutcome({ tone: 'error', message: labels.reasons.network ?? labels.generic });
    } finally {
      setPending(false);
      // Secrets never stay in the form after an attempt.
      for (const name of ['f.password', 'f.code']) {
        const field = element.elements.namedItem(name);
        if (field instanceof HTMLInputElement) field.value = '';
      }
    }
  };

  return (
    <form onSubmit={onSubmit} className="admin-form" aria-busy={pending || undefined} data-testid={`setup-form-${kind}`}>
      <fieldset className="admin-form__fields" disabled={pending}>
        {children}
      </fieldset>
      <div className="admin-form__actions">
        <Button type="submit" variant="primary" isLoading={pending}>
          {labels.submit}
        </Button>
      </div>
      <p className={`admin-form__result admin-form__result--${outcome.tone === 'error' ? 'error' : outcome.tone === 'success' ? 'success' : 'idle'}`} role={outcome.tone === 'error' ? 'alert' : 'status'}>
        {outcome.message}
      </p>
    </form>
  );
}
