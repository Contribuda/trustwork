'use client';

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button, TextArea, useToast } from '@trustwork/ui';
import type { CommandState } from '../_data/command-state';

export type ConsoleFormLabels = {
  submit: string;
  reason?: string | undefined;
  reasonHelp?: string | undefined;
  auditNote?: string | undefined;
  secondPersonNote?: string | undefined;
};

export type ConsoleFormProps = {
  /** The server action (`submitConsoleCommand`); it re-authorizes everything on the server. */
  action: (previous: CommandState, form: FormData) => Promise<CommandState>;
  /** Hidden fields: `command`, `hub`, `expectedRevision`, the demo `persona` and `scenario`, a setup `token`, `f.*` values. */
  hidden: Readonly<Record<string, string>>;
  labels: ConsoleFormLabels;
  /** Every staff mutation carries a reason; the setup wizard does not. */
  withReason?: boolean | undefined;
  /** When set, the form is shown read-only with this explanation (no permission, offline, …). */
  disabledReason?: string | null | undefined;
  /** After an accepted demo command, continue here (the setup wizard's next step). */
  nextHref?: string | undefined;
  submitVariant?: 'primary' | 'secondary' | 'danger' | undefined;
  /** Visible fields, rendered on the server. Their names start with `f.` so they reach the command as fields. */
  children?: ReactNode;
  className?: string | undefined;
};

const INITIAL: CommandState = { status: 'idle' };

/**
 * Every console mutation goes through this form (ADM-002): visible fields, the required reason (`ReasonField`), the
 * audit note (`AuditNote`), and a live region with the server's answer, also shown as a toast. In demo mode the
 * answer is "Demo: changes are not saved" or the validation error; nothing is stored. Strings arrive as props: the
 * console's locale namespace stays on the server.
 */
export function ConsoleForm({ action, hidden, labels, withReason = true, disabledReason, nextHref, submitVariant = 'primary', children, className }: ConsoleFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const toast = useToast();
  const router = useRouter();
  const shown = useRef(0);
  const disabled = Boolean(disabledReason);

  useEffect(() => {
    if (state.status === 'idle' || state.at === shown.current) return;
    shown.current = state.at;
    toast.add({ title: state.message, tone: state.tone === 'error' ? 'error' : state.tone === 'warning' ? 'warning' : 'info' });
    if (state.status === 'done' && nextHref) router.push(nextHref);
  }, [state, toast, router, nextHref]);

  // Submitted through a transition instead of `action={…}` so React does not reset the fields afterwards: a rejected
  // or stale command keeps what the person typed (screens.md, "Stale").
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  };

  return (
    <form onSubmit={onSubmit} className={`admin-form ${className ?? ''}`} aria-busy={pending || undefined}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <fieldset className="admin-form__fields" disabled={disabled || pending}>
        {children}
        {withReason ? (
          <TextArea name="reason" label={labels.reason ?? ''} description={labels.reasonHelp} isRequired rows={2} maxLength={500} isDisabled={disabled} />
        ) : null}
      </fieldset>
      {labels.secondPersonNote ? <p className="admin-note admin-note--second">{labels.secondPersonNote}</p> : null}
      {withReason && labels.auditNote ? <p className="admin-note">{labels.auditNote}</p> : null}
      {disabledReason ? <p className="admin-note admin-note--disabled">{disabledReason}</p> : null}
      <div className="admin-form__actions">
        <Button type="submit" variant={submitVariant} isDisabled={disabled} isLoading={pending}>
          {labels.submit}
        </Button>
      </div>
      <p className={`admin-form__result admin-form__result--${state.status === 'idle' ? 'idle' : state.tone}`} role={state.status === 'rejected' ? 'alert' : 'status'}>
        {state.status === 'idle' ? '' : state.message}
      </p>
    </form>
  );
}
