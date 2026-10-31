'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreateCompanyCommandSchema } from '@trustwork/contracts/client';
import { Button, Form, FormActions, FormAlert, TextArea, TextField } from '@trustwork/ui';
import { mapFieldErrors, useAuthForm } from '@/components/auth/useAuthForm';
import type { ErrorEnvelopeLike } from '@/app/_lib/api-client';
import { t, type LocaleKey } from '@/app/_lib/i18n';

const FIELD_MAP = {
  name: { required: 'company.create.error.nameRequired', too_long: 'company.create.error.nameTooLong', invalid: 'company.create.error.nameRequired' },
  handle: { invalid: 'company.create.error.handleInvalid', too_short: 'company.create.error.handleInvalid', too_long: 'company.create.error.handleInvalid' },
  publicDescription: { too_long: 'company.create.error.descriptionTooLong', invalid: 'company.create.error.descriptionTooLong' },
} as const;

/** Directory handle problems come as `validation.schema` with `{ field: 'handle', reason }` (BE-003). */
const HANDLE_REASONS: Record<string, LocaleKey> = {
  handle_unavailable: 'company.create.error.handleTaken',
  handle_invalid: 'company.create.error.handleInvalid',
  handle_limit: 'company.create.error.handleLimit',
};

/**
 * Creates the company page (`POST /v1/companies`, WEB-004): a `registered` company with the creator as its only
 * administrator. The API refuses a person who already has an active employer (`membership.already_employed`) and a
 * taken handle; both render localized copy. The page address is optional: without it the page uses its identifier.
 */
export function CompanyCreateForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const form = useAuthForm();

  const onError = (error: ErrorEnvelopeLike) => {
    const reason = error.details?.reason;
    if (error.details?.field === 'handle' && typeof reason === 'string' && HANDLE_REASONS[reason]) return { handle: t(HANDLE_REASONS[reason]!) };
    return mapFieldErrors(form.fieldIssues(error), FIELD_MAP);
  };

  return (
    <section id="create" aria-labelledby="company-create-title" className="ws-card" style={{ maxWidth: '40rem' }}>
      <h2 id="company-create-title" className="ws-h2">
        {t('company.create.title')}
      </h2>
      <p className="ws-muted">{t('company.create.body')}</p>
      {form.alert ? (
        <FormAlert
          tone={form.alert.tone}
          autoFocus
          errors={Object.entries(form.fields)
            .filter(([, v]) => v)
            .map(([k, v]) => ({ id: `company-${k}`, label: v! }))}
        >
          {form.alert.text}
        </FormAlert>
      ) : null}
      <Form
        validationBehavior="aria"
        {...(form.hydrated ? { 'data-hydrated': '' } : {})}
        aria-labelledby="company-create-title"
        isBusy={form.busy}
        onSubmit={async (event) => {
          event.preventDefault();
          const payload = { name, handle: handle.trim() ? handle.trim() : null, publicDescription: description.trim() ? description.trim() : null };
          const response = await form.submit({ path: '/v1/companies', payload, schema: CreateCompanyCommandSchema, idempotent: true, onError });
          if (response.kind === 'ok') router.refresh();
        }}
      >
        <div className="au-form__fields">
          <TextField id="company-name" label={t('company.create.name')} value={name} onChange={setName} autoComplete="organization" isRequired errorMessage={form.fields.name} isDisabled={form.busy} />
          <TextField
            id="company-handle"
            label={t('company.create.handle')}
            description={t('company.create.handleHint')}
            value={handle}
            onChange={setHandle}
            autoComplete="off"
            errorMessage={form.fields.handle}
            isDisabled={form.busy}
          />
          <TextArea id="company-publicDescription" label={t('company.create.description')} description={t('company.create.descriptionHint')} value={description} onChange={setDescription} rows={3} maxLength={4000} errorMessage={form.fields.publicDescription} isDisabled={form.busy} />
          <FormActions>
            <Button type="submit" variant="accent" isLoading={form.busy} pendingLabel={t('company.create.pending')}>
              {t('company.create.submit')}
            </Button>
          </FormActions>
          <p className="ws-note">{t('company.create.statusNote')}</p>
        </div>
      </Form>
    </section>
  );
}
