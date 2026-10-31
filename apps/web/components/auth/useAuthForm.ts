'use client';

import { useEffect, useState } from 'react';
import { fieldIssues, postJson, type ApiResult, type ErrorEnvelopeLike, type FieldIssue } from '@/app/_lib/api-client';
import { errorMessage, t, type LocaleKey } from '@/app/_lib/i18n';

export type FieldErrors = Record<string, string | undefined>;

/** Maps `details.fields[{ path, code }]` from a contract envelope to Russian field messages. */
export function mapFieldErrors(issues: FieldIssue[], map: Record<string, Partial<Record<FieldIssue['code'], LocaleKey>>>, params?: Record<string, number>): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const key = map[issue.path]?.[issue.code] ?? map[issue.path]?.invalid;
    if (key && !out[issue.path]) out[issue.path] = t(key, params);
  }
  return out;
}

/** Shared submit state for the auth forms: busy flag, form-level alert, field errors, last envelope. */
export function useAuthForm() {
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ tone: 'error' | 'info' | 'success' | 'warning'; text: string; code?: string } | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const [result, setResult] = useState<ApiResult | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function submit(url: string, payload: Record<string, unknown>, onError: (error: ErrorEnvelopeLike) => FieldErrors | null): Promise<ApiResult> {
    setBusy(true);
    setAlert(null);
    setFields({});
    const response = await postJson(url, payload);
    setResult(response);
    if (response.kind === 'network') setAlert({ tone: 'error', text: t('auth.error.network') });
    else if (response.kind === 'error') {
      const mapped = onError(response.error);
      if (mapped && Object.keys(mapped).length) {
        setFields(mapped);
        setAlert({ tone: 'error', text: t('form.errorSummaryTitle'), code: response.error.code });
      } else {
        const retry = response.error.details?.retryAfterSeconds;
        setAlert({ tone: 'error', text: errorMessage(response.error.code, typeof retry === 'number' ? { minutes: Math.max(1, Math.ceil(retry / 60)) } : undefined), code: response.error.code });
      }
    }
    setBusy(false);
    return response;
  }

  return { busy, alert, fields, result, submit, setAlert, fieldIssues, hydrated };
}
