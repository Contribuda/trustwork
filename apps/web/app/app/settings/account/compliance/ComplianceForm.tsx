'use client';

import { useState } from 'react';
import { Button, Form, FormAlert, TextArea } from '@trustwork/ui';
import { AppealComplianceDecisionCommandSchema } from '@trustwork/contracts/client';
import { t } from '@/app/_lib/i18n';
import { useStepUp } from '@/components/auth/StepUp';
import { useAuthForm } from '@/components/auth/useAuthForm';

/**
 * First-party self service only. The page decides whether an appeal is open; the API decides again on submission.
 * `companyId` comes from the session's own administrator membership, never from the URL.
 */
export function ComplianceForm({ title, companyId = null }: { title: string; companyId?: string | null }) {
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const form = useAuthForm();
  const stepUp = useStepUp();
  const scope = companyId ? 'company' : 'own';

  // The engine has no authoritative activated notice-disclosure policy. The generic notice on the page remains the only
  // status copy: do not infer a legal permission, a cleared hold, an assigned reviewer or a review deadline.
  return <>
    {submitted ? <FormAlert tone="success" autoFocus>{t('compliance.submitted')}</FormAlert> : <section className="ws-card" aria-labelledby={`compliance-appeal-${scope}`}>
      <h2 id={`compliance-appeal-${scope}`} className="ws-h2">{title}</h2>
      {form.alert ? <FormAlert tone={form.alert.tone}>{form.alert.text}</FormAlert> : null}
      <Form onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        // Freeze this submission across the real password step-up and an idempotent retry.
        const payload = { companyId, reason: reason.trim() };
        try {
          const response = await stepUp.guard(() => form.submit({ path: '/v1/screening/me/appeal', payload, schema: AppealComplianceDecisionCommandSchema, idempotent: true }));
          if (response.kind === 'ok') setSubmitted(true);
        } finally { setPending(false); }
      }}>
        <TextArea id={`compliance-reason-${scope}`} label={t('compliance.reason')} description={t('compliance.appealHelp')}
          value={reason} onChange={setReason} maxLength={2000} isRequired isDisabled={pending} />
        <Button type="submit" isDisabled={!form.hydrated || pending || !reason.trim()} isLoading={form.busy} pendingLabel={t('compliance.pending')}>{t('compliance.submit')}</Button>
      </Form>
    </section>}
    {stepUp.dialog}
  </>;
}
