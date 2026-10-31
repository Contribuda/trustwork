'use client';

import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { fieldIssues, newIdempotencyKey, postJson, validateCommand, type ApiResult, type ErrorEnvelopeLike, type FieldIssue } from '@/app/_lib/api-client';
import { errorMessage, t, type LocaleKey } from '@/app/_lib/i18n';

export type FieldErrors = Record<string, string | undefined>;
export type FormAlertState = { tone: 'error' | 'info' | 'success' | 'warning'; text: string; code?: string };
/** `demo`: the payload passed contract validation in a demo deployment, where nothing is sent (no API exists there). */
export type SubmitResult = ApiResult | { kind: 'demo' } | { kind: 'invalid' };

/** Maps field issues from client validation or the API envelope to localized field messages. */
export function mapFieldErrors(issues: FieldIssue[], map: Record<string, Partial<Record<FieldIssue['code'], LocaleKey>>>, params?: Record<string, number>): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const key = map[issue.path]?.[issue.code] ?? map[issue.path]?.invalid;
    if (key && !out[issue.path]) out[issue.path] = t(key, params);
  }
  return out;
}

/** Localized copy for an error envelope: never the raw code or the English API message (WEB-004). */
export function alertFor(error: ErrorEnvelopeLike): FormAlertState {
  const retry = error.details?.retryAfterSeconds;
  const params = typeof retry === 'number' ? { minutes: Math.max(1, Math.ceil(retry / 60)) } : undefined;
  return { tone: error.code === 'auth.recovery.on_hold' ? 'warning' : 'error', text: errorMessage(error.code, params), code: error.code };
}

export interface SubmitOptions<T> {
  path: `/v1/${string}`;
  payload: Record<string, unknown> | null;
  /** Contract schema checked in the browser first; field issues then render without a request. */
  schema?: z.ZodType<T>;
  /** Field mapping for issues reported by validation or the API. */
  onError?: (error: ErrorEnvelopeLike) => FieldErrors | null;
  /** Demo deployments validate only and never call the API. */
  demo?: boolean;
  /** Authenticated mutations: send the form's idempotency key (kept across retries, renewed after success). */
  idempotent?: boolean;
}

/** Shared submit state for the auth and workspace forms: busy flag, form-level alert, field errors, last result. */
export function useAuthForm() {
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<FormAlertState | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const key = useRef<string | null>(null);
  useEffect(() => setHydrated(true), []);

  function showError(error: ErrorEnvelopeLike, onError?: (error: ErrorEnvelopeLike) => FieldErrors | null) {
    const mapped = onError?.(error);
    if (mapped && Object.keys(mapped).length) {
      setFields(mapped);
      setAlert({ tone: 'error', text: t('form.errorSummaryTitle'), code: error.code });
    } else setAlert(alertFor(error));
  }

  async function submit<T>(options: SubmitOptions<T>): Promise<SubmitResult> {
    setAlert(null);
    setFields({});
    if (options.schema) {
      const checked = validateCommand(options.schema, options.payload ?? {});
      if (!checked.ok) {
        showError(checked.error, options.onError);
        const invalid = { kind: 'invalid' } as const;
        setResult(invalid);
        return invalid;
      }
    }
    if (options.demo) {
      const demo = { kind: 'demo' } as const;
      setResult(demo);
      return demo;
    }
    setBusy(true);
    if (options.idempotent && !key.current) key.current = newIdempotencyKey();
    const response = await postJson(options.path, options.payload, options.idempotent && key.current ? { idempotencyKey: key.current } : {});
    setResult(response);
    if (response.kind === 'network') setAlert({ tone: 'error', text: t('error.network') });
    else if (response.kind === 'error') {
      showError(response.error, options.onError);
      // A definitive refusal ends this submission: the next one (usually with corrected fields) gets a new key, or
      // the API would answer `validation.idempotency_conflict`. Network failures, 5xx and an unfinished first
      // execution keep the key, so a retry cannot repeat the effect.
      if (response.status < 500 && response.error.code !== 'validation.idempotency_in_progress') key.current = null;
    } else key.current = null;
    setBusy(false);
    return response;
  }

  return { busy, alert, fields, result, submit, setAlert, fieldIssues, hydrated };
}
