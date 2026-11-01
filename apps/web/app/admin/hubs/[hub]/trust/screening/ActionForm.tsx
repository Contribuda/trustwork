'use client';
import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { newIdempotencyKey, postJson } from '@/app/_lib/api-client';
import type { Copy } from './model';

/** Each submitted payload retains its key after an ambiguous outcome. A changed command gets a new key. */
export function ActionForm({ path, label, copy, evidence, fixed = {}, numbers = {}, choices = {}, disabled = false }: {
  path: `/v1/${string}`; label: string; copy: Copy; evidence?: Record<string, string>; fixed?: Record<string, string>; numbers?: Record<string, {label: string; value: number; min: number; max: number}>; choices?: Record<string, {label: string; options: Record<string, string>}>; disabled?: boolean;
}) {
  const router = useRouter();
  const pending = useRef<{ key: string; payload: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled) return;
    const form = event.currentTarget;
    if (!pending.current) {
      const data = new FormData(form);
      const reason = String(data.get('reason') ?? '').trim();
      if (!reason) { setMessage(copy.reasonRequired); return; }
      pending.current = { key: newIdempotencyKey(), payload: { ...fixed, ...Object.fromEntries(Object.keys(numbers).map((name) => [name, Number(data.get(name))])), ...Object.fromEntries(Object.keys(choices).map((name) => [name, String(data.get(name))])), reason, ...(evidence ? { evidence: data.get('evidence') } : {}) } };
    }
    setBusy(true);
    const result = await postJson(path, pending.current.payload, { idempotencyKey: pending.current.key });
    setBusy(false);
    if (result.kind === 'ok') {
      pending.current = null; setUncertain(false); setMessage(copy.saved); form.reset(); router.refresh();
    } else if (result.kind === 'network' || result.status >= 500 || (result.kind === 'error' && result.error.code === 'validation.idempotency_in_progress')) {
      setUncertain(true); setMessage(copy.unknownOutcome);
    } else {
      pending.current = null; setUncertain(false);
      setMessage(`${result.error.code === 'access.second_approver_required' ? copy.secondRequired : copy.refused} ${result.error.requestId}`);
    }
    requestAnimationFrame(() => status.current?.focus());
  }
  return <form onSubmit={submit} className="screening-form">
    <fieldset disabled={disabled || busy || uncertain}>
      <legend>{label}</legend>
      {Object.entries(choices).map(([name, field]) => <label key={name}>{field.label}<select name={name} required>{Object.entries(field.options).map(([value,text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}
      {Object.entries(numbers).map(([name, field]) => <label key={name}>{field.label}<input name={name} type="number" required min={field.min} max={field.max} step={1} defaultValue={field.value} /></label>)}
      <label>{copy.reason}<textarea name="reason" required maxLength={500} rows={3} /></label>
      {evidence ? <label>{copy.evidence}<select name="evidence" required>{Object.entries(evidence).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label> : null}
    </fieldset>
    <p className="admin-note">{copy.audit}</p>
    <button type="submit" disabled={disabled || busy}>{uncertain ? copy.retry : label}</button>
    <p ref={status} tabIndex={-1} role="status">{message}</p>
  </form>;
}
