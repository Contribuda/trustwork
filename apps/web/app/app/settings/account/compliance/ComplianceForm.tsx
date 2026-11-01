'use client';

import { useEffect, useState } from 'react';
import { Button, Form, FormAlert, TextArea } from '@trustwork/ui';
import { OwnComplianceStatusSchema, AppealComplianceDecisionCommandSchema, type OwnComplianceStatus } from '@trustwork/contracts/client';
import { t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';
import { useStepUp } from '@/components/auth/StepUp';
import { useAuthForm } from '@/components/auth/useAuthForm';

/** First-party self service only. Never accept a subject id from the URL or fetch a staff projection. */
export function ComplianceForm({ live }: { live: boolean }) {
  const [own, setOwn] = useState<OwnComplianceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const form = useAuthForm();
  const stepUp = useStepUp();

  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    setFailed(false);
    void fetch(withBase('/v1/screening/me'), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('status unavailable');
        const parsed = OwnComplianceStatusSchema.parse(await response.json());
        if (!controller.signal.aborted) setOwn(parsed);
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [live, reload]);

  // The engine has no authoritative activated notice-disclosure policy. The generic notice above remains the only
  // status copy: do not infer a legal permission, a cleared hold, an assigned reviewer or a review deadline.
  return <>
    {failed || !live ? <FormAlert tone="warning">{t('compliance.unavailable')}</FormAlert> : null}
    {failed && live ? <Button variant="secondary" onPress={() => setReload((n) => n + 1)}>{t('compliance.retry')}</Button> : null}
    {submitted ? <FormAlert tone="success" autoFocus>{t('compliance.submitted')}</FormAlert> : null}
    {own?.canAppeal && !submitted ? <section className="ws-card" aria-labelledby="compliance-appeal-title">
      <h2 id="compliance-appeal-title" className="ws-h2">{t('compliance.appealTitle')}</h2>
      {form.alert ? <FormAlert tone={form.alert.tone}>{form.alert.text}</FormAlert> : null}
      <Form onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        // Freeze this submission across the real password step-up and an idempotent retry.
        const payload = { companyId: null, reason: reason.trim() };
        try {
          const response = await stepUp.guard(() => form.submit({ path: '/v1/screening/me/appeal', payload, schema: AppealComplianceDecisionCommandSchema, idempotent: true }));
          if (response.kind === 'ok') {
            const parsed = OwnComplianceStatusSchema.safeParse(response.body);
            if (!parsed.success) { setFailed(true); return; }
            setOwn(parsed.data);
            setReason('');
            setSubmitted(true);
          }
        } finally { setPending(false); }
      }}>
        <TextArea id="compliance-reason" label={t('compliance.reason')} description={t('compliance.appealHelp')}
          value={reason} onChange={setReason} maxLength={2000} isRequired isDisabled={pending} />
        <Button type="submit" isDisabled={!form.hydrated || pending || !reason.trim()} isLoading={form.busy} pendingLabel={t('compliance.pending')}>{t('compliance.submit')}</Button>
      </Form>
    </section> : null}
    {stepUp.dialog}
  </>;
}
