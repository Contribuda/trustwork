'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, FormAlert } from '@trustwork/ui';
import { useAuthForm } from '@/components/auth/useAuthForm';
import { errorMessage, t } from '@/app/_lib/i18n';
import { build, type FieldReader, type Shape } from './shapes';

type Variant = 'primary' | 'secondary' | 'accent' | 'ghost' | 'danger';
export type CommandButton = { label: string; intent?: string; variant?: Variant; success?: string; confirm?: { title: string; body: string; label: string; destructive?: boolean } };

function reader(form: HTMLFormElement): FieldReader {
  const data = new FormData(form);
  return { get: (name) => String(data.get(name) ?? ''), checked: (name) => data.get(name) !== null };
}

/**
 * The one client form of the commerce screens (WEB-002). Its fields are plain labelled inputs rendered on the server
 * (children); on submit it builds the exact contract command (`shapes.ts`) and posts it to the same-origin `/v1/*` route
 * with the CSRF header and an idempotency key kept for retries of the same submission. Refusals render as localized
 * copy and move focus to the field to fix. In a demo deployment nothing is sent. A commitment whose outcome is unknown
 * (timeout, 5xx) is never retried blindly: the form says the outcome is unknown, reconciles by reloading the projection,
 * and a repeat reuses the same idempotency key.
 */
export function CommandForm({ path, base, shape, demo, buttons, children, redirect, success, label }: { path: `/v1/${string}`; base: Record<string, unknown>; shape: Shape; demo: boolean; buttons: CommandButton[]; children?: ReactNode; redirect?: { base: string; key: string } | { to: string }; success?: string; label?: string }) {
  const router = useRouter();
  const form = useAuthForm();
  const ref = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState<CommandButton | null>(null);
  const [unknown, setUnknown] = useState(false);

  function mark(field: string | undefined) {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
    const el = field ? (root.elements.namedItem(field) as HTMLElement | null) : null;
    if (el && 'focus' in el) {
      el.setAttribute('aria-invalid', 'true');
      el.focus();
    }
  }

  /** Builds the command from the fields, or shows the refusal and focuses the field to fix. */
  function prepare(button: CommandButton) {
    const root = ref.current;
    if (!root) return null;
    const built = build(shape, path, base, reader(root), button.intent ?? null);
    if (!built.ok) {
      form.setAlert({ tone: 'error', text: t(built.error) });
      mark(built.field);
      return null;
    }
    mark(undefined);
    return built;
  }

  async function execute(button: CommandButton) {
    const root = ref.current;
    const built = prepare(button);
    if (!root || !built) return;
    let revision: number | null = null;
    let body: Record<string, unknown> = {};
    for (const step of built.steps) {
      const payload = step.revisionFromQuote && revision !== null ? { ...step.payload, expectedRevision: revision } : step.payload;
      const result = await form.submit({ path: step.path, payload, demo, idempotent: true });
      if (result.kind === 'demo') {
        form.setAlert({ tone: 'info', text: t('commerce.demoNotSent') });
        return;
      }
      if (result.kind === 'network' || (result.kind === 'error' && result.status >= 500)) {
        if (shape.kind === 'placeOrder') setUnknown(true);
        else if (shape.kind === 'accept' || shape.kind === 'quote') form.setAlert({ tone: 'warning', text: t('commerce.accept.unknown') });
        return;
      }
      if (result.kind !== 'ok') {
        const details = result.kind === 'error' ? (result.error.details ?? {}) : {};
        const code = result.kind === 'error' ? result.error.code : '';
        if (shape.kind === 'placeOrder' && (code === 'commercial.budget_insufficient' || (code === 'commercial.authority_missing' && String(details.reason ?? '').startsWith('budget')))) {
          form.setAlert({ tone: 'error', text: t('commerce.order.budgetUnavailable', { reason: errorMessage(code) }) });
          mark('budget');
        } else if (shape.kind === 'placeOrder' && (code === 'commercial.authority_missing' || code === 'access.forbidden')) form.setAlert({ tone: 'error', text: t('commerce.order.authorityInsufficient') });
        if (details.reason === 'electronic_records_consent_required' && typeof details.disclosureKey === 'string') {
          const input = root.elements.namedItem('disclosureKey') as HTMLInputElement | null;
          if (input) input.value = details.disclosureKey;
          form.setAlert({ tone: 'error', text: t('commerce.consent.changed') });
          mark('consent');
        }
        return;
      }
      body = result.body;
      const quote = body.quote as { revision?: unknown } | undefined;
      if (typeof quote?.revision === 'number') revision = quote.revision;
    }
    if (button.success ?? success) form.setAlert({ tone: 'success', text: (button.success ?? success)! });
    if (redirect && 'to' in redirect) {
      router.push(redirect.to);
      router.refresh();
      return;
    }
    if (redirect) {
      const [head, tail] = redirect.key.split('.') as [string, string | undefined];
      const value = tail ? (body[head] as Record<string, unknown> | undefined)?.[tail] : body[head];
      if (typeof value === 'string') {
        router.push(`${redirect.base}/${encodeURIComponent(value)}`);
        return;
      }
    }
    router.refresh();
  }

  return (
    <form
      ref={ref}
      className="cm-stack"
      noValidate
      aria-label={label}
      aria-busy={form.busy || undefined}
      {...(form.hydrated ? { 'data-hydrated': '' } : {})}
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const button = buttons.find((b) => (b.intent ?? '') === (submitter?.value ?? '')) ?? buttons[0]!;
        if (!button.confirm) void execute(button);
        else if (prepare(button)) {
          form.setAlert(null);
          setPending(button);
        }
      }}
    >
      {form.alert ? <FormAlert tone={form.alert.tone}>{form.alert.text}</FormAlert> : null}
      {unknown ? (
        <div className="cm-stack" role="status">
          <p className="banner banner--warning">{t('commerce.order.outcomeUnknown')}</p>
          <div className="cm-actions">
            <Button variant="secondary" onPress={() => router.refresh()}>
              {t('commerce.order.checkResult')}
            </Button>
            <Button variant="ghost" isLoading={form.busy} onPress={() => void execute(buttons[0]!)}>
              {t('commerce.order.placeSameRequest')}
            </Button>
          </div>
          <p className="ws-note">{t('commerce.order.sameRequestNote')}</p>
        </div>
      ) : null}
      <div className="cm-stack" hidden={unknown}>
        {children}
        <div className="cm-actions">
          {buttons.map((b) => (
            <Button key={b.intent ?? 'submit'} type="submit" value={b.intent ?? ''} variant={b.variant ?? 'accent'} isLoading={form.busy} pendingLabel={t('commerce.saving')}>
              {b.label}
            </Button>
          ))}
        </div>
      </div>
      {pending?.confirm ? (
        <ConfirmDialog
          title={pending.confirm.title}
          description={pending.confirm.body}
          isOpen
          onOpenChange={(open) => (open ? null : setPending(null))}
          isLoading={form.busy}
          isDestructive={pending.confirm.destructive ?? false}
          confirmLabel={pending.confirm.label}
          cancelLabel={t('commerce.cancel')}
          onConfirm={async () => {
            const button = pending;
            await execute(button);
            setPending(null);
          }}
        />
      ) : null}
    </form>
  );
}
